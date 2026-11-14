// Minimal CBOR encoder (RFC 8949) covering what WebAuthn attestation objects and COSE keys need:
// unsigned/negative integers, byte strings, text strings and maps (keys emitted in insertion order).
export type CborValue =
  | number
  | string
  | Uint8Array
  | Map<CborValue, CborValue>
  | Record<string, unknown>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000)
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  throw new Error("cbor: length too large");
}

function enc(v: unknown, out: number[]): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("cbor: only safe integers supported");
    if (v >= 0) out.push(...head(0, v));
    else out.push(...head(1, -1 - v));
  } else if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    out.push(...head(3, b.length), ...b);
  } else if (v instanceof Uint8Array) {
    out.push(...head(2, v.length), ...v);
  } else if (v instanceof Map) {
    out.push(...head(5, v.size));
    for (const [k, val] of v) {
      enc(k, out);
      enc(val, out);
    }
  } else if (v && typeof v === "object") {
    const entries = Object.entries(v);
    out.push(...head(5, entries.length));
    for (const [k, val] of entries) {
      enc(k, out);
      enc(val, out);
    }
  } else {
    throw new Error(`cbor: unsupported value ${String(v)}`);
  }
}

export function cborEncode(v: CborValue): Uint8Array {
  const out: number[] = [];
  enc(v, out);
  return Uint8Array.from(out);
}
