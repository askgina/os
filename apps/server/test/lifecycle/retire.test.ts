import { ApiError, type MandateDraft } from "@askgina/os-api";
import type { ApprovalId, IntentId, MandateId, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, intents, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { finalizeDue } from "../../src/lifecycle/finalize.ts";
import { hasUnminedTransactions } from "../../src/lifecycle/state.ts";
import {
  createFixture,
  draftFor,
  type Fixture,
  fund,
  type TestAgent,
  toolJson,
} from "../execution/fixture.ts";
import { TEST_CHAIN_ID } from "../support/context.ts";

const WEEK = 604_800;

const ETH = 10n ** 18n;

let f: Fixture;

beforeAll(async () => {
  f = await createFixture("lifecycle_retire");
});

afterAll(async () => {
  await f?.close();
});

const api = () => f.t.owner.browser.api;

const now = () => f.t.clock.now();

/** Move the shared clock, and sign the owner in again: a session lasts less than a week. */
async function advance(seconds: number): Promise<void> {
  f.t.clock.advance(seconds);
  await f.t.signIn(f.t.owner.credentialId, f.t.owner.browser);
}

async function refusal(call: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) {
      return error.detail === undefined
        ? { code: error.code }
        : { code: error.code, detail: error.detail };
    }

    throw error;
  }

  throw new Error("the call was not refused");
}

async function fundedAgent(ws: WorkspaceId, name: string): Promise<TestAgent> {
  const agent = await f.newAgent(name, ws);
  await f.setPolicy(ws, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 10n * ETH);

  return agent;
}

async function grantMandate(ws: WorkspaceId, agent: TestAgent): Promise<MandateId> {
  const draft: MandateDraft = {
    agentId: agent.id,
    assets: [
      {
        chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
        asset: "native",
        maxPerAction: ETH.toString(),
        maxPerWindow: (2n * ETH).toString(),
        maxTotal: (3n * ETH).toString(),
      },
    ],
    windowSeconds: 86_400,
    recipients: ["0x00000000000000000000000000000000000000aa"],
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: now() + 3 * 86_400,
    purpose: "pay the suppliers this week",
  };

  const opened = await api().call("proposeMandate", {
    params: { workspaceId: ws, walletId: agent.walletId },
    body: draft,
  });

  const row = await f.t.approve(opened.id as ApprovalId, [f.t.owner]);
  expect(row.status).toBe("executed");

  return row.subjectId as MandateId;
}

const requestRetire = (ws: WorkspaceId, walletId: WalletId, destroyAfter: number) =>
  api().call("requestRetireWallet", {
    params: { workspaceId: ws, walletId },
    body: { destroyAfter },
  });

const walletOf = (ws: WorkspaceId, walletId: WalletId) =>
  api().call("getWallet", { params: { workspaceId: ws, walletId } });

async function newestEventAbout(ws: WorkspaceId, walletId: WalletId): Promise<string | undefined> {
  const [row] = await f.t.ctx.db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, ws), eq(auditEvents.subjectId, walletId)))
    .orderBy(desc(auditEvents.seq))
    .limit(1);

  return row?.action;
}

/** Empty the wallet's native coin to the workspace's treasury and follow it to its block. */
async function sweepToTreasury(ws: WorkspaceId, walletId: WalletId, to: `0x${string}`) {
  const opened = await api().call("requestSweep", {
    params: { workspaceId: ws, walletId },
    body: { chainId: TEST_CHAIN_ID, asset: "native", to },
  });

  const approvalId = opened.id as ApprovalId;
  expect((await f.t.approve(approvalId, [f.t.owner])).status).toBe("executed");
  const steps = engineOf(f.t.ctx).steps();

  for (let i = 0; i < 20 && !(await steps.followUp(approvalId)).done; i += 1);

  return approvalId;
}

describe("retiring a wallet", () => {
  it("retires, cancels to held, comes back with a new policy, then is destroyed", async () => {
    const ws = await f.newWorkspace("Retire");
    const agent = await fundedAgent(ws, "Retiring");
    const other = await fundedAgent(ws, "Staying");
    const retiredMandate = await grantMandate(ws, agent);
    const otherMandate = await grantMandate(ws, other);

    expect(await refusal(requestRetire(ws, agent.walletId, now() + 3_600))).toEqual({
      code: "invalid_request",
      detail: "destroy_delay_out_of_range",
    });
    const firstDestroyAfter = now() + WEEK + 60;
    const opened = await requestRetire(ws, agent.walletId, firstDestroyAfter);
    expect(opened).toMatchObject({ kind: "retire-wallet", status: "pending", threshold: 1 });
    const detail = await api().call("getApproval", { params: { approvalId: opened.id } });
    expect(detail.envelope).toMatchObject({
      type: "retire-wallet",
      wallet: { walletId: agent.walletId, address: agent.address },
      destroyAfter: firstDestroyAfter,
    });
    expect(detail.subject).toMatchObject({
      kind: "retire-wallet",
      wallet: { id: agent.walletId },
      destroyAfter: firstDestroyAfter,
    });
    expect((await f.t.approve(opened.id as ApprovalId, [f.t.owner])).status).toBe("executed");

    expect((await walletOf(ws, agent.walletId)).lifecycle).toEqual({
      state: "retiring",
      destroyAfter: firstDestroyAfter,
    });
    expect((await f.t.ctx.signer.getWallet(agent.walletId)).state).toBe("retiring");
    // Its mandate ends now (D8); the other wallet's does not.
    expect((await f.t.ctx.signer.getMandate(retiredMandate)).status).toBe("revoked");
    expect((await f.t.ctx.signer.getMandate(otherMandate)).status).toBe("active");
    expect(await newestEventAbout(ws, agent.walletId)).toBe("wallet.retiring");
    expect(await refusal(requestRetire(ws, agent.walletId, firstDestroyAfter))).toEqual({
      code: "conflict",
      detail: "wallet_retired",
    });

    // Cancelled: the key stays, and the wallet signs nothing until a new policy.
    const held = await api().call("cancelRetireWallet", {
      params: { workspaceId: ws, walletId: agent.walletId },
      body: {},
    });

    expect(held.lifecycle).toEqual({ state: "held", destroyAfter: null });
    expect((await f.t.ctx.signer.getWallet(agent.walletId)).state).toBe("held");
    expect(
      await refusal(
        api().call("cancelRetireWallet", {
          params: { workspaceId: ws, walletId: agent.walletId },
          body: {},
        }),
      ),
    ).toEqual({ code: "conflict", detail: "not_retiring" });
    await f.setPolicy(ws, agent.walletId, draftFor(agent.id));
    expect((await walletOf(ws, agent.walletId)).lifecycle).toEqual({
      state: "active",
      destroyAfter: null,
    });
    expect((await f.t.ctx.signer.getMandate(retiredMandate)).status).toBe("revoked");

    // Retired again, and destroyed once its time has come.
    const destroyAfter = now() + WEEK + 60;
    const again = await requestRetire(ws, agent.walletId, destroyAfter);
    expect((await f.t.approve(again.id as ApprovalId, [f.t.owner])).status).toBe("executed");
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 0 });
    await advance(WEEK + 120);
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 1, skipped: 0 });
    expect((await walletOf(ws, agent.walletId)).lifecycle).toEqual({
      state: "destroyed",
      destroyAfter,
    });
    expect((await f.t.ctx.signer.getWallet(agent.walletId)).state).toBe("destroyed");
    expect(await newestEventAbout(ws, agent.walletId)).toBe("wallet.destroyed");
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 0 });
    expect((await walletOf(ws, other.walletId)).lifecycle.state).toBe("active");
    // A week on, the other wallet's mandate ran out on its own; nobody revoked it.
    expect((await f.t.ctx.signer.getMandate(otherMandate)).status).toBe("expired");
  });

  it("waits for a given-up transaction until a later one of its wallet used its nonce (D7)", async () => {
    const ws = await f.newWorkspace("Rejected nonce");
    const agent = await fundedAgent(ws, "Nonce");

    const treasury = await api().call("createTreasury", {
      params: { workspaceId: ws },
      body: { label: "Treasury" },
    });

    const first = await sweepToTreasury(ws, agent.walletId, treasury.address);
    await fund(agent.address, 5n * ETH);
    const second = await sweepToTreasury(ws, agent.walletId, treasury.address);
    const subject = { workspaceId: ws, walletId: agent.walletId };

    const setStatus = (approvalId: ApprovalId, status: "rejected" | "broadcast" | "confirmed") =>
      f.t.ctx.db
        .update(transactions)
        .set({ status })
        .where(eq(transactions.approvalId, approvalId));

    expect(await hasUnminedTransactions(f.t.ctx, subject)).toBe(false);

    // Given up on, but the next transaction of the wallet was mined at a later nonce.
    await setStatus(first, "rejected");
    expect(await hasUnminedTransactions(f.t.ctx, subject)).toBe(false);
    // Nothing used its nonce yet: it can still be mined.
    await setStatus(second, "rejected");
    expect(await hasUnminedTransactions(f.t.ctx, subject)).toBe(true);
    await setStatus(second, "broadcast");
    expect(await hasUnminedTransactions(f.t.ctx, subject)).toBe(true);
    expect(await hasUnminedTransactions(f.t.ctx, { workspaceId: ws, walletId: null })).toBe(true);
    await setStatus(second, "confirmed");
    expect(await hasUnminedTransactions(f.t.ctx, subject)).toBe(false);
  });
});

describe("removing an agent", () => {
  it("disabling it cancels its payments waiting for people and revokes them at the signer", async () => {
    const ws = await f.newWorkspace("Remove agent");
    const agent = await fundedAgent(ws, "Leaving");
    const client = await f.mcp(agent.token);

    const proposed = toolJson(
      await client.callTool({
        name: "propose_transfer",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: "0x00000000000000000000000000000000000000bb",
          amount: "0.01",
          memo: "rent",
        },
      }),
    );

    expect(proposed.status).toBe("pending_approval");

    const [intent] = await f.t.ctx.db
      .select({ approvalId: intents.approvalId })
      .from(intents)
      .where(eq(intents.id, proposed.intentId as IntentId));

    const approvalId = intent?.approvalId as ApprovalId;
    expect((await engineOf(f.t.ctx).row(approvalId)).status).toBe("pending");

    const disabled = await api().call("disableAgent", {
      params: { workspaceId: ws, agentId: agent.id },
      body: {},
    });

    expect(disabled.status).toBe("disabled");
    expect((await engineOf(f.t.ctx).row(approvalId)).status).toBe("cancelled");
    expect((await f.t.ctx.signer.getApproval(approvalId)).state).toBe("revoked");
    expect(f.t.log.lines.some((line) => line.includes('"event":"agent.payments_cancelled"'))).toBe(
      true,
    );
  });
});
