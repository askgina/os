import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DataKeyStore,
  DataKeyUnavailableError,
  type KeyringFile,
  LocalKeyring,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
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
    const failure = error as { code: number; stdout: string };
    code = failure.code;
    stdout = failure.stdout;
  }
  const lines = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  test.each([
    [[]],
    [["rotate"]],
    [["shred", "run"]],
    [["shred", "table", "x"]],
    [["rewrap", "--batch", "0"]],
  ])("bad arguments %j exit 1 without touching the database", async (args) => {
    const result = await runCli(args, {
      DATABASE_URL: "postgres://unused@127.0.0.1:1/x",
      KEYRING_FILE: "/nonexistent",
    });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatchObject({ event: "keys.cli.usage_error" });
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
