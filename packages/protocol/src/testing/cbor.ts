import { z } from "zod";

// Minimal CBOR encoder (RFC 8949) covering what WebAuthn attestation objects and COSE keys need:
// unsigned/negative integers, byte strings, text strings and maps (keys emitted in insertion order).
export type CborValue =
  | number
  | string
  | Uint8Array
  | Map<CborValue, CborValue>
  | { [key: string]: CborValue };

const CborText = z.string();

const CborNumber = z.number();

/** A map written as a plain object: its own string keys, in insertion order. */
const CborObject = z.record(z.string(), z.custom<CborValue>());

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];

  if (n < 0x100) return [(major << 5) | 24, n];

  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];

  if (n < 0x100000000)
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  throw new Error("cbor: length too large");
}

function encMap(entries: Iterable<[CborValue, CborValue]>, size: number, out: number[]): void {
  out.push(...head(5, size));

  for (const [k, val] of entries) {
    enc(k, out);
    enc(val, out);
  }
}

function enc(v: CborValue, out: number[]): void {
  if (v instanceof Uint8Array) {
    out.push(...head(2, v.length), ...v);

    return;
  }

  if (v instanceof Map) {
    encMap(v, v.size, out);

    return;
  }

  const text = CborText.safeParse(v);

  if (text.success) {
    const b = new TextEncoder().encode(text.data);
    out.push(...head(3, b.length), ...b);

    return;
  }

  const number = CborNumber.safeParse(v);

  if (number.success) {
    if (!Number.isSafeInteger(number.data)) throw new Error("cbor: only safe integers supported");

    if (number.data >= 0) out.push(...head(0, number.data));
    else out.push(...head(1, -1 - number.data));

    return;
  }

  const object = CborObject.safeParse(v);

  if (!object.success) throw new Error(`cbor: unsupported value ${String(v)}`);
  const entries = Object.entries(object.data);
  encMap(entries, entries.length, out);
}

export function cborEncode(v: CborValue): Uint8Array {
  const out: number[] = [];
  enc(v, out);

  return Uint8Array.from(out);
}
