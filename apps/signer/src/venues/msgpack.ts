/**
 * A msgpack encoder for exactly the values a Hyperliquid action is made of: strings, non-negative
 * safe integers, booleans, null, arrays and maps with string keys in a fixed order. Anything else
 * throws, so a value the venue would hash differently can never reach a signature.
 *
 * Written here instead of taken from a package so the signer's dependency set stays as small as
 * it is (threat model, "A compromised dependency"). Tests compare it byte for byte with
 * `@msgpack/msgpack`.
 */

/** A value `encodeMsgpack` accepts. Objects must be `MsgpackMap`s, so key order is explicit. */
export type MsgpackValue = string | boolean | null | number | readonly MsgpackValue[] | MsgpackMap;

/** A msgpack map whose keys are encoded in the order given. Duplicate keys are refused. */
export class MsgpackMap {
  readonly entries: readonly (readonly [string, MsgpackValue])[];

  constructor(entries: readonly (readonly [string, MsgpackValue])[]) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry[0] !== "string") throw new TypeError("msgpack map keys must be strings");
      if (seen.has(entry[0])) throw new TypeError(`duplicate msgpack map key ${entry[0]}`);
      seen.add(entry[0]);
    }
    this.entries = Object.freeze(
      entries.map(([key, value]) => Object.freeze([key, value] as const)),
    );
  }
}

const utf8 = new TextEncoder();

class Writer {
  #bytes: number[] = [];

  byte(value: number): void {
    this.#bytes.push(value);
  }

  /** `value` as `width` big-endian bytes; `value` is a non-negative safe integer that fits. */
  uint(value: number, width: 1 | 2 | 4 | 8): void {
    let rest = BigInt(value);
    const bytes: number[] = [];
    for (let index = 0; index < width; index++) {
      bytes.unshift(Number(rest & 0xffn));
      rest >>= 8n;
    }
    this.#bytes.push(...bytes);
  }

  bytes(values: Uint8Array): void {
    for (const value of values) this.#bytes.push(value);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** A length header: the fix form up to `fixMax`, then the 8-bit (if any), 16- and 32-bit forms. */
function writeLength(
  writer: Writer,
  length: number,
  fix: number,
  fixMax: number,
  [code8, code16, code32]: readonly [number | undefined, number, number],
) {
  if (length <= fixMax) {
    writer.byte(fix | length);
  } else if (code8 !== undefined && length <= 0xff) {
    writer.byte(code8);
    writer.uint(length, 1);
  } else if (length <= 0xffff) {
    writer.byte(code16);
    writer.uint(length, 2);
  } else if (length <= 0xffff_ffff) {
    writer.byte(code32);
    writer.uint(length, 4);
  } else {
    throw new RangeError("msgpack value is too long");
  }
}

function writeValue(writer: Writer, value: unknown): void {
  if (value === null) {
    writer.byte(0xc0);
  } else if (value === false) {
    writer.byte(0xc2);
  } else if (value === true) {
    writer.byte(0xc3);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(`msgpack numbers must be non-negative safe integers, got ${value}`);
    }
    if (value <= 0x7f) {
      writer.byte(value);
    } else if (value <= 0xff) {
      writer.byte(0xcc);
      writer.uint(value, 1);
    } else if (value <= 0xffff) {
      writer.byte(0xcd);
      writer.uint(value, 2);
    } else if (value <= 0xffff_ffff) {
      writer.byte(0xce);
      writer.uint(value, 4);
    } else {
      writer.byte(0xcf);
      writer.uint(value, 8);
    }
  } else if (typeof value === "string") {
    if (!value.isWellFormed()) throw new TypeError("msgpack strings must be well-formed UTF-16");
    const bytes = utf8.encode(value);
    writeLength(writer, bytes.length, 0xa0, 31, [0xd9, 0xda, 0xdb]);
    writer.bytes(bytes);
  } else if (Array.isArray(value)) {
    writeLength(writer, value.length, 0x90, 15, [undefined, 0xdc, 0xdd]);
    for (let index = 0; index < value.length; index++) writeValue(writer, value[index]);
  } else if (value instanceof MsgpackMap) {
    writeLength(writer, value.entries.length, 0x80, 15, [undefined, 0xde, 0xdf]);
    for (const [key, entry] of value.entries) {
      writeValue(writer, key);
      writeValue(writer, entry);
    }
  } else {
    throw new TypeError(`msgpack cannot encode a value of type ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  if (typeof value !== "object") return typeof value;
  return value?.constructor?.name ?? "object";
}

/** A JSON value as a request body carries it: objects keep their keys in insertion order. */
export type JsonValue =
  | string
  | boolean
  | null
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JavaScript object puts keys that look like array indices first, whatever order they were
 * added in, so such a key cannot keep its map position in JSON. No Hyperliquid action has one.
 */
const INDEX_LIKE_KEY = /^(?:0|[1-9][0-9]*)$/;

/** `value` as JSON, each map an object with its keys in the map's order. */
export function msgpackToJson(value: MsgpackValue): JsonValue {
  if (value instanceof MsgpackMap) {
    const object: { [key: string]: JsonValue } = {};
    for (const [key, entry] of value.entries) {
      if (INDEX_LIKE_KEY.test(key)) throw new TypeError(`map key ${key} cannot keep its order`);
      object[key] = msgpackToJson(entry);
    }
    return object;
  }
  if (Array.isArray(value)) return value.map(msgpackToJson);
  return value as string | boolean | null | number;
}

/**
 * The map form of a parsed JSON value, each object a `MsgpackMap` with its keys in the object's
 * order: what the venue hashes when it reads a body. Throws for anything `encodeMsgpack` would.
 */
export function jsonToMsgpack(value: unknown): MsgpackValue {
  if (Array.isArray(value)) return value.map(jsonToMsgpack);
  if (value !== null && typeof value === "object") {
    return new MsgpackMap(
      Object.entries(value).map(([key, entry]) => [key, jsonToMsgpack(entry)] as const),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new TypeError(`cannot encode ${describe(value)}`);
}

/** The msgpack bytes of `value`. Throws a `TypeError` or `RangeError` for anything unsupported. */
export function encodeMsgpack(value: MsgpackValue): Uint8Array {
  const writer = new Writer();
  writeValue(writer, value);
  return writer.result();
}
