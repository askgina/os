import { randomBytes } from "node:crypto";
import type { ApprovalId, Sweep, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { eq } from "drizzle-orm";
import { erc20Abi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonceReservations, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { TEST_CHAIN_ID } from "../support/context.ts";
import { anvil, createFixture, deployToken, draftFor, type Fixture, fund } from "./fixture.ts";

let f: Fixture;

beforeAll(async () => {
  f = await createFixture("exec_sweep");
});
afterAll(async () => {
  await f?.close();
});

const steps = () => engineOf(f.t.ctx).steps();
const api = () => f.t.owner.browser.api;

/** A workspace whose agent wallet holds `wei`, with a treasury, and the agent then disabled. */
async function abandonedWallet(name: string, wei: bigint) {
  const workspaceId = await f.newWorkspace(name);
  const agent = await f.newAgent("Gone", workspaceId);
  await f.setPolicy(workspaceId, agent.walletId, draftFor(agent.id));
  await fund(agent.address, wei);
  const treasury = await api().call("createTreasury", {
    params: { workspaceId },
    body: { label: "Reserve" },
  });
  await api().call("disableAgent", { params: { workspaceId, agentId: agent.id }, body: {} });
  return { workspaceId, agent, treasury };
}

async function requestSweep(
  workspaceId: WorkspaceId,
  walletId: WalletId,
  body: { asset: "native" | `0x${string}`; to: `0x${string}` },
) {
  return api().call("requestSweep", {
    params: { workspaceId, walletId },
    body: { chainId: TEST_CHAIN_ID, ...body },
  });
}

async function sweepOf(approvalId: ApprovalId): Promise<Sweep> {
  const detail = await api().call("getApproval", { params: { approvalId } });
  if (detail.subject.kind !== "sweep-wallet") throw new Error(`a ${detail.subject.kind} request`);
  return detail.subject.sweep;
}

async function settle(approvalId: ApprovalId) {
  for (let i = 0; i < 20 && !(await steps().followUp(approvalId)).done; i += 1);
}

describe("sweeping a wallet whose agent is gone", () => {
  it("moves the native balance to the treasury once, also while the workspace is paused", async () => {
    const { workspaceId, agent, treasury } = await abandonedWallet("Sweep native", 3n * 10n ** 18n);
    await api().call("pauseWorkspace", { params: { workspaceId }, body: {} });

    const request = await requestSweep(workspaceId, agent.walletId, {
      asset: "native",
      to: treasury.address,
    });
    expect(request).toMatchObject({ kind: "sweep-wallet", status: "pending", threshold: 1 });
    const approvalId = request.id as ApprovalId;
    const sweep = await sweepOf(approvalId);
    const nonceBefore = await anvil.getTransactionCount({ address: agent.address });

    expect((await f.t.approve(approvalId, [f.t.owner])).status).toBe("executed");
    await settle(approvalId);

    expect(await anvil.getBalance({ address: treasury.address })).toBe(BigInt(sweep.amount));
    // What stays behind is less than the fee ceiling the sweep reserved.
    expect(await anvil.getBalance({ address: agent.address })).toBeLessThan(
      BigInt(sweep.maxFeeWei),
    );
    expect(await anvil.getTransactionCount({ address: agent.address })).toBe(nonceBefore + 1);
    const [row] = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.approvalId, approvalId));
    expect(row).toMatchObject({ intentId: null, status: "confirmed" });

    // Running the step again, or asking the signer again, makes no second transaction.
    expect(await steps().execute(approvalId)).toEqual({ ok: true });
    await settle(approvalId);
    expect(await anvil.getTransactionCount({ address: agent.address })).toBe(nonceBefore + 1);
    expect(await anvil.getBalance({ address: treasury.address })).toBe(BigInt(sweep.amount));

    const detail = await api().call("getApproval", { params: { approvalId } });
    expect(detail.subject).toMatchObject({
      kind: "sweep-wallet",
      destination: "treasury",
      transaction: { status: "confirmed" },
    });
  });

  it("moves the whole balance of a token, paying the fee in the native coin", async () => {
    const { workspaceId, agent, treasury } = await abandonedWallet("Sweep token", 10n ** 18n);
    const token = await deployToken(agent.address, 123_456_789n);
    const request = await requestSweep(workspaceId, agent.walletId, {
      asset: token,
      to: treasury.address,
    });
    const approvalId = request.id as ApprovalId;
    expect((await sweepOf(approvalId)).amount).toBe("123456789");

    expect((await f.t.approve(approvalId, [f.t.owner])).status).toBe("executed");
    await settle(approvalId);
    const balanceOf = (address: `0x${string}`) =>
      anvil.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
    expect(await balanceOf(agent.address)).toBe(0n);
    expect(await balanceOf(treasury.address)).toBe(123_456_789n);
  });

  it("ends as failed with the signer's code when the destination is not allowed, and sends nothing", async () => {
    const { workspaceId, agent } = await abandonedWallet("Sweep elsewhere", 10n ** 18n);
    const stranger = `0x${randomBytes(20).toString("hex")}` as const;
    const nonceBefore = await anvil.getTransactionCount({ address: agent.address });
    // The control plane opens the request; only the signer decides where a sweep may go.
    const request = await requestSweep(workspaceId, agent.walletId, {
      asset: "native",
      to: stranger,
    });
    const approvalId = request.id as ApprovalId;
    const before = await api().call("getApproval", { params: { approvalId } });
    expect(before.subject).toMatchObject({ kind: "sweep-wallet", destination: null });

    const ended = await f.t.approve(approvalId, [f.t.owner]);
    expect(ended).toMatchObject({
      status: "failed",
      failureCode: "sweep_destination_not_allowed",
    });
    expect(await anvil.getBalance({ address: stranger })).toBe(0n);
    expect(await anvil.getTransactionCount({ address: agent.address })).toBe(nonceBefore);
    const reservations = await f.t.ctx.db
      .select()
      .from(nonceReservations)
      .where(eq(nonceReservations.approvalId, approvalId));
    expect(reservations).toEqual([]);
  });

  it("is refused to anyone but an owner, and for a wallet with nothing to move", async () => {
    const { workspaceId, agent, treasury } = await abandonedWallet("Sweep refused", 0n);
    await expect(
      requestSweep(workspaceId, agent.walletId, { asset: "native", to: treasury.address }),
    ).rejects.toMatchObject({ code: "conflict", detail: "nothing_to_sweep" });
    const bob = await f.addApprover(workspaceId, "Bob Approver");
    await expect(
      bob.browser.api.call("requestSweep", {
        params: { workspaceId, walletId: agent.walletId },
        body: { chainId: TEST_CHAIN_ID, asset: "native", to: treasury.address },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
