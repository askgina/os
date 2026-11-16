import type {
  ApprovalId,
  ApproveIntentEnvelope,
  Authorization,
  ChainId,
  EvmIntent,
  MandateId,
  UserId,
  WalletPolicy,
  WorkspaceId,
} from "@askgina/os-protocol";
import {
  type AttemptResponse,
  type RepriceRequest,
  SignerError,
  type SignerErrorCode,
} from "@askgina/os-protocol/signer";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ApprovalRow } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Transaction } from "../context.ts";
import {
  approvalAssertions,
  approvals,
  intents,
  type StuckReason,
  transactions,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { ChainError, chainAccess, type FeeQuote } from "./chains.ts";
import { type IntentRow, readEvmIntent } from "./intents.ts";
import {
  type Attempt,
  attemptsOf,
  broadcastNewest,
  lockAttempts,
  REPRICE_STOPPED,
  RETRYABLE_SIGNER_CODES,
  recordAttempt,
  type TransactionRow,
} from "./transactions.ts";

/**
 * Repricing: one more attempt of a sent, unmined payment with both fees higher, at the same
 * account nonce, signed with no passkey (`docs/approval-protocol.md`, section 8, "Reprices and
 * cancels"). The follow-up asks for one by itself on a schedule (`REPRICE_AUTO`,
 * `REPRICE_AFTER_SECONDS`), and an approver can ask now with "Speed up". Both go through
 * {@link reprice}, serialized per transaction by the attempts lock and, at the signer, by the
 * attempt number. The signer enforces every limit; the control plane only chooses when, and how
 * far within the approved ceiling.
 */

/** Who asked: the follow-up by itself, or a person's speed-up. */
export type RepriceActor = { type: "system" } | { type: "user"; id: UserId };

/**
 * What one request for a reprice did.
 * - `repriced`: the signer signed a new attempt; it is stored and was offered to the chain.
 * - `caught_up`: the signer had signed attempts this control plane had not stored (it stopped
 *   between the two); they are stored now and the newest was offered to the chain.
 * - `not_due`: the newest attempt is too recent.
 * - `not_repriceable`: not a sent, unmined payment: a sweep, a final transaction, one not yet
 *   broadcast, or one whose nonce was used already.
 * - `retry_later`: the chain or the signer could not be reached or failed; nothing changed.
 * - a {@link StuckReason}: why there is no new attempt, also recorded on the transaction.
 */
export type RepriceOutcome =
  | "repriced"
  | "caught_up"
  | "not_due"
  | "not_repriceable"
  | "retry_later"
  | StuckReason;

/** A person's speed-up waits this long after the newest attempt, so that two clicks make one. */
export const SPEED_UP_SPACING_SECONDS = 15;

/** The signer's permanent refusals of a reprice, as the reason the transaction stays as it is. */
const REFUSALS: Partial<Record<SignerErrorCode, StuckReason>> = {
  reprice_window_closed: "reprice_window_closed",
  attempts_exhausted: "attempts_exhausted",
  fee_not_raised: "fee_ceiling_reached",
  fee_cap_exceeded: "fee_ceiling_reached",
  workspace_paused: "workspace_paused",
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const larger = (a: bigint, b: bigint) => (a > b ? a : b);

export type NextFees =
  | { kind: "fees"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { kind: "ceiling_reached" };

/**
 * The fees of the next attempt. Both are at least `bumpPercent` above the newest attempt's,
 * rounded up, and at least 1 wei above (so a zero tip rises): nodes replace a pooled transaction
 * only for such a raise. The tip is at least what the chain suggests now, and the fee cap at
 * least twice the current base fee plus the tip, as for a first signature. The fee cap is then
 * cut to what `ceilingWei` allows for `gas`, and the tip to the fee cap; `ceiling_reached` when
 * that leaves the fee cap below its raise. (The tip then still has its raise: an attempt's tip
 * is never above its fee cap, so its raise is never above the fee cap's.)
 */
export function nextFees(input: {
  latest: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  gas: bigint;
  ceilingWei: bigint;
  quote: FeeQuote;
  bumpPercent: number;
}): NextFees {
  const raised = (value: bigint) =>
    larger((value * BigInt(100 + input.bumpPercent) + 99n) / 100n, value + 1n);

  const minFee = raised(input.latest.maxFeePerGas);
  const minTip = raised(input.latest.maxPriorityFeePerGas);
  let tip = larger(minTip, input.quote.maxPriorityFeePerGas);
  let fee = larger(minFee, 2n * input.quote.baseFeePerGas + tip);
  const affordable = input.ceilingWei / input.gas;

  if (fee > affordable) fee = affordable;

  if (tip > fee) tip = fee;

  if (fee < minFee) return { kind: "ceiling_reached" };

  return { kind: "fees", maxFeePerGas: fee, maxPriorityFeePerGas: tip };
}

/** What the signer checks a reprice against: the envelope people approved, or the mandate. */
type Binding = { envelope: ApproveIntentEnvelope } | { mandateId: MandateId };

function bindingOf(approval: ApprovalRow): Binding | null {
  if (approval.kind === "approve-intent" && approval.envelope?.type === "approve-intent") {
    return { envelope: approval.envelope };
  }

  if (approval.kind === "mandate-use" && approval.mandateId !== null) {
    return { mandateId: approval.mandateId };
  }

  return null;
}

/** {@link catchUpAttempts} could not ask the signer; `cause` is what the call threw. */
export class AttemptsUnreadable extends Error {
  override readonly name = "AttemptsUnreadable";

  constructor(cause: unknown) {
    super("the signer could not be asked for the attempts it holds", { cause });
  }
}

/**
 * Store the attempts the signer holds of `transaction` and this record lacks: those it signed
 * while the caller that asked for them stopped before storing them. Each is asked for again
 * with exactly its number and fees, which the signer answers with the bytes it signed, also
 * while paused, fenced or after the window: a payment's through its reprice route, a sweep's
 * cancels through the cancel route with the stored approval of the `cancel-transaction`
 * request that produced it. Runs in `tx`, which holds {@link lockAttempts}; `stored` runs for
 * each attempt stored, in `tx`, with the request a cancel is under and, when that request's own
 * signature produced it (not a reprice of it), `producedBy`. Returns how many were stored: 0
 * means the signer holds no more attempts than this record. A signer that cannot be asked
 * throws {@link AttemptsUnreadable}.
 */
export async function catchUpAttempts(
  ctx: AppContext,
  tx: Transaction,
  input: {
    workspaceId: WorkspaceId;
    transaction: TransactionRow;
    latest: Attempt;
    stored(
      response: AttemptResponse,
      under: { cancelApprovalId: ApprovalId | null; producedBy: ApprovalId | null },
    ): Promise<void>;
  },
): Promise<number> {
  const { transaction, latest } = input;
  const target = transaction.approvalId;

  const asking = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw new AttemptsUnreadable(error);
    }
  };

  const missing = (await asking(() => ctx.signer.getApproval(target))).attempts
    .filter((attempt) => attempt.attempt > latest.attempt)
    .sort((a, b) => a.attempt - b.attempt);

  if (missing.length === 0) return 0;

  // Which `cancel-transaction` request produced each cancel the signer signed on passkeys: a
  // request that reached the signer is approved, executed, or failed after it.
  const producers = new Map<string, ApprovalId>();

  if (missing.some((attempt) => attempt.kind === "cancel")) {
    const cancels = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.kind, "cancel-transaction"),
          eq(approvals.subjectId, target),
          inArray(approvals.status, ["approved", "executed", "failed"]),
        ),
      );

    for (const { id } of cancels) {
      const produced = await asking(() => ctx.signer.getApproval(id));

      for (const attempt of produced.attempts) producers.set(attempt.transactionHash, id);
    }
  }

  // A payment's attempts, cancels included, are all asked for again through its reprice route.
  const [approval] = await tx.select().from(approvals).where(eq(approvals.id, target));
  const binding = approval ? bindingOf(approval) : null;
  let bound: (Binding & { intent: EvmIntent }) | null = null;

  if (binding !== null && transaction.intentId !== null) {
    const [row] = await tx.select().from(intents).where(eq(intents.id, transaction.intentId));

    if (!row) throw new Error("a transaction's intent no longer exists");
    bound = { ...binding, intent: await readEvmIntent(ctx, row) };
  }

  // A reprice of a cancel is under that cancel's request, as the signer records it.
  let cancelApprovalId = latest.cancelApprovalId;

  for (const attempt of missing) {
    const fees = {
      attempt: attempt.attempt,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
    };

    const producer = producers.get(attempt.transactionHash);
    let response: AttemptResponse;

    if (bound !== null) {
      const request: RepriceRequest = { ...bound, ...fees };
      response = await asking(() => ctx.signer.reprice(target, request));
    } else if (producer !== undefined) {
      const [cancel] = await tx
        .select({ envelope: approvals.envelope })
        .from(approvals)
        .where(eq(approvals.id, producer));

      const assertions = await tx
        .select()
        .from(approvalAssertions)
        .where(eq(approvalAssertions.approvalId, producer))
        .orderBy(asc(approvalAssertions.createdAt));

      if (!cancel?.envelope || assertions.length === 0) {
        throw new Error("a cancel the signer signed has no approval stored here");
      }

      const authorization: Authorization = {
        envelope: cancel.envelope,
        assertions: assertions.map((assertion) => ({
          userId: assertion.userId,
          credentialId: assertion.credentialId,
          response: assertion.response,
        })),
      };

      response = await asking(() =>
        ctx.signer.cancelTransaction(target, { authorization, ...fees }),
      );
    } else {
      throw new Error("an attempt the signer holds cannot be asked for again");
    }

    if (response.attempt.transactionHash !== attempt.transactionHash) {
      throw new Error("the signer answered with another attempt than the one it holds");
    }

    if (producer !== undefined) cancelApprovalId = producer;
    const under = response.attempt.kind === "cancel" ? cancelApprovalId : null;
    await recordAttempt(ctx, tx, {
      workspaceId: input.workspaceId,
      transaction,
      response,
      cancelApprovalId: under,
    });
    await input.stored(response, { cancelApprovalId: under, producedBy: producer ?? null });
  }

  return missing.length;
}

/**
 * The fee ceiling of the next attempt, as the signer computes it: the payment's own
 * `maxFeeWei`, or once a cancel exists that cancel's, and the wallet's current policy cap if it
 * is lower. A cancel whose request is not known here (none is stored with it) is bounded by the
 * newest cancel request for this transaction, or else only by the policy; the signer refuses
 * anything above its own record.
 */
async function ceilingOf(
  tx: Transaction,
  input: {
    approvalId: ApprovalId;
    intent: EvmIntent;
    latest: Attempt;
    policy: WalletPolicy | null;
  },
): Promise<bigint> {
  const policyCeiling = input.policy === null ? null : BigInt(input.policy.fees.maxPerTxWei);
  let ceiling: bigint | null = BigInt(input.intent.maxFeeWei);

  if (input.latest.kind === "cancel") {
    const [cancel] = await tx
      .select({ envelope: approvals.envelope })
      .from(approvals)
      .where(
        input.latest.cancelApprovalId !== null
          ? eq(approvals.id, input.latest.cancelApprovalId)
          : and(
              sql`${approvals.envelope}->>'type' = 'cancel-transaction'`,
              sql`${approvals.envelope}->>'targetApprovalId' = ${input.approvalId}`,
            ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    ceiling =
      cancel?.envelope?.type === "cancel-transaction" ? BigInt(cancel.envelope.maxFeeWei) : null;
  }

  if (ceiling === null) return policyCeiling ?? 0n;

  return policyCeiling !== null && policyCeiling < ceiling ? policyCeiling : ceiling;
}

/**
 * Ask the signer for the next attempt of `approvalId`'s transaction and store it, under the
 * attempts lock. `automatic` (the follow-up) acts only when the newest attempt and the last
 * request are both `REPRICE_AFTER_SECONDS` old; `speed_up` (a person) when the newest attempt
 * is {@link SPEED_UP_SPACING_SECONDS} old and the wallet's earlier transactions are mined.
 *
 * Refusals that would only repeat (the ceiling, the window, the attempt limit, a binding the
 * signer no longer accepts) are recorded as the stuck reason and stop automatic repricing until
 * another attempt exists; a pause is retried when the next reprice is due.
 *
 * A crash after the signer signed and before the attempt was stored is recovered here: the
 * signer then answers `conflict` for the next number, so the attempts it has are read back and
 * each missing one is requested again with exactly its fees, which the signer answers with the
 * bytes it signed (also while paused or after the window), and stored.
 */
async function reprice(
  ctx: AppContext,
  approvalId: ApprovalId,
  actor: RepriceActor,
  trigger: "automatic" | "speed_up",
): Promise<RepriceOutcome> {
  const chains = chainAccess(ctx);

  const result = await ctx.db.transaction(
    async (tx): Promise<{ outcome: RepriceOutcome; workspaceId: WorkspaceId | null }> => {
      await lockAttempts(tx, approvalId);

      const [transaction] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.approvalId, approvalId));

      const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId));
      const binding = approval ? bindingOf(approval) : null;

      if (
        !transaction ||
        !approval ||
        binding === null ||
        transaction.intentId === null ||
        (transaction.status !== "broadcast" && transaction.status !== "stuck")
      ) {
        return { outcome: "not_repriceable", workspaceId: null };
      }

      const { workspaceId } = approval;
      const answer = (outcome: RepriceOutcome) => ({ outcome, workspaceId });
      const stopped = transaction.stuckReason;

      if (stopped !== null && REPRICE_STOPPED.includes(stopped)) return answer(stopped);

      const attempts = await attemptsOf(ctx, workspaceId, transaction, tx);
      const latest = attempts.at(-1);

      if (!latest) throw new Error("a transaction without its first attempt");
      const now = ctx.now();
      const triedAt = transaction.repriceTriedAt === null ? 0 : seconds(transaction.repriceTriedAt);

      const due =
        trigger === "automatic"
          ? Math.max(latest.signedAt, triedAt) + ctx.config.reprice.afterSeconds
          : latest.signedAt + SPEED_UP_SPACING_SECONDS;

      if (now < due) return answer("not_due");

      /** Record that it asked (or found it could not), and why nothing changed if so. */
      const note = async (reason?: StuckReason) => {
        await tx
          .update(transactions)
          .set({
            repriceTriedAt: new Date(now * 1000),
            ...(reason === undefined ? {} : { stuckReason: reason }),
          })
          .where(eq(transactions.approvalId, approvalId));
      };

      const [workspace] = await tx
        .select({ paused: workspaces.paused })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));

      if (workspace?.paused) {
        await note("workspace_paused");

        return answer("workspace_paused");
      }

      const chainId = transaction.chainId as ChainId;

      const [wallet] = await tx
        .select({ address: wallets.address, policy: wallets.policy })
        .from(wallets)
        .where(eq(wallets.id, transaction.walletId));

      if (!wallet) throw new Error("a transaction's wallet no longer exists");

      let quote: FeeQuote;

      try {
        if (trigger === "speed_up") {
          // The follow-up looks at the nonce before it asks; a person may ask any time. Only
          // the next nonce to mine is worth a higher fee.
          const accountNonce = await chains.latestNonce(
            chainId,
            wallet.address,
            await chains.head(chainId),
          );

          if (accountNonce > transaction.nonce) return answer("not_repriceable");

          if (accountNonce < transaction.nonce) {
            await tx
              .update(transactions)
              .set({ stuckReason: "waiting_behind_nonce" })
              .where(eq(transactions.approvalId, approvalId));

            return answer("waiting_behind_nonce");
          }
        }

        quote = await chains.fees(chainId);
      } catch (error) {
        ctx.log.warn("reprice could not read the chain", {
          approvalId,
          code: error instanceof ChainError ? error.code : "rpc_unavailable",
        });
        await note();

        return answer("retry_later");
      }

      const [intentRow] = await tx
        .select()
        .from(intents)
        .where(eq(intents.id, transaction.intentId));

      if (!intentRow) throw new Error("a transaction's intent no longer exists");
      const intent = await readEvmIntent(ctx, intentRow);

      const fees = nextFees({
        latest,
        gas: latest.gas,
        ceilingWei: await ceilingOf(tx, { approvalId, intent, latest, policy: wallet.policy }),
        quote,
        bumpPercent: ctx.config.reprice.bumpPercent,
      });

      if (fees.kind === "ceiling_reached") {
        await note("fee_ceiling_reached");

        return answer("fee_ceiling_reached");
      }

      const request = (attempt: number, maxFee: bigint, maxTip: bigint): RepriceRequest => ({
        intent,
        ...binding,
        attempt,
        maxFeePerGas: maxFee.toString(),
        maxPriorityFeePerGas: maxTip.toString(),
      });

      /** The audit event and log line of one attempt this reprice stored. */
      const stored = async (response: AttemptResponse) => {
        const { attempt } = response;
        await appendAudit(
          ctx,
          {
            workspaceId,
            actor: actor.type === "user" ? actor : { type: "system", id: null },
            action: "transaction.repriced",
            subject: { type: "approval", id: approvalId },
            detail: {
              trigger,
              attempt: attempt.attempt,
              kind: attempt.kind,
              transactionHash: attempt.transactionHash,
              maxFeePerGas: attempt.maxFeePerGas,
              maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
            },
          },
          tx,
        );
        ctx.log.info("transaction repriced", { approvalId, attempt: attempt.attempt, trigger });
      };

      const unavailable = async (error: unknown) => {
        ctx.log.warn("reprice failed at the signer", {
          approvalId,
          code: error instanceof SignerError ? error.code : "unreachable",
        });
        await note();

        return answer("retry_later");
      };

      let response: AttemptResponse;

      try {
        response = await ctx.signer.reprice(
          approvalId,
          request(latest.attempt + 1, fees.maxFeePerGas, fees.maxPriorityFeePerGas),
        );
      } catch (error) {
        if (!(error instanceof SignerError) || RETRYABLE_SIGNER_CODES.includes(error.code)) {
          return unavailable(error);
        }

        if (error.code !== "conflict") {
          const reason = REFUSALS[error.code] ?? "reprice_refused";
          ctx.log.warn("reprice refused", { approvalId, code: error.code });
          await note(reason);

          return answer(reason);
        }

        // Another number than the next: the signer has attempts this record lacks.
        let caught: number;

        try {
          caught = await catchUpAttempts(ctx, tx, { workspaceId, transaction, latest, stored });
        } catch (lookup) {
          if (lookup instanceof AttemptsUnreadable) return unavailable(lookup.cause);
          throw lookup;
        }

        if (caught === 0) {
          // Not a number conflict: the signer no longer accepts what binds this request.
          ctx.log.warn("reprice refused", { approvalId, code: "conflict" });
          await note("reprice_refused");

          return answer("reprice_refused");
        }

        await note();

        return answer("caught_up");
      }

      // The signer gives a reprice of a cancel the cancel's request; so does this record.
      await recordAttempt(ctx, tx, {
        workspaceId,
        transaction,
        response,
        cancelApprovalId: response.attempt.kind === "cancel" ? latest.cancelApprovalId : null,
      });
      await stored(response);
      await note();

      return answer("repriced");
    },
  );

  if (
    result.workspaceId !== null &&
    (result.outcome === "repriced" || result.outcome === "caught_up")
  ) {
    await broadcastNewest(ctx, result.workspaceId, approvalId);
  }

  return result.outcome;
}

/** The follow-up's automatic reprice: acts only when one is due and nothing stopped it. */
export function repriceAutomatically(
  ctx: AppContext,
  approvalId: ApprovalId,
): Promise<RepriceOutcome> {
  return reprice(ctx, approvalId, { type: "system" }, "automatic");
}

/**
 * An approver's "Speed up": reprice now rather than when the schedule would, with no passkey
 * (the signer lets only the two fees rise, under the approved ceiling and within its window).
 * Two clicks race on the attempts lock; the second finds the newest attempt too recent and
 * answers `not_due`. The caller checks that `userId` may approve in the transaction's workspace.
 */
export function speedUp(
  ctx: AppContext,
  approvalId: ApprovalId,
  userId: UserId,
): Promise<RepriceOutcome> {
  return reprice(ctx, approvalId, { type: "user", id: userId }, "speed_up");
}

/**
 * The `speedUp` route: an approver's speed-up of an intent's transaction, as an HTTP answer.
 * Returns when the intent is to be answered as it is now: a new attempt was stored, or the
 * newest one is too recent for another (`not_due`: a second click, or the automatic reprice).
 * Every other outcome is a `conflict` with the reason as `detail`, or `internal` with
 * `retry_later` when the chain or the signer could not be reached. The caller checks the role.
 */
export async function speedUpIntent(
  ctx: AppContext,
  row: IntentRow,
  userId: UserId,
): Promise<void> {
  // A use of a mandate signs under its own approval id, as a request does.
  const outcome: RepriceOutcome =
    row.approvalId === null ? "not_repriceable" : await speedUp(ctx, row.approvalId, userId);

  switch (outcome) {
    case "repriced":
    case "caught_up":
    case "not_due":
      return;
    case "retry_later":
      throw new HttpError(
        "internal",
        "the chain or the signer could not be reached; try again",
        "retry_later",
      );
    case "not_repriceable":
      throw new HttpError(
        "conflict",
        "only a payment that was sent and is not mined yet can be sped up",
        outcome,
      );
    case "waiting_behind_nonce":
      throw new HttpError(
        "conflict",
        "an earlier transaction of this wallet is not mined yet; a higher fee here would not help",
        outcome,
      );
    case "workspace_paused":
      throw new HttpError("conflict", "this workspace is paused; a cancel still works", outcome);
    default:
      throw new HttpError("conflict", "this transaction cannot be repriced any further", outcome);
  }
}
