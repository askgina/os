import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-signer-signature";
export const TIMESTAMP_HEADER = "x-signer-timestamp";
export const MAX_CLOCK_SKEW_SECONDS = 60;
export const MIN_SECRET_BYTES = 32;

export interface SignedRequestParts {
  method: string;
  /** Path and query string exactly as sent, for example `/v1/wallets/wal_…?x=1`. */
  pathWithQuery: string;
  /** Seconds since the Unix epoch, as sent in {@link TIMESTAMP_HEADER}. */
  timestamp: number;
  body: Uint8Array;
}

/**
 * Authenticate a control-plane request to the signer with a shared secret. This proves where a
 * request came from and that it was not altered or replayed after a minute. It never stands in
 * for a passkey: nothing that adds authority is allowed on this signature alone.
 */
export function signRequest(secret: Uint8Array, parts: SignedRequestParts): string {
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`request-signing secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const bodyDigest = createHash("sha256").update(parts.body).digest("hex");
  const message = [
    parts.method.toUpperCase(),
    parts.pathWithQuery,
    String(parts.timestamp),
    bodyDigest,
  ].join("\n");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function verifyRequestSignature(
  secret: Uint8Array,
  parts: SignedRequestParts & { signature: string; now: number },
): boolean {
  if (!Number.isSafeInteger(parts.timestamp)) return false;
  if (Math.abs(parts.now - parts.timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  if (!/^[0-9a-f]{64}$/.test(parts.signature)) return false;
  const expected = Buffer.from(signRequest(secret, parts), "hex");
  return timingSafeEqual(expected, Buffer.from(parts.signature, "hex"));
}
