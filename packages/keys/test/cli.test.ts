import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  DataKeyStore,
  DataKeyUnavailableError,
  type JsonValue,
  type KeyringFile,
  LocalKeyring,
  TransitKeyProvider,
} from "../src/index.ts";
import { startTransitStub, type TransitStub } from "./support/transit-stub.ts";

const execFileAsync = promisify(execFile);

/** What execFile rejects with on a non-zero exit: the exit code and the output so far. */
const ExitFailure = z.object({ code: z.number(), stdout: z.string() });

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

const dir = mkdtempSync(join(tmpdir(), "os-keys-cli-"));

const k1 = LocalKeyring.generate("k1");

const k2: KeyringFile = {
  active: "k2",
  keys: { ...k1.keys, k2: randomBytes(32).toString("base64") },
};

let db: TestDatabase;

let pool: pg.Pool;

function ringFile(name: string, file: KeyringFile): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });

  return path;
}

/** Run the CLI as an operator would: a separate Node process. */
async function runCli(args: string[], env: Record<string, string>) {
  let code = 0;
  let stdout: string;

  try {
    ({ stdout } = await execFileAsync(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    }));
  } catch (error) {
    // execFile rejects on a non-zero exit with the exit code and output attached.
    ({ code, stdout } = ExitFailure.parse(error));
  }

  const lines = stdout
    .split("\n")
    .filter(Boolean)
    .map((line): JsonValue => JSON.parse(line));

  return { code, lines, stdout };
}

beforeAll(async () => {
  db = await createTestDatabase("keys_cli");
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("keys CLI", () => {
  test("rewrap moves keys to the new KEK; the old KEK can then be removed", async () => {
    const old = new DataKeyStore({ pool, provider: new LocalKeyring(k1), cacheTtlMs: 0 });
    const key = await old.getOrCreate("workspace", "ws_cli", "ws_cli");

    const result = await runCli(["rewrap", "--batch", "1"], {
      DATABASE_URL: db.url,
      KEYRING_FILE: ringFile("k2.json", k2),
    });

    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      { event: "keys.rewrap", activeKek: "k2", rewrapped: 1, failedCount: 0, failed: [] },
    ]);

    const k2Only = new DataKeyStore({
      pool,
      provider: new LocalKeyring({ active: "k2", keys: { k2: k2.keys.k2 ?? "" } }),
      cacheTtlMs: 0,
    });

    expect(Buffer.from(await k2Only.get("workspace", "ws_cli"))).toEqual(Buffer.from(key));
    expect(result.stdout).not.toContain(Buffer.from(key).toString("hex"));
    expect(result.stdout).not.toContain(k2.keys.k2);
  });

  test("takes the database password from a file when the URL carries none", async () => {
    const url = new URL(db.url);
    const passwordFile = join(dir, "db-password");
    writeFileSync(passwordFile, `${url.password}\n`, { mode: 0o600 });
    url.password = "";
    const env = { DATABASE_URL: url.toString(), KEYRING_FILE: ringFile("k2-file.json", k2) };
    const result = await runCli(["rewrap"], { ...env, DATABASE_PASSWORD_FILE: passwordFile });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatchObject({ event: "keys.rewrap", failedCount: 0 });

    const unreadable = await runCli(["rewrap"], {
      ...env,
      DATABASE_PASSWORD_FILE: join(dir, "no-such-file"),
    });

    expect(unreadable.code).toBe(1);
    expect(unreadable.lines[0]).toMatchObject({ message: "DATABASE_PASSWORD_FILE cannot be read" });
  });

  test("rewrap exits 2 and lists rows it could not unwrap", async () => {
    const store = new DataKeyStore({ pool, provider: new LocalKeyring(k2), cacheTtlMs: 0 });
    await store.getOrCreate("run", "wrun_bad");
    await pool.query(
      "UPDATE os_keys.data_keys SET wrapped_key = set_byte(wrapped_key, 15, get_byte(wrapped_key, 15) # 1) WHERE key_id = 'wrun_bad'",
    );

    const k3: KeyringFile = {
      active: "k3",
      keys: { ...k2.keys, k3: randomBytes(32).toString("base64") },
    };

    const result = await runCli(["rewrap"], {
      DATABASE_URL: db.url,
      KEYRING_FILE: ringFile("k3.json", k3),
    });

    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatchObject({
      event: "keys.rewrap",
      failedCount: 1,
      failed: ["run:wrun_bad"],
    });
  });

  test("shred destroys a key, and a second shred reports that nothing was live", async () => {
    const store = new DataKeyStore({ pool, provider: new LocalKeyring(k2), cacheTtlMs: 0 });
    await store.getOrCreate("run", "wrun_shred");
    const env = { DATABASE_URL: db.url, KEYRING_FILE: ringFile("k2-shred.json", k2) };
    const first = await runCli(["shred", "run", "wrun_shred"], env);
    expect(first.code).toBe(0);
    expect(first.lines).toEqual([
      { event: "keys.shred", scope: "run", id: "wrun_shred", shredded: true },
    ]);
    await expect(store.get("run", "wrun_shred")).rejects.toBeInstanceOf(DataKeyUnavailableError);
    const again = await runCli(["shred", "run", "wrun_shred"], env);
    expect(again.code).toBe(3);
    expect(again.lines[0]).toMatchObject({ shredded: false });
  });

  test("shred-tenant destroys one tenant's run keys, and a repeat exits 0 with 0", async () => {
    const store = new DataKeyStore({ pool, provider: new LocalKeyring(k2), cacheTtlMs: 0 });
    await store.getOrCreate("run", "wrun_ta1", "ws_ta");
    await store.getOrCreate("run", "wrun_ta2", "ws_ta");
    const other = await store.getOrCreate("run", "wrun_tb1", "ws_tb");
    const env = { DATABASE_URL: db.url, KEYRING_FILE: ringFile("k2-tenant.json", k2) };
    const first = await runCli(["shred-tenant", "run", "ws_ta"], env);
    expect(first.code).toBe(0);
    expect(first.lines).toEqual([
      { event: "keys.shred_tenant", scope: "run", tenantId: "ws_ta", shredded: 2 },
    ]);

    for (const id of ["wrun_ta1", "wrun_ta2"]) {
      await expect(store.get("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
      await expect(store.getOrCreate("run", id)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    }

    expect(Buffer.from(await store.get("run", "wrun_tb1"))).toEqual(Buffer.from(other));
    const again = await runCli(["shred-tenant", "run", "ws_ta"], env);
    expect(again.code).toBe(0);
    expect(again.lines).toEqual([
      { event: "keys.shred_tenant", scope: "run", tenantId: "ws_ta", shredded: 0 },
    ]);
  });

  test.each([
    [[]],
    [["rotate"]],
    [["shred", "run"]],
    [["shred", "table", "x"]],
    [["shred-tenant", "run"]],
    [["shred-tenant", "table", "ws_x"]],
    [["shred-tenant", "run", "ws_x", "extra"]],
    [["rewrap", "--batch", "0"]],
  ])("bad arguments %j exit 1 without touching the database", async (args) => {
    const result = await runCli(args, {
      DATABASE_URL: "postgres://unused@127.0.0.1:1/x",
      KEYRING_FILE: "/nonexistent",
    });

    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatchObject({ event: "keys.cli.usage_error" });
  });

  describe("with KEY_PROVIDER=openbao", () => {
    /** The environment the commands run with on OpenBao. */
    type OpenBaoEnv = {
      DATABASE_URL: string;
      KEY_PROVIDER: string;
      OPENBAO_ADDR: string;
      OPENBAO_AUTH: string;
      OPENBAO_TOKEN_FILE: string;
    };

    let stub: TransitStub;
    let baoDb: TestDatabase;
    let baoPool: pg.Pool;
    let env: OpenBaoEnv;

    beforeAll(async () => {
      stub = await startTransitStub();
      baoDb = await createTestDatabase("keys_cli_openbao");
      baoPool = new pg.Pool({ connectionString: baoDb.url, max: 2 });
      const tokenFile = join(dir, "bao-token");
      writeFileSync(tokenFile, stub.rootToken, { mode: 0o600 });
      env = {
        DATABASE_URL: baoDb.url,
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: stub.address.href,
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: tokenFile,
      };
    });

    afterAll(async () => {
      await baoPool.end();
      await baoDb.drop();
      await stub.close();
    });

    test("rewrap with the keyring file still set moves file keys to Transit", async () => {
      const fileStore = new DataKeyStore({ pool: baoPool, provider: new LocalKeyring(k1) });
      const key = await fileStore.getOrCreate("workspace", "ws_bao", "ws_bao");

      const result = await runCli(["rewrap"], {
        ...env,
        KEYRING_FILE: ringFile("k1-bao.json", k1),
      });

      expect(result.code).toBe(0);
      expect(result.lines).toEqual([
        {
          event: "keys.rewrap",
          activeKek: "bao:transit/os-kek@1",
          rewrapped: 1,
          failedCount: 0,
          failed: [],
        },
      ]);

      const transit = new TransitKeyProvider({
        address: stub.address,
        auth: { kind: "token", tokenFile: env.OPENBAO_TOKEN_FILE ?? "" },
        refreshSeconds: 0,
      });

      try {
        const transitOnly = new DataKeyStore({ pool: baoPool, provider: transit, cacheTtlMs: 0 });
        expect(Buffer.from(await transitOnly.get("workspace", "ws_bao"))).toEqual(Buffer.from(key));
      } finally {
        await transit.close();
      }
    });

    test("an unreachable OpenBao exits 4; shred-tenant needs no provider and exits 0", async () => {
      const down = { ...env, OPENBAO_ADDR: "http://127.0.0.1:1", OPENBAO_TIMEOUT_MS: "500" };
      const rewrap = await runCli(["rewrap"], down);
      expect(rewrap.code).toBe(4);
      expect(rewrap.lines).toEqual([
        {
          event: "keys.cli.provider_error",
          error: "KeyProviderUnavailableError",
          message: "openbao: the server could not be reached (ECONNREFUSED)",
        },
      ]);
      const shred = await runCli(["shred-tenant", "workspace", "ws_bao"], down);
      expect(shred.code).toBe(0);
      expect(shred.lines).toEqual([
        { event: "keys.shred_tenant", scope: "workspace", tenantId: "ws_bao", shredded: 1 },
      ]);
    });

    test("missing OpenBao settings exit 1 naming the variable", async () => {
      const result = await runCli(["rewrap"], { ...env, OPENBAO_ADDR: "" });
      expect(result.code).toBe(1);
      expect(result.lines).toEqual([
        { event: "keys.cli.usage_error", message: "OPENBAO_ADDR is not set" },
      ]);
    });
  });

  test("missing configuration and a broken keyring exit 1", async () => {
    const noEnv = await runCli(["rewrap"], {});
    expect(noEnv.code).toBe(1);
    expect(noEnv.lines[0]).toMatchObject({ message: "DATABASE_URL is not set" });
    const brokenPath = join(dir, "broken.json");
    writeFileSync(brokenPath, "{ not json");
    const broken = await runCli(["rewrap"], { DATABASE_URL: db.url, KEYRING_FILE: brokenPath });
    expect(broken.code).toBe(1);
    expect(broken.lines[0]).toMatchObject({ event: "keys.cli.keyring_error" });
  });
});
