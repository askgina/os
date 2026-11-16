import { createHmac, timingSafeEqual } from "node:crypto";
import { expect } from "@playwright/test";
import pg from "pg";
import { z } from "zod";
import { type JsonObject, jsonObjectIn } from "./json.ts";
import { databaseUrl, exec, stack } from "./stack.ts";

/** One request the stack's webhook receiver recorded (see `webhook-receiver.mts`). */
const ReceivedRequest = z.object({
  /** Milliseconds since the Unix epoch, on the receiver's clock. */
  receivedAt: z.number(),
  method: z.string(),
  path: z.string(),
  /** Lower-cased header names. */
  headers: z.record(z.string(), z.string()),
  /** The body exactly as received. */
  body: z.string(),
  /** What the receiver answered. */
  status: z.number(),
});

export type ReceivedRequest = z.infer<typeof ReceivedRequest>;

/** Every request the receiver has recorded, oldest first. */
export async function receivedRequests(): Promise<ReceivedRequest[]> {
  const response = await fetch(`${stack.webhookReceiverUrl}/requests`);

  if (!response.ok) throw new Error(`the webhook receiver answered ${response.status}`);

  return z.array(ReceivedRequest).parse(await response.json());
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

/** The recorded requests whose body `match` selects, once the receiver accepted one of them. */
export async function acknowledged(
  match: (body: JsonObject) => boolean,
): Promise<ReceivedRequest[]> {
  let matching: ReceivedRequest[] = [];
  await expect
    .poll(
      async () => {
        matching = (await receivedRequests()).filter((request) => match(bodyOf(request)));

        return matching.some((request) => request.status === 200);
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  return matching;
}

/** The webhook's outbox rows for one request or use and one event, as the server keeps them. */
export async function webhookDeliveries(
  approvalId: string,
  event: string,
): Promise<{ id: string; state: string; attempts: number }[]> {
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    const { rows } = await db.query<{ id: string; state: string; attempts: number }>(
      "SELECT id, state, attempts FROM os.notification_deliveries WHERE approval_id = $1 AND event = $2 AND target = 'webhook' ORDER BY id",
      [approvalId, event],
    );

    return rows;
  } finally {
    await db.end();
  }
}

/**
 * Check one recorded attempt the way the deploy guide tells a receiver to: a JSON POST, signed
 * with the secret from the server's volume over its exact bytes, with a timestamp within 300
 * seconds, and a body that is canonical JSON with exactly `keys` and none of `secrets`.
 */
export function expectSignedDelivery(
  secret: string,
  request: ReceivedRequest,
  keys: string[],
  secrets: string[],
): JsonObject {
  expect(request.method).toBe("POST");
  expect(request.headers["content-type"]).toBe("application/json");
  expect(signatureVerifies(secret, request)).toBe(true);
  // One more byte and it no longer verifies: the check above is a real one.
  expect(signatureVerifies(secret, { ...request, body: `${request.body} ` })).toBe(false);
  const timestamp = Number(request.headers["x-os-timestamp"]);
  expect(Number.isInteger(timestamp)).toBe(true);
  expect(Math.abs(request.receivedAt / 1000 - timestamp)).toBeLessThanOrEqual(300);

  const body = bodyOf(request);
  expect(Object.keys(body)).toEqual(keys);
  // Sorted keys and no white space: the exact bytes JSON.stringify gives for what it parsed.
  expect(request.body).toBe(JSON.stringify(body));
  expect(body).toMatchObject({ v: 1, deliveryId: request.headers["x-os-delivery"] });
  const seen = `${JSON.stringify(request.headers)}\n${request.body}`.toLowerCase();

  for (const value of secrets) expect(seen).not.toContain(value.toLowerCase());

  return body;
}

/** The JSON object in a request's body, or an empty object when the body is not one. */
export function bodyOf(request: Pick<ReceivedRequest, "body">): JsonObject {
  return jsonObjectIn(request.body) ?? {};
}
