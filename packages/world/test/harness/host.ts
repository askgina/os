// Test-side control of proof host processes (server.ts) and of the databases they use.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { vi } from "vitest";

const execFileAsync = promisify(execFile);
const serverScript = fileURLToPath(new URL("./server.ts", import.meta.url));
const worldModule = fileURLToPath(new URL("./world.ts", import.meta.url));
const bootstrap = fileURLToPath(new URL("../../node_modules/.bin/bootstrap", import.meta.url));

export interface Host {
  process: ChildProcess;
  output(): string;
  call<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }>;
  kill(): Promise<void>;
}

const running = new Set<Host>();

/** Create upstream's schemas (workflow, graphile_worker, …) in a fresh database. */
export async function bootstrapWorkflowSchema(url: string): Promise<void> {
  await execFileAsync(bootstrap, [], { env: { ...process.env, WORKFLOW_POSTGRES_URL: url } });
}

/**
 * Start server.ts as a separate process and wait until its World has started. `env` selects the
 * key provider (see world.ts) and any other harness switch.
 */
export async function startHost(options: {
  port: number;
  databaseUrl: string;
  env: Record<string, string>;
}): Promise<Host> {
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: worldModule,
      WORKFLOW_POSTGRES_URL: options.databaseUrl,
      PORT: String(options.port),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = Promise.withResolvers<void>();
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("READY")) ready.resolve();
    else if (output.includes("START_FAILED"))
      ready.reject(new Error(`host failed to start: ${output.slice(-2000)}`));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("exit", (code, signal) =>
    ready.reject(new Error(`host exited before ready (${code ?? signal}): ${output.slice(-2000)}`)),
  );
  const base = `http://127.0.0.1:${options.port}`;
  const host: Host = {
    process: child,
    output: () => output,
    async call<T>(path: string, body?: unknown) {
      const response = await fetch(
        base + path,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      );
      return { status: response.status, json: (await response.json()) as T };
    },
    async kill() {
      running.delete(host);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGKILL");
      await exited.promise;
    },
  };
  running.add(host);
  await ready.promise;
  return host;
}

export async function killAllHosts(): Promise<void> {
  await Promise.all([...running].map((host) => host.kill()));
}

export async function sql<T extends pg.QueryResultRow>(
  url: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Wait until the run has created its hook, i.e. it is suspended waiting to be resumed. */
export async function waitForHook(url: string, token: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await sql(url, "SELECT 1 FROM workflow.workflow_hooks WHERE token = $1", [
        token,
      ]);
      if (rows.length === 0) throw new Error(`hook ${token} not created yet`);
    },
    { timeout: 60_000, interval: 200 },
  );
}
