import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeConfig, createBridge } from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";

const SECRET = "webhook-secret-with-more-than-thirty-two-characters";

const TOPIC = "approvals-test";

const WORKSPACE = "wsp_01k9z5n3r2q4m6p8t0v2x4y6za";

const APPROVAL = "apr_01k9z5n3r2q4m6p8t0v2x4y6zb";

const LINK = `https://os.example.com/w/${WORKSPACE}/approvals/${APPROVAL}`;

interface Published {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  status: number;
}

let clock = 1_800_000_000;

let ntfy: Server;

let ntfyUrl: string;

let ntfyStatus = 200;

let published: Published[] = [];

let bridge: Server | undefined;

let bridgeUrl: string;

let logged: Record<string, unknown>[] = [];

async function listen(server: Server): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.closeAllConnections();
  server.close(() => resolve());
  await promise;
}

async function startBridge(overrides: Partial<BridgeConfig> = {}): Promise<void> {
  if (bridge) await close(bridge);
  bridge = createBridge(
    { secret: SECRET, ntfyUrl, topic: TOPIC, token: null, linkOrigin: null, ...overrides },
    { now: () => clock, log: (fields) => logged.push(fields) },
  );
  bridgeUrl = await listen(bridge);
}

/** A delivery body as the control plane writes it: canonical JSON, keys sorted. */
function delivery(deliveryId: string, fields: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = {
    approvalId: APPROVAL,
    deliveryId,
    event: "approval.opened",
    expiresAt: clock + 3_600,
    kind: "approve-intent",
    link: LINK,
    v: 1,
    workspaceId: WORKSPACE,
    ...fields,
  };

  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1)));

  return JSON.stringify(sorted);
}

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

type DeliveryHeaders = Partial<
  Record<"x-os-delivery" | "x-os-timestamp" | "x-os-signature", string>
>;

/**
 * POST `body` to the sidecar as the control plane does: under the delivery id in the body,
 * timestamped now and signed, unless `headers` say otherwise.
 */
async function deliver(body: string, headers: DeliveryHeaders = {}): Promise<number> {
  let deliveryId = "";

  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed === "object" && parsed !== null && "deliveryId" in parsed) {
      deliveryId = String(parsed.deliveryId);
    }
  } catch {}

  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-os-delivery": deliveryId,
      "x-os-timestamp": String(clock),
      "x-os-signature": sign(body, clock),
      ...headers,
    },
    body,
  });

  await response.body?.cancel();

  return response.status;
}

beforeEach(async () => {
  published = [];
  logged = [];
  ntfyStatus = 200;
  ntfy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(chunk as Buffer);
    published.push({
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      status: ntfyStatus,
    });
    response.writeHead(ntfyStatus, { "content-type": "application/json" }).end("{}");
  });
  ntfyUrl = await listen(ntfy);
  await startBridge();
});

afterEach(async () => {
  if (bridge) await close(bridge);
  bridge = undefined;
  await close(ntfy);
});

describe("the ntfy sidecar", () => {
  it("publishes a signed delivery once, as fixed text, with no link, token or identifier", async () => {
    expect(await deliver(delivery("ndl_01"))).toBe(204);
    expect(published).toHaveLength(1);
    const [message] = published;
    expect(message?.path).toBe(`/${TOPIC}`);
    expect(message?.body).toBe("Approval waiting");
    expect(message?.headers.click).toBeUndefined();
    expect(message?.headers.authorization).toBeUndefined();
    const sent = JSON.stringify(message);

    for (const identifier of [WORKSPACE, APPROVAL, "ndl_01"]) {
      expect(sent).not.toContain(identifier);
    }

    // Its log line names the delivery and what happened, and nothing the body says.
    expect(logged).toEqual([
      {
        message: "delivery",
        status: 204,
        code: "published",
        deliveryId: "ndl_01",
        event: "approval.opened",
      },
    ]);
  });

  it("refuses a changed body, another secret, and a missing or malformed signature", async () => {
    const body = delivery("ndl_02");
    const changed = body.replace("approve-intent", "approve-intenT");
    expect(await deliver(changed, { "x-os-signature": sign(body, clock) })).toBe(401);
    expect(await deliver(body, { "x-os-signature": sign(body, clock, `${SECRET}x`) })).toBe(401);
    expect(await deliver(body, { "x-os-signature": "" })).toBe(401);
    expect(await deliver(body, { "x-os-signature": sign(body, clock).replace("v1=", "v0=") })).toBe(
      401,
    );
    // The signature covers the timestamp: another one with the same signature fails.
    expect(await deliver(body, { "x-os-timestamp": String(clock - 1) })).toBe(401);
    expect(published).toHaveLength(0);
    expect(logged.map((line) => line.code)).toEqual([
      "bad_signature",
      "bad_signature",
      "unsigned",
      "unsigned",
      "bad_signature",
    ]);
  });

  it("refuses a timestamp more than 300 seconds old or ahead", async () => {
    for (const offset of [-301, 301]) {
      const body = delivery(`ndl_03${offset}`);
      const timestamp = clock + offset;

      const status = await deliver(body, {
        "x-os-timestamp": String(timestamp),
        "x-os-signature": sign(body, timestamp),
      });

      expect(status).toBe(401);
    }

    expect(published).toHaveLength(0);
    const body = delivery("ndl_03");
    const timestamp = clock - 300;
    expect(
      await deliver(body, {
        "x-os-timestamp": String(timestamp),
        "x-os-signature": sign(body, timestamp),
      }),
    ).toBe(204);
    expect(published).toHaveLength(1);
  });

  it("answers a repeated delivery id without publishing again, also when the two race", async () => {
    const body = delivery("ndl_04");
    expect(await deliver(body)).toBe(204);
    clock += 30;
    // A retry is signed again, with its own timestamp.
    expect(await deliver(body)).toBe(204);
    expect(published).toHaveLength(1);

    const racing = delivery("ndl_05");
    expect(await Promise.all([deliver(racing), deliver(racing)])).toEqual([204, 204]);
    expect(published).toHaveLength(2);
  });

  it("forgets a delivery id after a day", async () => {
    const body = delivery("ndl_06");
    expect(await deliver(body)).toBe(204);
    clock += 86_400;
    expect(await deliver(body)).toBe(204);
    expect(published).toHaveLength(2);
  });

  it("answers 502 while ntfy refuses, so the control plane retries, and publishes once it takes it", async () => {
    const body = delivery("ndl_07");
    ntfyStatus = 503;
    expect(await deliver(body)).toBe(502);
    ntfyStatus = 401;
    expect(await deliver(body)).toBe(502);
    ntfyStatus = 200;
    expect(await deliver(body)).toBe(204);
    expect(await deliver(body)).toBe(204);
    expect(published.map((request) => request.status)).toEqual([503, 401, 200]);

    await close(ntfy);
    expect(await deliver(delivery("ndl_08"))).toBe(502);
  });

  it("refuses a signed body that is not a version 1 delivery under the id in its header", async () => {
    expect(await deliver(delivery("ndl_09"), { "x-os-delivery": "ndl_other" })).toBe(400);
    expect(await deliver(delivery("ndl_10", { v: 2 }))).toBe(400);
    expect(await deliver("approval waiting", { "x-os-delivery": "ndl_11" })).toBe(400);
    expect(
      await deliver(JSON.stringify([{ deliveryId: "ndl_12" }]), { "x-os-delivery": "ndl_12" }),
    ).toBe(400);
    expect(published).toHaveLength(0);
    expect(logged.map((line) => line.code)).toEqual([
      "delivery_id_mismatch",
      "unknown_version",
      "not_a_delivery",
      "not_a_delivery",
    ]);
  });

  it("says what happened for each event, and ignores an event it does not know", async () => {
    const mandateLink = `https://os.example.com/w/${WORKSPACE}/mandates/mnd_01k9z5n3r2q4m6p8t0v2x4y6zc`;
    expect(
      await deliver(
        JSON.stringify({
          approvalId: APPROVAL,
          deliveryId: "ndl_13",
          event: "mandate.used",
          link: mandateLink,
          mandateId: "mnd_01k9z5n3r2q4m6p8t0v2x4y6zc",
          v: 1,
          workspaceId: WORKSPACE,
        }),
      ),
    ).toBe(204);
    expect(await deliver(delivery("ndl_14", { event: "approval.reminder" }))).toBe(204);
    expect(await deliver(delivery("ndl_15", { event: "approval.decided" }))).toBe(204);
    expect(await deliver(delivery("ndl_16", { event: "toString" }))).toBe(204);
    expect(published.map((request) => request.body)).toEqual([
      "Paid under an approval in advance",
      "Approval expiring soon",
    ]);
  });

  it("adds the link and the ntfy token only when configured, and leaves out a link elsewhere", async () => {
    await startBridge({ linkOrigin: "https://os.example.com", token: "tk_example" });
    expect(await deliver(delivery("ndl_17"))).toBe(204);
    expect(published[0]?.headers.click).toBe(LINK);
    expect(published[0]?.headers.authorization).toBe("Bearer tk_example");

    // A link to another site, or to no web page, is not passed on; the text still is.
    for (const [id, link] of [
      ["ndl_18", "https://os.example.com.evil.example/w/x"],
      ["ndl_19", "javascript:alert(1)"],
      ["ndl_20", 7],
    ] as const) {
      expect(await deliver(delivery(id, { link }))).toBe(204);
    }

    expect(published.map((request) => request.headers.click)).toEqual([
      LINK,
      undefined,
      undefined,
      undefined,
    ]);
    expect(published.map((request) => request.body)).toEqual(
      Array.from({ length: 4 }, () => "Approval waiting"),
    );
    expect(logged.map((line) => line.code)).toEqual([
      "published",
      "published_without_link",
      "published_without_link",
      "published_without_link",
    ]);
  });

  it("answers its health check, and nothing but POST otherwise", async () => {
    expect((await fetch(`${bridgeUrl}/healthz`)).status).toBe(200);
    expect((await fetch(bridgeUrl)).status).toBe(405);
    expect(logged.map((line) => line.code)).toEqual(["method_not_allowed"]);
  });
});

describe("the sidecar's settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ntfy-sidecar-"));
    writeFileSync(join(dir, "secret"), `  ${SECRET}\n`);
    writeFileSync(join(dir, "token"), "tk_example\n");
    writeFileSync(join(dir, "empty"), "\n");
    writeFileSync(join(dir, "short"), "too-short");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    NOTIFY_WEBHOOK_SECRET_FILE: join(dir, "secret"),
    NTFY_URL: "https://ntfy.example.com/",
    NTFY_TOPIC: TOPIC,
  });

  it("reads the trimmed secret and defaults to port 8080, no token and no link", () => {
    expect(
      readConfig({
        ...base(),
        PORT: "",
        NTFY_TOKEN_FILE: "",
        NTFY_INCLUDE_LINK: "",
        PUBLIC_ORIGIN: "https://os.example.com",
      }),
    ).toEqual({
      port: 8080,
      secret: SECRET,
      ntfyUrl: "https://ntfy.example.com",
      topic: TOPIC,
      token: null,
      linkOrigin: null,
    });
  });

  it("reads a token file, a path under the ntfy URL and the link setting", () => {
    expect(
      readConfig({
        ...base(),
        NTFY_URL: "https://example.com/ntfy/",
        NTFY_TOKEN_FILE: join(dir, "token"),
        NTFY_INCLUDE_LINK: "1",
        PUBLIC_ORIGIN: "https://os.example.com/",
        PORT: "9000",
      }),
    ).toMatchObject({
      port: 9000,
      ntfyUrl: "https://example.com/ntfy",
      token: "tk_example",
      linkOrigin: "https://os.example.com",
    });
    expect(readConfig({ ...base(), NTFY_TOKEN_FILE: join(dir, "empty") }).token).toBeNull();
  });

  it("refuses to start on a missing or wrong setting", () => {
    const { NTFY_TOPIC: _topic, ...withoutTopic } = base();
    expect(() => readConfig(withoutTopic)).toThrow("NTFY_TOPIC is required");
    expect(() => readConfig({ ...base(), NOTIFY_WEBHOOK_SECRET_FILE: join(dir, "short") })).toThrow(
      "at least 32 characters",
    );
    expect(() => readConfig({ ...base(), NTFY_TOPIC: "../admin" })).toThrow("NTFY_TOPIC");
    expect(() => readConfig({ ...base(), NTFY_URL: "ftp://ntfy.example.com" })).toThrow("NTFY_URL");
    expect(() => readConfig({ ...base(), NTFY_URL: "https://user:pass@ntfy.example.com" })).toThrow(
      "NTFY_URL",
    );
    expect(() => readConfig({ ...base(), NTFY_INCLUDE_LINK: "yes" })).toThrow("NTFY_INCLUDE_LINK");
    expect(() => readConfig({ ...base(), NTFY_INCLUDE_LINK: "1" })).toThrow(
      "PUBLIC_ORIGIN is required",
    );
    expect(() => readConfig({ ...base(), PORT: "80a" })).toThrow("PORT");
  });
});
