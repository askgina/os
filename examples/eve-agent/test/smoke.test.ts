/**
 * The example's claim, end to end: an eve agent runs with no Vercel service on the encrypting
 * World, its one consequential act is a `propose_transfer` over MCP, and what it was told and
 * what it passed to that tool cannot be found in its database.
 *
 * The real gateway is replaced by a small MCP server with the two tools the agent uses, built
 * with the real SDK. The same run on the stock Postgres World is the control: if the scanner
 * cannot find the markers there, it is blind and this test proves nothing, so it fails.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LocalKeyring } from "@askgina/os-keys";
import { createTestDatabase, scanForMarkers, type TestDatabase } from "@askgina/os-testkit";
import { createWorld } from "@askgina/os-world/target";
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GatewayArguments } from "../lib/gateway.ts";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL("..", import.meta.url));

const BIN = join(HERE, "node_modules", ".bin");

const AGENT_PORT = 25801;

const TOKEN = `osa_${randomBytes(16).toString("hex")}`;

const PASSWORD = randomBytes(18).toString("base64url");

// The same list as `WORLD_READABLE_ATTRIBUTE_KEYS` in compose.yaml.
const READABLE_ATTRIBUTE_KEYS = [
  "$eve.type",
  "$eve.version",
  "$eve.session",
  "$eve.parent",
  "$eve.root",
  "$eve.parent_call",
  "$eve.parent_turn",
  "$eve.subagent",
  "$eve.trigger",
  "$eve.prewarm",
].join(",");

// Everything the agent inherits, minus anything that could reach Vercel or switch on telemetry.
function agentEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith("VERCEL") || key === "AI_GATEWAY_API_KEY") delete env[key];
  }

  // Vitest sets NODE_ENV=test, and under it eve swaps every authored model for its own canned
  // test model, so the agent must run as it would in production.
  return { ...env, NODE_ENV: "production", EVE_TELEMETRY_DISABLED: "1", ...extra };
}

type Call = { tool: string; args: GatewayArguments };

/** What a TCP server listening on a host and port reports as its address. */
const ListeningAddress = z.object({ port: z.number() });

/** The answer eve gives when it opens a session. */
const CreatedSession = z.object({ sessionId: z.string() });

/** The two gateway tools the agent calls, answering as the real gateway does. */
async function startFakeGateway() {
  const calls: Call[] = [];

  const handler = createMcpHandler(
    async () => {
      const server = new McpServer({ name: "fake-gateway", version: "0.0.0" });

      const json = (value: { [field: string]: string | number }) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      });

      server.registerTool(
        "propose_transfer",
        {
          inputSchema: z.object({
            chainId: z.string(),
            to: z.string(),
            amount: z.string(),
            asset: z.string().optional(),
            memo: z.string(),
            walletId: z.string().optional(),
          }),
        },
        async (args) => {
          calls.push({ tool: "propose_transfer", args });

          return json({
            intentId: "int_01jd0000000000000000000004",
            status: "pending_approval",
            approvalUrl: "https://os.example.com/approvals/apr_01jd0000000000000000000005",
            expiresAt: 1_700_000_600,
          });
        },
      );
      server.registerTool(
        "get_intent",
        { inputSchema: z.object({ intentId: z.string(), waitSeconds: z.number().optional() }) },
        async (args) => {
          calls.push({ tool: "get_intent", args });

          return json({ intentId: args.intentId, status: "pending_approval" });
        },
      );

      return server;
    },
    { responseMode: "json" },
  );

  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.headers.get("authorization") === `Bearer ${TOKEN}`
        ? handler.fetch(request)
        : new Response("unauthenticated", { status: 401 }),
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = ListeningAddress.parse(server.address());

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function build(world: string | undefined): Promise<void> {
  await execFileAsync(join(BIN, "eve"), ["build"], {
    cwd: HERE,
    env: agentEnvironment(world ? { EVE_WORKFLOW_WORLD: world } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function startAgent(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(
    join(BIN, "eve"),
    ["start", "--host", "127.0.0.1", "--port", String(AGENT_PORT)],
    {
      cwd: HERE,
      env: agentEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;

  for (;;) {
    if (child.exitCode !== null) throw new Error(`eve start exited:\n${output.slice(-4000)}`);

    const healthy = await fetch(`http://127.0.0.1:${AGENT_PORT}/eve/v1/health`).then(
      (response) => response.ok,
      () => false,
    );

    if (healthy) return child;

    if (Date.now() > deadline)
      throw new Error(`eve start never became healthy:\n${output.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopAgent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

const auth = `Basic ${Buffer.from(`operator:${PASSWORD}`).toString("base64")}`;

/** Send one message and read the session's event stream until the turn has settled. */
async function talk(message: string): Promise<string> {
  const base = `http://127.0.0.1:${AGENT_PORT}/eve/v1/session`;

  const created = await fetch(base, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });

  expect(created.status).toBeLessThan(300);
  const { sessionId } = CreatedSession.parse(await created.json());
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);

  try {
    const stream = await fetch(`${base}/${sessionId}/stream`, {
      headers: { authorization: auth },
      signal: abort.signal,
    });

    const reader = stream.body?.getReader();

    if (!reader) throw new Error("no stream body");
    const decoder = new TextDecoder();
    let text = "";

    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      text += decoder.decode(value, { stream: true });

      if (text.includes('"turn.settled"')) {
        abort.abort();

        return text;
      }
    }

    throw new Error(`stream ended before the turn settled:\n${text.slice(-2000)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** One full run: build on `world`, start, ask for a payment, stop. Returns what the gateway saw. */
async function runOnce(input: {
  world: string | undefined;
  db: TestDatabase;
  keyringFile: string;
  gatewayUrl: string;
  message: string;
}) {
  await execFileAsync(join(BIN, "bootstrap"), [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: input.db.url },
  });
  await build(input.world);

  const agent = await startAgent({
    WORKFLOW_POSTGRES_URL: input.db.url,
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: "12",
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "10",
    WORLD_KEYRING_FILE: input.keyringFile,
    WORLD_READABLE_ATTRIBUTE_KEYS: READABLE_ATTRIBUTE_KEYS,
    OFFLINE_MODEL: "1",
    MCP_URL: input.gatewayUrl,
    AGENT_TOKEN: TOKEN,
    EVE_CHAT_PASSWORD: PASSWORD,
  });

  try {
    return await talk(input.message);
  } finally {
    await stopAgent(agent);
  }
}

describe("eve agent on the encrypting World", () => {
  const dir = mkdtempSync(join(tmpdir(), "eve-agent-smoke-"));
  const keyringFile = join(dir, "keyring.json");
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
  let encrypted: TestDatabase;
  let stock: TestDatabase;

  beforeAll(async () => {
    writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate("k1")), { mode: 0o600 });
    gateway = await startFakeGateway();
    [encrypted, stock] = await Promise.all([
      createTestDatabase("eve_encrypted"),
      createTestDatabase("eve_stock"),
    ]);
  });

  afterAll(async () => {
    await gateway?.close();
    await Promise.all([encrypted?.drop(), stock?.drop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the upstream World's capabilities eve depends on", async () => {
    const previous = {
      url: process.env.WORKFLOW_POSTGRES_URL,
      keys: process.env.WORLD_KEYRING_FILE,
    };

    process.env.WORKFLOW_POSTGRES_URL = encrypted.url;
    process.env.WORLD_KEYRING_FILE = keyringFile;

    try {
      const world = createWorld();
      // eve refuses compaction handoff without these and claims session starts itself
      // (non-atomically) without the first.
      expect(world.capabilities).toMatchObject({
        atomicStartHook: { active: true },
        hookForceClaim: true,
        hookRetention: { active: true },
      });
      expect(world.getEncryptionKeyForRun).toBeTypeOf("function");
      await world.close?.();
    } finally {
      process.env.WORKFLOW_POSTGRES_URL = previous.url;
      process.env.WORLD_KEYRING_FILE = previous.keys;
    }
  });

  it("proposes the transfer it was asked for and stores none of the conversation in plaintext", async () => {
    const run = async (world: string | undefined, db: TestDatabase) => {
      const marker = `eve-marker-${randomBytes(8).toString("hex")}`;
      const to = `0x${randomBytes(20).toString("hex")}`;
      const before = gateway.calls.length;

      const events = await runOnce({
        world,
        db,
        keyringFile,
        gatewayUrl: gateway.url,
        message: `pay 0.25 to ${to} for order ${marker}`,
      });

      const proposals = gateway.calls
        .slice(before)
        .filter((call) => call.tool === "propose_transfer");

      expect(proposals, events.slice(-2000)).toHaveLength(1);
      expect(proposals[0]?.args).toMatchObject({ to, amount: "0.25", chainId: "eip155:31337" });
      expect(String(proposals[0]?.args.memo)).toContain(marker);
      expect(events).toContain("approvals/apr_01jd0000000000000000000005");

      return scanForMarkers(db.url, [marker, to]);
    };

    // Control first: on the stock World the scanner must see both markers.
    const control = await run("@workflow/world-postgres", stock);
    expect(new Set(control.hits.map((hit) => hit.marker)).size).toBe(2);

    const scan = await run(undefined, encrypted);
    expect(scan.rows).toBeGreaterThan(0);
    // eve stores a session title as a run attribute, and attributes cannot be encrypted. The
    // World withholds it, and keeps readable the attributes eve needs to run the session.
    const client = new pg.Client({ connectionString: encrypted.url });
    await client.connect();

    try {
      const { rows } = await client.query<{ key: string; value: string }>(
        `SELECT DISTINCT a.key, a.value FROM workflow.workflow_runs r, jsonb_each_text(r.attributes) a
         WHERE a.key IN ('$eve.title', '$eve.type')`,
      );

      expect(rows).toEqual(
        expect.arrayContaining([
          { key: "$eve.title", value: "[withheld]" },
          { key: "$eve.type", value: "session" },
        ]),
      );
    } finally {
      await client.end();
    }

    expect(
      scan.hits.map((hit) => `${hit.schema}.${hit.table}.${hit.column} (${hit.encoding})`),
    ).toEqual([]);
  });
});
