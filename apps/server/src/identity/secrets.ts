import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `bytes` random bytes as unpadded base64url. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 of a secret, lowercase hex. Only this form of a token is ever stored. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking, through timing, how many leading characters match.
 * Inputs of different lengths are simply unequal.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}
