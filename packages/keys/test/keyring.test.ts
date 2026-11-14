import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { LocalKeyring } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "os-keys-keyring-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeRing(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

describe("LocalKeyring wrap and unwrap", () => {
  const file = LocalKeyring.generate("k1");
  const ring = new LocalKeyring(file);
  const dataKey = randomBytes(32);
  const aad = Buffer.from("scope:id");

  test("round-trips a data key", async () => {
    const wrapped = await ring.wrap("k1", dataKey, aad);
    expect(wrapped).toHaveLength(12 + 32 + 16);
    expect(Buffer.from(await ring.unwrap("k1", wrapped, aad))).toEqual(dataKey);
  });

  test("two wraps of the same key differ, so wrapped keys reveal nothing about equality", async () => {
    const [a, b] = await Promise.all([
      ring.wrap("k1", dataKey, aad),
      ring.wrap("k1", dataKey, aad),
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("the AAD is bound: a wrapped key does not open under other associated data", async () => {
    const wrapped = await ring.wrap("k1", dataKey, aad);
    await expect(ring.unwrap("k1", wrapped, Buffer.from("scope:other"))).rejects.toThrow();
  });

  test("the KEK is bound: another keyring with the same id cannot unwrap", async () => {
    const wrapped = await ring.wrap("k1", dataKey, aad);
    const impostor = new LocalKeyring(LocalKeyring.generate("k1"));
    await expect(impostor.unwrap("k1", wrapped, aad)).rejects.toThrow();
  });

  test("a flipped bit anywhere in the wrapped key is detected", async () => {
    const wrapped = Buffer.from(await ring.wrap("k1", dataKey, aad));
    for (const index of [0, 20, wrapped.length - 1]) {
      const tampered = Buffer.from(wrapped);
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      await expect(ring.unwrap("k1", tampered, aad)).rejects.toThrow();
    }
  });

  test("a wrapped key of the wrong length and an unknown KEK id are refused", async () => {
    const wrapped = await ring.wrap("k1", dataKey, aad);
    await expect(ring.unwrap("k1", wrapped.subarray(1), aad)).rejects.toThrow(/malformed/);
    await expect(ring.unwrap("k9", wrapped, aad)).rejects.toThrow(/unknown KEK/);
    await expect(ring.wrap("k9", dataKey, aad)).rejects.toThrow(/unknown KEK/);
  });

  test("hasKek and activeKekId reflect the file", () => {
    const two = new LocalKeyring({
      active: "k2",
      keys: { ...file.keys, k2: randomBytes(32).toString("base64") },
    });
    expect(two.activeKekId()).toBe("k2");
    expect(two.hasKek("k1")).toBe(true);
    expect(two.hasKek("k3")).toBe(false);
  });
});

describe("LocalKeyring configuration", () => {
  test("refuses an active id that is not in the keyring", () => {
    expect(() => new LocalKeyring({ active: "x", keys: LocalKeyring.generate("k1").keys })).toThrow(
      /active KEK x/,
    );
  });

  test("refuses keys that are not 32 bytes or not canonical base64", () => {
    const good = randomBytes(32).toString("base64");
    expect(() => new LocalKeyring({ active: "k1", keys: { k1: "AAAA" } })).toThrow(/32 bytes/);
    // Buffer.from ignores the stray characters, so without the canonical check this would load
    // as a valid, different-looking key.
    expect(
      () =>
        new LocalKeyring({ active: "k1", keys: { k1: `${good.slice(0, 10)}!!${good.slice(10)}` } }),
    ).toThrow(/canonical/);
  });

  test("loads a valid file", () => {
    const path = writeRing("good.json", JSON.stringify(LocalKeyring.generate("k7")));
    expect(LocalKeyring.fromFile(path).activeKekId()).toBe("k7");
  });

  test("a file that is not JSON fails without echoing its contents", () => {
    const secret = randomBytes(32).toString("base64");
    const path = writeRing("broken.json", `{"active":"k1","keys":{"k1":"${secret}"`);
    let message = "";
    try {
      LocalKeyring.fromFile(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("keyring: the keyring file is not valid JSON");
    expect(message).not.toContain(secret.slice(0, 8));
  });

  test("a missing file is reported without its path or contents", () => {
    expect(() => LocalKeyring.fromFile(join(dir, "absent.json"))).toThrow(
      "keyring: the keyring file is unreadable",
    );
  });

  test.each([
    ["an array", "[]"],
    ["no active field", JSON.stringify({ keys: {} })],
    ["keys not an object", JSON.stringify({ active: "k1", keys: "abc" })],
    ["a key that is not a string", JSON.stringify({ active: "k1", keys: { k1: 5 } })],
  ])("a file with %s is refused", (_name, body) => {
    expect(() => LocalKeyring.fromFile(writeRing(`shape-${_name}.json`, body))).toThrow(
      /^keyring:/,
    );
  });
});
