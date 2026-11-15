import { createHmac, timingSafeEqual } from "node:crypto";
import { exec, stack } from "./stack.ts";

/** One request the stack's webhook receiver recorded (see `webhook-receiver.mts`). */
export interface ReceivedRequest {
  /** Milliseconds since the Unix epoch, on the receiver's clock. */
  receivedAt: number;
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The body exactly as received. */
  body: string;
  /** What the receiver answered. */
  status: number;
}

/** Every request the receiver has recorded, oldest first. */
export async function receivedRequests(): Promise<ReceivedRequest[]> {
  const response = await fetch(`${stack.webhookReceiverUrl}/requests`);
  if (!response.ok) throw new Error(`the webhook receiver answered ${response.status}`);
  return (await response.json()) as ReceivedRequest[];
}

/**
 * From now on, answer the first attempt of each delivery the receiver has not seen with 503 and
 * `Retry-After: 1` (`true`), or answer every attempt with 200 again (`false`).
 */
export async function failFirstAttempts(on: boolean): Promise<void> {
  const response = await fetch(`${stack.webhookReceiverUrl}/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failFirstAttempt: on }),
  });
  if (response.status !== 204) throw new Error(`the webhook receiver answered ${response.status}`);
}

/**
 * The webhook's signing secret as the server uses it: the trimmed text of the file `init`
 * created in the server's secrets volume, where an operator copies it from.
 */
export async function webhookSecret(): Promise<string> {
  return (await exec("server", "cat", "/run/secrets/server/notify-webhook-secret")).trim();
}

/**
 * Whether `request` carries a valid signature under `secret`, checked the way the deploy guide
 * tells a receiver to: `x-os-signature` is `v1=` and the hex HMAC-SHA-256 of the
 * `x-os-timestamp` header, a dot and the exact body, compared in constant time.
 */
export function signatureVerifies(
  secret: string,
  request: Pick<ReceivedRequest, "headers" | "body">,
): boolean {
  const timestamp = request.headers["x-os-timestamp"];
  const signature = request.headers["x-os-signature"];
  if (timestamp === undefined || signature === undefined) return false;
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${request.body}`).digest();
  return timingSafeEqual(Buffer.from(signature.slice(3), "hex"), expected);
}

/** The JSON object in a request's body, or an empty object when the body is not one. */
export function bodyOf(request: Pick<ReceivedRequest, "body">): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(request.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
