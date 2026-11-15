import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ApprovalId,
  type ApproveIntentEnvelope,
  type CancelTransactionEnvelope,
  type EvmIntent,
  newId,
  type Operation,
} from "@askgina/os-protocol";
import type { AttemptResponse, SignResponse, TransactionParams } from "@askgina/os-protocol/signer";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, SCHEMA_VERSION, type Vault } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  CHAIN,
  Clock,
  DROP_VERSION_7,
  ETH,
  grantMandate,
  header,
  intentFor,
  type Person,
  RECIPIENT,
  refused,
  replacePolicy,
  setUpWorld,
  startSigner,
  TOKEN,
  tokenIntent,
  txParams,
  useRequest,
  type World,
} from "./harness.ts";

/** The first signature's fees (`txParams`). */
const FEE = 2_000_000_000n;
const TIP = 1_000_000_000n;
/** The harness intent's `maxFeeWei`, over 21000 gas: the highest fee per gas it allows. */
const INTENT_CEILING = 10n ** 15n;
const MAX_FEE_PER_GAS = INTENT_CEILING / 21_000n;

/** A payment approved with a passkey and signed once. */
interface Payment {
  intent: EvmIntent;
  envelope: ApproveIntentEnvelope;
  params: TransactionParams;
  signed: SignResponse;
  approvalId: ApprovalId;
}

/** A tenth of an ether by default, so a test world can pay many times within its daily cap. */
const PAYMENT = ETH / 10n;

async function pay(world: World, operation?: Operation): Promise<Payment> {
  const intent = intentFor(
    world,
    operation ?? { type: "evm.transfer", to: RECIPIENT, valueWei: String(PAYMENT) },
  );
  const authorization = approveIntent(world, intent, {
    people: world.people.slice(0, world.policy.approvals.threshold),
  });
  const params = txParams();
  const signed = await world.t.client.sign({ intent, authorization, transaction: params });
  const { envelope } = authorization;
  if (envelope.type !== "approve-intent") throw new Error("not an approve-intent envelope");
  return { intent, envelope, params, signed, approvalId: envelope.approvalId };
}

function reprice(
  world: World,
  payment: Payment,
  attempt: number,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<AttemptResponse> {
  return world.t.client.reprice(payment.approvalId, {
    intent: payment.intent,
    envelope: payment.envelope,
    attempt,
    maxFeePerGas: String(maxFeePerGas),
    maxPriorityFeePerGas: String(maxPriorityFeePerGas),
  });
}

function cancelEnvelope(
  world: World,
  payment: Payment,
  changes: Partial<CancelTransactionEnvelope> = {},
): CancelTransactionEnvelope {
  return {
    ...header(world.t.clock, newId("apr"), world.workspaceId),
    type: "cancel-transaction",
    targetApprovalId: payment.approvalId,
    walletId: world.walletId,
    chainId: CHAIN,
    txNonce: payment.params.nonce,
    maxFeeWei: String(10n ** 15n),
    ...changes,
  };
}

function cancel(
  world: World,
  payment: Payment,
  envelope: CancelTransactionEnvelope,
  fees: { attempt: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  people: readonly Person[] = world.people,
): Promise<AttemptResponse> {
  return world.t.client.cancelTransaction(payment.approvalId, {
    authorization: authorize(envelope, people),
    attempt: fees.attempt,
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
  });
}

/** What a signed transaction is, apart from its fees and its signature. */
function withoutFees(signed: `0x${string}`) {
  const {
    maxFeePerGas: _fee,
    maxPriorityFeePerGas: _tip,
    r: _r,
    s: _s,
    v: _v,
    yParity: _yParity,
    ...rest
  } = parseTransaction(signed);
  return rest;
}

async function decisionsOf(world: World, action: string) {
  const { decisions } = await world.t.client.listDecisions(world.workspaceId, { limit: 1000 });
  return decisions
    .filter((decision) => decision.action === action)
    .map((decision) => [decision.outcome, decision.code]);
}

describe("a reprice", () => {
  it("changes only the two fee fields: nonce, gas, to, value, data and chain equal the first signature", async () => {
    const world = await setUpWorld(startSigner());
    for (const operation of [
      undefined,
      { type: "evm.erc20.transfer", token: TOKEN, to: RECIPIENT, amount: "1000" } as const,
    ]) {
      const payment = await pay(world, operation);
      const next = await reprice(world, payment, 1, FEE * 2n, TIP * 2n);

      expect(next).toMatchObject({
        approvalId: payment.approvalId,
        walletId: world.walletId,
        from: world.address,
        attempt: {
          attempt: 1,
          kind: "reprice",
          gas: payment.params.gas,
          maxFeePerGas: String(FEE * 2n),
          maxPriorityFeePerGas: String(TIP * 2n),
        },
      });
      const first = parseTransaction(payment.signed.signedTransaction);
      const second = parseTransaction(next.signedTransaction);
      expect(withoutFees(next.signedTransaction)).toEqual(
        withoutFees(payment.signed.signedTransaction),
      );
      expect(second.nonce).toBe(payment.params.nonce);
      expect([second.maxFeePerGas, second.maxPriorityFeePerGas]).toEqual([FEE * 2n, TIP * 2n]);
      expect([first.maxFeePerGas, first.maxPriorityFeePerGas]).toEqual([FEE, TIP]);
      const from = await recoverTransactionAddress({
        serializedTransaction: next.signedTransaction as `0x02${string}`,
      });
      expect(from.toLowerCase()).toBe(world.address);

      // The approval reports both attempts; its transaction hash stays the first one's.
      const state = await world.t.client.getApproval(payment.approvalId);
      expect(state.state).toBe("signed");
      expect(state.transactionHash).toBe(payment.signed.transactionHash);
      expect(state.attempts.map((attempt) => [attempt.attempt, attempt.kind])).toEqual([
        [0, "original"],
        [1, "reprice"],
      ]);
      expect(state.attempts[0]).toMatchObject({
        transactionHash: payment.signed.transactionHash,
        gas: payment.params.gas,
        maxFeePerGas: String(FEE),
        maxPriorityFeePerGas: String(TIP),
      });
      expect(state.attempts[1]?.transactionHash).toBe(next.attempt.transactionHash);
    }
  });

  it("refuses a reprice that does not raise both fees", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    await refused(reprice(world, payment, 1, FEE, TIP * 2n), "fee_not_raised");
    await refused(reprice(world, payment, 1, FEE * 2n, TIP), "fee_not_raised");
    await refused(reprice(world, payment, 1, FEE - 1n, TIP + 1n), "fee_not_raised");
    // Both higher, but the tip above the fee cap.
    await refused(reprice(world, payment, 1, FEE + 1n, FEE + 2n), "fee_cap_exceeded");
    // Raised against the latest attempt, not the first.
    await reprice(world, payment, 1, FEE * 2n, TIP * 2n);
    await refused(reprice(world, payment, 2, FEE * 2n - 1n, TIP * 3n), "fee_not_raised");
    expect((await reprice(world, payment, 2, FEE * 2n + 1n, TIP * 2n + 1n)).attempt.attempt).toBe(
      2,
    );
  });

  it("refuses a reprice above the intent's fee ceiling, and above a policy fee cap lowered after signing", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    await refused(reprice(world, payment, 1, MAX_FEE_PER_GAS + 1n, TIP * 2n), "fee_cap_exceeded");
    const atCeiling = await reprice(world, payment, 1, MAX_FEE_PER_GAS, TIP * 2n);
    expect(
      BigInt(atCeiling.attempt.gas) * BigInt(atCeiling.attempt.maxFeePerGas),
    ).toBeLessThanOrEqual(INTENT_CEILING);

    const lowered = await pay(world);
    await replacePolicy(world, { fees: { maxPerTxWei: String(21_000n * FEE * 3n) } });
    await refused(reprice(world, lowered, 1, FEE * 3n + 1n, TIP * 2n), "fee_cap_exceeded");
    expect((await reprice(world, lowered, 1, FEE * 3n, TIP * 2n)).attempt.kind).toBe("reprice");
  });

  it("refuses a reprice for an approval never signed, a revoked one, a different envelope, or a different intent", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const fees = {
      attempt: 1,
      maxFeePerGas: String(FEE * 2n),
      maxPriorityFeePerGas: String(TIP * 2n),
    };
    const request = { intent: payment.intent, envelope: payment.envelope, ...fees };

    await refused(world.t.client.reprice(newId("apr"), request), "not_found");
    const revoked = newId("apr");
    await world.t.client.revokeApproval(revoked, world.workspaceId);
    await refused(world.t.client.reprice(revoked, request), "approval_revoked");
    // The policy's approval was applied, never signed.
    const { decisions } = await world.t.client.listDecisions(world.workspaceId);
    const applied = decisions.find((decision) => decision.action === "set-policy")?.approvalId;
    if (!applied) throw new Error("no policy approval");
    await refused(world.t.client.reprice(applied as ApprovalId, request), "conflict");

    // Another envelope for the same approval id and intent: not the one people approved.
    const other = approveIntent(world, payment.intent).envelope;
    if (other.type !== "approve-intent") throw new Error("not an approve-intent envelope");
    await refused(
      world.t.client.reprice(payment.approvalId, {
        ...request,
        envelope: { ...other, approvalId: payment.approvalId },
      }),
      "conflict",
    );
    // The envelope of another approval.
    const second = await pay(world);
    await refused(
      world.t.client.reprice(payment.approvalId, { ...request, envelope: second.envelope }),
      "conflict",
    );
    // An envelope that is not one: refused, not an internal error.
    await refused(
      world.t.client.reprice(payment.approvalId, {
        ...request,
        envelope: { ...payment.envelope, expiresAt: payment.envelope.issuedAt },
      }),
      "conflict",
    );
    // The right envelope, another intent.
    await refused(
      world.t.client.reprice(payment.approvalId, {
        ...request,
        intent: { ...payment.intent, memo: "pay another invoice" },
      }),
      "intent_mismatch",
    );
    expect((await world.t.client.getApproval(payment.approvalId)).attempts).toHaveLength(1);
  });

  it("a repeated reprice returns the stored attempt; another reprice for the same attempt number is a conflict", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const first = await reprice(world, payment, 1, FEE * 2n, TIP * 2n);
    expect(await reprice(world, payment, 1, FEE * 2n, TIP * 2n)).toEqual(first);
    await refused(reprice(world, payment, 1, FEE * 3n, TIP * 3n), "conflict");
    // Numbers are consecutive: neither a gap nor the first signature's number.
    await refused(reprice(world, payment, 3, FEE * 3n, TIP * 3n), "conflict");
    await refused(
      world.t.client.reprice(payment.approvalId, {
        intent: payment.intent,
        envelope: payment.envelope,
        attempt: 0,
        maxFeePerGas: String(FEE * 3n),
        maxPriorityFeePerGas: String(TIP * 3n),
      }),
      "invalid_request",
    );
    expect((await world.t.client.getApproval(payment.approvalId)).attempts).toHaveLength(2);
  });

  it("two concurrent reprices for one attempt number sign once, and attempts stay numbered without gaps", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const [a, b] = await Promise.all([
      reprice(world, payment, 1, FEE * 2n, TIP * 2n),
      reprice(world, payment, 1, FEE * 2n, TIP * 2n),
    ]);
    expect(a).toEqual(b);

    const settled = await Promise.allSettled([
      reprice(world, payment, 2, FEE * 3n, TIP * 3n),
      reprice(world, payment, 2, FEE * 4n, TIP * 4n),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((result) => result.status === "rejected");
    expect(lost?.status === "rejected" && lost.reason).toMatchObject({ code: "conflict" });

    const { attempts } = await world.t.client.getApproval(payment.approvalId);
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([0, 1, 2]);
    expect(new Set(attempts.map((attempt) => attempt.transactionHash)).size).toBe(3);
  });

  it("refuses beyond SIGNER_MAX_TX_ATTEMPTS and after SIGNER_REPRICE_WINDOW_SECONDS", async () => {
    const capped = await setUpWorld(startSigner({ maxTxAttempts: 3 }));
    const payment = await pay(capped);
    await reprice(capped, payment, 1, FEE * 2n, TIP * 2n);
    await reprice(capped, payment, 2, FEE * 3n, TIP * 3n);
    await refused(reprice(capped, payment, 3, FEE * 4n, TIP * 4n), "attempts_exhausted");
    // A cancel is an attempt too.
    await refused(
      cancel(capped, payment, cancelEnvelope(capped, payment), {
        attempt: 3,
        maxFeePerGas: FEE * 4n,
        maxPriorityFeePerGas: TIP * 4n,
      }),
      "attempts_exhausted",
    );

    const windowed = await setUpWorld(startSigner({ repriceWindowSeconds: 600 }));
    const late = await pay(windowed);
    windowed.t.clock.value += 599;
    const last = await reprice(windowed, late, 1, FEE * 2n, TIP * 2n);
    windowed.t.clock.value += 1;
    await refused(reprice(windowed, late, 2, FEE * 3n, TIP * 3n), "reprice_window_closed");
    // A repeat of an attempt already signed is still answered.
    expect(await reprice(windowed, late, 1, FEE * 2n, TIP * 2n)).toEqual(last);
    // After the window a person decides: a cancel still signs.
    const cancelled = await cancel(windowed, late, cancelEnvelope(windowed, late), {
      attempt: 2,
      maxFeePerGas: FEE * 3n,
      maxPriorityFeePerGas: TIP * 3n,
    });
    expect(cancelled.attempt.kind).toBe("cancel");

    // A window of 0 refuses every reprice.
    const off = await setUpWorld(startSigner({ repriceWindowSeconds: 0 }));
    await refused(reprice(off, await pay(off), 1, FEE * 2n, TIP * 2n), "reprice_window_closed");
  });

  it("refuses a reprice while the workspace is paused; a cancel still signs", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const repriced = await reprice(world, payment, 1, FEE * 2n, TIP * 2n);
    await world.t.client.pauseWorkspace(world.workspaceId);
    await refused(reprice(world, payment, 2, FEE * 3n, TIP * 3n), "workspace_paused");
    // A repeat of what was signed before the pause is answered, as for a first signature.
    expect(await reprice(world, payment, 1, FEE * 2n, TIP * 2n)).toEqual(repriced);
    const cancelled = await cancel(world, payment, cancelEnvelope(world, payment), {
      attempt: 2,
      maxFeePerGas: FEE * 3n,
      maxPriorityFeePerGas: TIP * 3n,
    });
    expect(cancelled.attempt).toMatchObject({ attempt: 2, kind: "cancel" });
  });
});

describe("a cancel", () => {
  it("signs a zero-value self-transfer at the approval's nonce with gas 21000, only with passkeys at the wallet threshold", async () => {
    const world = await setUpWorld(startSigner(), { people: 2, policyThreshold: 2 });
    const payment = await pay(world, undefined);
    const fees = { attempt: 1, maxFeePerGas: FEE * 2n, maxPriorityFeePerGas: TIP * 2n };
    const envelope = cancelEnvelope(world, payment);

    await refused(
      cancel(world, payment, envelope, fees, world.people.slice(0, 1)),
      "insufficient_approvals",
    );
    const cancelled = await cancel(world, payment, envelope, fees);
    expect(cancelled).toMatchObject({
      approvalId: payment.approvalId,
      walletId: world.walletId,
      from: world.address,
      attempt: { attempt: 1, kind: "cancel", gas: "21000" },
    });
    const transaction = parseTransaction(cancelled.signedTransaction);
    expect(transaction).toMatchObject({
      chainId: 31337,
      nonce: payment.params.nonce,
      to: world.address,
      gas: 21_000n,
      maxFeePerGas: FEE * 2n,
      maxPriorityFeePerGas: TIP * 2n,
    });
    expect(transaction.value ?? 0n).toBe(0n);
    expect(transaction.data ?? "0x").toBe("0x");

    // The same request again returns the same attempt; the cancel's approval reports it.
    expect(await cancel(world, payment, envelope, fees)).toEqual(cancelled);
    expect(await world.t.client.getApproval(envelope.approvalId)).toEqual({
      approvalId: envelope.approvalId,
      state: "applied",
      transactionHash: cancelled.attempt.transactionHash,
      attempts: [cancelled.attempt],
    });
    expect((await world.t.client.getApproval(payment.approvalId)).attempts).toEqual([
      expect.objectContaining({ attempt: 0, kind: "original" }),
      cancelled.attempt,
    ]);
  });

  it("refuses a wrong target, a maxFeeWei above the policy cap or under its fees, and a reused envelope nonce", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const fees = { attempt: 1, maxFeePerGas: FEE * 2n, maxPriorityFeePerGas: TIP * 2n };
    for (const envelope of [
      cancelEnvelope(world, payment, { txNonce: payment.params.nonce + 1 }),
      cancelEnvelope(world, payment, { walletId: newId("wal") }),
      cancelEnvelope(world, payment, { chainId: "eip155:1" }),
    ]) {
      await refused(cancel(world, payment, envelope, fees), "envelope_mismatch");
    }
    // A target the signer never signed.
    const never = { ...payment, approvalId: newId("apr") };
    await refused(cancel(world, never, cancelEnvelope(world, never), fees), "envelope_mismatch");
    // The path names another approval than the envelope.
    const other = await pay(world);
    await refused(cancel(world, other, cancelEnvelope(world, payment), fees), "envelope_mismatch");

    await refused(
      cancel(
        world,
        payment,
        cancelEnvelope(world, payment, { maxFeeWei: String(10n ** 16n + 1n) }),
        fees,
      ),
      "fee_cap_exceeded",
    );
    // Fees above the cancel's own ceiling, though inside the payment's.
    await refused(
      cancel(
        world,
        payment,
        cancelEnvelope(world, payment, { maxFeeWei: String(21_000n * FEE) }),
        fees,
      ),
      "fee_cap_exceeded",
    );
    await refused(
      cancel(world, payment, cancelEnvelope(world, payment), { ...fees, maxFeePerGas: FEE }),
      "fee_not_raised",
    );

    const used = cancelEnvelope(world, payment);
    await cancel(world, payment, used, fees);
    await refused(
      cancel(
        world,
        payment,
        { ...cancelEnvelope(world, payment), nonce: used.nonce },
        {
          attempt: 2,
          maxFeePerGas: FEE * 3n,
          maxPriorityFeePerGas: TIP * 3n,
        },
      ),
      "nonce_reused",
    );
  });

  it("after a cancel, a reprice rebuilds the self-transfer, never the payment", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const ceiling = 21_000n * FEE * 3n;
    await cancel(world, payment, cancelEnvelope(world, payment, { maxFeeWei: String(ceiling) }), {
      attempt: 1,
      maxFeePerGas: FEE * 2n,
      maxPriorityFeePerGas: TIP * 2n,
    });

    // Inside the payment's ceiling, above the cancel's.
    await refused(reprice(world, payment, 2, FEE * 3n + 1n, TIP * 3n), "fee_cap_exceeded");
    const again = await reprice(world, payment, 2, FEE * 3n, TIP * 3n);
    expect(again.attempt).toMatchObject({ attempt: 2, kind: "cancel", gas: "21000" });
    const transaction = parseTransaction(again.signedTransaction);
    expect(transaction).toMatchObject({ to: world.address, nonce: payment.params.nonce });
    expect(transaction.value ?? 0n).toBe(0n);

    // A second cancel may raise the ceiling of the first; the reprices after it follow it.
    const raised = cancelEnvelope(world, payment, { maxFeeWei: String(21_000n * FEE * 5n) });
    const second = await cancel(world, payment, raised, {
      attempt: 3,
      maxFeePerGas: FEE * 4n,
      maxPriorityFeePerGas: TIP * 4n,
    });
    expect(second.attempt.kind).toBe("cancel");
    // A policy fee cap lowered since caps a cancel's reprices as well.
    await replacePolicy(world, { fees: { maxPerTxWei: String((21_000n * FEE * 9n) / 2n) } });
    await refused(reprice(world, payment, 4, FEE * 5n, TIP * 5n), "fee_cap_exceeded");
    expect((await reprice(world, payment, 4, (FEE * 9n) / 2n, TIP * 5n)).attempt.kind).toBe(
      "cancel",
    );
    expect(
      (await world.t.client.getApproval(payment.approvalId)).attempts.map((a) => a.kind),
    ).toEqual(["original", "cancel", "cancel", "cancel", "cancel"]);
    expect((await world.t.client.getApproval(raised.approvalId)).attempts).toEqual([
      second.attempt,
    ]);
  });
});

describe("what attempts leave unchanged", () => {
  it("no reprice or cancel changes the spend ledger", async () => {
    const world = await setUpWorld(startSigner());
    const payment = await pay(world);
    const spent = (await world.t.client.getWallet(world.walletId)).spent;
    expect(spent).toEqual([{ chainId: CHAIN, asset: "native", amount: String(PAYMENT) }]);
    await reprice(world, payment, 1, FEE * 2n, TIP * 2n);
    await cancel(world, payment, cancelEnvelope(world, payment), {
      attempt: 2,
      maxFeePerGas: FEE * 3n,
      maxPriorityFeePerGas: TIP * 3n,
    });
    await reprice(world, payment, 3, FEE * 4n, TIP * 4n);
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual(spent);
  });

  it("every allowed and refused reprice and cancel is in the decision log, and verify-log passes", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const payment = await pay(world);
    await reprice(world, payment, 1, FEE * 2n, TIP * 2n);
    await refused(reprice(world, payment, 2, FEE, TIP), "fee_not_raised");
    await refused(reprice(world, payment, 5, FEE * 3n, TIP * 3n), "conflict");
    const envelope = cancelEnvelope(world, payment);
    await cancel(world, payment, envelope, {
      attempt: 2,
      maxFeePerGas: FEE * 3n,
      maxPriorityFeePerGas: TIP * 3n,
    });
    await refused(
      cancel(world, payment, cancelEnvelope(world, payment, { txNonce: 999 }), {
        attempt: 3,
        maxFeePerGas: FEE * 4n,
        maxPriorityFeePerGas: TIP * 4n,
      }),
      "envelope_mismatch",
    );

    expect(await decisionsOf(world, "reprice")).toEqual([
      ["allowed", null],
      ["denied", "fee_not_raised"],
      ["denied", "conflict"],
    ]);
    expect(await decisionsOf(world, "cancel-transaction")).toEqual([
      ["allowed", null],
      ["denied", "envelope_mismatch"],
    ]);
    const { decisions } = await world.t.client.listDecisions(world.workspaceId);
    expect(
      decisions
        .filter((d) => d.action === "reprice")
        .every((d) => d.approvalId === payment.approvalId),
    ).toBe(true);
    expect(
      decisions.find((d) => d.action === "cancel-transaction" && d.outcome === "allowed")
        ?.approvalId,
    ).toBe(envelope.approvalId);
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
  });

  it("an attempt the vault signs wrongly is refused and nothing is recorded", async () => {
    const honest = createTestVault();
    const state = { cheat: false };
    const vault: Vault = {
      createWallet: (walletId) => honest.createWallet(walletId),
      signEvmTransaction: (walletId, credential, transaction) =>
        honest.signEvmTransaction(
          walletId,
          credential,
          state.cheat ? { ...transaction, value: (transaction.value ?? 0n) + 1n } : transaction,
        ),
      destroyWallet: (walletId) => honest.destroyWallet(walletId),
    };
    const world = await setUpWorld(startSigner({ vault }));
    const payment = await pay(world);
    state.cheat = true;
    await refused(reprice(world, payment, 1, FEE * 2n, TIP * 2n), "vault_error");
    const envelope = cancelEnvelope(world, payment);
    const fees = { attempt: 1, maxFeePerGas: FEE * 2n, maxPriorityFeePerGas: TIP * 2n };
    await refused(cancel(world, payment, envelope, fees), "vault_error");
    expect((await world.t.client.getApproval(payment.approvalId)).attempts).toHaveLength(1);
    expect((await world.t.client.getApproval(envelope.approvalId)).state).toBe("unknown");

    // Nothing was used up: the same cancel signs once the vault is honest.
    state.cheat = false;
    expect((await cancel(world, payment, envelope, fees)).attempt.kind).toBe("cancel");
  });
});

describe("mandates and the restore fence", () => {
  it("a mandated payment is repriced under its use and counted once; the use's binding is checked and a revoked mandate stops it", async () => {
    const world = await setUpWorld(startSigner());
    const { mandate } = await grantMandate(world);
    const intent = tokenIntent(world, 400_000n);
    const use = useRequest(intent);
    const signed = await world.t.client.signUnderMandate(mandate.id, use);
    const before = await world.t.client.getMandate(mandate.id);
    const spent = (await world.t.client.getWallet(world.walletId)).spent;
    const fees = {
      attempt: 1,
      maxFeePerGas: String(FEE * 2n),
      maxPriorityFeePerGas: String(TIP * 2n),
    };

    const repriced = await world.t.client.reprice(use.approvalId, {
      intent,
      mandateId: mandate.id,
      ...fees,
    });
    expect(repriced.attempt).toMatchObject({ attempt: 1, kind: "reprice" });
    expect(withoutFees(repriced.signedTransaction)).toEqual(withoutFees(signed.signedTransaction));
    expect(await world.t.client.getMandate(mandate.id)).toEqual(before);
    expect(before.usage.uses).toBe(1);
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual(spent);

    const next = {
      ...fees,
      attempt: 2,
      maxFeePerGas: String(FEE * 3n),
      maxPriorityFeePerGas: String(TIP * 3n),
    };
    // A use has no approve-intent envelope: one offered for it is not what the signer stored.
    const envelope = approveIntent(world, intent).envelope;
    if (envelope.type !== "approve-intent") throw new Error("not an approve-intent envelope");
    await refused(
      world.t.client.reprice(use.approvalId, {
        intent,
        envelope: { ...envelope, approvalId: use.approvalId },
        ...next,
      }),
      "conflict",
    );
    await refused(
      world.t.client.reprice(use.approvalId, { intent, mandateId: newId("mnd"), ...next }),
      "conflict",
    );
    await refused(
      world.t.client.reprice(use.approvalId, {
        intent: { ...intent, memo: "another payment" },
        mandateId: mandate.id,
        ...next,
      }),
      "intent_mismatch",
    );
    // An approved payment cannot be repriced as a mandate use either.
    const payment = await pay(world);
    await refused(
      world.t.client.reprice(payment.approvalId, {
        intent: payment.intent,
        mandateId: mandate.id,
        ...fees,
      }),
      "conflict",
    );

    await world.t.client.revokeMandate(mandate.id, world.workspaceId);
    await refused(
      world.t.client.reprice(use.approvalId, { intent, mandateId: mandate.id, ...next }),
      "mandate_revoked",
    );
    // A person can still cancel it.
    const cancelled = await world.t.client.cancelTransaction(use.approvalId, {
      authorization: authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "cancel-transaction",
          targetApprovalId: use.approvalId,
          walletId: world.walletId,
          chainId: CHAIN,
          txNonce: use.transaction.nonce,
          maxFeeWei: String(10n ** 15n),
        },
        world.people,
      ),
      attempt: 2,
      maxFeePerGas: String(FEE * 3n),
      maxPriorityFeePerGas: String(TIP * 3n),
    });
    expect(cancelled.attempt.kind).toBe("cancel");
    expect((await world.t.client.getMandate(mandate.id)).usage).toEqual(before.usage);
  });

  it("after the restore fence, a payment signed before it is only cancelled, never repriced; one signed after it is repriced", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const payment = await pay(world);
    t.clock.value += 1;
    t.signer.fence();
    await refused(reprice(world, payment, 1, FEE * 2n, TIP * 2n), "envelope_fenced");

    // Envelopes issued from the fence plus the verifier's skew on are accepted.
    t.clock.value += 31;
    const cancelled = await cancel(world, payment, cancelEnvelope(world, payment), {
      attempt: 1,
      maxFeePerGas: FEE * 2n,
      maxPriorityFeePerGas: TIP * 2n,
    });
    expect(cancelled.attempt.kind).toBe("cancel");
    await refused(reprice(world, payment, 2, FEE * 3n, TIP * 3n), "envelope_fenced");

    const after = await pay(world);
    expect((await reprice(world, after, 1, FEE * 2n, TIP * 2n)).attempt.kind).toBe("reprice");
  });
});

describe("the database's schema version 6", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("a version 5 file gains the attempts table, and a payment signed before the change is repriced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-signer-attempts-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");
    const host = {
      sqlitePath,
      clock: new Clock(),
      vault: createTestVault(),
      tokenKey: randomBytes(32),
    };
    let t = startSigner(host);
    const world = await setUpWorld(t);
    const payment = await pay(world);
    t.signer.close();

    // What a signer at version 5 left behind.
    const old = new DatabaseSync(sqlitePath);
    old.exec(`DROP TABLE signature_attempts; ${DROP_VERSION_7} PRAGMA user_version = 5;`);
    old.close();

    t = startSigner(host);
    const upgraded: World = { ...world, t };
    expect((await t.client.getApproval(payment.approvalId)).attempts).toHaveLength(1);
    const next = await reprice(upgraded, payment, 1, FEE * 2n, TIP * 2n);
    expect(withoutFees(next.signedTransaction)).toEqual(
      withoutFees(payment.signed.signedTransaction),
    );
    t.signer.close();

    const db = new DatabaseSync(sqlitePath);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(user_version).toBe(SCHEMA_VERSION);
  });
});
