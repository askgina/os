import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  DataKeyStore,
  DataKeyTenantMismatchError,
  DataKeyUnavailableError,
  type KeyProvider,
  KeyProviderUnavailableError,
  type KeyringFile,
  type KeyScope,
  LocalKeyring,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const k1 = LocalKeyring.generate("k1");
let db: TestDatabase;
const pools: pg.Pool[] = [];
const dir = mkdtempSync(join(tmpdir(), "os-keys-store-"));

function pool(): pg.Pool {
  const created = new pg.Pool({ connectionString: db.url, max: 4 });
  pools.push(created);
  return created;
}

function store(file: KeyringFile = k1, cacheTtlMs = 0): DataKeyStore {
  return new DataKeyStore({ pool: pool(), provider: new LocalKeyring(file), cacheTtlMs });
}

const newId = (prefix = "wrun_") => `${prefix}${randomBytes(10).toString("hex")}`;
const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");

async function query<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return (await pool().query<T>(text, params)).rows;
}

beforeAll(async () => {
  db = await createTestDatabase("keys_store");
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("migration", () => {
  test("is idempotent when many stores migrate at once", async () => {
    await Promise.all(Array.from({ length: 6 }, () => store().ensureMigrated()));
    await store().ensureMigrated();
    const rows = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'os_keys'",
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("creating and reading keys", () => {
  test("concurrent first use from 20 independent stores converges on one key", async () => {
    const id = newId();
    const keys = await Promise.all(
      Array.from({ length: 20 }, () => store().getOrCreate("run", id)),
    );
    expect(new Set(keys.map(hex)).size).toBe(1);
    const rows = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM os_keys.data_keys WHERE key_id = $1",
      [id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  test("two OS processes racing for a new key converge, and a restarted process gets it too", async () => {
    const keyringFile = join(dir, "ring.json");
    writeFileSync(keyringFile, JSON.stringify(k1), { mode: 0o600 });
    const script = join(import.meta.dirname, "fixtures", "get-key.ts");
    const env = {
      ...process.env,
      DATABASE_URL: db.url,
      KEYRING_FILE: keyringFile,
      SCOPE: "run",
      KEY_ID: newId(),
    };
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script], { env }),
      execFileAsync(process.execPath, [script], { env }),
    ]);
    expect(a.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(b.stdout.trim()).toBe(a.stdout.trim());
    const restarted = await execFileAsync(process.execPath, [script], { env });
    expect(restarted.stdout.trim()).toBe(a.stdout.trim());
  });

  test("a restarted store with an empty cache returns the same 32 bytes", async () => {
    const id = newId();
    const first = await store(k1, 60_000).getOrCreate("run", id);
    expect(first).toHaveLength(32);
    expect(hex(await store().getOrCreate("run", id))).toBe(hex(first));
    expect(hex(await store().get("run", id))).toBe(hex(first));
  });

  test("get never creates a key", async () => {
    const id = newId();
    await expect(store().get("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    const rows = await query("SELECT 1 FROM os_keys.data_keys WHERE key_id = $1", [id]);
    expect(rows).toHaveLength(0);
  });

  test("scopes do not collide: the same id in two scopes has two different keys", async () => {
    const id = newId("ws_");
    const s = store();
    const run = await s.getOrCreate("run", id);
    const workspace = await s.getOrCreate("workspace", id);
    expect(hex(run)).not.toBe(hex(workspace));
  });

  test("the wrapped key in the database is not the data key", async () => {
    const id = newId();
    const key = await store().getOrCreate("run", id);
    const rows = await query<{ wrapped_key: Buffer }>(
      "SELECT wrapped_key FROM os_keys.data_keys WHERE key_id = $1",
      [id],
    );
    expect(rows[0]?.wrapped_key.includes(Buffer.from(key))).toBe(false);
  });
});

describe("binding the wrapping to where the key belongs", () => {
  async function wrappedOf(scope: KeyScope, id: string): Promise<Buffer> {
    const rows = await query<{ wrapped_key: Buffer }>(
      "SELECT wrapped_key FROM os_keys.data_keys WHERE scope = $1 AND key_id = $2",
      [scope, id],
    );
    const wrapped = rows[0]?.wrapped_key;
    if (!wrapped) throw new Error("no row");
    return wrapped;
  }

  test("a wrapped key copied to another id does not unwrap", async () => {
    const [a, b] = [newId(), newId()];
    const s = store();
    await s.getOrCreate("run", a);
    await s.getOrCreate("run", b);
    await query("UPDATE os_keys.data_keys SET wrapped_key = $1 WHERE key_id = $2", [
      await wrappedOf("run", a),
      b,
    ]);
    await expect(s.getOrCreate("run", b)).rejects.toThrow();
  });

  test("a wrapped key copied to another scope does not unwrap", async () => {
    const id = newId("ws_");
    const s = store();
    await s.getOrCreate("run", id);
    await s.getOrCreate("workspace", id);
    await query(
      "UPDATE os_keys.data_keys SET wrapped_key = $1 WHERE scope = 'workspace' AND key_id = $2",
      [await wrappedOf("run", id), id],
    );
    await expect(s.getOrCreate("workspace", id)).rejects.toThrow();
  });

  test("changing the recorded tenant makes the key unreadable", async () => {
    const id = newId();
    const s = store();
    await s.getOrCreate("run", id, "ws_a");
    await query("UPDATE os_keys.data_keys SET tenant_id = 'ws_b' WHERE key_id = $1", [id]);
    await expect(s.getOrCreate("run", id)).rejects.toThrow();
    await expect(s.get("run", id)).rejects.toThrow();
  });

  test("a caller naming a different tenant is refused, also when the key is cached", async () => {
    const id = newId();
    const s = store(k1, 60_000);
    const key = await s.getOrCreate("run", id, "ws_a");
    expect(hex(await s.getOrCreate("run", id))).toBe(hex(key));
    expect(hex(await s.getOrCreate("run", id, "ws_a"))).toBe(hex(key));
    await expect(s.getOrCreate("run", id, "ws_b")).rejects.toBeInstanceOf(
      DataKeyTenantMismatchError,
    );
    await expect(store().getOrCreate("run", id, "ws_b")).rejects.toBeInstanceOf(
      DataKeyTenantMismatchError,
    );
  });

  test("a key created without a tenant is not later handed to a caller that names one", async () => {
    const id = newId();
    await store().getOrCreate("run", id);
    await expect(store().getOrCreate("run", id, "ws_a")).rejects.toBeInstanceOf(
      DataKeyTenantMismatchError,
    );
  });
});

describe("shred", () => {
  test("destroys the key, leaves a tombstone, and never re-mints", async () => {
    const id = newId();
    const s = store(k1, 60_000);
    await s.getOrCreate("run", id);
    expect(await s.shred("run", id)).toBe(true);
    expect(await s.shred("run", id)).toBe(false);
    await expect(s.getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    await expect(store().getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    await expect(s.get("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    const rows = await query<{
      wrapped_key: Buffer | null;
      kek_id: string | null;
      shredded_at: Date | null;
    }>("SELECT wrapped_key, kek_id, shredded_at FROM os_keys.data_keys WHERE key_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wrapped_key).toBeNull();
    expect(rows[0]?.kek_id).toBeNull();
    expect(rows[0]?.shredded_at).toBeInstanceOf(Date);
  });

  test("shredding an id that never had a key blocks it from ever getting one", async () => {
    const id = newId();
    const s = store();
    expect(await s.shred("run", id)).toBe(false);
    await expect(s.getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
  });

  test("shredding one scope leaves the other scope's key for the same id alone", async () => {
    const id = newId("ws_");
    const s = store();
    const workspace = await s.getOrCreate("workspace", id);
    await s.getOrCreate("run", id);
    await s.shred("run", id);
    expect(hex(await s.getOrCreate("workspace", id))).toBe(hex(workspace));
  });
});

describe("shredTenant", () => {
  test("destroys one tenant's run keys and leaves another tenant's readable", async () => {
    const [tenantA, tenantB] = [newId("ws_"), newId("ws_")];
    const [a1, a2, b1] = [newId(), newId(), newId()];
    const s = store(k1, 60_000);
    await s.getOrCreate("run", a1, tenantA);
    await s.getOrCreate("run", a2, tenantA);
    const bKey = await s.getOrCreate("run", b1, tenantB);
    // The tenant's own workspace key lives in another scope and is not touched.
    const wsKey = await s.getOrCreate("workspace", tenantA, tenantA);

    expect(await s.shredTenant("run", tenantA)).toEqual({ shredded: 2 });

    // Evicted from this store's cache as well as destroyed in the database.
    for (const id of [a1, a2]) {
      await expect(s.get("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
      await expect(s.getOrCreate("run", id, tenantA)).rejects.toBeInstanceOf(
        DataKeyUnavailableError,
      );
      await expect(store().getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    }
    const rows = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM os_keys.data_keys WHERE key_id = ANY($1) AND wrapped_key IS NULL AND kek_id IS NULL AND shredded_at IS NOT NULL",
      [[a1, a2]],
    );
    expect(rows[0]?.n).toBe(2);
    expect(hex(await store().get("run", b1))).toBe(hex(bKey));
    expect(hex(await store().get("workspace", tenantA))).toBe(hex(wsKey));

    expect(await s.shredTenant("run", tenantA)).toEqual({ shredded: 0 });
    expect(await s.shredTenant("run", newId("ws_"))).toEqual({ shredded: 0 });
  });

  test("migration creates the partial tenant index", async () => {
    await store().ensureMigrated();
    const rows = await query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'os_keys' AND indexname = 'data_keys_tenant_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(scope, tenant_id)");
    expect(rows[0]?.indexdef).toContain("WHERE (shredded_at IS NULL)");
  });
});

describe("cache", () => {
  test("another process's cached key outlives a shred until its TTL runs out, then fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = newId();
    const holder = store(k1, 60_000);
    const key = await holder.getOrCreate("run", id);
    expect(await store().shred("run", id)).toBe(true);
    // This is the documented hazard: shred is effective fleet-wide only after the TTL.
    expect(hex(await holder.getOrCreate("run", id))).toBe(hex(key));
    vi.setSystemTime(Date.now() + 60_001);
    await expect(holder.getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
  });

  test("a cache TTL of 0 reads the database every time; evict drops the cache", async () => {
    const events: string[] = [];
    const id = newId();
    const uncached = new DataKeyStore({
      pool: pool(),
      provider: new LocalKeyring(k1),
      cacheTtlMs: 0,
      onEvent: (event) => events.push(event),
    });
    await uncached.getOrCreate("run", id);
    await uncached.getOrCreate("run", id);
    expect(events.filter((e) => e === "cache-hit")).toHaveLength(0);
    expect(events.filter((e) => e === "created")).toHaveLength(1);

    const cachedEvents: string[] = [];
    const cached = new DataKeyStore({
      pool: pool(),
      provider: new LocalKeyring(k1),
      cacheTtlMs: 60_000,
      onEvent: (event) => cachedEvents.push(event),
    });
    await cached.getOrCreate("run", id);
    await cached.getOrCreate("run", id);
    expect(cachedEvents.filter((e) => e === "cache-hit")).toHaveLength(1);
    cached.evict();
    await cached.getOrCreate("run", id);
    expect(cachedEvents.filter((e) => e === "unwrap")).toHaveLength(2);
  });
});

describe("rewrap", () => {
  test("moves every live key to the new active KEK without changing it, and reports bad rows", async () => {
    // Its own database, so rows tampered with by other tests do not count.
    const rotationDb = await createTestDatabase("keys_rotation");
    const rotationPool = new pg.Pool({ connectionString: rotationDb.url, max: 4 });
    try {
      const make = (file: KeyringFile) =>
        new DataKeyStore({ pool: rotationPool, provider: new LocalKeyring(file), cacheTtlMs: 0 });
      const old = make(k1);
      const ids = Array.from({ length: 5 }, () => newId());
      const before = await Promise.all(ids.map((id) => old.getOrCreate("run", id)));
      const workspace = await old.getOrCreate("workspace", "ws_rot", "ws_rot");
      const shredded = newId();
      await old.getOrCreate("run", shredded);
      await old.shred("run", shredded);
      const tampered = newId();
      await old.getOrCreate("run", tampered);
      await rotationPool.query(
        "UPDATE os_keys.data_keys SET wrapped_key = set_byte(wrapped_key, 20, get_byte(wrapped_key, 20) # 1) WHERE key_id = $1",
        [tampered],
      );

      const k2: KeyringFile = {
        active: "k2",
        keys: { ...k1.keys, k2: randomBytes(32).toString("base64") },
      };
      const rotated = make(k2);
      // A small batch so pagination is exercised.
      const first = await rotated.rewrap(2);
      expect(first).toEqual({ rewrapped: 6, failed: [`run:${tampered}`] });
      expect(await rotated.rewrap()).toEqual({ rewrapped: 0, failed: [`run:${tampered}`] });

      const k2Only = make({ active: "k2", keys: { k2: k2.keys.k2 ?? "" } });
      const after = await Promise.all(ids.map((id) => k2Only.getOrCreate("run", id)));
      expect(after.map(hex)).toEqual(before.map(hex));
      expect(hex(await k2Only.getOrCreate("workspace", "ws_rot", "ws_rot"))).toBe(hex(workspace));
      await expect(k2Only.getOrCreate("run", shredded)).rejects.toBeInstanceOf(
        DataKeyUnavailableError,
      );
      const tombstone = await rotationPool.query(
        "SELECT kek_id, shredded_at FROM os_keys.data_keys WHERE key_id = $1",
        [shredded],
      );
      expect(tombstone.rows[0]).toMatchObject({ kek_id: null });
    } finally {
      await rotationPool.end();
      await rotationDb.drop();
    }
  });
});

/** A keyring whose service is down: `ready`, `wrap` and `unwrap` fail while `down` is set. */
function flakyProvider(file: KeyringFile): KeyProvider & { down: boolean; readyCalls: number } {
  const ring = new LocalKeyring(file);
  const outage = () => new KeyProviderUnavailableError("test: the provider is down");
  return {
    down: true,
    readyCalls: 0,
    async ready() {
      this.readyCalls += 1;
      if (this.down) throw outage();
    },
    activeKekId: () => ring.activeKekId(),
    async wrap(kekId, dataKey, aad) {
      if (this.down) throw outage();
      return ring.wrap(kekId, dataKey, aad);
    },
    async unwrap(kekId, wrapped, aad) {
      if (this.down) throw outage();
      return ring.unwrap(kekId, wrapped, aad);
    },
    close: () => ring.close(),
  };
}

describe("a key provider that is down", () => {
  test("getOrCreate waits for ready(), fails with its error, mints nothing, and works once it is back", async () => {
    const provider = flakyProvider(k1);
    const flaky = new DataKeyStore({ pool: pool(), provider, cacheTtlMs: 0 });
    const id = newId();
    await expect(flaky.getOrCreate("run", id)).rejects.toBeInstanceOf(KeyProviderUnavailableError);
    await expect(flaky.ensureMigrated()).rejects.toBeInstanceOf(KeyProviderUnavailableError);
    expect(await query("SELECT 1 FROM os_keys.data_keys WHERE key_id = $1", [id])).toHaveLength(0);
    provider.down = false;
    const key = await flaky.getOrCreate("run", id);
    expect(key).toHaveLength(32);
    // Ready once it worked; a later outage shows up on the operation itself.
    const calls = provider.readyCalls;
    provider.down = true;
    await expect(flaky.get("run", id)).rejects.toBeInstanceOf(KeyProviderUnavailableError);
    expect(provider.readyCalls).toBe(calls);
  });

  test("shred and shredTenant do not need the provider", async () => {
    const id = newId();
    await store().getOrCreate("run", id, "ws_down");
    const down = new DataKeyStore({ pool: pool(), provider: flakyProvider(k1), cacheTtlMs: 0 });
    expect(await down.shredTenant("run", "ws_down")).toEqual({ shredded: 1 });
    expect(await down.shred("run", newId())).toBe(false);
    await expect(store().get("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
  });

  test("rewrap stops with the provider's error instead of listing reachable rows as failed", async () => {
    const rotationDb = await createTestDatabase("keys_store_rewrap_down");
    const rotationPool = new pg.Pool({ connectionString: rotationDb.url, max: 4 });
    try {
      await new DataKeyStore({ pool: rotationPool, provider: new LocalKeyring(k1) }).getOrCreate(
        "run",
        newId(),
      );
      const k2: KeyringFile = {
        active: "k2",
        keys: { ...k1.keys, k2: randomBytes(32).toString("base64") },
      };
      const provider = flakyProvider(k2);
      provider.down = false;
      const rotating = new DataKeyStore({ pool: rotationPool, provider, cacheTtlMs: 0 });
      await rotating.ensureMigrated();
      provider.down = true;
      await expect(rotating.rewrap()).rejects.toBeInstanceOf(KeyProviderUnavailableError);
      provider.down = false;
      expect(await rotating.rewrap()).toEqual({ rewrapped: 1, failed: [] });
    } finally {
      await rotationPool.end();
      await rotationDb.drop();
    }
  });
});
