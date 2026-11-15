// The real OpenBao dev server from `deploy/compose.test.yaml` (service `openbao`), for the tests
// that must run against it in CI. Each caller gets its own Transit mount and AppRole, so files
// do not share state; pausing the container pauses it for everyone.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

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

/** Freeze the OpenBao container: connections open, nothing answers. */
export async function pauseOpenBao(): Promise<void> {
  await execFileAsync("docker", ["pause", CONTAINER]);
}

export async function unpauseOpenBao(): Promise<void> {
  await execFileAsync("docker", ["unpause", CONTAINER]);
}
