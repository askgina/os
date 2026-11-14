import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");

/** Where the stack under test lives. `e2e/run.sh` starts it with exactly these values. */
export const stack = {
  /** The Compose project the helpers act on. The backup gate switches it to the restored copy. */
  project: process.env.E2E_PROJECT ?? "os-e2e",
  origin: process.env.E2E_ORIGIN ?? "http://localhost:55902",
  /** The signer's confirmation page, on its own origin. */
  approveOrigin: process.env.APPROVE_ORIGIN ?? "http://localhost:55903",
  postgresPort: Number(process.env.E2E_POSTGRES_PORT ?? 55900),
  anvilUrl: process.env.E2E_ANVIL_URL ?? "http://127.0.0.1:55901",
};

/** The services `up` starts. `init` runs once and exits; the others depend on it. */
export const SERVICES = [
  "postgres",
  "signer",
  "approve",
  "server",
  "caddy",
  "agent-gateway",
  "anvil",
];

/**
 * Every volume that holds state, by its name in `compose.yaml`. `approve-secrets` is not one: it
 * holds a copy of a signer secret, which `init` writes again from `signer-secrets`.
 */
export const VOLUMES = [
  "postgres-data",
  "signer-data",
  "server-secrets",
  "signer-secrets",
  "db-secrets",
];

/**
 * The image for throwaway helper containers: the same pinned one `compose.yaml` uses for `init`,
 * so it is already present and nothing is pulled in the middle of a gate.
 */
const HELPER_IMAGE =
  "node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc";

/** Run `docker ...` and return its stdout. */
export async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The full `docker` argument list for a Compose command against the current project. */
export function composeArgs(...args: string[]): string[] {
  return [
    "compose",
    "-p",
    stack.project,
    "-f",
    join(ROOT, "compose.yaml"),
    "-f",
    join(ROOT, "e2e", "compose.e2e.yaml"),
    "--profile",
    "dev",
    "--profile",
    "agent",
    ...args,
  ];
}

/** Run `docker compose ...` against the current project and return its stdout. */
export function compose(...args: string[]): Promise<string> {
  return docker(...composeArgs(...args));
}

/** Run a command inside a running service container. */
export function exec(service: string, ...command: string[]): Promise<string> {
  return compose("exec", "-T", service, ...command);
}

/** The setup token the server printed on its first start. */
export async function setupToken(): Promise<string> {
  const logs = await compose("logs", "--no-color", "server");
  // Every start before setup prints a fresh token and retires the previous one: the last wins.
  const token = [...logs.matchAll(/setup token: ([A-Za-z0-9_-]{20,})/g)].at(-1)?.[1];
  if (!token) throw new Error("the server log has no setup token line");
  return token;
}

/** A connection string for the stack's Postgres, through the port the e2e overlay publishes. */
export async function databaseUrl(): Promise<string> {
  const password = (await exec("postgres", "cat", "/run/secrets/db/postgres-password")).trim();
  return `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${stack.postgresPort}/postgres`;
}

/**
 * Run a throwaway container on the internal `agents` network, the position a compromised agent
 * is in, and report what its script printed. Docker's own messages go to stderr and are kept
 * apart, so they can never be mistaken for the script's answer.
 */
export async function fromAgentsNetwork(
  script: string,
): Promise<{ exitCode: number; output: string; diagnostics: string }> {
  try {
    const { stdout, stderr } = await run(
      "docker",
      ["run", "--rm", "--network", `${stack.project}_agents`, HELPER_IMAGE, "node", "-e", script],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return { exitCode: 0, output: stdout, diagnostics: stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: failure.stdout ?? "",
      diagnostics: failure.stderr ?? "",
    };
  }
}

/** Wait until the stack answers its health check through the public proxy. */
export async function waitUntilHealthy(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const healthy = await fetch(`${stack.origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    if (Date.now() > deadline) throw new Error("the stack did not become healthy in time");
    await delay(500);
  }
}

/**
 * Back up every state volume of the running project into the volumes of another project name,
 * as the deploy guide says: with every service that holds state stopped. The chain is not part
 * of a backup and keeps running, so the stack goes on with the same chain afterwards.
 */
export async function backUpInto(project: string): Promise<void> {
  const stateful = SERVICES.filter((service) => service !== "anvil");
  await compose("stop", ...stateful);
  for (const volume of VOLUMES) {
    await docker(
      "run",
      "--rm",
      "-v",
      `${stack.project}_${volume}:/from:ro`,
      "-v",
      `${project}_${volume}:/to`,
      HELPER_IMAGE,
      "cp",
      "-a",
      "/from/.",
      "/to/",
    );
  }
  await compose("up", "-d", "--wait", "--wait-timeout", "300", ...stateful);
  await waitUntilHealthy();
}

/**
 * Restore a backup made by {@link backUpInto} the way an operator restores onto a fresh machine:
 * remove the running stack, fence the restored signer before it serves (`admin.ts fence`, as the
 * deploy guide says), then start the copy. The restored stack gets a fresh local chain. Returns
 * the fence the signer set, in seconds since the Unix epoch.
 */
export async function restoreFrom(project: string): Promise<number> {
  // The original must release its published ports before the copy can take them.
  await compose("down", "--remove-orphans");
  stack.project = project;
  const output = await compose("run", "--rm", "signer", "node", "src/admin.ts", "fence");
  const line = JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
    ok: boolean;
    fenceAt: number;
  };
  if (!line.ok) throw new Error("the restored signer could not be fenced");
  await compose("up", "-d", "--wait", "--wait-timeout", "300", ...SERVICES);
  await waitUntilHealthy();
  return line.fenceAt;
}
