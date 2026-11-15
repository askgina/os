/**
 * What an operator does once to an OpenBao for askgina/os, for `stack (openbao)`: service
 * `openbao-bootstrap` in `e2e/compose.openbao.yaml`, run by Node from the pinned image with no
 * dependencies on every `up`, before the server. Each step checks before it changes anything,
 * so running it again changes nothing.
 *
 * 1. Initialize OpenBao with one unseal key, kept with the root token in the `openbao-init`
 *    volume (`/state/init.json`). A test stack only: a real one keeps them with people.
 * 2. Unseal it (also after a restart, or in a restored copy of the stack) and wait until it
 *    is active.
 * 3. Enable Transit at `transit` with the AEAD key `os-kek`, write `deploy/openbao/policy.hcl`
 *    as the policy `os-server`, enable AppRole, and give the role `os-server` that policy alone.
 * 4. Hand the server its AppRole credentials as secrets: `openbao-role-id` and
 *    `openbao-secret-id` in its secrets volume, owned by the server's user, mode 0400. A secret
 *    id already there is kept.
 *
 * Prints one JSON line with what it did; never a key, a token or a secret id.
 */
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ADDRESS = process.env.OPENBAO_ADDR ?? "http://openbao:8200";
const STATE_DIR = "/state";
const STATE_FILE = join(STATE_DIR, "init.json");
const SERVER_SECRETS = "/secrets/server";
const POLICY_FILE = "/policy/policy.hcl";
const MOUNT = "transit";
const KEY = "os-kek";
const ROLE = "os-server";
/** The server's user in its image (`node`), as `deploy/init/init.mjs` uses. */
const NODE_UID = 1000;

interface Answer {
  status: number;
  body: unknown;
}

/** `value[name]` when `value` is an object, else undefined: answers are checked, not trusted. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Answer> {
  const response = await fetch(new URL(`/v1/${path}`, ADDRESS), {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { "x-vault-token": token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {}
  return { status: response.status, body: parsed };
}

/** OpenBao's own error texts; they name paths and reasons, never a secret. */
function errorsOf(answer: Answer): string {
  const errors = field(answer.body, "errors");
  return Array.isArray(errors) ? errors.join("; ") : "";
}

async function must(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Answer> {
  const answer = await call(method, path, token, body);
  if (answer.status >= 300) {
    throw new Error(`${method} ${path}: ${answer.status} ${errorsOf(answer)}`);
  }
  return answer;
}

/** Enable a secrets engine or auth method; one already at that path is left as it is. */
async function enable(path: string, type: string, token: string): Promise<boolean> {
  const answer = await call("POST", path, token, { type });
  if (answer.status < 300) return true;
  if (answer.status === 400 && /already in use/.test(errorsOf(answer))) return false;
  throw new Error(`POST ${path}: ${answer.status} ${errorsOf(answer)}`);
}

/** Retry `check` every half second until it is true, or fail after `seconds`. */
async function until(what: string, seconds: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${seconds} seconds`);
    await delay(500);
  }
}

/** Write a file the server reads: replaced whole, never half written, readable by it alone. */
function writeSecret(name: string, value: string): boolean {
  const path = join(SERVER_SECRETS, name);
  if (existsSync(path) && readFileSync(path, "utf8") === value) return false;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value, { mode: 0o400 });
  chownSync(temporary, NODE_UID, NODE_UID);
  chmodSync(temporary, 0o400);
  renameSync(temporary, path);
  return true;
}

async function main(): Promise<void> {
  // Any answer will do: uninitialized and sealed answer too.
  await until("OpenBao did not answer", 120, async () => {
    const answer = await call("GET", "sys/health?uninitcode=200&sealedcode=200&standbycode=200");
    return answer.status === 200;
  });

  let initializedNow = false;
  const { body: init } = await call("GET", "sys/init");
  if (field(init, "initialized") !== true) {
    const { body } = await must("PUT", "sys/init", undefined, {
      secret_shares: 1,
      secret_threshold: 1,
    });
    const keys = field(body, "keys_base64");
    const rootToken = field(body, "root_token");
    if (!Array.isArray(keys) || typeof keys[0] !== "string" || typeof rootToken !== "string") {
      throw new Error("sys/init answered without an unseal key and a root token");
    }
    const state = { unsealKey: keys[0], rootToken };
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    chmodSync(STATE_DIR, 0o700);
    initializedNow = true;
  }
  if (!existsSync(STATE_FILE)) {
    throw new Error(`OpenBao is initialized, but ${STATE_FILE} is missing: it cannot be unsealed`);
  }
  const saved: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const unsealKey = field(saved, "unsealKey");
  const token = field(saved, "rootToken");
  if (typeof unsealKey !== "string" || typeof token !== "string") {
    throw new Error(`${STATE_FILE} holds no unseal key and root token`);
  }

  let unsealedNow = false;
  const { body: seal } = await call("GET", "sys/seal-status");
  if (field(seal, "sealed") !== false) {
    const { body } = await must("PUT", "sys/unseal", undefined, { key: unsealKey });
    if (field(body, "sealed") !== false) {
      throw new Error("OpenBao is still sealed after its unseal key");
    }
    unsealedNow = true;
  }
  // Raft elects this single node its leader a moment after the unseal.
  await until("OpenBao did not become active", 120, async () => {
    return (await call("GET", "sys/health")).status === 200;
  });

  const transitEnabled = await enable(`sys/mounts/${MOUNT}`, "transit", token);
  let keyCreated = false;
  if ((await call("GET", `${MOUNT}/keys/${KEY}`, token)).status === 404) {
    await must("POST", `${MOUNT}/keys/${KEY}`, token, { type: "aes256-gcm96" });
    keyCreated = true;
  }
  await must("PUT", `sys/policies/acl/${ROLE}`, token, {
    policy: readFileSync(POLICY_FILE, "utf8"),
  });
  const approleEnabled = await enable("sys/auth/approle", "approle", token);
  await must("POST", `auth/approle/role/${ROLE}`, token, {
    token_policies: [ROLE],
    token_ttl: "1h",
    token_max_ttl: "24h",
  });
  const { body: roleIdAnswer } = await must("GET", `auth/approle/role/${ROLE}/role-id`, token);
  const roleId = field(field(roleIdAnswer, "data"), "role_id");
  if (typeof roleId !== "string") throw new Error("the role has no role id");
  const roleIdWritten = writeSecret("openbao-role-id", roleId);
  let secretIdWritten = false;
  if (!existsSync(join(SERVER_SECRETS, "openbao-secret-id"))) {
    const { body } = await must("POST", `auth/approle/role/${ROLE}/secret-id`, token);
    const secretId = field(field(body, "data"), "secret_id");
    if (typeof secretId !== "string") throw new Error("the role gave no secret id");
    secretIdWritten = writeSecret("openbao-secret-id", secretId);
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "openbao.bootstrap",
      initializedNow,
      unsealedNow,
      transitEnabled,
      keyCreated,
      approleEnabled,
      roleIdWritten,
      secretIdWritten,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      event: "openbao.bootstrap_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
