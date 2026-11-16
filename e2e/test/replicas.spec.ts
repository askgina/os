/**
 * The gates of two server replicas only (`E2E_REPLICAS=1 e2e/run.sh`, CI `stack (replicas)`):
 * two server containers on one database, behind both edges, as specs/beyond-one-machine.md
 * (milestone 4) asks. They run in order on a fresh stack and share its installation;
 * `release-gates.spec.ts` then runs on another fresh stack with the same two replicas.
 */
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { formatEther } from "viem";
import { chain } from "../src/chain.ts";
import { intentSettles, type PayingAgent, payingAgent, propose } from "../src/installation.ts";
import { Person } from "../src/person.ts";
import {
  compose,
  containerLogs,
  containersOf,
  databaseUrl,
  docker,
  execIn,
  killContainer,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import { acknowledged, bodyOf, receivedRequests } from "../src/webhook.ts";

test.describe.configure({ mode: "serial" });

const RECIPIENT = "0x00000000000000000000000000000000000b0b0b";

const REQUESTS_PER_MINUTE = 120;

const run = Date.now().toString(36);

let replicas: string[] = [];

let ada: Person;

let payer: PayingAgent;

/** The JSON objects one container logged, every start of it included, oldest first. */
async function logLines(container: string): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];

  for (const line of (await containerLogs(container)).split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {}
  }

  return lines;
}

async function eventCount(container: string, event: string): Promise<number> {
  return (await logLines(container)).filter((line) => line.event === event).length;
}

/** What `GET /readyz` answers inside one replica, on its own port, as its health check asks. */
async function readyzIn(container: string): Promise<string> {
  const output = await execIn(
    container,
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/readyz').then((r) => console.log(r.status), () => console.log('unreachable'))",
  );

  return output.trim().split("\n").at(-1) ?? "";
}

async function waitUntilReady(container: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if ((await readyzIn(container).catch(() => "")) === "200") return;

    if (Date.now() > deadline) throw new Error(`${container} did not become ready in time`);
    await delay(1_000);
  }
}

/** The replica that logged `step.started` for `approvalId`'s signing step, once one has. */
async function replicaThatStartsSigning(
  approvalId: string,
  timeoutMs: number,
): Promise<{ container: string; replica: string }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    for (const container of replicas) {
      const started = (await logLines(container)).find(
        (line) =>
          line.event === "step.started" && line.approvalId === approvalId && line.step === "sign",
      );

      if (started) return { container, replica: String(started.replica) };
    }

    if (Date.now() > deadline) throw new Error(`no replica started signing ${approvalId}`);
    await delay(250);
  }
}

const MCP_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

/** One agent request through the public edge (Caddy), as an agent on the internet sends it. */
async function mcpThroughEdge(token: string): Promise<Response> {
  return fetch(`${stack.origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: MCP_BODY,
  });
}

/**
 * `count` agent requests, one after another, to one replica on its own port from inside its
 * container, with the Host header the edge presents. Returns each answer's status.
 */
async function mcpInside(container: string, token: string, count: number): Promise<unknown[]> {
  const script = `
    const http = require("node:http");
    const body = ${JSON.stringify(MCP_BODY)};
    const one = () => new Promise((resolve) => {
      const request = http.request({
        host: "127.0.0.1", port: 3000, path: "/mcp", method: "POST",
        headers: {
          host: process.env.MCP_HOST,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer " + process.env.MCP_TOKEN,
          "content-length": Buffer.byteLength(body),
        },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", () => resolve("unreachable"));
      request.end(body);
    });
    (async () => {
      const statuses = [];
      for (let i = 0; i < Number(process.env.MCP_COUNT); i += 1) statuses.push(await one());
      console.log(JSON.stringify(statuses));
    })();`;

  const output = await docker(
    "exec",
    "-e",
    `MCP_TOKEN=${token}`,
    "-e",
    `MCP_HOST=${new URL(stack.origin).host}`,
    "-e",
    `MCP_COUNT=${count}`,
    container,
    "node",
    "-e",
    script,
  );

  return JSON.parse(output.trim().split("\n").at(-1) ?? "[]") as unknown[];
}

test.beforeAll(async () => {
  await waitUntilHealthy();
  replicas = await containersOf("server");
});

test.afterAll(async () => {
  await payer?.agent.close();
});

test("two replicas boot before setup and log no token; of two setup-token commands at once, one token claims the installation", async () => {
  expect(replicas).toHaveLength(2);
  const pending = await Promise.all(replicas.map((c) => eventCount(c, "setup.token_pending")));

  for (const n of pending) expect(n).toBeGreaterThanOrEqual(1);

  // The operator's command in both replicas at once: two tokens printed, one stored.
  const tokens = await Promise.all(
    replicas.map(async (container) => {
      const printed = await execIn(container, "node", "apps/server/src/cli.ts", "setup-token");

      const answer = JSON.parse(printed.trim().split("\n").at(-1) ?? "{}") as {
        setupToken?: string;
      };

      return answer.setupToken ?? "";
    }),
  );

  expect(new Set(tokens).size).toBe(2);
  const claimed: boolean[] = [];

  for (const token of tokens) {
    const person = new Person(stack.origin, "Ada");

    const taken = await person.setUp(token).then(
      () => true,
      () => false,
    );

    claimed.push(taken);

    if (taken) ada = person;
  }

  expect(claimed.filter(Boolean)).toHaveLength(1);

  // Neither token is in either replica's log.
  for (const container of replicas) {
    const logs = await containerLogs(container);

    for (const token of tokens) expect(logs).not.toContain(token);
  }

  // Once the owner exists, the operator's command on either replica mints nothing.
  for (const container of replicas) {
    const refused = await execIn(container, "node", "apps/server/src/cli.ts", "setup-token").then(
      () => ({ exitCode: 0, stdout: "" }),
      (error: { code?: number; stdout?: string }) => ({
        exitCode: error.code,
        stdout: error.stdout ?? "",
      }),
    );

    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
      ok: false,
      code: "setup_done",
    });
  }
});

test("both replicas answer /readyz with 200, and so does the edge", async () => {
  for (const container of replicas) expect(await readyzIn(container), container).toBe("200");
  expect((await fetch(`${stack.origin}/readyz`)).status).toBe(200);
});

test("a workspace, an agent with a funded wallet, and its limits approved with a passkey", async () => {
  payer = await payingAgent(ada, `Replicas ${run}`);
});

test("the replica that started signing a payment is killed, and the other finishes it with exactly one transaction", async () => {
  // Up to a minute for the step to start, 90 seconds to settle, and the killed replica's restart.
  test.setTimeout(420_000);
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payer.wallet.address });

  const { intentId, approvalId } = await propose(
    payer.agent,
    RECIPIENT,
    "0.01",
    "survives losing its replica",
  );

  let killed: string | undefined;

  try {
    // With the chain frozen, the signing step cannot get past its fee quote, so the replica that
    // started it is still inside it when it dies. The approval's answer may wait on the chain
    // too, so it is not awaited before the kill.
    await compose("pause", "anvil");
    const approving = ada.confirm(approvalId).catch(() => undefined);
    const started = await replicaThatStartsSigning(approvalId, 60_000);
    killed = started.container;
    // The log names the replica by its host name, which Docker sets for each container.
    expect((await docker("inspect", "--format", "{{.Config.Hostname}}", killed)).trim()).toBe(
      started.replica,
    );
    await killContainer(killed);
    await approving;
  } finally {
    await compose("unpause", "anvil");
  }

  const survivor = replicas.find((container) => container !== killed) ?? "";

  try {
    const killedAt = Date.now();
    expect(await intentSettles(ada, intentId, 90_000)).toBe("confirmed");
    process.stdout.write(
      `${JSON.stringify({ gate: "replica-killed", confirmedAfterSeconds: (Date.now() - killedAt) / 1000 })}\n`,
    );
    // The survivor ran the signing step again, and the signer gave back no second transaction.
    const survivorLines = await logLines(survivor);
    expect(
      survivorLines.some((line) => line.event === "step.started" && line.approvalId === approvalId),
    ).toBe(true);
    expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
    expect(await chain.getTransactionCount({ address: payer.wallet.address })).toBe(
      nonceBefore + 1,
    );
    const detail = await ada.api.call("getIntent", { params: { intentId } });
    expect(detail.transaction?.attempts).toHaveLength(1);
  } finally {
    if (killed !== undefined) {
      await docker("start", killed);
      await waitUntilReady(killed);
    }
  }
});

test("each notification about one payment reaches the webhook once while both replicas sweep", async () => {
  test.setTimeout(360_000);

  // Both replicas deliver Workflow steps and run the 3-second sweep that sends notifications.
  for (const container of replicas) expect(await readyzIn(container), container).toBe("200");
  const { intentId, approvalId } = await propose(payer.agent, RECIPIENT, "0.001", "announced once");

  // The webhook hears of a request only while it waits for people: a row the sweep finds after
  // the decision is dropped (`approval_ended`), never sent. So the request waits until the
  // receiver has accepted its announcement, and then through several more sweeps of both
  // replicas, each of which could send it again if the outbox let two senders have it.
  const announced = await acknowledged(
    (body) => body.approvalId === approvalId && body.event === "approval.opened",
  );

  await delay(10_000);

  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    const outbox = async () =>
      (
        await db.query<{ id: string; event: string; state: string; attempts: number }>(
          "SELECT id, event, state, attempts FROM os.notification_deliveries WHERE approval_id = $1 AND target = 'webhook' ORDER BY id",
          [approvalId],
        )
      ).rows;

    const rows = await outbox();
    // The webhook's only notification of a request: its announcement, sent once, first time.
    expect(rows.map(({ event, state, attempts }) => ({ event, state, attempts }))).toEqual([
      { event: "approval.opened", state: "sent", attempts: 0 },
    ]);

    const received = (await receivedRequests()).filter(
      (request) => bodyOf(request).approvalId === approvalId,
    );

    const deliveryIds = received.map((request) => request.headers["x-os-delivery"] ?? "");
    process.stdout.write(
      `${JSON.stringify({ gate: "webhook-once", deliveries: received.length, firstAcknowledged: announced.length })}\n`,
    );
    expect(received.map((request) => request.status)).toEqual([200]);
    expect(deliveryIds).toEqual(rows.map((row) => row.id));

    // Deciding the request adds nothing for the webhook, and nothing is sent about it again.
    await ada.confirm(approvalId);
    expect(await intentSettles(ada, intentId, 120_000)).toBe("confirmed");
    await delay(10_000);
    expect(await outbox()).toEqual(rows);
    expect(
      (await receivedRequests()).filter((request) => bodyOf(request).approvalId === approvalId),
    ).toHaveLength(1);
  } finally {
    await db.end();
  }
});

test("one agent's requests are counted once across both replicas: the 121st in a minute is refused through Caddy", async () => {
  const bucket = `agent:${payer.agentId}`;
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    await db.query("DELETE FROM os.rate_limits WHERE bucket = $1", [bucket]);
    expect((await mcpThroughEdge(payer.agentToken)).status).toBe(200);
    // The bucket's clock stands still from now on, so the count is exact however long the
    // requests take: its refill counts from `at`, which no take moves back.
    await db.query("UPDATE os.rate_limits SET at = now() + interval '1 hour' WHERE bucket = $1", [
      bucket,
    ]);
    const [first, second] = replicas;

    if (first === undefined || second === undefined) throw new Error("expected two replicas");
    const half = REQUESTS_PER_MINUTE / 2;
    expect(await mcpInside(first, payer.agentToken, half - 1)).toEqual(
      Array.from({ length: half - 1 }, () => 200),
    );
    expect(await mcpInside(second, payer.agentToken, half)).toEqual(
      Array.from({ length: half }, () => 200),
    );

    const over = await mcpThroughEdge(payer.agentToken);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: "rate_limited" } });

    for (const container of replicas) {
      expect(await mcpInside(container, payer.agentToken, 1), container).toEqual([429]);
    }
  } finally {
    await db.query("DELETE FROM os.rate_limits WHERE bucket = $1", [bucket]).catch(() => {});
    await db.end();
  }
});
