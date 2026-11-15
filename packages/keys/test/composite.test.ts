// Moving from the keyring file to Transit with CompositeKeyProvider, on Postgres and the
// in-process Transit stub.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CompositeKeyProvider,
  DataKeyStore,
  type KeyProvider,
  KeyProviderRefusedError,
  KeyProviderUnavailableError,
  LocalKeyring,
  TransitKeyProvider,
} from "../src/index.ts";
import { startTransitStub, type TransitStub } from "./support/transit-stub.ts";

const dir = mkdtempSync(join(tmpdir(), "os-keys-composite-"));
const ring = LocalKeyring.generate("k1");
let db: TestDatabase;
let pool: pg.Pool;
let stub: TransitStub;
const providers: KeyProvider[] = [];

function transit(timeoutMs = 2000): TransitKeyProvider {
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, stub.rootToken, { mode: 0o600 });
  const made = new TransitKeyProvider({
    address: stub.address,
    auth: { kind: "token", tokenFile },
    timeoutMs,
    refreshSeconds: 0,
  });
  providers.push(made);
  return made;
}

function composite(timeoutMs?: number): CompositeKeyProvider {
  const made = new CompositeKeyProvider({
    active: transit(timeoutMs),
    legacy: new LocalKeyring(ring),
  });
  providers.push(made);
  return made;
}

const store = (provider: KeyProvider) => new DataKeyStore({ pool, provider, cacheTtlMs: 0 });
const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");
const kekIds = async () =>
  (
    await pool.query<{ key_id: string; kek_id: string }>(
      "SELECT key_id, kek_id FROM os_keys.data_keys WHERE shredded_at IS NULL ORDER BY key_id",
    )
  ).rows;

beforeAll(async () => {
  stub = await startTransitStub();
  db = await createTestDatabase("keys_composite");
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
});

afterAll(async () => {
  await Promise.all(providers.map((provider) => provider.close()));
  await pool.end();
  await db.drop();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("moving from the keyring file to Transit", () => {
  const before = new Map<string, string>();

  test("keys created under the file read through the composite; new keys go to Transit", async () => {
    const fileStore = store(new LocalKeyring(ring));
    for (const id of ["wrun_c1", "wrun_c2", "ws_c3"]) {
      before.set(
        id,
        hex(await fileStore.getOrCreate(id.startsWith("ws_") ? "workspace" : "run", id)),
      );
    }
    const mixed = store(composite());
    for (const [id, key] of before) {
      expect(hex(await mixed.get(id.startsWith("ws_") ? "workspace" : "run", id))).toBe(key);
    }
    before.set("wrun_c4", hex(await mixed.getOrCreate("run", "wrun_c4")));
    expect(await kekIds()).toEqual([
      { key_id: "wrun_c1", kek_id: "k1" },
      { key_id: "wrun_c2", kek_id: "k1" },
      { key_id: "wrun_c4", kek_id: "bao:transit/os-kek@1" },
      { key_id: "ws_c3", kek_id: "k1" },
    ]);
  });

  test("a Transit outage is not answered from the file, and file keys still read", async () => {
    const mixed = store(composite(300));
    await mixed.ensureMigrated();
    stub.pause();
    try {
      await expect(mixed.get("run", "wrun_c4")).rejects.toBeInstanceOf(KeyProviderUnavailableError);
      expect(hex(await mixed.get("run", "wrun_c1"))).toBe(before.get("wrun_c1"));
    } finally {
      stub.unpause();
    }
  });

  test("the composite never wraps under a file KEK", async () => {
    const provider = composite();
    await provider.ready();
    await expect(provider.wrap("k1", randomBytes(32), Buffer.from("aad"))).rejects.toBeInstanceOf(
      KeyProviderRefusedError,
    );
  });

  test("rewrap moves every row to bao:, and with the file removed every key still reads", async () => {
    const mixed = store(composite());
    expect(await mixed.rewrap()).toEqual({ rewrapped: 3, failed: [] });
    expect((await kekIds()).map((row) => row.kek_id)).toEqual(
      Array.from({ length: 4 }, () => "bao:transit/os-kek@1"),
    );
    const transitOnly = store(transit());
    for (const [id, key] of before) {
      expect(hex(await transitOnly.get(id.startsWith("ws_") ? "workspace" : "run", id))).toBe(key);
    }
  });
});
