// The OpenBao Transit provider under DataKeyStore, against the in-process stub always and
// against the real OpenBao dev server from `deploy/compose.test.yaml` when it runs. In CI
// (`CI=true`) the real server is required; elsewhere its cases are skipped when it is not up.
// The real half holds the OpenBao test server (`holdOpenBao`) from setup to teardown, since it
// pauses the container and other packages' tests use it too.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import {
  holdOpenBao,
  OPENBAO_TEST_ADDR,
  openBaoReachable,
  type PreparedTransit,
  pauseOpenBao,
  prepareTransit,
  unpauseOpenBao,
} from "@askgina/os-testkit/openbao";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DataKeyStore,
  KeyProviderRefusedError,
  KeyProviderUnavailableError,
  TransitKeyProvider,
} from "../src/index.ts";
import { startTransitStub } from "./support/transit-stub.ts";

const dir = mkdtempSync(join(tmpdir(), "os-keys-transit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Backend {
  mount: string;
  provider(timeoutMs?: number): TransitKeyProvider;
  rotate(): Promise<void>;
  setMinDecryptionVersion(version: number): Promise<void>;
  pause(): Promise<void>;
  unpause(): Promise<void>;
  close(): Promise<void>;
}

function appRoleFiles(name: string, roleId: string, secretId: string) {
  const roleIdFile = join(dir, `${name}-role-id`);
  const secretIdFile = join(dir, `${name}-secret-id`);
  writeFileSync(roleIdFile, `${roleId}\n`, { mode: 0o600 });
  writeFileSync(secretIdFile, `${secretId}\n`, { mode: 0o600 });
  return { kind: "approle" as const, roleIdFile, secretIdFile };
}

async function stubBackend(): Promise<Backend> {
  const stub = await startTransitStub();
  const auth = appRoleFiles("stub", stub.roleId, stub.secretId);
  return {
    mount: "transit",
    provider: (timeoutMs = 2000) =>
      new TransitKeyProvider({ address: stub.address, auth, timeoutMs, refreshSeconds: 0 }),
    rotate: async () => stub.rotate(),
    setMinDecryptionVersion: async (version) => stub.setMinDecryptionVersion(version),
    pause: async () => stub.pause(),
    unpause: async () => stub.unpause(),
    close: () => stub.close(),
  };
}

async function openBaoBackend(): Promise<Backend> {
  const release = await holdOpenBao("packages/keys/test/transit.test.ts");
  let transit: PreparedTransit;
  try {
    transit = await prepareTransit();
  } catch (error) {
    await release();
    throw error;
  }
  const auth = appRoleFiles(transit.mount, transit.roleId, transit.secretId);
  return {
    mount: transit.mount,
    provider: (timeoutMs = 2000) =>
      new TransitKeyProvider({
        address: new URL(OPENBAO_TEST_ADDR),
        mount: transit.mount,
        key: transit.key,
        auth,
        timeoutMs,
        refreshSeconds: 0,
      }),
    rotate: () => transit.rotate(),
    setMinDecryptionVersion: (version) => transit.setMinDecryptionVersion(version),
    pause: pauseOpenBao,
    unpause: unpauseOpenBao,
    close: release,
  };
}

function acceptance(name: string, makeBackend: () => Promise<Backend>) {
  let backend: Backend;
  let db: TestDatabase;
  let pool: pg.Pool;
  const providers: TransitKeyProvider[] = [];
  const provider = (timeoutMs?: number) => {
    const created = backend.provider(timeoutMs);
    providers.push(created);
    return created;
  };
  const store = (made = provider()) => new DataKeyStore({ pool, provider: made, cacheTtlMs: 0 });
  const newId = () => `wrun_${randomBytes(8).toString("hex")}`;
  const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");
  const row = async (id: string) =>
    (
      await pool.query<{ kek_id: string; wrapped_key: Buffer }>(
        "SELECT kek_id, wrapped_key FROM os_keys.data_keys WHERE key_id = $1",
        [id],
      )
    ).rows[0];
  const keys = new Map<string, string>();

  // Longer than `holdOpenBao`'s 600-second wait for another file's hold on the OpenBao test
  // server (the World's ciphertext test holds it for its scenarios and a 20-second outage).
  beforeAll(async () => {
    backend = await makeBackend();
    db = await createTestDatabase(`keys_transit_${name}`);
    pool = new pg.Pool({ connectionString: db.url, max: 4 });
  }, 630_000);

  afterAll(async () => {
    try {
      await Promise.all(providers.map((made) => made.close()));
      await pool?.end();
      await db?.drop();
    } finally {
      await backend?.close();
    }
  });

  test("a data key round-trips under bao:<mount>/os-kek@1 and reads from a fresh provider", async () => {
    const writer = store();
    for (let n = 0; n < 3; n += 1) {
      const id = newId();
      keys.set(id, hex(await writer.getOrCreate("run", id, "ws_transit")));
    }
    const [first] = keys.keys();
    const stored = await row(first ?? "");
    expect(stored?.kek_id).toBe(`bao:${backend.mount}/os-kek@1`);
    expect(stored?.wrapped_key.toString("utf8")).toMatch(/^vault:v1:/);
    const reader = store();
    for (const [id, key] of keys) expect(hex(await reader.get("run", id))).toBe(key);
  });

  test("a wrapped key presented with another row's AAD is refused", async () => {
    const writer = store();
    const a = newId();
    const b = newId();
    await writer.getOrCreate("run", a);
    await writer.getOrCreate("run", b);
    await pool.query(
      "UPDATE os_keys.data_keys SET wrapped_key = (SELECT wrapped_key FROM os_keys.data_keys WHERE key_id = $1) WHERE key_id = $2",
      [a, b],
    );
    await expect(store().get("run", b)).rejects.toBeInstanceOf(KeyProviderRefusedError);
    // Out of the way of the rewrap below, which would rightly report it.
    await writer.shred("run", b);
  });

  test("after a rotation and ready() the active id ends @2, and rewrap moves every row", async () => {
    await backend.rotate();
    const rotated = provider();
    const rotating = store(rotated);
    await rotating.ensureMigrated();
    expect(rotated.activeKekId()).toBe(`bao:${backend.mount}/os-kek@2`);
    const live = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM os_keys.data_keys WHERE shredded_at IS NULL",
    );
    const [first] = keys.keys();
    const old = await row(first ?? "");
    expect(await rotating.rewrap()).toEqual({ rewrapped: live.rows[0]?.n, failed: [] });
    expect((live.rows[0]?.n ?? 0) > 0).toBe(true);
    for (const [id, key] of keys) {
      expect((await row(id))?.kek_id).toBe(`bao:${backend.mount}/os-kek@2`);
      expect(hex(await store().get("run", id))).toBe(key);
    }

    // An old wrapped copy, as a backup taken before the rewrap holds it.
    await backend.setMinDecryptionVersion(2);
    await pool.query(
      "UPDATE os_keys.data_keys SET kek_id = $2, wrapped_key = $3 WHERE key_id = $1",
      [first, old?.kek_id, old?.wrapped_key],
    );
    await expect(store().get("run", first ?? "")).rejects.toBeInstanceOf(KeyProviderRefusedError);
  });

  test("while the server is paused, getOrCreate fails as unavailable within timeoutMs + 500 ms, then works", async () => {
    const timeoutMs = 1000;
    const paused = store(provider(timeoutMs));
    await paused.ensureMigrated();
    const id = newId();
    let resolved = false;
    await backend.pause();
    try {
      const started = Date.now();
      const attempt = paused.getOrCreate("run", id);
      attempt.then(
        () => {
          resolved = true;
        },
        () => {},
      );
      await expect(attempt).rejects.toBeInstanceOf(KeyProviderUnavailableError);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(timeoutMs + 500);
      const [existing] = keys.keys();
      await expect(paused.get("run", existing ?? "")).rejects.toBeInstanceOf(
        KeyProviderUnavailableError,
      );
    } finally {
      await backend.unpause();
    }
    expect(await paused.getOrCreate("run", id)).toHaveLength(32);
    expect(resolved).toBe(false);
  });
}

describe("Transit provider against the in-process stub", () => {
  acceptance("stub", stubBackend);
});

const reachable = await openBaoReachable();
describe.skipIf(!reachable && process.env.CI !== "true")(
  "Transit provider against OpenBao (deploy/compose.test.yaml)",
  () => {
    acceptance("openbao", openBaoBackend);
  },
);
