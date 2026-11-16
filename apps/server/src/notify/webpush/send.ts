import { createHash } from "node:crypto";
import type { ApprovalId } from "@askgina/os-protocol";
import type { WebPushConfig } from "../../config.ts";
import type { AppContext } from "../../context.ts";
import { isRetryable, postOnce } from "../http.ts";
import { encryptPayload, PushEncryptionError } from "./encrypt.ts";
import { importVapidKey, vapidAuthorization } from "./vapid.ts";

/**
 * Every message's record is padded to this many bytes, so the push service cannot tell one
 * message from another by its length (RFC 8291 §7).
 */
export const PUSH_PADDED_LENGTH = 512;

/** A push subscription as the browser reports it: `p256dh` and `auth` in base64url. */
export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  /** The JSON shown on the device. Never anything a person or agent typed beyond names. */
  payload: object;
  /** Replaces an undelivered message with the same topic at the push service: {@link pushTopic}. */
  topic: string;
  /** How long the push service keeps the message for an offline device. */
  ttlSeconds: number;
  urgency: "high" | "normal";
}

/**
 * `gone`: the subscription no longer exists (404, 410) and should be deleted. `retry`: try
 * again later (408, 429, 5xx, timeout, no answer). `rejected`: refused for good, or never sent
 * (the endpoint is not allowed, the subscription's keys are invalid). `reason` is a short code.
 */
export type PushResult =
  | { ok: true }
  | { ok: false; code: "gone" | "retry" | "rejected"; reason: string; retryAfter?: number };

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Whether the server may POST to `endpoint` on a member's behalf: `https:`, no credentials in
 * the URL, and a host equal to one of `hosts` or under it. Anything else could make the server
 * reach an internal address.
 */
export function pushEndpointAllowed(endpoint: string, hosts: readonly string[]): boolean {
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();

  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The `Topic` of an approval's messages: the first 32 characters of base64url(SHA-256 of
 * `os-approval:<id>`), so a reminder replaces the first message and the topic reveals no id.
 */
export function pushTopic(approvalId: ApprovalId): string {
  return createHash("sha256").update(`os-approval:${approvalId}`).digest("base64url").slice(0, 32);
}

const vapidKeys = new WeakMap<WebPushConfig, Promise<CryptoKey>>();

/**
 * Encrypt, sign and send one message to one subscription. Never throws for a delivery that
 * fails: every outcome is a {@link PushResult}, and a refused endpoint is never contacted.
 */
export async function sendPush(
  ctx: Pick<AppContext, "config" | "now">,
  subscription: PushSubscriptionKeys,
  message: PushMessage,
): Promise<PushResult> {
  const webPush = ctx.config.notify.webPush;

  if (webPush === null) return { ok: false, code: "rejected", reason: "push_off" };

  if (!pushEndpointAllowed(subscription.endpoint, webPush.endpointHosts)) {
    return { ok: false, code: "rejected", reason: "endpoint_refused" };
  }

  if (!TOPIC.test(message.topic)) return { ok: false, code: "rejected", reason: "bad_topic" };

  if (!Number.isSafeInteger(message.ttlSeconds) || message.ttlSeconds < 0) {
    return { ok: false, code: "rejected", reason: "bad_ttl" };
  }

  if (!BASE64URL.test(subscription.p256dh) || !BASE64URL.test(subscription.auth)) {
    return { ok: false, code: "rejected", reason: "bad_subscription" };
  }

  let body: Uint8Array<ArrayBuffer>;

  try {
    body = await encryptPayload({
      plaintext: new TextEncoder().encode(JSON.stringify(message.payload)),
      uaPublicKey: Buffer.from(subscription.p256dh, "base64url"),
      authSecret: Buffer.from(subscription.auth, "base64url"),
      paddedLength: PUSH_PADDED_LENGTH,
    });
  } catch (error) {
    if (!(error instanceof PushEncryptionError)) throw error;
    const reason = error.code === "too_long" ? "payload_too_large" : "bad_subscription";

    return { ok: false, code: "rejected", reason };
  }

  let privateKey = vapidKeys.get(webPush);

  if (privateKey === undefined) {
    privateKey = importVapidKey(webPush.vapidPrivateKey);
    vapidKeys.set(webPush, privateKey);
  }

  const now = ctx.now();

  const authorization = await vapidAuthorization({
    endpoint: new URL(subscription.endpoint),
    subject: webPush.subject,
    privateKey: await privateKey,
    publicKeyRaw: webPush.vapidPublicKey,
    now,
  });

  const outcome = await postOnce(
    subscription.endpoint,
    {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(message.ttlSeconds),
      urgency: message.urgency,
      topic: message.topic,
    },
    body,
    now,
  );

  if (outcome.status === null) return { ok: false, code: "retry", reason: outcome.code };

  if (outcome.status >= 200 && outcome.status < 300) return { ok: true };
  const reason = `http_${outcome.status}`;

  if (outcome.status === 404 || outcome.status === 410) return { ok: false, code: "gone", reason };

  if (!isRetryable(outcome.status)) return { ok: false, code: "rejected", reason };

  return outcome.retryAfter === undefined
    ? { ok: false, code: "retry", reason }
    : { ok: false, code: "retry", reason, retryAfter: outcome.retryAfter };
}
