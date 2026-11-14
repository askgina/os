import { randomBytes } from "node:crypto";
import type { ApprovalId, IntentId } from "@askgina/os-protocol";
import { SignerError, type SignRequest } from "@askgina/os-protocol/signer";
import type { Client } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { parseTransaction } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approverCredentials,
  intents,
  memberships,
  transactions,
  workspaces,
} from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { ChainAccess, ChainError, chainAccess } from "../../src/execution/chains.ts";
import { sweep } from "../../src/execution/index.ts";
import { MAX_PENDING_PER_AGENT } from "../../src/execution/intents.ts";
import type { WorkflowRuntime } from "../../src/execution/workflow-runtime.ts";
import { FAILED_AUTH_PER_MINUTE } from "../../src/mcp/gateway.ts";
import { TEST_CHAIN_ID, TEST_ORIGIN, type TestPerson } from "../support/context.ts";
import { anvil, createFixture, draftFor, type Fixture, fund, toolJson } from "./fixture.ts";

let f: Fixture;
let bob: TestPerson;

beforeAll(async () => {
  f = await createFixture("exec_hardening");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
});
afterAll(async () => {
  await f?.close();
});

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

async function propose(client: Client, amount = "0.01") {
  const result = await client.callTool({
    name: "propose_transfer",
    arguments: { chainId: TEST_CHAIN_ID, to: randomAddress(), amount, memo: "test" },
  });
  const proposed = toolJson(result);
  if (typeof proposed.intentId !== "string") throw new Error(JSON.stringify(proposed));
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, proposed.intentId as IntentId));
  if (!row?.approvalId) throw new Error("intent without approval");
  return { intentId: row.id, approvalId: row.approvalId, url: String(proposed.approvalUrl) };
}

async function approveOnly(approvalId: ApprovalId, person: TestPerson = f.t.owner) {
  const { options } = await person.browser.api.call("startApproval", {
    params: { approvalId },
    body: {},
  });
  const response = f.t.authenticator.authenticate({
    credentialId: person.credentialId,
    challenge: String(options.challenge),
    origin: TEST_ORIGIN,
  });
  return person.browser.api.call("approve", {
    params: { approvalId },
    body: { response: response as never },
  });
}

async function agentClient(name: string) {
  const agent = await f.newAgent(name);
  await f.setPolicy(f.workspaceId, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 50n * 10n ** 18n);
  return { agent, client: await f.mcp(agent.token) };
}

const intentOf = (intentId: IntentId) =>
  f.t.owner.browser.api.call("getIntent", { params: { intentId } });

async function transactionOf(approvalId: ApprovalId) {
  const [row] = await f.t.ctx.db
    .select()
    .from(transactions)
    .where(eq(transactions.approvalId, approvalId));
  if (!row) throw new Error("no transaction");
  return row;
}

async function rawOf(approvalId: ApprovalId) {
  const row = await transactionOf(approvalId);
  return (await f.t.ctx.sealer.open(
    f.workspaceId,
    `transactions.raw:${approvalId}`,
    row.raw,
  )) as `0x${string}`;
}

/** Replace one method of an object for the length of `run`. */
async function patched<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
  run: () => Promise<void>,
) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value: replacement, configurable: true, writable: true });
  try {
    await run();
  } finally {
    if (own) Object.defineProperty(target, key, own);
    else delete target[key];
  }
}

const steps = () => engineOf(f.t.ctx).steps();

describe("links and proposals", () => {
  it("links to the approval page the web app serves", async () => {
    const { client } = await agentClient("Linker");
    const { approvalId, url } = await propose(client);
    expect(url).toBe(`${TEST_ORIGIN}/w/${f.workspaceId}/approvals/${approvalId}`);
  });

  it("refuses a proposal while the workspace is paused", async () => {
    const { client } = await agentClient("Paused");
    await f.t.ctx.db
      .update(workspaces)
      .set({ paused: true })
      .where(eq(workspaces.id, f.workspaceId));
    try {
      const result = await client.callTool({
        name: "propose_transfer",
        arguments: { chainId: TEST_CHAIN_ID, to: randomAddress(), amount: "0.01", memo: "x" },
      });
      expect(result.isError).toBe(true);
      expect(toolJson(result)).toMatchObject({ error: "conflict", detail: "workspace_paused" });
    } finally {
      await f.t.ctx.db
        .update(workspaces)
        .set({ paused: false })
        .where(eq(workspaces.id, f.workspaceId));
    }
  });

  it("refuses more open proposals than the limit until some are decided", async () => {
    const { client } = await agentClient("Spammer");
    const opened = [];
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) opened.push(await propose(client));
    const over = await client.callTool({
      name: "propose_transfer",
      arguments: { chainId: TEST_CHAIN_ID, to: randomAddress(), amount: "0.01", memo: "x" },
    });
    expect(toolJson(over)).toMatchObject({ error: "rate_limited", detail: "too_many_pending" });
    const first = opened[0];
    if (!first) throw new Error("nothing opened");
    await client.callTool({ name: "cancel_intent", arguments: { intentId: first.intentId } });
    await propose(client);
  });
});

describe("cancelling", () => {
  it("does not mark an approved intent cancelled; it is still signed", async () => {
    const { client } = await agentClient("Late canceller");
    const { intentId, approvalId } = await propose(client);
    await approveOnly(approvalId);
    const answer = toolJson(
      await client.callTool({ name: "cancel_intent", arguments: { intentId } }),
    );
    expect(answer.status).not.toBe("cancelled");
    expect((await engineOf(f.t.ctx).row(approvalId)).status).toBe("approved");
    expect(await steps().execute(approvalId)).toEqual({ ok: true });
    expect((await intentOf(intentId)).status).toBe("signed");
  });
});

describe("the MCP gateway's errors", () => {
  const SECRET = "https://rpc.example/v2/SECRETKEY123";

  async function expectInternal(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(toolJson(result)).toMatchObject({ error: "internal" });
    expect(JSON.stringify(result)).not.toContain("SECRETKEY123");
  }

  it("answers internal failures with one fixed refusal and never their text", async () => {
    const { client } = await agentClient("Unlucky");
    await propose(client);
    const chains = chainAccess(f.t.ctx);
    const boom = async () => {
      throw new Error(`request to ${SECRET} failed`);
    };
    await patched(chains, "balances", boom, () => expectInternal(client, "get_balances", {}));
    await patched(chains, "simulate", boom, async () => {
      await expectInternal(client, "propose_transfer", {
        chainId: TEST_CHAIN_ID,
        to: randomAddress(),
        amount: "0.01",
        memo: "x",
      });
      await expectInternal(client, "propose_contract_call", {
        chainId: TEST_CHAIN_ID,
        to: randomAddress(),
        data: "0x12345678",
        memo: "x",
      });
    });
    await patched(f.t.ctx.sealer, "open", boom, () => expectInternal(client, "list_intents", {}));
    expect(f.t.log.lines.join("\n")).not.toContain("SECRETKEY123");
  });

  it("refuses a client after too many failed authentications, before reading the database", async () => {
    const { agent } = await agentClient("Guessed");
    const call = (token: string, client: string) =>
      f.t.app.fetch(
        new Request(`${TEST_ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "x-forwarded-for": client,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      );
    for (let i = 0; i < FAILED_AUTH_PER_MINUTE; i += 1) {
      expect((await call(`osa_${"x".repeat(40)}`, "203.0.113.9")).status).toBe(401);
    }
    // Even a valid token is refused from that client now: the limit comes before the lookup.
    expect((await call(agent.token, "203.0.113.9")).status).toBe(429);
    expect((await call(agent.token, "203.0.113.10")).status).toBe(200);
  });
});

describe("deciding", () => {
  it("lets a passkey being removed still approve, as the signer still accepts it", async () => {
    const { client } = await agentClient("Removal race");
    const { approvalId } = await propose(client);
    const where = and(
      eq(approverCredentials.workspaceId, f.workspaceId),
      eq(approverCredentials.credentialId, bob.credentialId),
    );
    await f.t.ctx.db.update(approverCredentials).set({ state: "removing" }).where(where);
    try {
      const detail = await bob.browser.api.call("getApproval", { params: { approvalId } });
      expect(detail.canDecide).toBe(true);
      expect((await approveOnly(approvalId, bob)).status).toBe("approved");
    } finally {
      await f.t.ctx.db.update(approverCredentials).set({ state: "active" }).where(where);
    }
  });

  it("does not offer a decision to a member whose role cannot decide", async () => {
    const { client } = await agentClient("Demoted");
    const { approvalId } = await propose(client);
    const where = and(
      eq(memberships.workspaceId, f.workspaceId),
      eq(memberships.userId, bob.userId),
    );
    await f.t.ctx.db.update(memberships).set({ role: "viewer" }).where(where);
    try {
      const detail = await bob.browser.api.call("getApproval", { params: { approvalId } });
      expect(detail.canDecide).toBe(false);
    } finally {
      await f.t.ctx.db.update(memberships).set({ role: "approver" }).where(where);
    }
  });
});

describe("signing", () => {
  it("retries a signer that does not recognise our request signature, rather than failing", async () => {
    const { client } = await agentClient("Skewed");
    const { intentId, approvalId } = await propose(client);
    await approveOnly(approvalId);
    const signer = f.t.ctx.signer;
    await patched(
      signer,
      "sign",
      async () => {
        throw new SignerError("unauthenticated", "request signature rejected", 401);
      },
      async () => {
        await expect(steps().execute(approvalId)).rejects.toBeInstanceOf(SignerError);
      },
    );
    expect(await steps().execute(approvalId)).toEqual({ ok: true });
    expect((await intentOf(intentId)).status).toBe("signed");
  });

  it("never gives a second approval the nonce of one that crashed after the signer signed it", async () => {
    const { agent, client } = await agentClient("Crashy");
    const a = await propose(client);
    const b = await propose(client);
    await approveOnly(a.approvalId);
    await approveOnly(b.approvalId);
    const start = await anvil.getTransactionCount({ address: agent.address });
    const signer = f.t.ctx.signer;
    const realSign = signer.sign.bind(signer);
    let firstHash = "";
    await patched(
      signer,
      "sign",
      async (input: SignRequest) => {
        firstHash = (await realSign(input)).transactionHash;
        throw new Error("process died before the row was stored");
      },
      async () => {
        await expect(steps().execute(a.approvalId)).rejects.toThrow();
      },
    );
    expect(await steps().execute(b.approvalId)).toEqual({ ok: true });
    expect(await steps().execute(a.approvalId)).toEqual({ ok: true });
    const rowA = await transactionOf(a.approvalId);
    const rowB = await transactionOf(b.approvalId);
    expect(rowA.hash).toBe(firstHash);
    expect([rowA.nonce, rowB.nonce]).toEqual([start, start + 1]);
    for (const id of [a.approvalId, b.approvalId]) {
      for (let i = 0; i < 20 && !(await steps().followUp(id)).done; i += 1);
    }
    expect((await intentOf(a.intentId)).status).toBe("confirmed");
    expect((await intentOf(b.intentId)).status).toBe("confirmed");
  });
});

describe("cleanup and recovery", () => {
  it("abandons the intent even when revoking at the signer fails", async () => {
    const { client } = await agentClient("Cleanup");
    for (const failure of [
      new TypeError("fetch failed"),
      new SignerError("conflict", "already signed", 409),
    ]) {
      const { intentId, approvalId } = await propose(client);
      await bob.browser.api.call("reject", { params: { approvalId }, body: {} });
      await patched(
        f.t.ctx.signer,
        "revokeApproval",
        async () => {
          throw failure;
        },
        () => steps().abandon(approvalId, "rejected"),
      );
      expect((await intentOf(intentId)).status).toBe("rejected");
    }
  });

  it("ends an intent whose request was decided before any workflow run existed", async () => {
    const { client } = await agentClient("Orphan");
    const rejected = await propose(client);
    const approved = await propose(client);
    await bob.browser.api.call("reject", { params: { approvalId: rejected.approvalId }, body: {} });
    await approveOnly(approved.approvalId);
    expect((await intentOf(rejected.intentId)).status).toBe("pending_approval");
    f.t.clock.advance(11);

    const engine = engineOf(f.t.ctx);
    const started: string[] = [];
    await patched(
      engine,
      "startRun",
      async (id: ApprovalId) => {
        started.push(id);
      },
      async () => {
        await sweep(f.t.ctx);
      },
    );
    expect((await intentOf(rejected.intentId)).status).toBe("rejected");
    expect(started).toContain(approved.approvalId);
    expect(started).not.toContain(rejected.approvalId);
    const again = await sweep(f.t.ctx);
    expect(again.abandoned).toBe(0);
  });

  it("starts at most one workflow run for a request, however many starts race", async () => {
    const { client } = await agentClient("Racer");
    const { approvalId } = await propose(client);
    const engine = engineOf(f.t.ctx);
    let starts = 0;
    const fake = {
      world: undefined as never,
      async startRun() {
        starts += 1;
        return `wrun_fake_${starts}`;
      },
      async wake() {
        return false;
      },
    } satisfies WorkflowRuntime;
    engine.attachRuntime(fake);
    try {
      const row = await engine.row(approvalId);
      const expiresAt = Math.floor(row.expiresAt.getTime() / 1000);
      await Promise.all([
        engine.startRun(approvalId, f.workspaceId, expiresAt),
        engine.startRun(approvalId, f.workspaceId, expiresAt),
        engine.startRun(approvalId, f.workspaceId, expiresAt),
      ]);
    } finally {
      engine.attachRuntime(null);
    }
    expect(starts).toBe(1);
    expect((await engine.row(approvalId)).runId).toBe("wrun_fake_1");
  });
});

describe("the chain", () => {
  it("tells an RPC failure apart from a missing transaction", async () => {
    const hash = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
    expect(await chainAccess(f.t.ctx).receipt(TEST_CHAIN_ID, hash)).toEqual({ state: "missing" });
    const dead = new ChainAccess([
      { ...chainAccess(f.t.ctx).config(TEST_CHAIN_ID), rpcUrl: "http://127.0.0.1:1" },
    ]);
    await expect(dead.receipt(TEST_CHAIN_ID, hash)).rejects.toMatchObject({
      code: "rpc_unavailable",
    });
  });

  it("refuses an endpoint that serves another chain", async () => {
    const wrong = new ChainAccess([
      { ...chainAccess(f.t.ctx).config(TEST_CHAIN_ID), chainId: "eip155:1" },
    ]);
    await expect(
      wrong.balances(randomAddress(), [{ chainId: "eip155:1", asset: "native" }]),
    ).rejects.toMatchObject({
      code: "chain_mismatch",
    });
  });

  it("keeps rebroadcasting, then ends a transaction the chain never took and frees its nonce", async () => {
    const { agent, client } = await agentClient("Refused");
    const { intentId, approvalId } = await propose(client);
    await approveOnly(approvalId);
    expect(await steps().execute(approvalId)).toEqual({ ok: true });
    const nonce = (await transactionOf(approvalId)).nonce;
    const refuse = async () => {
      throw new ChainError("broadcast_failed");
    };
    await patched(chainAccess(f.t.ctx), "broadcast", refuse, async () => {
      expect((await steps().followUp(approvalId)).done).toBe(false);
      expect((await transactionOf(approvalId)).status).toBe("signed");
      f.t.clock.advance(f.t.ctx.config.reconcileTimeoutSeconds + 1);
      expect((await steps().followUp(approvalId)).done).toBe(true);
    });
    expect((await transactionOf(approvalId)).status).toBe("rejected");
    expect(await intentOf(intentId)).toMatchObject({
      status: "failed",
      failureCode: "broadcast_rejected",
    });
    const next = await propose(client);
    await approveOnly(next.approvalId);
    expect(await steps().execute(next.approvalId)).toEqual({ ok: true });
    expect((await transactionOf(next.approvalId)).nonce).toBe(nonce);
    expect(nonce).toBe(await anvil.getTransactionCount({ address: agent.address }));
  });

  it("continues a transaction the chain does know although sending it again failed", async () => {
    const { client } = await agentClient("Known");
    const { intentId, approvalId } = await propose(client);
    await approveOnly(approvalId);
    await steps().execute(approvalId);
    await anvil.sendRawTransaction({ serializedTransaction: await rawOf(approvalId) });
    await patched(
      chainAccess(f.t.ctx),
      "broadcast",
      async () => {
        throw new ChainError("broadcast_failed");
      },
      async () => {
        f.t.clock.advance(f.t.ctx.config.reconcileTimeoutSeconds + 1);
        expect((await steps().followUp(approvalId)).done).toBe(false);
      },
    );
    expect((await transactionOf(approvalId)).status).toBe("broadcast");
    for (let i = 0; i < 20 && !(await steps().followUp(approvalId)).done; i += 1);
    expect((await intentOf(intentId)).status).toBe("confirmed");
  });

  it("never calls a transaction stuck during an RPC outage, and confirms a stuck one later", async () => {
    const { client } = await agentClient("Slow");
    const { intentId, approvalId } = await propose(client);
    await approveOnly(approvalId);
    await steps().execute(approvalId);
    const chains = chainAccess(f.t.ctx);
    // Keep the transaction off the chain for now.
    await patched(
      chains,
      "broadcast",
      async () => {},
      async () => {
        expect((await steps().followUp(approvalId)).done).toBe(false);
        expect((await transactionOf(approvalId)).status).toBe("broadcast");
        f.t.clock.advance(f.t.ctx.config.reconcileTimeoutSeconds + 1);
        await patched(
          chains,
          "receipt",
          async () => {
            throw new ChainError("rpc_unavailable");
          },
          async () => {
            expect((await steps().followUp(approvalId)).done).toBe(false);
          },
        );
        expect((await transactionOf(approvalId)).status).toBe("broadcast");
        expect(await steps().followUp(approvalId)).toEqual({ done: false, waitSeconds: 600 });
      },
    );
    expect((await intentOf(intentId)).status).toBe("stuck");
    await anvil.sendRawTransaction({ serializedTransaction: await rawOf(approvalId) });
    expect(parseTransaction(await rawOf(approvalId)).nonce).toBe(
      (await transactionOf(approvalId)).nonce,
    );
    for (let i = 0; i < 20 && !(await steps().followUp(approvalId)).done; i += 1);
    expect((await intentOf(intentId)).status).toBe("confirmed");
  });
});
