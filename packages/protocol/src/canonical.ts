import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

/**
 * Domain-separation tags. Every digest in the protocol is
 * `SHA-256(tag || "\n" || canonical JSON)`, so a digest of one kind of structure can never be
 * replayed as a digest of another kind.
 */
export const DomainTag = {
  intent: "askgina.os/v1/intent",
  policy: "askgina.os/v1/policy",
  authorize: "askgina.os/v1/authorize",
  audit: "askgina.os/v1/audit",
  sweep: "askgina.os/v1/sweep",
  /** The challenge of the step where a new approver proves they hold the passkey being added. */
  possession: "askgina.os/v1/possession",
  /** A mandate: what people approve once for a series of an agent's transfers. */
  mandate: "askgina.os/v1/mandate",
  /** One use of a mandate, the signer's record of a transfer it signed under that mandate. */
  mandateUse: "askgina.os/v1/mandate-use",
} as const;

export type DomainTag = (typeof DomainTag)[keyof typeof DomainTag];

/** A value JSON can carry: what `JSON.parse` returns and what `JSON.stringify` writes as is. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * RFC 8785 (JCS) canonical JSON. Callers pass only values that came out of a strict schema:
 * strings, integers below 2^53, booleans, null, arrays and plain objects.
 */
export function canonicalJson<Value>(value: Value): string {
  const text = canonicalize(value);

  if (text === undefined) {
    throw new TypeError("value has no canonical JSON form");
  }

  return text;
}

export function digest<Value>(tag: DomainTag, value: Value): Uint8Array {
  return sha256(utf8ToBytes(`${tag}\n${canonicalJson(value)}`));
}

export function digestHex<Value>(tag: DomainTag, value: Value): string {
  return bytesToHex(digest(tag, value));
}
