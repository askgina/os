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
 * Prints a JSON line as each step starts and one with what it did, or one naming the step that
 * failed; never a key, a token or a secret id.
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
/** Everything together; `e2e/run.sh` waits 300 seconds for the whole stack. */
const OVERALL_MS = 240_000;
const deadline = Date.now() + OVERALL_MS;
/**
 * The first initialization bootstraps Raft, and this single node waits out an election timeout
 * (5 seconds) before it leads and can answer; the server itself gives up on a request after 90.
 */
const INIT_TIMEOUT_MS = 100_000;
/** An unseal, a health check, a configuration call. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;

let step = "start";

/** Name the step that runs now, on stdout, so a failure names it too. */
function begin(name: string): void {
  step = name;
  process.stdout.write(`${JSON.stringify({ event: "openbao.bootstrap_step", step })}\n`);
}

interface Answer {
  status: number;
  body: unknown;
}

/** `value[name]` when `value` is an object, else undefined: answers are checked, not trusted. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Whether a failed fetch never reached OpenBao: nothing listens yet, or its name does not resolve
 * yet. Only then is any request, even one that changes something, safe to send again.
 */
function neverArrived(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const codes = [field(cause, "code")];
  const inner = field(cause, "errors");
  if (Array.isArray(inner)) codes.push(...inner.map((each) => field(each, "code")));
  return codes.some(
    (code) => code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN",
  );
}

/**
 * One call to OpenBao, sent again while it cannot reach OpenBao at all, until the overall
 * deadline. A call that reached it and got no answer within `timeoutMs` fails: it may have
 * taken effect.
 */
async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<Answer> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${method} ${path}: OpenBao unreachable until the deadline`);
    const allowed = Math.min(timeoutMs, left);
    let response: Response;
    try {
      response = await fetch(new URL(`/v1/${path}`, ADDRESS), {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.token === undefined ? {} : { "x-vault-token": options.token }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(allowed),
      });
    } catch (error) {
      if (neverArrived(error)) {
        await delay(500);
        continue;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`${method} ${path}: no answer within ${allowed} ms`);
      }
      throw new Error(`${method} ${path}: ${error instanceof Error ? error.message : error}`);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {}
    return { status: response.status, body: parsed };
  }
}

/** OpenBao's own error texts; they name paths and reasons, never a secret. */
function errorsOf(answer: Answer): string {
  const errors = field(answer.body, "errors");
  return Array.isArray(errors) ? errors.join("; ") : "";
}

async function must(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<Answer> {
  const answer = await call(method, path, options);
  if (answer.status >= 300) {
    throw new Error(`${method} ${path}: ${answer.status} ${errorsOf(answer)}`);
  }
  return answer;
}

/** Enable a secrets engine or auth method; one already at that path is left as it is. */
async function enable(path: string, type: string, token: string): Promise<boolean> {
  const answer = await call("POST", path, { token, body: { type } });
  if (answer.status < 300) return true;
  if (answer.status === 400 && /already in use/.test(errorsOf(answer))) return false;
  throw new Error(`POST ${path}: ${answer.status} ${errorsOf(answer)}`);
}

/**
 * Ask `check` every half second until it is true, or fail at the overall deadline with what it
 * last answered or threw.
 */
async function until(what: string, check: () => Promise<boolean | string>): Promise<void> {
  let last = "nothing yet";
  for (;;) {
    try {
      const outcome = await check();
      if (outcome === true) return;
      last = outcome === false ? "not yet" : outcome;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`${what} before the deadline; last: ${last}`);
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
  begin("wait-for-answer");
  // Any answer will do: uninitialized and sealed answer too.
  await until("OpenBao did not answer", async () => {
    const answer = await call("GET", "sys/health?uninitcode=200&sealedcode=200&standbycode=200", {
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    return answer.status === 200 || `status ${answer.status}`;
  });

  begin("init");
  let initializedNow = false;
  const { body: init } = await must("GET", "sys/init");
  if (field(init, "initialized") !== true) {
    // Sent once: should its answer be lost, so is the unseal key, and only `down -v` helps.
    const { body } = await must("PUT", "sys/init", {
      body: { secret_shares: 1, secret_threshold: 1 },
      timeoutMs: INIT_TIMEOUT_MS,
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

  begin("unseal");
  let unsealedNow = false;
  // Giving the key again is harmless, so a lost answer is simply asked again.
  await until("OpenBao did not unseal", async () => {
    const { body: seal } = await must("GET", "sys/seal-status");
    if (field(seal, "sealed") === false) return true;
    const { body } = await must("PUT", "sys/unseal", { body: { key: unsealKey } });
    unsealedNow = true;
    return field(body, "sealed") === false || "still sealed";
  });

  begin("wait-active");
  // Raft elects this single node its leader again after each unseal.
  await until("OpenBao did not become active", async () => {
    const { status } = await call("GET", "sys/health", { timeoutMs: HEALTH_TIMEOUT_MS });
    return status === 200 || `status ${status}`;
  });

  begin("transit");
  const transitEnabled = await enable(`sys/mounts/${MOUNT}`, "transit", token);
  let keyCreated = false;
  if ((await call("GET", `${MOUNT}/keys/${KEY}`, { token })).status === 404) {
    await must("POST", `${MOUNT}/keys/${KEY}`, { token, body: { type: "aes256-gcm96" } });
    keyCreated = true;
  }

  begin("policy");
  await must("PUT", `sys/policies/acl/${ROLE}`, {
    token,
    body: { policy: readFileSync(POLICY_FILE, "utf8") },
  });

  begin("approle");
  const approleEnabled = await enable("sys/auth/approle", "approle", token);
  await must("POST", `auth/approle/role/${ROLE}`, {
    token,
    body: { token_policies: [ROLE], token_ttl: "1h", token_max_ttl: "24h" },
  });

  begin("credentials");
  const { body: roleIdAnswer } = await must("GET", `auth/approle/role/${ROLE}/role-id`, { token });
  const roleId = field(field(roleIdAnswer, "data"), "role_id");
  if (typeof roleId !== "string") throw new Error("the role has no role id");
  const roleIdWritten = writeSecret("openbao-role-id", roleId);
  let secretIdWritten = false;
  if (!existsSync(join(SERVER_SECRETS, "openbao-secret-id"))) {
    const { body } = await must("POST", `auth/approle/role/${ROLE}/secret-id`, { token });
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
      step,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
