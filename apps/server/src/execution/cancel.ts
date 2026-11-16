import type { ApprovalSummary } from "@askgina/os-api";
import { ApprovalId, IntentId, type UserId, type WorkspaceId } from "@askgina/os-protocol";
import { type AttemptResponse, SignerError } from "@askgina/os-protocol/signer";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ApprovalFailure, type ApprovalKindHandler } from "../approvals/kinds.ts";
import { type AuditInput, appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { approvals, transactions } from "../db/schema.ts";
import type { JsonValue } from "../db/sealed.ts";
import { stored } from "../db/stored.ts";
import { loadWallet, walletSummary } from "../directory/views.ts";
import { HttpError } from "../http/errors.ts";
import { engineOf } from "./approvals.ts";
import { chainAccess } from "./chains.ts";
import { getIntentRow, intentDetail, intentTitle } from "./intents.ts";
import { catchUpAttempts, nextFees } from "./repricing.ts";
import {
  type Attempt,
  attemptsOf,
  broadcastNewest,
  chainIdOf,
  lockAttempts,
  RETRYABLE_SIGNER_CODES,
  recordAttempt,
  SENT,
  transactionInfo,
  transactionOf,
} from "./transactions.ts";

/**
 * `cancel-transaction`: people ask the signer, with their passkeys at the wallet policy's
 * threshold, to replace a sent, unmined transaction with a transfer of nothing from the wallet
 * to itself at the same account nonce (`docs/approval-protocol.md`, section 8, "Reprices and
 * cancels"). Whichever the chain mines first wins, so a cancel is an attempt, not a guarantee.
 * It is stored as one more attempt of the transaction it stops; that transaction's own
 * follow-up reconciles it, so this kind has no follow-up of its own. A landed cancel gives no
 * spend back: the signer counted the payment when it first signed it.
 */

/** What `cancel-transaction` keeps sealed in its approval's detail. */
const CancelDetail = z.object({
  /** The approval whose transaction it stops: an `approve-intent`, a mandate use or a sweep. */
  targetApprovalId: ApprovalId,
  /** The payment it stops; null for a sweep. */
  intentId: IntentId.nullable(),
});

type CancelDetail = z.infer<typeof CancelDetail>;

function cancelDetail(detail: JsonValue): CancelDetail {
  return stored(CancelDetail, detail, "approval detail (cancel-transaction)");
}

/** The gas of a transfer of nothing from the wallet to itself. */
const CANCEL_GAS = 21_000n;

/** Thrown inside the opening transaction when a cancel request for the transaction waits. */
class CancelWaiting extends Error {
  override readonly name = "CancelWaiting";
  readonly approvalId: ApprovalId;

  constructor(approvalId: ApprovalId) {
    super("a cancel request for this transaction waits for approval");
    this.approvalId = approvalId;
  }
}

/**
 * Open a `cancel-transaction` request for the transaction `targetApprovalId` signed. Allowed
 * while the workspace is paused: a cancel moves nothing. Its fee ceiling is the wallet policy's
 * fee cap per transaction and it is approved at the policy's threshold and within its lifetime,
 * as the signer checks with its own copy of the policy. While one request for the transaction
 * waits, asking again answers that one.
 */
export async function requestCancel(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    targetApprovalId: ApprovalId | null;
    intentId: IntentId | null;
    requestedBy: UserId;
  },
): Promise<ApprovalSummary> {
  const transaction = await transactionOf(ctx, input.targetApprovalId);

  if (transaction === null || transaction.status === "signed") {
    throw new HttpError(
      "conflict",
      "nothing was sent yet, so there is nothing to cancel",
      "not_sent",
    );
  }

  if (!SENT.includes(transaction.status)) {
    throw new HttpError(
      "conflict",
      "the transaction is already mined or replaced",
      "transaction_final",
    );
  }

  if (transaction.stuckReason === "attempts_exhausted") {
    throw new HttpError(
      "conflict",
      "the signer allows no more attempts of this transaction",
      "attempts_exhausted",
    );
  }

  const state = await ctx.signer.getWallet(transaction.walletId).catch((cause: unknown) => {
    throw new HttpError(
      "internal",
      "the signer could not be reached",
      cause instanceof SignerError ? cause.code : undefined,
    );
  });

  if (state.policy === null) {
    throw new HttpError("policy_denied", "this wallet has no approved policy", "policy_missing");
  }

  const { policy } = state;
  const maxFeeWei = BigInt(policy.fees.maxPerTxWei);
  // Whatever the chain asks, a cancel must outbid the newest attempt within its ceiling.
  const latest = (await attemptsOf(ctx, input.workspaceId, transaction)).at(-1);

  if (!latest) throw new Error("a transaction without its first attempt");

  const reachable = nextFees({
    latest,
    gas: CANCEL_GAS,
    ceilingWei: maxFeeWei,
    quote: { baseFeePerGas: 0n, maxPriorityFeePerGas: 0n },
    bumpPercent: ctx.config.reprice.bumpPercent,
  });

  if (reachable.kind === "ceiling_reached") {
    throw new HttpError(
      "conflict",
      "the wallet policy's fee cap per transaction is too low to replace this transaction",
      "fee_ceiling_reached",
    );
  }

  const target = transaction.approvalId;
  const engine = engineOf(ctx);

  try {
    return await engine.open({
      workspaceId: input.workspaceId,
      kind: "cancel-transaction",
      subjectId: target,
      envelope: {
        targetApprovalId: target,
        walletId: transaction.walletId,
        chainId: chainIdOf(transaction),
        txNonce: transaction.nonce,
        maxFeeWei: maxFeeWei.toString(),
      },
      threshold: policy.approvals.threshold,
      ttlSeconds: policy.approvals.ttlSeconds,
      detail: { targetApprovalId: target, intentId: input.intentId } satisfies CancelDetail,
      requestedBy: { type: "user", id: input.requestedBy },
      alongside: async (tx, approvalId) => {
        // Requests for one transaction are ordered here, so only one of them waits at a time.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cancel:${target}`}, 0))`,
        );

        const [waiting] = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.kind, "cancel-transaction"),
              eq(approvals.subjectId, target),
              eq(approvals.status, "pending"),
              gt(approvals.expiresAt, new Date(ctx.now() * 1000)),
              ne(approvals.id, approvalId),
            ),
          )
          .limit(1);

        if (waiting) throw new CancelWaiting(waiting.id);
        await appendAudit(
          ctx,
          {
            workspaceId: input.workspaceId,
            actor: { type: "user", id: input.requestedBy },
            action: "transaction.cancel_requested",
            subject: { type: "approval", id: target },
            detail: { cancelApprovalId: approvalId, intentId: input.intentId },
          },
          tx,
        );
      },
    });
  } catch (error) {
    if (error instanceof CancelWaiting)
      return engine.summary(await engine.request(error.approvalId));
    throw error;
  }
}

/** The inbox line of the sweep a cancel stops. */
async function sweepTitle(ctx: AppContext, approvalId: ApprovalId): Promise<string> {
  const engine = engineOf(ctx);
  const sweep = await engine.request(approvalId);

  return engine.handler(sweep.kind).title(ctx, sweep, await engine.openDetail(sweep));
}

export function cancelTransactionKind(): ApprovalKindHandler<"cancel-transaction"> {
  return {
    kind: "cancel-transaction",
    async title(ctx, _approval, detail) {
      const { targetApprovalId, intentId } = cancelDetail(detail);

      if (intentId === null) return `Cancel sweep: ${await sweepTitle(ctx, targetApprovalId)}`;

      return `Cancel payment: ${await intentTitle(ctx, await getIntentRow(ctx, intentId))}`;
    },
    async describe(ctx, approval, detail) {
      const { targetApprovalId, intentId } = cancelDetail(detail);
      const { envelope } = approval;

      if (envelope.type !== "cancel-transaction") throw new Error("a cancel with another envelope");
      const transaction = await transactionOf(ctx, targetApprovalId);

      if (!transaction) throw new Error("a cancel request without its transaction");
      const { wallet, agentId } = await loadWallet(ctx, approval.workspaceId, envelope.walletId);

      return {
        kind: "cancel-transaction",
        wallet: walletSummary(wallet, agentId),
        intent:
          intentId === null ? null : await intentDetail(ctx, await getIntentRow(ctx, intentId)),
        sweep:
          intentId === null
            ? { approvalId: targetApprovalId, title: await sweepTitle(ctx, targetApprovalId) }
            : null,
        transaction: await transactionInfo(ctx, approval.workspaceId, transaction),
        txNonce: envelope.txNonce,
        maxFeeWei: envelope.maxFeeWei,
      };
    },
    async confirmationSubject() {
      // The envelope names the target; the signer shows it from its own record of the signature.
      return { kind: "envelope-only" };
    },
    /**
     * Sign the cancel and store it as the next attempt, under the attempts lock, so no reprice
     * and no final outcome of the transaction comes between; then offer it to the chain. A
     * transaction that became final before the cancel could be signed ends the request
     * `failed` with `transaction_final`. Run again after a crash, the signer answers the same
     * envelope with the attempt it produced, and storing it again changes nothing.
     *
     * The signer's `conflict` means it holds attempts this record lacks (a reprice or another
     * cancel whose caller stopped before storing it): they are stored here first, exactly as
     * the signer signed them, and the cancel is asked for once more after the newest of them.
     */
    async execute(ctx, approval, authorization, detail) {
      const { targetApprovalId } = cancelDetail(detail);
      const { envelope } = approval;

      if (envelope.type !== "cancel-transaction") throw new Error("a cancel with another envelope");

      const result = await ctx.db.transaction(async (tx): Promise<{ failure: string | null }> => {
        await lockAttempts(tx, targetApprovalId);

        const [transaction] = await tx
          .select()
          .from(transactions)
          .where(eq(transactions.approvalId, targetApprovalId));

        if (!transaction) return { failure: "transaction_missing" };
        let attempts: Attempt[] = await attemptsOf(ctx, approval.workspaceId, transaction, tx);

        if (attempts.some((attempt) => attempt.cancelApprovalId === approval.id)) {
          return { failure: null };
        }

        if (!SENT.includes(transaction.status)) return { failure: "transaction_final" };
        // A chain that cannot be read fails the step, which is tried again.
        const quote = await chainAccess(ctx).fees(chainIdOf(transaction));

        /** The audit event and log line of one attempt stored here. */
        const stored = async (
          response: AttemptResponse,
          under: { cancelApprovalId: ApprovalId | null; producedBy: ApprovalId | null },
        ) => {
          const { attempt } = response;

          const fees = {
            attempt: attempt.attempt,
            transactionHash: attempt.transactionHash,
            maxFeePerGas: attempt.maxFeePerGas,
            maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
          };

          const event: AuditInput =
            under.producedBy === null
              ? {
                  workspaceId: approval.workspaceId,
                  actor: { type: "system", id: null },
                  subject: { type: "approval", id: targetApprovalId },
                  // A reprice its caller did not store before it stopped.
                  action: "transaction.repriced",
                  detail: { trigger: "recovered", kind: attempt.kind, ...fees },
                }
              : {
                  workspaceId: approval.workspaceId,
                  actor: { type: "system", id: null },
                  subject: { type: "approval", id: targetApprovalId },
                  action: "transaction.cancel_signed",
                  detail: { cancelApprovalId: under.producedBy, ...fees },
                };

          await appendAudit(ctx, event, tx);
          ctx.log.info(
            under.producedBy === null ? "transaction repriced" : "transaction cancel signed",
            { approvalId: targetApprovalId, attempt: attempt.attempt },
          );
        };

        for (let caughtUp = false; ; caughtUp = true) {
          const latest = attempts.at(-1);

          if (!latest) throw new Error("a transaction without its first attempt");

          const fees = nextFees({
            latest,
            gas: CANCEL_GAS,
            ceilingWei: BigInt(envelope.maxFeeWei),
            quote,
            bumpPercent: ctx.config.reprice.bumpPercent,
          });

          if (fees.kind === "ceiling_reached") return { failure: "fee_ceiling_reached" };

          let response: AttemptResponse;

          try {
            response = await ctx.signer.cancelTransaction(targetApprovalId, {
              authorization,
              attempt: latest.attempt + 1,
              maxFeePerGas: fees.maxFeePerGas.toString(),
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
            });
          } catch (error) {
            if (!(error instanceof SignerError) || RETRYABLE_SIGNER_CODES.includes(error.code)) {
              throw error;
            }

            if (error.code !== "conflict") return { failure: error.code };

            // Asked once more only: a second conflict is a race the next try of the step wins.
            if (caughtUp) throw new Error("the signer still holds attempts not stored here");

            const caught = await catchUpAttempts(ctx, tx, {
              workspaceId: approval.workspaceId,
              transaction,
              latest,
              stored,
            });

            // Not about attempt numbers: the signer refuses this cancel for good.
            if (caught === 0) return { failure: "conflict" };
            attempts = await attemptsOf(ctx, approval.workspaceId, transaction, tx);

            if (attempts.some((attempt) => attempt.cancelApprovalId === approval.id)) {
              return { failure: null };
            }

            continue;
          }

          if (response.attempt.attempt !== latest.attempt + 1) {
            // The signer answered with this cancel's own attempt, signed before attempts this
            // record lacks: they are stored first, then it, under this request.
            await catchUpAttempts(ctx, tx, {
              workspaceId: approval.workspaceId,
              transaction,
              latest,
              stored,
            });

            return { failure: null };
          }

          await recordAttempt(ctx, tx, {
            workspaceId: approval.workspaceId,
            transaction,
            response,
            cancelApprovalId: approval.id,
          });
          await stored(response, { cancelApprovalId: approval.id, producedBy: approval.id });

          return { failure: null };
        }
      });

      if (result.failure !== null) {
        if (result.failure === "attempts_exhausted") {
          await ctx.db
            .update(transactions)
            .set({ stuckReason: "attempts_exhausted" })
            .where(eq(transactions.approvalId, targetApprovalId));
        }

        throw new ApprovalFailure(result.failure, "the cancel could not be signed");
      }

      await broadcastNewest(ctx, approval.workspaceId, targetApprovalId);
    },
  };
}

export function registerCancelKind(ctx: AppContext): void {
  engineOf(ctx).register(cancelTransactionKind());
}
