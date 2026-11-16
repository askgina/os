import { execFile, spawn } from "node:child_process";
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
  /** OpenBao, with `E2E_OPENBAO=1`, through the port `e2e/compose.openbao.yaml` publishes. */
  openBaoUrl: `http://127.0.0.1:${Number(process.env.E2E_OPENBAO_PORT ?? 55905)}`,
  /**
   * The fake Hyperliquid testnet venue, with `E2E_VENUE=1`, through the port
   * `e2e/compose.venue.yaml` publishes on the host's loopback.
   */
  venueUrl: `http://127.0.0.1:${Number(process.env.E2E_VENUE_PORT ?? 55906)}`,
  /** The fake Hyperliquid mainnet venue, with `E2E_VENUE=1`, the same way. */
  venueMainnetUrl: `http://127.0.0.1:${Number(process.env.E2E_VENUE_MAINNET_PORT ?? 55907)}`,
};

/** `E2E_REPLICAS=1` (`e2e/run.sh`): two server replicas, from `e2e/compose.replicas.yaml`. */
const REPLICAS = process.env.E2E_REPLICAS === "1";

/** `E2E_OPENBAO=1` (`e2e/run.sh`): keys in OpenBao Transit, from `e2e/compose.openbao.yaml`. */
const OPENBAO = process.env.E2E_OPENBAO === "1";

/**
 * `E2E_VENUE=1` (`e2e/run.sh`, the venue gates' own stack): the fake Hyperliquid testnet and
 * mainnet venues and the server's `VENUES_FILE` naming both, from `e2e/compose.venue.yaml`.
 */
const VENUE = process.env.E2E_VENUE === "1";

/**
 * `E2E_LIFECYCLE=1` (`e2e/run.sh`, the lifecycle gates' own stack): Web Push on, from
 * `e2e/compose.lifecycle.yaml`, so erasing a person can remove a device they added.
 */
const LIFECYCLE = process.env.E2E_LIFECYCLE === "1";

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
  ...(OPENBAO ? ["openbao"] : []),
  ...(VENUE ? ["fake-hyperliquid", "fake-hyperliquid-mainnet"] : []),
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
  "openbao",
  "openbao-bootstrap",
  "fake-hyperliquid",
  "fake-hyperliquid-mainnet",
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
  // OpenBao's storage and the unseal key that opens it: a restored copy must find both.
  ...(OPENBAO ? ["openbao-data", "openbao-init"] : []),
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
    const files = [
      ["-f", join(ROOT, "compose.yaml")],
      ["-f", join(ROOT, "e2e", "compose.e2e.yaml")],
      REPLICAS ? ["-f", join(ROOT, "e2e", "compose.replicas.yaml")] : [],
      OPENBAO ? ["-f", join(ROOT, "e2e", "compose.openbao.yaml")] : [],
      VENUE ? ["-f", join(ROOT, "e2e", "compose.venue.yaml")] : [],
      LIFECYCLE ? ["-f", join(ROOT, "e2e", "compose.lifecycle.yaml")] : [],
    ];

    return ["-p", stack.project, ...files.flat(), ...profiles];
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

/**
 * Run a command inside a running service container with `input` on its stdin, and report its
 * exit code and what it printed: an operator's command answers with both, so a non-zero exit is
 * not an error here. Docker's own messages go to stderr and are kept apart, as in
 * {@link fromAgentsNetwork}.
 */
export function execWithInput(
  service: string,
  input: string,
  ...command: string[]
): Promise<{ exitCode: number; output: string; diagnostics: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    exitCode: number;
    output: string;
    diagnostics: string;
  }>();

  const child = spawn("docker", composeArgs("exec", "-T", service, ...command), { cwd: ROOT });
  let output = "";
  let diagnostics = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ exitCode: code ?? 1, output, diagnostics }));
  child.stdin.end(input);

  return promise;
}

/**
 * A new setup token from the operator's command, run in a server container as the README says.
 * Every call replaces the token before it.
 */
export async function setupToken(): Promise<string> {
  const printed = await exec("server", "node", "apps/server/src/cli.ts", "setup-token");
  const answer: unknown = JSON.parse(printed.trim().split("\n").at(-1) ?? "null");
  const token = (answer as { setupToken?: unknown } | null)?.setupToken;

  if (typeof token !== "string") throw new Error(`setup-token answered ${printed.trim()}`);

  return token;
}

/**
 * The containers of one service of the stack's project, running or stopped, by name, in order:
 * `<project>-server-1`, `<project>-server-2` with two replicas. Not for a split stack.
 */
export async function containersOf(service: string): Promise<string[]> {
  const output = await docker(
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${stack.project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.Names}}",
  );

  return output
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .sort();
}

/** Everything one container wrote to stdout, every start of it included: the server's log. */
export function containerLogs(container: string): Promise<string> {
  return docker("logs", container);
}

/**
 * Kill one container as a crash would and return once it has stopped, as the release gates kill
 * the server: `kill` returns before that, and `stop` also keeps its restart policy from
 * starting it again.
 */
export async function killContainer(container: string): Promise<void> {
  await docker("kill", container);
  await docker("stop", "--timeout", "0", container);
}

/** Run a command in one container, chosen by name: one replica rather than its service. */
export function execIn(container: string, ...command: string[]): Promise<string> {
  return docker("exec", container, ...command);
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
