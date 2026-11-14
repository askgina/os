import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { open, openJson, seal, sealJson } from "../src/seal.ts";

const key = randomBytes(32);
const context = "intents.payload:int_01";

describe("seal and open", () => {
  test("round-trips bytes and JSON", () => {
    const plaintext = Buffer.from("send 1 ETH to bob");
    expect(open(key, seal(key, plaintext, context), context)).toEqual(plaintext);
    const value = { to: "0xabc", amount: "1", nested: [1, null, "x"] };
    expect(openJson(key, sealJson(key, value, context), context)).toEqual(value);
  });

  test("the sealed bytes do not contain the plaintext and differ on every call", () => {
    const plaintext = Buffer.from("PLAINTEXT_MARKER_123");
    const a = seal(key, plaintext, context);
    const b = seal(key, plaintext, context);
    expect(a.includes(plaintext)).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a).toHaveLength(1 + 12 + plaintext.length + 16);
  });

  test("a value copied to another row or column fails to open", () => {
    const sealed = seal(key, Buffer.from("x"), context);
    expect(() => open(key, sealed, "intents.payload:int_02")).toThrow();
    expect(() => open(key, sealed, "intents.memo:int_01")).toThrow();
  });

  test("another key fails to open", () => {
    expect(() => open(randomBytes(32), seal(key, Buffer.from("x"), context), context)).toThrow();
  });

  test("tampering with the iv, body or tag is detected", () => {
    const sealed = seal(key, Buffer.from("tamper me"), context);
    for (const index of [1, 13, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x80;
      expect(() => open(key, tampered, context)).toThrow();
    }
  });

  test("an unknown version byte and a truncated value are refused before decryption", () => {
    const sealed = seal(key, Buffer.from("x"), context);
    const wrongVersion = Buffer.from(sealed);
    wrongVersion[0] = 2;
    expect(() => open(key, wrongVersion, context)).toThrow(/unknown version/);
    expect(() => open(key, sealed.subarray(0, 28), context)).toThrow(/malformed/);
    expect(() => open(key, Buffer.alloc(0), context)).toThrow(/malformed/);
  });
});
