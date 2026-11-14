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
  postgresPort: Number(process.env.E2E_POSTGRES_PORT ?? 55900),
  anvilUrl: process.env.E2E_ANVIL_URL ?? "http://127.0.0.1:55901",
};

/** The services `up` starts. `init` runs once and exits; the others depend on it. */
export const SERVICES = ["postgres", "signer", "server", "caddy", "agent-gateway", "anvil"];

/** Every volume that holds state, by its name in `compose.yaml`. */
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
 * Copy every state volume of the running project into the volumes of a new project name, the
 * way an operator restores a backup onto a fresh machine: stop everything, copy the volumes,
 * start the copy. The chain is not part of a backup; the restored stack gets a fresh local one.
 */
export async function restoreInto(project: string): Promise<void> {
  const source = stack.project;
  await compose("stop");
  for (const volume of VOLUMES) {
    await docker(
      "run",
      "--rm",
      "-v",
      `${source}_${volume}:/from:ro`,
      "-v",
      `${project}_${volume}:/to`,
      HELPER_IMAGE,
      "cp",
      "-a",
      "/from/.",
      "/to/",
    );
  }
  // The original must release its published ports before the copy can take them.
  await compose("down", "--remove-orphans");
  stack.project = project;
  await compose("up", "-d", "--wait", "--wait-timeout", "300", ...SERVICES);
  await waitUntilHealthy();
}
