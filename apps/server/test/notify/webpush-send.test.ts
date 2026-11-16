import { createServer } from "node:https";
import { newId } from "@askgina/os-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import {
  type PushMessage,
  type PushResult,
  pushEndpointAllowed,
  pushTopic,
  sendPush,
} from "../../src/notify/webpush/send.ts";
import {
  browserSubscription,
  decryptPush,
  listeningPort,
  type PushService,
  pushConfig,
  startPushService,
} from "./support.ts";

const NOW = 1_800_000_000;

let service: PushService;

let port: number;

let config: Config;

beforeAll(async () => {
  service = await startPushService();
  port = Number(new URL(service.origin).port);
  config = pushConfig();
});

afterAll(async () => {
  await service?.close();
});

/** A browser's subscription with an endpoint at the push service. */
const subscription = (path = "/push/subscription-1") =>
  browserSubscription(`${service.origin}${path}`);

const approvalId = newId("apr");

const message: PushMessage = {
  payload: { web_push: 8030, notification: { title: "Approval waiting", navigate: "/" } },
  topic: pushTopic(approvalId),
  ttlSeconds: 120,
  urgency: "high",
};

const ctx = () => ({ config, now: () => NOW });

describe("sending a Web Push message", () => {
  it("POSTs one encrypted, padded, VAPID-signed message that only the subscription can read; 201 delivers", async () => {
    const { ua, keys } = await subscription();
    const before = service.pushed.length;
    expect(await sendPush(ctx(), keys, message)).toEqual({ ok: true });
    expect(service.pushed).toHaveLength(before + 1);
    const request = service.pushed.at(-1);

    if (!request) throw new Error("nothing was pushed");
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/push/subscription-1");
    expect(request.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "120",
      urgency: "high",
      topic: message.topic,
    });
    // Every message is the same length: the 86-byte header, a 512-byte record and the tag.
    expect(request.body.length).toBe(614);
    expect(JSON.parse(await decryptPush(request.body, ua))).toEqual(message.payload);

    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      request.headers.authorization ?? "",
    );

    if (!match) throw new Error("no VAPID authorization");
    const [, header = "", claims = "", signature = "", key = ""] = match;
    expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toEqual({
      aud: `https://localhost:${port}`,
      exp: NOW + 43_200,
      sub: "mailto:ops@example.com",
    });
    expect(Buffer.from(key, "base64url")).toEqual(
      Buffer.from(config.notify.webPush?.vapidPublicKey ?? []),
    );

    const verifier = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(Buffer.from(key, "base64url")),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        new Uint8Array(Buffer.from(signature, "base64url")),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it("maps the push service's answers: 404 and 410 gone, 408, 429 and 5xx retry with Retry-After, other answers rejected", async () => {
    const { keys } = await subscription();
    service.answer(
      { status: 410 },
      { status: 404 },
      { status: 429, headers: { "retry-after": "30" } },
      { status: 503 },
      { status: 408 },
      { status: 400 },
      { status: 413 },
      { status: 302, headers: { location: "https://elsewhere.example/" } },
    );
    const results = [];

    for (let i = 0; i < 8; i += 1) results.push(await sendPush(ctx(), keys, message));
    expect(results).toEqual([
      { ok: false, code: "gone", reason: "http_410" },
      { ok: false, code: "gone", reason: "http_404" },
      { ok: false, code: "retry", reason: "http_429", retryAfter: 30 },
      { ok: false, code: "retry", reason: "http_503" },
      { ok: false, code: "retry", reason: "http_408" },
      { ok: false, code: "rejected", reason: "http_400" },
      { ok: false, code: "rejected", reason: "http_413" },
      { ok: false, code: "rejected", reason: "http_302" },
    ]);
  });

  it("is a retry when the push service does not answer", async () => {
    const { keys } = await subscription();
    const closedServer = createServer();
    const listening = Promise.withResolvers<void>();
    closedServer.listen(0, listening.resolve);
    await listening.promise;
    const closedPort = listeningPort(closedServer);
    const closed = Promise.withResolvers<void>();
    closedServer.close(() => closed.resolve());
    await closed.promise;
    expect(
      await sendPush(
        ctx(),
        { ...keys, endpoint: `https://localhost:${closedPort}/push/x` },
        message,
      ),
    ).toEqual({ ok: false, code: "retry", reason: "network" });
  });

  it("refuses, without any request, an endpoint that is not https: or not under an allowed host", async () => {
    const { keys } = await subscription();
    const before = service.pushed.length;

    for (const endpoint of [
      `http://localhost:${port}/push/x`,
      `https://127.0.0.1:${port}/push/x`,
      `https://notlocalhost:${port}/push/x`,
      `https://localhost.evil.example:${port}/push/x`,
      `https://user:secret@localhost:${port}/push/x`,
      "not a url",
    ]) {
      expect(await sendPush(ctx(), { ...keys, endpoint }, message)).toEqual({
        ok: false,
        code: "rejected",
        reason: "endpoint_refused",
      });
    }

    expect(service.pushed).toHaveLength(before);

    const browsers = ["fcm.googleapis.com", "push.apple.com", "notify.windows.com"];
    expect(pushEndpointAllowed("https://web.push.apple.com/QGuQ", browsers)).toBe(true);
    expect(pushEndpointAllowed("https://wns2-by3p.notify.windows.com/w/?token=x", browsers)).toBe(
      true,
    );
    expect(pushEndpointAllowed("https://fcm.googleapis.com:443/fcm/send/x", browsers)).toBe(true);
    expect(pushEndpointAllowed("https://xfcm.googleapis.com/fcm/send/x", browsers)).toBe(false);
    expect(pushEndpointAllowed("https://fcm.googleapis.com.evil.example/x", browsers)).toBe(false);
    expect(pushEndpointAllowed("https://evilpush.apple.com.example/x", browsers)).toBe(false);
  });

  it("refuses, without any request, a subscription with bad keys, a bad topic and a message too long to pad", async () => {
    const { keys } = await subscription();
    const before = service.pushed.length;

    const refused = (result: PushResult, reason: string) =>
      expect(result).toEqual({ ok: false, code: "rejected", reason });

    refused(await sendPush(ctx(), { ...keys, p256dh: "not+base64" }, message), "bad_subscription");
    refused(
      await sendPush(ctx(), { ...keys, p256dh: keys.p256dh.slice(0, -2) }, message),
      "bad_subscription",
    );
    refused(await sendPush(ctx(), { ...keys, auth: "AAAA" }, message), "bad_subscription");
    refused(await sendPush(ctx(), keys, { ...message, topic: "a/b" }), "bad_topic");
    refused(
      await sendPush(ctx(), keys, { ...message, payload: { title: "x".repeat(600) } }),
      "payload_too_large",
    );
    refused(
      await sendPush(
        { config: { ...config, notify: { ...config.notify, webPush: null } }, now: () => NOW },
        keys,
        message,
      ),
      "push_off",
    );
    expect(service.pushed).toHaveLength(before);
  });

  it("gives each approval one topic of 32 base64url characters that does not reveal its id", () => {
    const other = newId("apr");
    expect(pushTopic(approvalId)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pushTopic(approvalId)).toBe(pushTopic(approvalId));
    expect(pushTopic(other)).not.toBe(pushTopic(approvalId));
    expect(pushTopic(approvalId)).not.toContain(approvalId.slice(4, 14));
  });
});
