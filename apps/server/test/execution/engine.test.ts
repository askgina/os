import { randomBytes } from "node:crypto";
import { ApiErrorBody, routes } from "@askgina/os-api";
import type { ApprovalId, IntentId } from "@askgina/os-protocol";
import type { SignRequest, SignResponse } from "@askgina/os-protocol/signer";
import { scanForMarkers } from "@askgina/os-testkit";
import type { Client } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, parseTransaction } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, intents, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { TEST_CHAIN_ID, TEST_ORIGIN, type TestPerson } from "../support/context.ts";
import {
  anvil,
  createFixture,
  deployToken,
  draftFor,
  type Fixture,
  fund,
  toolJson,
} from "./fixture.ts";

let f: Fixture;
let bob: TestPerson;

beforeAll(async () => {
  f = await createFixture("exec_engine");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
});
afterAll(async () => {
  await f?.close();
});

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

async function propose(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ intentId: IntentId; approvalId: ApprovalId }> {
  const proposed = toolJson(await client.callTool({ name: "propose_transfer", arguments: args }));
  if (typeof proposed.intentId !== "string") throw new Error(JSON.stringify(proposed));
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, proposed.intentId as IntentId));
  if (!row?.approvalId) throw new Error("intent without approval");
  return { intentId: row.id, approvalId: row.approvalId };
}

/** Approve through the HTTP API with a person's passkey, as the approval page does. */
async function approveViaApi(person: TestPerson, approvalId: ApprovalId) {
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

/** Run the follow-up step until it is done, as the workflow would. */
async function followUntilDone(approvalId: ApprovalId) {
  const steps = engineOf(f.t.ctx).steps();
  for (let i = 0; i < 20; i += 1) {
    if ((await steps.followUp(approvalId)).done) return;
  }
  throw new Error("follow-up never finished");
}

async function intentStatus(intentId: IntentId) {
  return f.t.owner.browser.api.call("getIntent", { params: { intentId } });
}

async function agentWith(name: string, overrides: Parameters<typeof draftFor>[1] = {}) {
  const agent = await f.newAgent(name);
  await f.setPolicy(f.workspaceId, agent.walletId, draftFor(agent.id, overrides));
  await fund(agent.address, 50n * 10n ** 18n);
  return { agent, client: await f.mcp(agent.token) };
}

describe("approving an intent", () => {
  it("signs once through the API, even when the process dies between the signature and our row, and confirms on chain", async () => {
    const client = await f.mcp(f.agent.token);
    const recipient = randomAddress();
    const nonceBefore = await anvil.getTransactionCount({ address: f.agent.address });
    const { intentId, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.5",
      memo: "pay the supplier",
    });

    const pending = await f.t.owner.browser.api.call("listApprovals", {
      params: { workspaceId: f.workspaceId },
      query: {},
    });
    expect(pending.items.map((item) => item.id)).toContain(approvalId);

    const decided = await approveViaApi(f.t.owner, approvalId);
    expect(decided.status).toBe("approved");

    const steps = engineOf(f.t.ctx).steps();
    // The signer signs, then this process dies before the transaction row is stored.
    const signer = f.t.ctx.signer;
    const realSign = signer.sign.bind(signer);
    let signedFirst: SignResponse | undefined;
    Object.defineProperty(signer, "sign", {
      configurable: true,
      writable: true,
      value: async (input: SignRequest) => {
        signedFirst = await realSign(input);
        throw new Error("process died");
      },
    });
    try {
      await expect(steps.execute(approvalId)).rejects.toThrow("process died");
    } finally {
      Object.defineProperty(signer, "sign", {
        configurable: true,
        writable: true,
        value: realSign,
      });
    }
    if (!signedFirst) throw new Error("the signer was never reached");
    expect(
      await f.t.ctx.db.select().from(transactions).where(eq(transactions.intentId, intentId)),
    ).toHaveLength(0);
    // The retried step gets the signer's replay of the first signature: one transaction, with
    // the nonce the signed transaction carries.
    expect(await steps.execute(approvalId)).toEqual({ ok: true });
    const rows = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.intentId, intentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(signedFirst.transactionHash);
    expect(rows[0]?.nonce).toBe(
      parseTransaction(signedFirst.signedTransaction as `0x${string}`).nonce,
    );

    await followUntilDone(approvalId);
    // A second broadcast of the same bytes changes nothing on chain.
    await steps.followUp(approvalId);
    expect(await anvil.getTransactionCount({ address: f.agent.address })).toBe(nonceBefore + 1);
    expect(await anvil.getBalance({ address: recipient })).toBe(5n * 10n ** 17n);

    const detail = await intentStatus(intentId);
    expect(detail.status).toBe("confirmed");
    expect(detail.transaction?.status).toBe("confirmed");
    expect(
      (await f.t.owner.browser.api.call("getApproval", { params: { approvalId } })).status,
    ).toBe("executed");
  });

  it("waits for two different people when the policy asks for two", async () => {
    // A policy may not ask for more people than the workspace's admin threshold, so this runs
    // in its own workspace with two approvers and an admin threshold of two.
    const workspaceId = await f.newWorkspace("Two people");
    const carol = await f.addApprover(workspaceId, "Carol Approver");
    const raised = await f.t.owner.browser.api.call("requestAdminThreshold", {
      params: { workspaceId },
      body: { adminThreshold: 2 },
    });
    expect((await f.t.approve(raised.id as ApprovalId, [f.t.owner])).status).toBe("executed");
    const agent = await f.newAgent("Two-person", workspaceId);
    const policy = await f.t.owner.browser.api.call("requestPolicy", {
      params: { workspaceId, walletId: agent.walletId },
      body: { draft: draftFor(agent.id, { approvals: { threshold: 2, ttlSeconds: 3_600 } }) },
    });
    expect((await f.t.approve(policy.id as ApprovalId, [f.t.owner, carol])).status).toBe(
      "executed",
    );
    await fund(agent.address, 50n * 10n ** 18n);
    const client = await f.mcp(agent.token);
    const { intentId, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "1",
      memo: "needs two",
    });
    const first = await approveViaApi(f.t.owner, approvalId);
    expect(first).toMatchObject({ status: "pending", approvals: 1, canDecide: false });
    await expect(approveViaApi(f.t.owner, approvalId)).rejects.toMatchObject({ code: "conflict" });
    const second = await approveViaApi(carol, approvalId);
    expect(second).toMatchObject({ status: "approved", approvals: 2 });
    expect(await engineOf(f.t.ctx).steps().execute(approvalId)).toEqual({ ok: true });
    expect((await intentStatus(intentId)).status).toBe("signed");
  });

  it("lets only one of two concurrent decisions win, and the loser fails cleanly", async () => {
    const client = await f.mcp(f.agent.token);
    const { approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.01",
      memo: "race",
    });
    const results = await Promise.allSettled([
      approveViaApi(f.t.owner, approvalId),
      bob.browser.api.call("reject", { params: { approvalId }, body: {} }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toMatchObject({ code: "conflict" });
    const row = await engineOf(f.t.ctx).row(approvalId);
    expect(["approved", "rejected"]).toContain(row.status);
  });

  it("gives two approved intents of one wallet consecutive nonces", async () => {
    const { agent, client } = await agentWith("Busy");
    const first = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.1",
      memo: "one",
    });
    const second = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.1",
      memo: "two",
    });
    await approveViaApi(f.t.owner, first.approvalId);
    await approveViaApi(f.t.owner, second.approvalId);
    const steps = engineOf(f.t.ctx).steps();
    await Promise.all([steps.execute(first.approvalId), steps.execute(second.approvalId)]);
    const rows = await f.t.ctx.db
      .select({ nonce: transactions.nonce })
      .from(transactions)
      .where(eq(transactions.walletId, agent.walletId));
    const start = await anvil.getTransactionCount({ address: agent.address });
    expect(rows.map((row) => row.nonce).sort()).toEqual([start, start + 1]);
    // Either may hold the lower nonce, and the higher one is mined only after it: follow both.
    const pending = new Set([first.approvalId, second.approvalId]);
    for (let i = 0; i < 40 && pending.size > 0; i += 1) {
      for (const id of [...pending]) {
        if ((await steps.followUp(id)).done) pending.delete(id);
      }
    }
    expect(pending.size).toBe(0);
    expect(await anvil.getTransactionCount({ address: agent.address })).toBe(start + 2);
  });

  it("ends an intent failed with policy_changed when the policy changed before signing", async () => {
    const { agent, client } = await agentWith("Policy shift");
    const { intentId, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.2",
      memo: "before the change",
    });
    await f.setPolicy(
      f.workspaceId,
      agent.walletId,
      draftFor(agent.id, { fees: { maxPerTxWei: "90000000000000000" } }),
    );
    const row = await f.t.approve(approvalId, [f.t.owner]);
    expect(row).toMatchObject({ status: "failed", failureCode: "policy_changed" });
    expect(await intentStatus(intentId)).toMatchObject({
      status: "failed",
      failureCode: "policy_changed",
    });
  });

  it("ends a rejected intent and revokes it at the signer", async () => {
    const client = await f.mcp(f.agent.token);
    const { intentId, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.01",
      memo: "no thanks",
    });
    const rejected = await bob.browser.api.call("reject", { params: { approvalId }, body: {} });
    expect(rejected.status).toBe("rejected");
    await f.t.settle(approvalId);
    expect((await intentStatus(intentId)).status).toBe("rejected");
    expect((await f.t.ctx.signer.getApproval(approvalId)).state).toBe("revoked");
  });

  it("expires an intent nobody decided on", async () => {
    const client = await f.mcp(f.agent.token);
    const { intentId, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.01",
      memo: "will lapse",
    });
    f.t.clock.advance(3_601);
    await expect(approveViaApi(f.t.owner, approvalId)).rejects.toMatchObject({ code: "conflict" });
    const steps = engineOf(f.t.ctx).steps();
    const row = await engineOf(f.t.ctx).row(approvalId);
    expect(await steps.settle(approvalId, row.runId ?? "wrun_test_expiry")).toBe("expired");
    await steps.abandon(approvalId, "expired");
    expect((await intentStatus(intentId)).status).toBe("expired");
    expect((await f.t.ctx.signer.getApproval(approvalId)).state).toBe("revoked");
  });

  it("moves ERC-20 tokens in base units of the token's decimals", async () => {
    const holder = await agentWith("Token holder");
    const token = await deployToken(holder.agent.address, 10_000_000n);
    await f.setPolicy(
      f.workspaceId,
      holder.agent.walletId,
      draftFor(holder.agent.id, {
        assets: [
          {
            chainId: TEST_CHAIN_ID,
            asset: "native",
            maxPerTx: "1000000000000000000",
            maxPerDay: "1000000000000000000",
          },
          { chainId: TEST_CHAIN_ID, asset: token, maxPerTx: "5000000", maxPerDay: "5000000" },
        ],
      }),
    );
    const recipient = randomAddress();
    const tooPrecise = toolJson(
      await holder.client.callTool({
        name: "propose_transfer",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: recipient,
          amount: "1.0000001",
          asset: token,
          memo: "x",
        },
      }),
    );
    expect(tooPrecise).toMatchObject({ error: "invalid_request" });
    const { intentId, approvalId } = await propose(holder.client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "1.5",
      asset: token,
      memo: "token payout",
    });
    const detail = await intentStatus(intentId);
    expect(detail.display).toMatchObject({ assetSymbol: "TST", amount: "1500000", token });
    await f.t.approve(approvalId, [f.t.owner]);
    await followUntilDone(approvalId);
    const balance = await anvil.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [recipient],
    });
    expect(balance).toBe(1_500_000n);
    expect((await intentStatus(intentId)).status).toBe("confirmed");
  });

  it("keeps what an agent typed out of every column and every log line", async () => {
    const memoMarker = `OSMEMO${randomBytes(8).toString("hex")}`;
    const recipient = randomAddress();
    const target = await deployToken(randomAddress(), 1n);
    const { agent, client } = await agentWith("Caller", {
      contractCalls: { mode: "allowlist", targets: [target] },
    });
    const calldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, 0x0cafebabe0cafebaben],
    });
    const call = toolJson(
      await client.callTool({
        name: "propose_contract_call",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: target,
          data: calldata,
          memo: `call ${memoMarker}`,
        },
      }),
    );
    expect(call.status).toBe("pending_approval");
    const transfer = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.01",
      memo: `send ${memoMarker}`,
    });
    await f.t.approve(transfer.approvalId, [f.t.owner]);
    await followUntilDone(transfer.approvalId);

    const markers = [memoMarker, calldata.slice(10), recipient.slice(2)];
    const scan = await scanForMarkers(f.t.ctx.config.databaseUrl, markers);
    expect(scan.hits).toEqual([]);
    for (const marker of markers) {
      expect(f.t.log.lines.join("\n")).not.toContain(marker);
    }
    const [stored] = await f.t.ctx.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(stored?.tokenHash).not.toContain(agent.token);
  });
});

describe("origin check on the execution routes", () => {
  // The identity test app covers every other write; these four exist only here.
  const writes = (["startApproval", "approve", "reject", "requestSweep"] as const).map(
    (name) => [name, routes[name]] as const,
  );

  it.each(writes)("%s refuses a write without a same-site Origin", async (_name, route) => {
    const path = route.path.replace(/:[A-Za-z]+/g, "x");
    const init = {
      method: route.method,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const missing = await f.t.owner.browser.fetch(path, { ...init, origin: null });
    const foreign = await f.t.owner.browser.fetch(path, {
      ...init,
      origin: "https://evil.example",
    });
    for (const response of [missing, foreign]) {
      expect(response.status).toBe(403);
      expect(ApiErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
  });
});
