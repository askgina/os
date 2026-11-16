import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BUNDLE_CHECK_CLASS,
  BUNDLE_LOCK_CLASS,
  type BundleLock,
  BundleMismatchError,
  bundleIdOf,
  holdBundleLock,
} from "../../src/execution/bundle-guard.ts";

let database: TestDatabase;

/** The test's own connections, outside every replica. */
let admin: pg.Pool;

const pools: pg.Pool[] = [];

const dir = mkdtempSync(join(tmpdir(), "os-bundle-guard-"));

/** A pool per process: each replica has its own. */
function pool(): pg.Pool {
  const created = new pg.Pool({ connectionString: database.url, max: 2 });
  pools.push(created);

  return created;
}

function bundle(name: string, code: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, code);

  return file;
}

const never = () => {
  throw new Error("no mismatch expected");
};

async function holders(): Promise<number[]> {
  const { rows } = await admin.query<{ objid: number }>(
    `SELECT objid::int FROM pg_locks
     WHERE locktype = 'advisory' AND granted AND classid = $1 AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [BUNDLE_LOCK_CLASS],
  );

  return rows.map((row) => row.objid);
}

beforeAll(async () => {
  database = await createTestDatabase("bundle_guard");
  admin = pool();
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await database.drop();
});

describe("the workflow bundle guard", () => {
  it("a second start with another workflow bundle is refused while the first runs, and the same bundle is accepted", async () => {
    const v1 = bundle("v1", "export const POST = 1;");
    const v2 = bundle("v2", "export const POST = 2;");
    const first = await holdBundleLock(pool(), v1, never);
    const same = await holdBundleLock(pool(), v1, never);
    expect(same.bundleId).toBe(first.bundleId);
    await expect(holdBundleLock(pool(), v2, never)).rejects.toBeInstanceOf(BundleMismatchError);
    expect(await holders()).toEqual([first.bundleId, first.bundleId]);

    // Once every process of the old bundle is gone, the new one starts.
    await first.release();
    await expect(holdBundleLock(pool(), v2, never)).rejects.toBeInstanceOf(BundleMismatchError);
    await same.release();
    const upgraded = await holdBundleLock(pool(), v2, never);
    expect(await holders()).toEqual([upgraded.bundleId]);
    await upgraded.release();
    expect(await holders()).toEqual([]);
  });

  it("two bundles starting at once do not both get in", async () => {
    const a = bundle("a", "a");
    const b = bundle("b", "b");

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => holdBundleLock(pool(), i % 2 === 0 ? a : b, never)),
    );

    const held = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BundleMismatchError);
    }

    expect(new Set(held.map((lock) => lock.bundleId)).size).toBeLessThanOrEqual(1);
    await Promise.all(held.map((lock: BundleLock) => lock.release()));
  });

  it("takes the lock again after its connection is lost, and reports a bundle that started meanwhile", async () => {
    const v1 = bundle("lost-v1", "lost 1");
    const v2 = bundle("lost-v2", "lost 2");
    const mismatches: BundleMismatchError[] = [];
    const held = await holdBundleLock(pool(), v1, (error) => mismatches.push(error));

    const kill = (client: pg.PoolClient | pg.Pool) =>
      client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
         WHERE locktype = 'advisory' AND classid = $1 AND objid = $2
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [BUNDLE_LOCK_CLASS, held.bundleId],
      );

    // Lost, then taken again on a new connection.
    await kill(admin);
    await vi.waitFor(async () => expect(await holders()).toEqual([held.bundleId]), {
      timeout: 5_000,
      interval: 50,
    });

    // Lost again, and another bundle gets in first: this process hears it. The other starter
    // holds the check lock while the connection dies, so it surely gets in before the retry.
    const other = await admin.connect();

    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1, 0)", [BUNDLE_CHECK_CLASS]);
      await kill(other);
      await other.query("SELECT pg_advisory_lock_shared($1, $2)", [
        BUNDLE_LOCK_CLASS,
        await bundleIdOf(v2),
      ]);
      await other.query("COMMIT");
      await vi.waitFor(() => expect(mismatches).toHaveLength(1), { timeout: 5_000, interval: 50 });
      expect(mismatches[0]?.bundleId).toBe(held.bundleId);
      expect(await holders()).toEqual([await bundleIdOf(v2)]);
    } finally {
      other.release(true);
    }

    await held.release();
    // The other starter's connection was closed, not unlocked: Postgres drops its lock when it
    // notices, a moment after the socket closes.
    await vi.waitFor(async () => expect(await holders()).toEqual([]), {
      timeout: 5_000,
      interval: 50,
    });
  });
});
