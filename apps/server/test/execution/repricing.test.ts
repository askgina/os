import { randomBytes } from "node:crypto";
import type { MandateDraft } from "@askgina/os-api";
import {
  type ApprovalId,
  AssertionResponse,
  type CancelTransactionEnvelope,
  type ChainId,
  envelopeChallenge,
  Hex,
  type IntentId,
  MandateId,
  newId,
  PROTOCOL_VERSION,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  type AttemptResponse,
  type RepriceRequest,
  SignerError,
} from "@askgina/os-protocol/signer";
import type { Client } from "@modelcontextprotocol/client";
import { and, asc, eq } from "drizzle-orm";
import { formatEther, parseTransaction } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  intents,
  transactionAttempts,
  transactions,
  workspaces,
} from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { chainAccess, type FeeQuote } from "../../src/execution/chains.ts";
import { nextFees, speedUp } from "../../src/execution/repricing.ts";
import { lockAttempts, recordAttempt } from "../../src/execution/transactions.ts";
import { TEST_APPROVAL_ORIGIN, TEST_CHAIN_ID, type TestPerson } from "../support/context.ts";
import {
  anvil,
  createFixture,
  draftFor,
  type Fixture,
  fund,
  intentIdOf,
  type TestAgent,
  toolJson,
} from "./fixture.ts";

/** The signer's reprice window here: short, so one test can pass it. */
const WINDOW_SECONDS = 2_000;

const ETH = 10n ** 18n;

const AMOUNT = 10n ** 16n;

let f: Fixture;

let bob: TestPerson;

beforeAll(async () => {
  f = await createFixture("exec_repricing", 1, { repriceWindowSeconds: WINDOW_SECONDS });
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
});

afterAll(async () => {
  await f?.close();
});

const randomAddress = (): `0x${string}` => `0x${randomBytes(20).toString("hex")}`;

const steps = () => engineOf(f.t.ctx).steps();

const followUp = (approvalId: ApprovalId) => steps().followUp(approvalId);

/** Move the clock past the point where an automatic reprice is due. */
const due = () => f.t.clock.advance(f.t.ctx.config.reprice.afterSeconds + 1);

const intentOf = (intentId: IntentId) =>
  f.t.owner.browser.api.call("getIntent", { params: { intentId } });

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

/**
 * Run with every broadcast held back: the chain never sees what the control plane offers, as
 * when its fee is too low to be mined or a node dropped it. `sent` lists the hashes offered.
 */
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

/** Count the signer's reprices while `run` runs; they still reach the signer. */
async function countingReprices(run: (requests: RepriceRequest[]) => Promise<void>) {
  const signer = f.t.ctx.signer;
  const real = signer.reprice.bind(signer);
  const requests: RepriceRequest[] = [];
  await patched(
    signer,
    "reprice",
    async (approvalId: ApprovalId, request: RepriceRequest) => {
      requests.push(request);

      return real(approvalId, request);
    },
    () => run(requests),
  );
}

interface Payment {
  agent: TestAgent;
  workspaceId: WorkspaceId;
  intentId: IntentId;
  approvalId: ApprovalId;
  to: `0x${string}`;
}

async function agentClient(name: string, workspaceId: WorkspaceId = f.workspaceId) {
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

  const intentId = intentIdOf(answer);

  const [row] = await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId));

  if (!row?.approvalId) throw new Error("an intent without its approval");

  return { intentId: row.id, approvalId: row.approvalId };
}

/** Propose, approve, sign and send a payment; must run inside {@link holding}. */
async function sendPayment(
  name: string,
  workspaceId: WorkspaceId = f.workspaceId,
): Promise<Payment> {
  const { agent, client } = await agentClient(name, workspaceId);
  const to = randomAddress();
  const { intentId, approvalId } = await propose(client, to);
  await f.t.approveOnPage(f.t.owner, approvalId);
  expect(await steps().execute(approvalId)).toEqual({ ok: true });
  await followUp(approvalId);
  expect((await transactionRow(approvalId)).status).toBe("broadcast");

  return { agent, workspaceId, intentId, approvalId, to };
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

/** The signed bytes of one attempt, as the control plane stored them. */
async function rawOf(payment: Payment, attempt: number): Promise<Hex> {
  if (attempt === 0) {
    const row = await transactionRow(payment.approvalId);

    return Hex.parse(
      await f.t.ctx.sealer.open(
        payment.workspaceId,
        `transactions.raw:${payment.approvalId}`,
        row.raw,
      ),
    );
  }

  const stored = (await attemptRows(payment.approvalId)).find((row) => row.attempt === attempt);

  if (!stored) throw new Error(`no attempt ${attempt}`);

  return Hex.parse(
    await f.t.ctx.sealer.open(
      payment.workspaceId,
      `transactions.raw:${payment.approvalId}:${attempt}`,
      stored.raw,
    ),
  );
}

/** Hand an attempt to the chain directly; the test chain mines it at once. */
async function mine(payment: Payment, attempt: number) {
  await anvil.sendRawTransaction({ serializedTransaction: await rawOf(payment, attempt) });
}

async function followUntilDone(approvalId: ApprovalId) {
  for (let i = 0; i < 20; i += 1) if ((await followUp(approvalId)).done) return;
  throw new Error("the follow-up never finished");
}

/** The signer's own list of the payment's attempts, by hash. */
async function signerHashes(approvalId: ApprovalId) {
  return (await f.t.ctx.signer.getApproval(approvalId)).attempts.map(
    (attempt) => attempt.transactionHash,
  );
}

async function localHashes(payment: Payment) {
  const row = await transactionRow(payment.approvalId);

  return [row.hash, ...(await attemptRows(payment.approvalId)).map((attempt) => attempt.hash)];
}

/**
 * A cancel approved with the owner's passkey and signed by the signer, stored as the control
 * plane stores one. The control plane opens the request through `requestCancel`; here the
 * envelope goes to the signer directly.
 */
async function cancelOf(payment: Payment): Promise<AttemptResponse> {
  const row = await transactionRow(payment.approvalId);
  const now = f.t.clock.now();

  const envelope: CancelTransactionEnvelope = {
    v: PROTOCOL_VERSION,
    approvalId: newId("apr"),
    workspaceId: payment.workspaceId,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: now,
    expiresAt: now + 300,
    type: "cancel-transaction",
    targetApprovalId: payment.approvalId,
    walletId: payment.agent.walletId,
    chainId: TEST_CHAIN_ID,
    txNonce: row.nonce,
    maxFeeWei: String(10n ** 16n),
  };

  const response = AssertionResponse.parse(
    f.t.authenticator.authenticate({
      credentialId: f.t.owner.credentialId,
      challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
      origin: TEST_APPROVAL_ORIGIN,
    }),
  );

  const latest = (await f.t.ctx.signer.getApproval(payment.approvalId)).attempts.at(-1);

  if (!latest) throw new Error("nothing signed");

  const cancelled = await f.t.ctx.signer.cancelTransaction(payment.approvalId, {
    authorization: {
      envelope,
      assertions: [{ userId: f.t.owner.userId, credentialId: f.t.owner.credentialId, response }],
    },
    attempt: latest.attempt + 1,
    maxFeePerGas: String(BigInt(latest.maxFeePerGas) * 2n),
    maxPriorityFeePerGas: String(BigInt(latest.maxPriorityFeePerGas) * 2n + 1n),
  });

  await f.t.ctx.db.transaction(async (tx) => {
    await lockAttempts(tx, payment.approvalId);
    await recordAttempt(f.t.ctx, tx, {
      workspaceId: payment.workspaceId,
      transaction: await transactionRow(payment.approvalId),
      response: cancelled,
      cancelApprovalId: null,
    });
  });

  return cancelled;
}

const auditCount = async (intentId: IntentId, action: string) =>
  (
    await f.t.ctx.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, intentId), eq(auditEvents.action, action)))
  ).length;

describe("nextFees", () => {
  const quote: FeeQuote = { baseFeePerGas: 10n, maxPriorityFeePerGas: 2n };

  it("raises both fields by the bump, lifts a zero tip to at least 1 wei, and reports the ceiling", () => {
    expect(
      nextFees({
        latest: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
        gas: 21_000n,
        ceilingWei: 21_000n * 10_000n,
        quote,
        bumpPercent: 12,
      }),
    ).toEqual({ kind: "fees", maxFeePerGas: 1_120n, maxPriorityFeePerGas: 112n });
    // Rounded up, never below 1 wei more, and never below what the chain asks now.
    expect(
      nextFees({
        latest: { maxFeePerGas: 5n, maxPriorityFeePerGas: 0n },
        gas: 21_000n,
        ceilingWei: 21_000n * 10_000n,
        quote: { baseFeePerGas: 100n, maxPriorityFeePerGas: 0n },
        bumpPercent: 12,
      }),
    ).toEqual({ kind: "fees", maxFeePerGas: 201n, maxPriorityFeePerGas: 1n });
    // Cut to the ceiling while that still raises both.
    expect(
      nextFees({
        latest: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
        gas: 100n,
        ceilingWei: 100n * 1_500n,
        quote: { baseFeePerGas: 5_000n, maxPriorityFeePerGas: 2n },
        bumpPercent: 12,
      }),
    ).toEqual({ kind: "fees", maxFeePerGas: 1_500n, maxPriorityFeePerGas: 112n });
    // No room for the bump: the ceiling is reached.
    expect(
      nextFees({
        latest: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
        gas: 100n,
        ceilingWei: 100n * 1_100n,
        quote,
        bumpPercent: 12,
      }),
    ).toEqual({ kind: "ceiling_reached" });
    // A suggested tip above the ceiling-cut fee cap is cut to it.
    expect(
      nextFees({
        latest: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 900n },
        gas: 100n,
        ceilingWei: 100n * 1_150n,
        quote: { baseFeePerGas: 10n, maxPriorityFeePerGas: 2_000n },
        bumpPercent: 12,
      }),
    ).toEqual({ kind: "fees", maxFeePerGas: 1_150n, maxPriorityFeePerGas: 1_150n });
  });
});

describe("automatic repricing", () => {
  it("reprices a payment that is not mined, inside its ceiling, offers the new attempt and ends confirmed once", async () => {
    await holding(async (sent) => {
      const payment = await sendPayment("Repriced");
      const start = await anvil.getTransactionCount({ address: payment.agent.address });
      // Not due yet: nothing is signed.
      await followUp(payment.approvalId);
      expect(await attemptRows(payment.approvalId)).toEqual([]);

      due();
      expect((await followUp(payment.approvalId)).done).toBe(false);
      const [first] = await attemptRows(payment.approvalId);
      expect(first).toMatchObject({ attempt: 1, kind: "reprice", status: "pending" });
      const original = parseTransaction(await rawOf(payment, 0));
      const repriced = parseTransaction(await rawOf(payment, 1));
      const bumped = (value: bigint) => (value * 112n + 99n) / 100n;
      expect(repriced.maxFeePerGas).toBeGreaterThanOrEqual(bumped(original.maxFeePerGas ?? 0n));
      expect(repriced.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
        bumped(original.maxPriorityFeePerGas ?? 0n),
      );
      const { intent } = await intentOf(payment.intentId);

      if (!("maxFeeWei" in intent)) throw new Error("a payment is an EVM intent");
      expect((repriced.gas ?? 0n) * (repriced.maxFeePerGas ?? 0n)).toBeLessThanOrEqual(
        BigInt(intent.maxFeeWei),
      );

      // Only the fees changed: the nonce, gas, recipient, value, data and chain are the first's.
      const unchanged = ({ nonce, gas, to, value, data, chainId }: typeof original) => ({
        nonce,
        gas,
        to,
        value,
        data,
        chainId,
      });

      expect(unchanged(repriced)).toEqual(unchanged(original));
      expect(sent.at(-1)).toBe(first?.hash);
      expect(await signerHashes(payment.approvalId)).toEqual(await localHashes(payment));

      await mine(payment, 1);
      await followUntilDone(payment.approvalId);
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "confirmed",
        minedAttempt: 1,
        stuckReason: null,
      });
      expect((await attemptRows(payment.approvalId))[0]?.status).toBe("mined");
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "confirmed",
        failureCode: null,
        transactionHash: first?.hash,
        transaction: { hash: first?.hash, status: "confirmed" },
      });
      expect(await anvil.getTransactionCount({ address: payment.agent.address })).toBe(start + 1);
      expect(await anvil.getBalance({ address: payment.to })).toBe(AMOUNT);
      expect(await followUp(payment.approvalId)).toEqual({ done: true, waitSeconds: 0 });
      expect(await auditCount(payment.intentId, "intent.confirmed")).toBe(1);
    });
  });

  it("settles once with the first signature when it is mined after a reprice, and marks the reprice replaced", async () => {
    await holding(async () => {
      const payment = await sendPayment("Original");
      due();
      await followUp(payment.approvalId);
      expect(await attemptRows(payment.approvalId)).toHaveLength(1);
      const original = await transactionRow(payment.approvalId);

      await mine(payment, 0);
      await followUntilDone(payment.approvalId);
      await followUp(payment.approvalId);
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "confirmed",
        minedAttempt: 0,
      });
      expect((await attemptRows(payment.approvalId))[0]?.status).toBe("replaced");
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "confirmed",
        transactionHash: original.hash,
      });
      expect(await auditCount(payment.intentId, "intent.confirmed")).toBe(1);
      expect(await anvil.getBalance({ address: payment.to })).toBe(AMOUNT);
    });
  });

  it("never reprices with REPRICE_AUTO off and keeps offering the newest attempt, while a speed-up still reprices", async () => {
    await holding(async (sent) => {
      const payment = await sendPayment("Manual");
      f.t.ctx.config.reprice.auto = false;

      try {
        await countingReprices(async (requests) => {
          due();
          await followUp(payment.approvalId);
          f.t.clock.advance(61);
          await followUp(payment.approvalId);
          expect(requests).toEqual([]);
        });
        expect(await attemptRows(payment.approvalId)).toEqual([]);
        expect(sent.filter((hash) => hash === sent[0]).length).toBeGreaterThanOrEqual(2);
        expect(await speedUp(f.t.ctx, payment.approvalId, f.t.owner.userId)).toBe("repriced");
        expect(await attemptRows(payment.approvalId)).toHaveLength(1);
      } finally {
        f.t.ctx.config.reprice.auto = true;
      }

      await mine(payment, 1);
      await followUntilDone(payment.approvalId);
      expect((await intentOf(payment.intentId)).status).toBe("confirmed");
    });
  });

  it("stops asking once the signer's window closed, and keeps offering the newest attempt", async () => {
    await holding(async (sent) => {
      const payment = await sendPayment("Late");
      await countingReprices(async (requests) => {
        f.t.clock.advance(WINDOW_SECONDS + 1);
        await followUp(payment.approvalId);
        expect(requests).toHaveLength(1);
        expect((await transactionRow(payment.approvalId)).stuckReason).toBe(
          "reprice_window_closed",
        );
        const offered = sent.length;
        due();
        await followUp(payment.approvalId);
        expect(requests).toHaveLength(1);
        expect(sent.length).toBe(offered + 1);
        expect(sent.at(-1)).toBe((await transactionRow(payment.approvalId)).hash);
      });
      expect(await attemptRows(payment.approvalId)).toEqual([]);
      expect((await intentOf(payment.intentId)).status).toBe("broadcast");
      await mine(payment, 0);
      await followUntilDone(payment.approvalId);
      expect((await intentOf(payment.intentId)).status).toBe("confirmed");
    });
  });

  it("does not reprice a payment waiting behind an earlier unmined nonce", async () => {
    await holding(async () => {
      const { client, agent } = await agentClient("Queue");
      const first = await propose(client, randomAddress());
      const second = await propose(client, randomAddress());

      for (const { approvalId } of [first, second]) {
        await f.t.approveOnPage(f.t.owner, approvalId);
        await steps().execute(approvalId);
        await followUp(approvalId);
      }

      due();
      await followUp(second.approvalId);
      expect(await transactionRow(second.approvalId)).toMatchObject({
        status: "broadcast",
        stuckReason: "waiting_behind_nonce",
      });
      expect(await attemptRows(second.approvalId)).toEqual([]);
      f.t.clock.advance(16);
      expect(await speedUp(f.t.ctx, second.approvalId, f.t.owner.userId)).toBe(
        "waiting_behind_nonce",
      );
      expect(await attemptRows(second.approvalId)).toEqual([]);
      // The earlier one is the next to mine, so it is repriced.
      await followUp(first.approvalId);
      expect(await attemptRows(first.approvalId)).toHaveLength(1);
      const payment = { agent, workspaceId: f.workspaceId, to: randomAddress() };
      await mine({ ...payment, ...first }, 1);
      await mine({ ...payment, ...second }, 0);
      await followUntilDone(first.approvalId);
      await followUntilDone(second.approvalId);
      expect((await intentOf(first.intentId)).status).toBe("confirmed");
      expect((await intentOf(second.intentId)).status).toBe("confirmed");
    });
  });

  it("stops at the fee ceiling and says so, without failing the payment", async () => {
    await holding(async () => {
      const payment = await sendPayment("Ceiling");
      f.t.ctx.config.reprice.bumpPercent = 100;

      try {
        for (let i = 0; i < 6; i += 1) {
          due();
          await followUp(payment.approvalId);

          if ((await transactionRow(payment.approvalId)).stuckReason === "fee_ceiling_reached") {
            break;
          }
        }
      } finally {
        f.t.ctx.config.reprice.bumpPercent = 12;
      }

      expect((await transactionRow(payment.approvalId)).stuckReason).toBe("fee_ceiling_reached");
      const { intent } = await intentOf(payment.intentId);

      if (!("maxFeeWei" in intent)) throw new Error("a payment is an EVM intent");

      for (const row of await attemptRows(payment.approvalId)) {
        expect(BigInt(row.gas) * BigInt(row.maxFeePerGas)).toBeLessThanOrEqual(
          BigInt(intent.maxFeeWei),
        );
      }

      await countingReprices(async (requests) => {
        due();
        await followUp(payment.approvalId);
        expect(requests).toEqual([]);
      });
      expect((await intentOf(payment.intentId)).status).toBe("broadcast");
      const newest = (await transactionRow(payment.approvalId)).latestAttempt;
      await mine(payment, newest);
      await followUntilDone(payment.approvalId);
      expect((await intentOf(payment.intentId)).status).toBe("confirmed");
    });
  });

  it("stops on the signer's fee_not_raised and fee_cap_exceeded without failing the payment", async () => {
    for (const code of ["fee_not_raised", "fee_cap_exceeded"] as const) {
      await holding(async () => {
        const payment = await sendPayment(`Refused ${code}`);
        let calls = 0;
        await patched(
          f.t.ctx.signer,
          "reprice",
          async () => {
            calls += 1;
            throw new SignerError(code, "refused", 403);
          },
          async () => {
            due();
            await followUp(payment.approvalId);
            due();
            await followUp(payment.approvalId);
          },
        );
        expect(calls).toBe(1);
        expect(await transactionRow(payment.approvalId)).toMatchObject({
          status: "broadcast",
          stuckReason: "fee_ceiling_reached",
        });
        expect((await intentOf(payment.intentId)).status).toBe("broadcast");
        await mine(payment, 0);
        await followUntilDone(payment.approvalId);
      });
    }
  });

  it("does not reprice while the workspace is paused, also when only the signer knows, and does after the resume", async () => {
    const workspaceId = await f.newWorkspace("Paused for repricing");
    await holding(async () => {
      const payment = await sendPayment("Paused", workspaceId);
      await f.t.owner.browser.api.call("pauseWorkspace", { params: { workspaceId }, body: {} });
      await countingReprices(async (requests) => {
        due();
        await followUp(payment.approvalId);
        expect(requests).toEqual([]);
        expect((await transactionRow(payment.approvalId)).stuckReason).toBe("workspace_paused");
        // A mirror that missed the pause: the signer refuses, and is asked again only when due.
        await f.t.ctx.db
          .update(workspaces)
          .set({ paused: false })
          .where(eq(workspaces.id, workspaceId));
        due();
        await followUp(payment.approvalId);
        await followUp(payment.approvalId);
        expect(requests).toHaveLength(1);
        await f.t.ctx.db
          .update(workspaces)
          .set({ paused: true })
          .where(eq(workspaces.id, workspaceId));
      });
      expect(await attemptRows(payment.approvalId)).toEqual([]);

      const resume = await f.t.owner.browser.api.call("requestResume", {
        params: { workspaceId },
        body: {},
      });

      expect((await f.t.approve(resume.id, [f.t.owner])).status).toBe("executed");
      due();
      await followUp(payment.approvalId);
      expect(await attemptRows(payment.approvalId)).toHaveLength(1);
      await mine(payment, 1);
      await followUntilDone(payment.approvalId);
      expect((await intentOf(payment.intentId)).status).toBe("confirmed");
    });
  });

  it("reprices a payment a mandate covers through the mandate, and the mandate's counts do not change", async () => {
    await holding(async () => {
      const { agent, client } = await agentClient("Mandated");
      const to = randomAddress();

      const draft: MandateDraft = {
        agentId: agent.id,
        assets: [
          {
            chainId: TEST_CHAIN_ID,
            asset: "native",
            maxPerAction: (1n * ETH).toString(),
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

      const opened = await f.t.owner.browser.api.call("proposeMandate", {
        params: { workspaceId: f.workspaceId, walletId: agent.walletId },
        body: draft,
      });

      const granted = await f.t.approve(opened.id, [bob]);
      expect(granted.status).toBe("executed");
      const mandateId = MandateId.parse(granted.subjectId);

      const { intentId, approvalId } = await propose(client, to);
      expect(await steps().execute(approvalId)).toEqual({ ok: true });
      await followUp(approvalId);
      const payment: Payment = { agent, workspaceId: f.workspaceId, intentId, approvalId, to };
      const before = (await f.t.ctx.signer.getMandate(mandateId)).usage;
      expect(before.uses).toBe(1);

      await countingReprices(async (requests) => {
        due();
        await followUp(approvalId);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ mandateId, attempt: 1 });
        expect(requests[0]).not.toHaveProperty("envelope");
      });
      expect(await attemptRows(approvalId)).toHaveLength(1);
      expect((await f.t.ctx.signer.getMandate(mandateId)).usage).toEqual(before);
      await mine(payment, 1);
      await followUntilDone(approvalId);
      expect((await intentOf(intentId)).status).toBe("confirmed");
      expect((await f.t.ctx.signer.getMandate(mandateId)).usage).toEqual(before);
    });
  });
});

describe("recovery and races", () => {
  it("stores the attempt the signer signed before a crash, one row per attempt number", async () => {
    // A fixed quote, so a repeated request asks for exactly the same fees.
    const fixed: FeeQuote = { baseFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    await holding(async (sent) => {
      for (const path of ["same fees", "other fees"] as const) {
        const payment = await sendPayment(`Crash ${path}`);
        const signer = f.t.ctx.signer;
        const real = signer.reprice.bind(signer);
        await patched(
          chainAccess(f.t.ctx),
          "fees",
          async () => fixed,
          async () => {
            await patched(
              signer,
              "reprice",
              async (approvalId: ApprovalId, request: RepriceRequest) => {
                await real(approvalId, request);
                throw new Error("the process died before the attempt was stored");
              },
              async () => {
                due();
                await followUp(payment.approvalId);
              },
            );
            expect(await attemptRows(payment.approvalId)).toEqual([]);
            expect(await signerHashes(payment.approvalId)).toHaveLength(2);

            // The same fees again answer with the stored bytes; other fees are a conflict, and
            // the attempt is read back from the signer.
            if (path === "other fees") f.t.ctx.config.reprice.bumpPercent = 20;

            try {
              due();
              await followUp(payment.approvalId);
            } finally {
              f.t.ctx.config.reprice.bumpPercent = 12;
            }
          },
        );
        const rows = await attemptRows(payment.approvalId);
        expect(rows.map((row) => row.attempt)).toEqual([1]);
        expect(await signerHashes(payment.approvalId)).toEqual(await localHashes(payment));
        expect(sent.at(-1)).toBe(rows[0]?.hash);
        await mine(payment, 1);
        await followUntilDone(payment.approvalId);
        expect(await transactionRow(payment.approvalId)).toMatchObject({
          status: "confirmed",
          minedAttempt: 1,
        });
      }
    });
  });

  it("makes no gap and no duplicate when a follow-up and a speed-up reprice at once", async () => {
    await holding(async () => {
      const payment = await sendPayment("Racing");
      due();

      const [followed, spedUp] = await Promise.all([
        followUp(payment.approvalId),
        speedUp(f.t.ctx, payment.approvalId, f.t.owner.userId),
      ]);

      expect(followed.done).toBe(false);
      expect(["repriced", "not_due"]).toContain(spedUp);
      const numbers = (await attemptRows(payment.approvalId)).map((row) => row.attempt);
      expect(numbers).toEqual([1]);
      expect(await signerHashes(payment.approvalId)).toEqual(await localHashes(payment));
      // A second click right away makes nothing more.
      expect(await speedUp(f.t.ctx, payment.approvalId, f.t.owner.userId)).toBe("not_due");
      f.t.clock.advance(16);
      expect(await speedUp(f.t.ctx, payment.approvalId, f.t.owner.userId)).toBe("repriced");
      expect((await attemptRows(payment.approvalId)).map((row) => row.attempt)).toEqual([1, 2]);
      await mine(payment, 2);
      await followUntilDone(payment.approvalId);
      expect((await intentOf(payment.intentId)).status).toBe("confirmed");
    });
  });

  it("holds the nonce until an attempt is final at the confirmation depth", async () => {
    const chains = chainAccess(f.t.ctx);
    const config = chains.config(TEST_CHAIN_ID);
    await holding(async () => {
      const payment = await sendPayment("Deep");
      due();
      await followUp(payment.approvalId);
      // Deeper than other test files can mine meanwhile, on the chain they share.
      await patched(
        chains,
        "config",
        () => ({ ...config, confirmations: 64 }),
        async () => {
          await mine(payment, 1);
          await followUp(payment.approvalId);
          expect(await transactionRow(payment.approvalId)).toMatchObject({
            status: "broadcast",
            minedAttempt: null,
          });
          // Mined but not final: no reprice is asked for, however long it waits.
          due();
          await followUp(payment.approvalId);
          expect(await attemptRows(payment.approvalId)).toHaveLength(1);
          await anvil.mine({ blocks: 64 });
          await followUntilDone(payment.approvalId);
        },
      );
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "confirmed",
        minedAttempt: 1,
      });
    });
  });
});

describe("outcomes after a cancel or another transaction", () => {
  it("ends voided when a cancel is mined, moves nothing, and the spend still counts", async () => {
    await holding(async () => {
      const payment = await sendPayment("Cancelled");
      const start = await anvil.getTransactionCount({ address: payment.agent.address });
      const spent = (await f.t.ctx.signer.getWallet(payment.agent.walletId)).spent;
      const cancel = await cancelOf(payment);
      expect(cancel.attempt).toMatchObject({ attempt: 1, kind: "cancel", gas: "21000" });

      await mine(payment, 1);
      await followUntilDone(payment.approvalId);
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "cancelled",
        minedAttempt: 1,
      });
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "voided",
        failureCode: "transaction_cancelled",
        transactionHash: cancel.attempt.transactionHash,
      });
      expect(await anvil.getBalance({ address: payment.to })).toBe(0n);
      expect(await anvil.getTransactionCount({ address: payment.agent.address })).toBe(start + 1);
      expect((await f.t.ctx.signer.getWallet(payment.agent.walletId)).spent).toEqual(spent);
    });
  });

  it("ends confirmed with cancel_too_late when the payment is mined after a cancel was signed", async () => {
    await holding(async () => {
      const payment = await sendPayment("Too late");
      await cancelOf(payment);
      // Repricing after a cancel goes on with the cancel.
      due();
      await followUp(payment.approvalId);
      expect((await attemptRows(payment.approvalId)).map((row) => row.kind)).toEqual([
        "cancel",
        "cancel",
      ]);
      await mine(payment, 0);
      await followUntilDone(payment.approvalId);
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "confirmed",
        minedAttempt: 0,
      });
      expect((await attemptRows(payment.approvalId)).map((row) => row.status)).toEqual([
        "replaced",
        "replaced",
      ]);
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "confirmed",
        failureCode: "cancel_too_late",
      });
      expect(await anvil.getBalance({ address: payment.to })).toBe(AMOUNT);
    });
  });

  it("ends failed with nonce_used_elsewhere when another transaction used the nonce", async () => {
    await holding(async () => {
      const payment = await sendPayment("Superseded");
      const { nonce } = await transactionRow(payment.approvalId);
      await anvil.impersonateAccount({ address: payment.agent.address });

      try {
        const hash = await anvil.sendTransaction({
          account: payment.agent.address,
          chain: null,
          to: payment.agent.address,
          value: 0n,
          nonce,
        });

        await anvil.waitForTransactionReceipt({ hash });
      } finally {
        await anvil.stopImpersonatingAccount({ address: payment.agent.address });
      }

      await followUntilDone(payment.approvalId);
      expect(await transactionRow(payment.approvalId)).toMatchObject({
        status: "superseded",
        minedAttempt: null,
      });
      expect(await intentOf(payment.intentId)).toMatchObject({
        status: "failed",
        failureCode: "nonce_used_elsewhere",
      });
      expect(await anvil.getBalance({ address: payment.to })).toBe(0n);
    });
  });
});
