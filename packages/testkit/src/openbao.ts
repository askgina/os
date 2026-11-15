// The real OpenBao dev server from `deploy/compose.test.yaml` (service `openbao`), for the tests
// that must run against it in CI. Each caller gets its own Transit mount and AppRole, so files
// do not share state; pausing the container pauses it for everyone, so every file that uses the
// server holds {@link holdOpenBao} for as long as it does.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { TEST_POSTGRES_URL } from "./postgres.ts";

const execFileAsync = promisify(execFile);

export const OPENBAO_TEST_ADDR = process.env.OPENBAO_TEST_ADDR ?? "http://127.0.0.1:55820";
const ROOT_TOKEN = process.env.OPENBAO_TEST_ROOT_TOKEN ?? "test-root";
const CONTAINER = process.env.OPENBAO_TEST_CONTAINER ?? "os-test-openbao-1";

async function bao(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(`/v1/${path}`, OPENBAO_TEST_ADDR), {
    method,
    headers: { "x-vault-token": ROOT_TOKEN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`openbao test setup: ${method} ${path}: ${response.status} ${text}`);
  return text === "" ? undefined : JSON.parse(text);
}

/** Whether the test server answers; used to skip outside CI when it is not running. */
export async function openBaoReachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/v1/sys/health", OPENBAO_TEST_ADDR), {
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** The advisory lock id, on the test Postgres, that stands for the one OpenBao test server. */
const OPENBAO_LOCK = 0x0b_a0_7e_57;
const LOCK_APPLICATION_PREFIX = "openbao-test-lock:";

/**
 * Hold the OpenBao test server for one test file (or section), across Vitest workers and
 * projects: a session advisory lock on the test Postgres. Vitest runs files of different
 * packages at once, and one file's `docker pause` (or `docker unpause`) would break another's
 * cases. Waits up to `timeoutMs` for the current holder, then fails naming it. The lock goes
 * with the connection, so a crashed test process releases it too. Call the returned function
 * in `afterAll` or `finally`; it is safe to call twice.
 */
export async function holdOpenBao(
  holder: string,
  timeoutMs = 300_000,
): Promise<() => Promise<void>> {
  const client = new pg.Client({
    connectionString: TEST_POSTGRES_URL,
    application_name: `${LOCK_APPLICATION_PREFIX}${holder}`.slice(0, 63),
  });
  // A lost connection only means the lock is gone; the holder's own cases then fail on their own.
  client.on("error", () => {});
  await client.connect();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [OPENBAO_LOCK],
      );
      if (rows[0]?.locked) break;
      if (Date.now() > deadline) {
        const current = await client.query<{ application_name: string; pid: number }>(
          `SELECT a.application_name, a.pid FROM pg_locks l
             JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND l.objid = $1`,
          [OPENBAO_LOCK],
        );
        const who = current.rows
          .map(
            (row) =>
              `${row.application_name.slice(LOCK_APPLICATION_PREFIX.length)} (pid ${row.pid})`,
          )
          .join(", ");
        throw new Error(
          `${holder}: the OpenBao test server is still held after ${timeoutMs} ms by ${who || "a holder that has since left"}; it should hold it for one file at most`,
        );
      }
      await delay(250);
    }
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [OPENBAO_LOCK]);
    } finally {
      await client.end().catch(() => {});
    }
  };
}

/**
 * The least privilege the server needs on its Transit key: what `deploy/openbao/policy.hcl`
 * grants. Token lookup and renewal come from OpenBao's `default` policy.
 */
export function transitPolicy(mount: string, key: string): string {
  return [
    `path "${mount}/encrypt/${key}" { capabilities = ["update"] }`,
    `path "${mount}/decrypt/${key}" { capabilities = ["update"] }`,
    `path "${mount}/keys/${key}" { capabilities = ["read"] }`,
  ].join("\n");
}

export interface PreparedTransit {
  mount: string;
  key: string;
  roleId: string;
  secretId: string;
  rotate(): Promise<void>;
  setMinDecryptionVersion(version: number): Promise<void>;
}

/** A fresh Transit mount and key, and an AppRole limited to {@link transitPolicy}. */
export async function prepareTransit(): Promise<PreparedTransit> {
  const suffix = randomBytes(5).toString("hex");
  const mount = `transit-${suffix}`;
  const key = "os-kek";
  const role = `os-server-${suffix}`;
  await bao("POST", `sys/mounts/${mount}`, { type: "transit" });
  await bao("POST", `${mount}/keys/${key}`, { type: "aes256-gcm96" });
  try {
    await bao("POST", "sys/auth/approle", { type: "approle" });
  } catch (error) {
    // Enabled by an earlier run or file; any other failure surfaces at the role below.
    if (!/400/.test((error as Error).message)) throw error;
  }
  await bao("PUT", `sys/policies/acl/${role}`, { policy: transitPolicy(mount, key) });
  await bao("POST", `auth/approle/role/${role}`, { token_policies: [role], token_ttl: "1h" });
  const roleId = (
    (await bao("GET", `auth/approle/role/${role}/role-id`)) as { data: { role_id: string } }
  ).data.role_id;
  const secretId = (
    (await bao("POST", `auth/approle/role/${role}/secret-id`)) as { data: { secret_id: string } }
  ).data.secret_id;
  return {
    mount,
    key,
    roleId,
    secretId,
    async rotate() {
      await bao("POST", `${mount}/keys/${key}/rotate`);
    },
    async setMinDecryptionVersion(version) {
      await bao("POST", `${mount}/keys/${key}/config`, { min_decryption_version: version });
    },
  };
}

/** Freeze the OpenBao container: connections open, nothing answers. Hold {@link holdOpenBao}. */
export async function pauseOpenBao(): Promise<void> {
  await execFileAsync("docker", ["pause", CONTAINER]);
}

export async function unpauseOpenBao(): Promise<void> {
  await execFileAsync("docker", ["unpause", CONTAINER]);
}
