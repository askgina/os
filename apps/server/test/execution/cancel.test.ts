import { randomBytes } from "node:crypto";
import type { ApprovalSummary, MandateDraft } from "@askgina/os-api";
import type {
  ApprovalId,
  ChainId,
  IntentId,
  MandateId,
  WalletId,
  WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import type { Client } from "@modelcontextprotocol/client";
import { and, asc, eq } from "drizzle-orm";
import { formatEther, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  intents,
  notificationDeliveries,
  transactionAttempts,
  transactions,
} from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { chainAccess } from "../../src/execution/chains.ts";
import { MCP_TOOL_NAMES } from "../../src/mcp/gateway.ts";
import { TEST_CHAIN_ID, type TestBrowser, type TestPerson } from "../support/context.ts";
import {
  anvil,
  createFixture,
  draftFor,
  type Fixture,
  fund,
  type TestAgent,
  toolJson,
} from "./fixture.ts";

const ETH = 10n ** 18n;
const AMOUNT = 10n ** 16n;

let f: Fixture;
let bob: TestPerson;

beforeAll(async () => {
  f = await createFixture("exec_cancel");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
});
afterAll(async () => {
  await f?.close();
});

const api = () => f.t.owner.browser.api;
const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
const steps = () => engineOf(f.t.ctx).steps();
const followUp = (approvalId: ApprovalId) => steps().followUp(approvalId);
const intentOf = (intentId: IntentId) => api().call("getIntent", { params: { intentId } });
/** Far enough past the newest attempt for a person's speed-up to make another. */
const pastSpacing = () => f.t.clock.advance(16);

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

/** Run with every broadcast held back, as when a fee is too low to be mined. */
async function holding(run: (sent: Hex[]) => Promise<void>) {
  const sent: Hex[] = [];
  await patched(
    chainAccess(f.t.ctx),
    "broadcast",
    async (_chainId: ChainId, _raw: Hex, hash: Hex) => {
      sent.push(hash);
    },
    () => run(sent),
  );
}

async function agentClient(
  name: string,
  workspaceId: WorkspaceId = f.workspaceId,
): Promise<{ agent: TestAgent; client: Client }> {
  const agent = await f.newAgent(name, workspaceId);
  await f.setPolicy(workspaceId, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 50n * ETH);
  return { agent, client: await f.mcp(agent.token) };
}

async function propose(client: Client, to: `0x${string}`) {
  const answer = toolJson(
    await client.callTool({
      name: "propose_transfer",
      arguments: { chainId: TEST_CHAIN_ID, to, amount: formatEther(AMOUNT), memo: "test" },
    }),
  );
  if (typeof answer.intentId !== "string") throw new Error(JSON.stringify(answer));
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, answer.intentId as IntentId));
  if (!row?.approvalId) throw new Error("an intent without its approval");
  return { intentId: row.id, approvalId: row.approvalId };
}

interface Payment {
  agent: TestAgent;
  client: Client;
  workspaceId: WorkspaceId;
  intentId: IntentId;
  approvalId: ApprovalId;
  to: `0x${string}`;
}

/** Approve with `people` on the confirmation page, sign and send; must run inside `holding`. */
async function sendPayment(
  sender: { agent: TestAgent; client: Client },
  workspaceId: WorkspaceId = f.workspaceId,
  people: TestPerson[] = [f.t.owner],
): Promise<Payment> {
  const to = randomAddress();
  const { intentId, approvalId } = await propose(sender.client, to);
  for (const person of people) await f.t.approveOnPage(person, approvalId);
  expect(await steps().execute(approvalId)).toEqual({ ok: true });
  await followUp(approvalId);
  expect((await transactionRow(approvalId)).status).toBe("broadcast");
  return { ...sender, workspaceId, intentId, approvalId, to };
}

async function transactionRow(approvalId: ApprovalId) {
  const [row] = await f.t.ctx.db
    .select()
    .from(transactions)
    .where(eq(transactions.approvalId, approvalId));
  if (!row) throw new Error("no transaction");
  return row;
}

const attemptRows = (approvalId: ApprovalId) =>
  f.t.ctx.db
    .select()
    .from(transactionAttempts)
    .where(eq(transactionAttempts.approvalId, approvalId))
    .orderBy(asc(transactionAttempts.attempt));

/** Hand one stored attempt to the chain directly; the test chain mines it at once. */
async function mine(workspaceId: WorkspaceId, approvalId: ApprovalId, attempt: number) {
  const sealed =
    attempt === 0
      ? (await transactionRow(approvalId)).raw
      : (await attemptRows(approvalId)).find((row) => row.attempt === attempt)?.raw;
  if (!sealed) throw new Error(`no attempt ${attempt}`);
  const location =
    attempt === 0 ? `transactions.raw:${approvalId}` : `transactions.raw:${approvalId}:${attempt}`;
  const raw = (await f.t.ctx.sealer.open(workspaceId, location, sealed)) as Hex;
  await anvil.sendRawTransaction({ serializedTransaction: raw });
}

async function followUntilDone(approvalId: ApprovalId) {
  for (let i = 0; i < 20; i += 1) if ((await followUp(approvalId)).done) return;
  throw new Error("the follow-up never finished");
}

const auditActors = async (subjectId: string, action: string) =>
  (
    await f.t.ctx.db
      .select({ actorType: auditEvents.actorType, actorId: auditEvents.actorId })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, subjectId), eq(auditEvents.action, action)))
  ).map((row) => `${row.actorType}:${row.actorId ?? ""}`);

/** A person who joined `workspaceId` through an invite, signed in in their own browser. */
async function invited(workspaceId: WorkspaceId, role: "viewer" | "approver", name: string) {
  const invite = await api().call("createInvite", { params: { workspaceId }, body: { role } });
  const token = invite.url.split("/").at(-1) ?? "";
  const browser: TestBrowser = f.t.browser();
  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });
  const passkey = f.t.register(start.options);
  await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
  });
  return browser;
}

describe("speeding up a payment", () => {
  it("lets an approver add an attempt with no passkey, answers a second click with the same, and refuses viewers and strangers", async () => {
    const sender = await agentClient("Sped up");
    await holding(async (sent) => {
      const payment = await sendPayment(sender);
      const before = await intentOf(payment.intentId);
      expect(before.transaction).toMatchObject({
        status: "broadcast",
        minedAttempt: null,
        canSpeedUp: true,
        canCancel: true,
        pendingCancelApprovalId: null,
      });
      expect(before.transaction?.attempts).toEqual([
        expect.objectContaining({ attempt: 0, kind: "original", status: "pending" }),
      ]);

      const viewer = await invited(f.workspaceId, "viewer", "Vera Viewer");
      const elsewhere = await f.newWorkspace("Somewhere else");
      const stranger = await invited(elsewhere, "approver", "Sam Stranger");
      const params = { intentId: payment.intentId };
      await expect(viewer.api.call("speedUp", { params, body: {} })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(stranger.api.call("speedUp", { params, body: {} })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(viewer.api.call("requestCancel", { params, body: {} })).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await attemptRows(payment.approvalId)).toEqual([]);

      pastSpacing();
      const sped = await bob.browser.api.call("speedUp", { params, body: {} });
      const [first, second] = sped.transaction?.attempts ?? [];
      expect(second).toMatchObject({ attempt: 1, kind: "reprice", status: "pending" });
      expect(BigInt(second?.maxFeePerGas ?? 0)).toBeGreaterThan(BigInt(first?.maxFeePerGas ?? 0));
      expect(sped.transactionHash).toBe(second?.hash);
      expect(sped.transaction?.hash).toBe(second?.hash);
      expect(sent.at(-1)).toBe(second?.hash);
      expect(await auditActors(payment.approvalId, "transaction.repriced")).toEqual([
        `user:${bob.userId}`,
      ]);
      // A second click right away makes no attempt and answers the same.
      const again = await bob.browser.api.call("speedUp", { params, body: {} });
      expect(again.transaction?.attempts).toHaveLength(2);

      // The agent reads every attempt and is offered nothing to do about them.
      const read = toolJson(
        await payment.client.callTool({
          name: "get_intent",
          arguments: { intentId: payment.intentId },
        }),
      );
      expect(read).toMatchObject({
        status: "broadcast",
        transactionHash: second?.hash,
        stuckReason: null,
      });
      expect(read.attempts).toEqual([
        {
          attempt: 0,
          kind: "original",
          hash: first?.hash,
          maxFeePerGas: first?.maxFeePerGas,
          maxPriorityFeePerGas: first?.maxPriorityFeePerGas,
          status: "pending",
          explorerUrl: first?.explorerUrl,
        },
        expect.objectContaining({ attempt: 1, kind: "reprice", hash: second?.hash }),
      ]);
      for (const key of ["canSpeedUp", "canCancel", "pendingCancelApprovalId"]) {
        expect(read).not.toHaveProperty(key);
      }
      const listed = toolJson(
        await payment.client.callTool({ name: "list_intents", arguments: {} }),
      );
      expect(listed.intents).toEqual([
        expect.objectContaining({ intentId: payment.intentId, attempts: read.attempts }),
      ]);
      const { tools } = await payment.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      expect(tools).toHaveLength(7);

      await mine(payment.workspaceId, payment.approvalId, 1);
      await followUntilDone(payment.approvalId);
      const mined = await intentOf(payment.intentId);
      expect(mined).toMatchObject({ status: "confirmed", transactionHash: second?.hash });
      expect(mined.transaction).toMatchObject({
        minedAttempt: 1,
        canSpeedUp: false,
        canCancel: false,
        stuckReason: null,
      });
      expect(mined.transaction?.attempts.map((attempt) => attempt.status)).toEqual([
        "not_mined",
        "mined",
      ]);
      await expect(bob.browser.api.call("speedUp", { params, body: {} })).rejects.toMatchObject({
        code: "conflict",
        detail: "not_repriceable",
      });
    });
  });

  it("says why a higher fee would not help: an earlier unmined nonce, a stopped reprice, a pause", async () => {
    const workspaceId = await f.newWorkspace("Speed-up answers");
    const sender = await agentClient("Answers", workspaceId);
    await holding(async () => {
      const first = await sendPayment(sender, workspaceId);
      const second = await sendPayment(sender, workspaceId);
      const speedUp = (intentId: IntentId) =>
        api().call("speedUp", { params: { intentId }, body: {} });

      pastSpacing();
      await expect(speedUp(second.intentId)).rejects.toMatchObject({
        code: "conflict",
        detail: "waiting_behind_nonce",
      });
      expect((await intentOf(second.intentId)).transaction).toMatchObject({
        stuckReason: "waiting_behind_nonce",
        canSpeedUp: false,
        canCancel: true,
      });

      // A refusal that would only repeat stops repricing, and is said again without asking.
      let calls = 0;
      await patched(
        f.t.ctx.signer,
        "reprice",
        async () => {
          calls += 1;
          throw new SignerError("reprice_window_closed", "closed", 403);
        },
        async () => {
          for (let i = 0; i < 2; i += 1) {
            await expect(speedUp(first.intentId)).rejects.toMatchObject({
              code: "conflict",
              detail: "reprice_window_closed",
            });
          }
        },
      );
      expect(calls).toBe(1);
      expect((await intentOf(first.intentId)).transaction).toMatchObject({
        stuckReason: "reprice_window_closed",
        canSpeedUp: false,
        canCancel: true,
      });

      await api().call("pauseWorkspace", { params: { workspaceId }, body: {} });
      await expect(speedUp(second.intentId)).rejects.toMatchObject({
        code: "conflict",
        detail: "workspace_paused",
      });
      expect((await intentOf(second.intentId)).transaction).toMatchObject({
        canSpeedUp: false,
        canCancel: true,
      });

      await mine(workspaceId, first.approvalId, 0);
      await mine(workspaceId, second.approvalId, 0);
      await followUntilDone(first.approvalId);
      await followUntilDone(second.approvalId);
      expect((await intentOf(second.intentId)).status).toBe("confirmed");
    });
  });
});

describe("cancelling a payment", () => {
  it("is approved on the confirmation page at the wallet's threshold, signed and sent, and voids the payment when mined; the spend still counts", async () => {
    const workspaceId = await f.newWorkspace("Two to cancel");
    const second = await f.addApprover(workspaceId, "Bea Second");
    // A policy may ask two people only once the workspace's admin threshold is two.
    const raise = await api().call("requestAdminThreshold", {
      params: { workspaceId },
      body: { adminThreshold: 2 },
    });
    expect((await f.t.approve(raise.id as ApprovalId, [f.t.owner])).status).toBe("executed");
    const agent = await f.newAgent("Cancelled", workspaceId);
    const policy = await api().call("requestPolicy", {
      params: { workspaceId, walletId: agent.walletId },
      body: { draft: draftFor(agent.id, { approvals: { threshold: 2, ttlSeconds: 3_600 } }) },
    });
    expect((await f.t.approve(policy.id as ApprovalId, [f.t.owner, second])).status).toBe(
      "executed",
    );
    await fund(agent.address, 50n * ETH);
    const sender = { agent, client: await f.mcp(agent.token) };
    await holding(async (sent) => {
      const payment = await sendPayment(sender, workspaceId, [f.t.owner, second]);
      const start = await anvil.getTransactionCount({ address: payment.agent.address });
      const spent = (await f.t.ctx.signer.getWallet(payment.agent.walletId)).spent;
      const params = { intentId: payment.intentId };

      const notify = f.t.ctx.config.notify;
      f.t.ctx.config.notify = {
        webhook: { url: "http://127.0.0.1:9/hook", secret: new Uint8Array(32) },
        webPush: null,
      };
      let opened: ApprovalSummary;
      try {
        opened = await second.browser.api.call("requestCancel", { params, body: {} });
      } finally {
        f.t.ctx.config.notify = notify;
      }
      expect(opened).toMatchObject({ kind: "cancel-transaction", status: "pending", threshold: 2 });
      expect(opened.title).toMatch(/^Cancel payment: Send 0\.01 ETH to 0x/);
      const cancelId = opened.id as ApprovalId;
      const outbox = await f.t.ctx.db
        .select({ event: notificationDeliveries.event, target: notificationDeliveries.target })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.approvalId, cancelId));
      expect(outbox).toEqual([{ event: "approval.opened", target: "webhook" }]);
      // While it waits, asking again answers the same request.
      const repeated = await api().call("requestCancel", { params, body: {} });
      expect(repeated.id).toBe(cancelId);
      expect((await intentOf(payment.intentId)).transaction).toMatchObject({
        canCancel: false,
        pendingCancelApprovalId: cancelId,
      });

      const detail = await api().call("getApproval", { params: { approvalId: cancelId } });
      const { nonce } = await transactionRow(payment.approvalId);
      expect(detail.envelope).toMatchObject({
        type: "cancel-transaction",
        targetApprovalId: payment.approvalId,
        walletId: payment.agent.walletId,
        txNonce: nonce,
        maxFeeWei: draftFor(payment.agent.id).fees.maxPerTxWei,
      });
      expect(detail.subject).toMatchObject({
        kind: "cancel-transaction",
        intent: { id: payment.intentId },
        sweep: null,
        txNonce: nonce,
        transaction: { status: "broadcast", attempts: [{ attempt: 0 }] },
      });
      expect(detail.confirmUrl).not.toBeNull();

      expect((await f.t.approveOnPage(f.t.owner, cancelId)).status).toBe("pending");
      expect((await f.t.approveOnPage(second, cancelId)).status).toBe("approved");
      expect(await steps().execute(cancelId)).toEqual({ ok: true });
      // Run again, as after a crash: nothing more is signed.
      expect(await steps().execute(cancelId)).toEqual({ ok: true });
      const [cancel, ...more] = await attemptRows(payment.approvalId);
      expect(more).toEqual([]);
      expect(cancel).toMatchObject({ attempt: 1, kind: "cancel", cancelApprovalId: cancelId });
      expect(sent.at(-1)).toBe(cancel?.hash);
      expect(await auditActors(payment.approvalId, "transaction.cancel_signed")).toEqual([
        "system:",
      ]);
      expect(await auditActors(payment.approvalId, "transaction.cancel_requested")).toEqual([
        `user:${second.userId}`,
      ]);

      await mine(workspaceId, payment.approvalId, 1);
      await followUntilDone(payment.approvalId);
      const voided = await intentOf(payment.intentId);
      expect(voided).toMatchObject({
        status: "voided",
        failureCode: "transaction_cancelled",
        transactionHash: cancel?.hash,
        transaction: { status: "cancelled", minedAttempt: 1, canCancel: false },
      });
      expect(voided.transaction?.attempts.map((attempt) => attempt.status)).toEqual([
        "not_mined",
        "mined",
      ]);
      expect(await anvil.getBalance({ address: payment.to })).toBe(0n);
      expect(await anvil.getTransactionCount({ address: payment.agent.address })).toBe(start + 1);
      expect((await f.t.ctx.signer.getWallet(payment.agent.walletId)).spent).toEqual(spent);
      await expect(api().call("requestCancel", { params, body: {} })).rejects.toMatchObject({
        code: "conflict",
        detail: "transaction_final",
      });
    });
  });

  it("is refused before anything was sent, and ends cleanly when the payment is mined first", async () => {
    const sender = await agentClient("Too late");
    const waiting = await propose(sender.client, randomAddress());
    await expect(
      api().call("requestCancel", { params: { intentId: waiting.intentId }, body: {} }),
    ).rejects.toMatchObject({ code: "conflict", detail: "not_sent" });

    await holding(async () => {
      // Mined while the cancel request waits: the request ends cancelled, nobody is asked.
      const payment = await sendPayment(sender);
      const params = { intentId: payment.intentId };
      const opened = await api().call("requestCancel", { params, body: {} });
      await mine(payment.workspaceId, payment.approvalId, 0);
      await followUntilDone(payment.approvalId);
      const ended = await f.t.settle(opened.id as ApprovalId);
      expect(ended.status).toBe("cancelled");
      expect(await f.t.ctx.signer.getApproval(opened.id as ApprovalId)).toMatchObject({
        state: "revoked",
      });
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "confirmed",
        failureCode: null,
      });

      // Approved, but mined before it could be signed: it ends failed, and nothing is signed.
      const raced = await sendPayment(sender);
      const late = await api().call("requestCancel", {
        params: { intentId: raced.intentId },
        body: {},
      });
      expect((await f.t.approveOnPage(f.t.owner, late.id as ApprovalId)).status).toBe("approved");
      await mine(raced.workspaceId, raced.approvalId, 0);
      await followUntilDone(raced.approvalId);
      expect(await steps().execute(late.id as ApprovalId)).toEqual({
        ok: false,
        code: "transaction_final",
      });
      expect(await attemptRows(raced.approvalId)).toEqual([]);
    });
  });

  it("cancels a sweep while the workspace is paused, and a payment a mandate covered", async () => {
    const workspaceId = await f.newWorkspace("Cancel a sweep");
    const sender = await agentClient("Swept", workspaceId);
    const treasury = await api().call("createTreasury", {
      params: { workspaceId },
      body: { label: "Reserve" },
    });
    await holding(async () => {
      const sweep = await api().call("requestSweep", {
        params: { workspaceId, walletId: sender.agent.walletId },
        body: { chainId: TEST_CHAIN_ID, asset: "native", to: treasury.address },
      });
      const sweepId = sweep.id as ApprovalId;
      expect((await f.t.approve(sweepId, [f.t.owner])).status).toBe("executed");
      await followUp(sweepId);
      await api().call("pauseWorkspace", { params: { workspaceId }, body: {} });

      const shown = await api().call("getApproval", { params: { approvalId: sweepId } });
      expect(shown.subject).toMatchObject({
        kind: "sweep-wallet",
        transaction: { status: "broadcast", canSpeedUp: false, canCancel: true },
      });
      const opened = await api().call("requestSweepCancel", {
        params: { approvalId: sweepId },
        body: {},
      });
      expect(opened.title).toMatch(/^Cancel sweep: Empty /);
      const cancelId = opened.id as ApprovalId;
      const detail = await api().call("getApproval", { params: { approvalId: cancelId } });
      expect(detail.subject).toMatchObject({
        kind: "cancel-transaction",
        intent: null,
        sweep: { approvalId: sweepId },
      });
      expect((await f.t.approve(cancelId, [f.t.owner])).status).toBe("executed");
      await mine(workspaceId, sweepId, 1);
      await followUntilDone(sweepId);
      const ended = await api().call("getApproval", { params: { approvalId: sweepId } });
      expect(ended.subject).toMatchObject({
        transaction: { status: "cancelled", minedAttempt: 1 },
      });
      expect(await anvil.getBalance({ address: treasury.address })).toBe(0n);
      // Only a sweep is cancelled through its request; a payment goes through its intent.
      const other = await propose((await agentClient("Not a sweep")).client, randomAddress());
      await expect(
        api().call("requestSweepCancel", { params: { approvalId: other.approvalId }, body: {} }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    const mandated = await agentClient("Mandated");
    const to = randomAddress();
    const draft: MandateDraft = {
      agentId: mandated.agent.id,
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
      recipients: [to],
      maxUses: 5,
      maxFeePerActionWei: "100000000000000000",
      notAfter: f.t.clock.now() + 3 * 86_400,
      purpose: "pay the supplier",
    };
    const grant = await api().call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: mandated.agent.walletId as WalletId },
      body: draft,
    });
    const granted = await f.t.approve(grant.id as ApprovalId, [bob]);
    expect(granted.status).toBe("executed");
    const mandateId = granted.subjectId as MandateId;
    await holding(async () => {
      const { intentId, approvalId } = await propose(mandated.client, to);
      expect(await steps().execute(approvalId)).toEqual({ ok: true });
      await followUp(approvalId);
      const usage = (await f.t.ctx.signer.getMandate(mandateId)).usage;
      const opened = await bob.browser.api.call("requestCancel", {
        params: { intentId },
        body: {},
      });
      expect((await f.t.approve(opened.id as ApprovalId, [f.t.owner])).status).toBe("executed");
      await mine(f.workspaceId, approvalId, 1);
      await followUntilDone(approvalId);
      expect(await intentOf(intentId)).toMatchObject({
        status: "voided",
        mandateId,
        failureCode: "transaction_cancelled",
      });
      expect(await anvil.getBalance({ address: to })).toBe(0n);
      expect((await f.t.ctx.signer.getMandate(mandateId)).usage).toEqual(usage);
    });
  });
});
