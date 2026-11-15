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
  /** The webhook receiver `e2e/compose.e2e.yaml` runs next to the stack, through its port. */
  webhookReceiverUrl: `http://127.0.0.1:${Number(process.env.E2E_WEBHOOK_PORT ?? 55904)}`,
};

/**
 * `E2E_SPLIT=1` (`e2e/run.sh`): the signer, its confirmation page and that page's edge run as a
 * second Compose project, {@link signerProject}, from `deploy/split/signer.compose.yaml`, as on
 * a host of their own; the control plane runs from `deploy/split/control.compose.yaml`. The two
 * projects share one network, which only the server and the signer join.
 */
const SPLIT = process.env.E2E_SPLIT === "1";

/** The project the signer runs in: the stack's own, or its second one when split. */
export function signerProject(): string {
  return SPLIT ? `${stack.project}-signer` : stack.project;
}

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

type Side = "control" | "signer";

/**
 * The services each project of a split stack starts. Both have a `caddy`: the signer project's
 * is the confirmation page's edge. A command that names `caddy` acts on the control project's.
 */
const SPLIT_SERVICES: Record<Side, string[]> = {
  control: ["postgres", "server", "caddy", "agent-gateway", "anvil"],
  signer: ["signer", "approve", "caddy"],
};
/** Services of the signer project; every other name is the control project's. */
const SIGNER_SIDE = ["signer", "approve"];
/** Every service name a command may mention. */
const SERVICE_NAMES = new Set([
  ...SPLIT_SERVICES.control,
  ...SIGNER_SIDE,
  "init",
  "webhook-receiver",
  "scripted-agent",
]);
/** The state volumes of {@link VOLUMES} that live in the signer project of a split stack. */
const SIGNER_VOLUMES = ["signer-data", "signer-secrets"];

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
export const HELPER_IMAGE =
  "node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc";

/** Run `docker ...` and return its stdout. */
export async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The project and the files of one side of the stack; there is one side unless split. */
function projectArgs(side: Side): string[] {
  const profiles = ["--profile", "dev", "--profile", "agent"];
  if (!SPLIT) {
    const files = ["-f", join(ROOT, "compose.yaml"), "-f", join(ROOT, "e2e", "compose.e2e.yaml")];
    return ["-p", stack.project, ...files, ...profiles];
  }
  if (side === "signer") {
    const files = [
      ["-f", join(ROOT, "deploy", "split", "signer.compose.yaml")],
      ["-f", join(ROOT, "e2e", "compose.split-signer.yaml")],
    ];
    return ["-p", signerProject(), ...files.flat()];
  }
  const files = [
    ["-f", join(ROOT, "deploy", "split", "control.compose.yaml")],
    ["-f", join(ROOT, "e2e", "compose.split-control.yaml")],
  ];
  return ["-p", stack.project, ...files.flat(), ...profiles];
}

/**
 * The sides a Compose command acts on, each with its own arguments. Unless split, the one
 * project. Split: `exec` and `run` go where their service runs; any other command goes to each
 * project with the services it runs, or to both when it names none (`down`). The signer
 * project comes first, so it is up before the server needs it.
 */
function bySide(args: string[]): [Side, string[]][] {
  if (!SPLIT) return [["control", args]];
  const [command, ...rest] = args;
  const named = rest.filter((arg) => SERVICE_NAMES.has(arg));
  if (command === "exec" || command === "run") {
    return [[SIGNER_SIDE.includes(named[0] ?? "") ? "signer" : "control", args]];
  }
  if (named.length === 0) {
    return [
      ["signer", args],
      ["control", args],
    ];
  }
  const sides: [Side, string[]][] = [];
  for (const side of ["signer", "control"] as const) {
    const other = (arg: string) =>
      SERVICE_NAMES.has(arg) && SIGNER_SIDE.includes(arg) !== (side === "signer");
    if (named.some((name) => !other(name))) sides.push([side, args.filter((arg) => !other(arg))]);
  }
  return sides;
}

/**
 * The full `docker` argument list for a Compose command against the project that runs its
 * service. Split, a command for services of both projects needs {@link compose}.
 */
export function composeArgs(...args: string[]): string[] {
  const sides = bySide(args);
  const [first] = sides;
  if (sides.length !== 1 || first === undefined) {
    throw new Error(`one Compose command cannot act on both projects: ${args.join(" ")}`);
  }
  return ["compose", ...projectArgs(first[0]), ...first[1]];
}

/** Run `docker compose ...` against the project, or each project, it acts on; joins stdout. */
export async function compose(...args: string[]): Promise<string> {
  let output = "";
  for (const [side, sideArgs] of bySide(args)) {
    output += await docker("compose", ...projectArgs(side), ...sideArgs);
  }
  return output;
}

/** Run `docker compose ...` against one side of the stack, the one project unless split. */
function composeIn(side: Side, ...args: string[]): Promise<string> {
  return docker("compose", ...projectArgs(side), ...args);
}

/** Each side of the stack, the signer's first: one unless split. */
const SIDES: Side[] = SPLIT ? ["signer", "control"] : ["control"];

/** The services `up` starts on one side. */
function servicesOn(side: Side): string[] {
  return SPLIT ? SPLIT_SERVICES[side] : SERVICES;
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
  const stateful = (side: Side) => servicesOn(side).filter((service) => service !== "anvil");
  for (const side of SIDES) await composeIn(side, "stop", ...stateful(side));
  for (const volume of VOLUMES) {
    // Split, the signer's volumes are in its own project, and so are their copies.
    const signerSide = SPLIT && SIGNER_VOLUMES.includes(volume);
    const from = signerSide ? signerProject() : stack.project;
    const to = signerSide ? `${project}-signer` : project;
    await docker(
      "run",
      "--rm",
      "-v",
      `${from}_${volume}:/from:ro`,
      "-v",
      `${to}_${volume}:/to`,
      HELPER_IMAGE,
      "cp",
      "-a",
      "/from/.",
      "/to/",
    );
  }
  for (const side of SIDES) {
    await composeIn(side, "up", "-d", "--wait", "--wait-timeout", "300", ...stateful(side));
  }
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
  for (const side of SIDES) await composeIn(side, "down", "--remove-orphans");
  stack.project = project;
  const output = await compose("run", "--rm", "signer", "node", "src/admin.ts", "fence");
  const line = JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
    ok: boolean;
    fenceAt: number;
  };
  if (!line.ok) throw new Error("the restored signer could not be fenced");
  for (const side of SIDES) {
    await composeIn(side, "up", "-d", "--wait", "--wait-timeout", "300", ...servicesOn(side));
  }
  await waitUntilHealthy();
  return line.fenceAt;
}
