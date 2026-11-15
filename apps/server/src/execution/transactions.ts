import type { TransactionAttemptView, TransactionInfo } from "@askgina/os-api";
import type { ApprovalId, ChainId, IntentId, WorkspaceId } from "@askgina/os-protocol";
import {
  type AttemptResponse,
  SignerError,
  type SignResponse,
  type TransactionAttemptKind,
  type TransactionParams,
} from "@askgina/os-protocol/signer";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { parseTransaction, type Hex as ViemHex } from "viem";
import { ApprovalFailure, type ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext, Executor, Transaction } from "../context.ts";
import {
  approvals,
  nonceReservations,
  type StuckReason,
  type TransactionStatusColumn,
  transactionAttempts,
  transactions,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { ChainError, chainAccess, type ReceiptState } from "./chains.ts";

/**
 * One signed transaction per approval, whatever approved it: an agent's `approve-intent` or a
 * person's `sweep-wallet`. This module reserves the account nonce, picks fees inside the
 * approved ceiling, asks the signer once, stores the result, then broadcasts and watches it.
 * Each kind supplies how to ask the signer and what to move along with the transaction.
 *
 * A transaction that is not mined can get more attempts at the same account nonce: reprices
 * (`repricing.ts`) and cancels. The nonce stays held, every attempt's hash is watched, and the
 * first attempt final at the chain's confirmation depth decides the outcome.
 */

export type TransactionRow = typeof transactions.$inferSelect;
type WalletRow = typeof wallets.$inferSelect;

export interface ExecutionOptions {
  /** How long the follow-up waits between receipt checks. */
  pollSeconds: number;
}

/** Statuses after which nothing about the transaction changes again. */
const FINAL: readonly TransactionStatusColumn[] = [
  "confirmed",
  "reverted",
  "rejected",
  "cancelled",
  "superseded",
];

/**
 * Reasons that stop automatic repricing until another attempt exists: asking again would only
 * be refused again.
 */
export const REPRICE_STOPPED: readonly StuckReason[] = [
  "fee_ceiling_reached",
  "reprice_window_closed",
  "attempts_exhausted",
  "reprice_refused",
];

const REBROADCAST_SECONDS = 60;
/** Longest wait between broadcast attempts while the chain will not take a transaction. */
const MAX_BROADCAST_BACKOFF_SECONDS = 60;
/** How often a `stuck` transaction is looked at again: it is still valid and may be mined. */
const STUCK_POLL_SECONDS = 600;
/** Gas the estimate is multiplied by, in percent, to absorb state changes before signing. */
export const GAS_MARGIN_PERCENT = 125n;
/** Used when a simulation failed and gave no estimate; the fee ceiling still bounds the cost. */
export const FALLBACK_GAS = 200_000n;

const rawLocation = (approvalId: string) => `transactions.raw:${approvalId}`;
const attemptRawLocation = (approvalId: string, attempt: number) =>
  `transactions.raw:${approvalId}:${attempt}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** The transaction an approval signed, or null when it has none (yet). */
export async function transactionOf(
  ctx: AppContext,
  approvalId: ApprovalId | null,
): Promise<TransactionRow | null> {
  if (approvalId === null) return null;
  const [row] = await ctx.db
    .select()
    .from(transactions)
    .where(eq(transactions.approvalId, approvalId));
  return row ?? null;
}

/**
 * The hash a person and an agent see: the mined attempt's once one is final, otherwise the
 * newest attempt's.
 */
export async function shownHash(ctx: AppContext, row: TransactionRow): Promise<ViemHex> {
  const attempt = row.minedAttempt ?? row.latestAttempt;
  if (attempt === 0) return row.hash as ViemHex;
  const [shown] = await ctx.db
    .select({ hash: transactionAttempts.hash })
    .from(transactionAttempts)
    .where(
      and(
        eq(transactionAttempts.approvalId, row.approvalId),
        eq(transactionAttempts.attempt, attempt),
      ),
    );
  return (shown?.hash ?? row.hash) as ViemHex;
}

/** Statuses in which a transaction was sent and nothing is final: it can get more attempts. */
export const SENT: readonly TransactionStatusColumn[] = ["broadcast", "stuck"];

/** Reasons a higher fee cannot cure: a speed-up would only be refused. */
const NOT_SPEEDABLE: readonly StuckReason[] = [
  ...REPRICE_STOPPED,
  "waiting_behind_nonce",
  "workspace_paused",
];

/** The `cancel-transaction` request for this transaction that waits for approval, if any. */
export async function waitingCancel(
  ctx: AppContext,
  approvalId: ApprovalId,
  executor: Executor = ctx.db,
): Promise<ApprovalId | null> {
  const [waiting] = await executor
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.kind, "cancel-transaction"),
        eq(approvals.subjectId, approvalId),
        eq(approvals.status, "pending"),
        gt(approvals.expiresAt, new Date(ctx.now() * 1000)),
      ),
    )
    .limit(1);
  return waiting?.id ?? null;
}

/** Every attempt of a transaction as people and agents see it, oldest first. */
export async function attemptViews(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  row: TransactionRow,
): Promise<TransactionAttemptView[]> {
  const chains = chainAccess(ctx);
  return (await attemptsOf(ctx, workspaceId, row)).map((attempt) => ({
    attempt: attempt.attempt,
    kind: attempt.kind,
    hash: attempt.hash,
    gas: attempt.gas.toString(),
    maxFeePerGas: attempt.maxFeePerGas.toString(),
    maxPriorityFeePerGas: attempt.maxPriorityFeePerGas.toString(),
    signedAt: attempt.signedAt,
    cancelApprovalId: attempt.cancelApprovalId,
    status: attempt.status === "replaced" ? "not_mined" : attempt.status,
    explorerUrl: chains.explorerLink(row.chainId as ChainId, attempt.hash),
  }));
}

/**
 * How a person sees a transaction: the shown hash, where it is, every attempt, why it is not
 * mined yet, and whether it can be sped up or a cancel requested now. `workspaceId` is its
 * approval's.
 */
export async function transactionInfo(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  row: TransactionRow,
): Promise<TransactionInfo> {
  const [attempts, [wallet], [workspace], pendingCancel] = await Promise.all([
    attemptViews(ctx, workspaceId, row),
    ctx.db.select({ policy: wallets.policy }).from(wallets).where(eq(wallets.id, row.walletId)),
    ctx.db
      .select({ paused: workspaces.paused })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
    waitingCancel(ctx, row.approvalId),
  ]);
  const shown = attempts.find(
    (attempt) => attempt.attempt === (row.minedAttempt ?? row.latestAttempt),
  );
  const hash = shown?.hash ?? (row.hash as ViemHex);
  const sent = SENT.includes(row.status);
  const reason = row.stuckReason;
  return {
    hash,
    status: row.status,
    blockNumber: row.blockNumber,
    explorerUrl: chainAccess(ctx).explorerLink(row.chainId as ChainId, hash),
    attempts,
    minedAttempt: row.minedAttempt,
    stuckReason: sent ? reason : null,
    // A sweep has no intent the signer could rebuild a reprice from.
    canSpeedUp:
      sent &&
      row.intentId !== null &&
      workspace?.paused !== true &&
      (reason === null || !NOT_SPEEDABLE.includes(reason)),
    canCancel:
      sent &&
      pendingCancel === null &&
      reason !== "attempts_exhausted" &&
      (wallet?.policy ?? null) !== null,
    pendingCancelApprovalId: pendingCancel,
  };
}

/**
 * End the cancel requests still waiting for approval of a transaction that is final: there is
 * nothing left to cancel, so nobody is asked for a passkey in vain. Each ends `cancelled`, and
 * its own run makes sure the signer never acts on it. A request already approved is left to
 * its run, which finds the transaction final and ends it `failed` with `transaction_final`.
 */
export async function endWaitingCancels(ctx: AppContext, approvalId: ApprovalId): Promise<void> {
  const waiting = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.kind, "cancel-transaction"),
        eq(approvals.subjectId, approvalId),
        eq(approvals.status, "pending"),
      ),
    );
  for (const { id } of waiting) await ctx.approvals.cancel(id);
}

// --- attempts ---------------------------------------------------------------------------------

/** One signed attempt of a transaction. Attempt 0 is the first signature. */
export interface Attempt {
  attempt: number;
  kind: TransactionAttemptKind;
  hash: ViemHex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The signer's time of signing, in seconds; for attempt 0, when its row was stored. */
  signedAt: number;
  /** For a cancel: the `cancel-transaction` request it is under, when known. */
  cancelApprovalId: ApprovalId | null;
  /**
   * `mined` once it is the attempt the chain mined; `replaced` once the transaction is final
   * through another attempt, another transaction at its nonce, or the chain never taking it.
   */
  status: "pending" | "mined" | "replaced";
}

/** Every attempt of a transaction, oldest first. `workspaceId` is its approval's. */
export async function attemptsOf(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  row: TransactionRow,
  executor: Executor = ctx.db,
): Promise<Attempt[]> {
  const [raw, later] = await Promise.all([
    ctx.sealer.open(workspaceId, rawLocation(row.approvalId), row.raw) as Promise<ViemHex>,
    executor
      .select()
      .from(transactionAttempts)
      .where(eq(transactionAttempts.approvalId, row.approvalId))
      .orderBy(asc(transactionAttempts.attempt)),
  ]);
  const first = parseTransaction(raw);
  return [
    {
      attempt: 0,
      kind: "original",
      hash: row.hash as ViemHex,
      gas: first.gas ?? 0n,
      maxFeePerGas: first.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: first.maxPriorityFeePerGas ?? 0n,
      signedAt: seconds(row.createdAt),
      cancelApprovalId: null,
      status:
        row.minedAttempt === 0 ? "mined" : FINAL.includes(row.status) ? "replaced" : "pending",
    },
    ...later.map((attempt) => ({
      attempt: attempt.attempt,
      kind: attempt.kind,
      hash: attempt.hash as ViemHex,
      gas: BigInt(attempt.gas),
      maxFeePerGas: BigInt(attempt.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(attempt.maxPriorityFeePerGas),
      signedAt: seconds(attempt.signedAt),
      cancelApprovalId: attempt.cancelApprovalId,
      status: attempt.status,
    })),
  ];
}

/** The newest attempt's hash and signed bytes, to offer it to the chain. */
async function newestAttempt(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  row: TransactionRow,
): Promise<{ hash: ViemHex; raw: ViemHex }> {
  if (row.latestAttempt === 0) {
    return {
      hash: row.hash as ViemHex,
      raw: (await ctx.sealer.open(workspaceId, rawLocation(row.approvalId), row.raw)) as ViemHex,
    };
  }
  const [newest] = await ctx.db
    .select({ hash: transactionAttempts.hash, raw: transactionAttempts.raw })
    .from(transactionAttempts)
    .where(
      and(
        eq(transactionAttempts.approvalId, row.approvalId),
        eq(transactionAttempts.attempt, row.latestAttempt),
      ),
    );
  if (!newest) throw new Error("the newest attempt of a transaction has no row");
  return {
    hash: newest.hash as ViemHex,
    raw: (await ctx.sealer.open(
      workspaceId,
      attemptRawLocation(row.approvalId, row.latestAttempt),
      newest.raw,
    )) as ViemHex,
  };
}

/**
 * Serializes everything that adds an attempt to a transaction or ends it: automatic reprices,
 * a person's speed-up, a cancel, and the follow-up's final outcome. Held until `tx` ends.
 */
export async function lockAttempts(tx: Transaction, approvalId: ApprovalId): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`attempts:${approvalId}`}, 0))`,
  );
}

/**
 * Store one attempt the signer returned (a reprice, or a cancel with `cancelApprovalId`), in
 * `tx`, which holds {@link lockAttempts}. Storing the same attempt again changes nothing but a
 * missing cancel request id, so a retry after a crash is safe. A new attempt clears the stuck
 * reason: what stopped repricing was about the attempt before it.
 */
export async function recordAttempt(
  ctx: AppContext,
  tx: Transaction,
  input: {
    workspaceId: WorkspaceId;
    transaction: TransactionRow;
    response: AttemptResponse;
    cancelApprovalId: ApprovalId | null;
  },
): Promise<void> {
  const { transaction, response } = input;
  const { attempt } = response;
  if (response.approvalId !== transaction.approvalId || attempt.kind === "original") {
    throw new Error("the signer returned an attempt of another transaction");
  }
  // Every attempt shares the first signature's nonce; that is what makes them exclusive.
  if (parseTransaction(response.signedTransaction as ViemHex).nonce !== transaction.nonce) {
    throw new Error("the signer returned an attempt at another account nonce");
  }
  const now = new Date(ctx.now() * 1000);
  await tx
    .insert(transactionAttempts)
    .values({
      approvalId: transaction.approvalId,
      attempt: attempt.attempt,
      kind: attempt.kind,
      hash: attempt.transactionHash,
      raw: await ctx.sealer.seal(
        input.workspaceId,
        attemptRawLocation(transaction.approvalId, attempt.attempt),
        response.signedTransaction,
      ),
      gas: attempt.gas,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      cancelApprovalId: input.cancelApprovalId,
      signedAt: new Date(attempt.signedAt * 1000),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [transactionAttempts.approvalId, transactionAttempts.attempt],
      set: {
        cancelApprovalId: sql`coalesce(${transactionAttempts.cancelApprovalId}, excluded.cancel_approval_id)`,
      },
    });
  await tx
    .update(transactions)
    .set({
      latestAttempt: sql`greatest(${transactions.latestAttempt}, ${attempt.attempt})`,
      stuckReason: null,
      updatedAt: now,
    })
    .where(eq(transactions.approvalId, transaction.approvalId));
}

/**
 * Offer the newest attempt of a sent, unmined transaction to the chain, and note when. A node
 * that refuses it changes nothing: the follow-up offers it again and reads every attempt's
 * receipt whichever node saw what.
 */
export async function broadcastNewest(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  approvalId: ApprovalId,
): Promise<void> {
  const row = await transactionOf(ctx, approvalId);
  if (!row || (row.status !== "broadcast" && row.status !== "stuck")) return;
  const newest = await newestAttempt(ctx, workspaceId, row);
  try {
    await chainAccess(ctx).broadcast(row.chainId as ChainId, newest.raw, newest.hash);
  } catch (error) {
    if (!(error instanceof ChainError)) throw error;
    ctx.log.warn("broadcasting an attempt failed", { approvalId, code: error.code });
  }
  await ctx.db
    .update(transactions)
    .set({ lastBroadcastAt: new Date(ctx.now() * 1000) })
    .where(eq(transactions.approvalId, approvalId));
}

interface FeeChoice {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Pick gas and fees for signing, inside the approved fee ceiling. */
function chooseFees(
  maxFeeWei: bigint,
  gasEstimate: bigint,
  fees: { baseFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): FeeChoice {
  const gas = (gasEstimate * GAS_MARGIN_PERCENT) / 100n;
  const needed = fees.baseFeePerGas + fees.maxPriorityFeePerGas;
  const affordable = maxFeeWei / gas;
  if (affordable < needed) {
    throw new ApprovalFailure(
      "fee_cap_exceeded",
      "current fees are above the approved fee ceiling",
    );
  }
  const preferred = 2n * fees.baseFeePerGas + fees.maxPriorityFeePerGas;
  return {
    gas,
    // biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints
    maxFeePerGas: preferred < affordable ? preferred : affordable,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}

/**
 * Signer refusals that a retry can cure: its own failures, and `unauthenticated`, which comes
 * from clock skew or a secret being rotated on one side first. Every other code is permanent.
 */
export const RETRYABLE_SIGNER_CODES: readonly string[] = [
  "internal",
  "vault_error",
  "unauthenticated",
];

/**
 * The account nonce for this approval's transaction, reserved and committed before the signer
 * is asked. The signer accepts a repeated account nonce (a reset chain counts from zero again;
 * a replacement needs the old one), so if this process died after the signer signed and before
 * the transaction row was stored, another approval of the same wallet must still not be given
 * the same nonce. A retry of this approval reuses its reservation.
 */
async function reserveNonce(
  ctx: AppContext,
  approvalId: ApprovalId,
  wallet: WalletRow,
  chainId: ChainId,
): Promise<number> {
  const chains = chainAccess(ctx);
  return ctx.db.transaction(async (tx) => {
    // One nonce allocator per wallet and chain.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nonce:${wallet.id}:${chainId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ nonce: nonceReservations.nonce })
      .from(nonceReservations)
      .where(eq(nonceReservations.approvalId, approvalId));
    if (existing) return existing.nonce;
    const [highest] = await tx
      .select({ nonce: sql<number | null>`max(${transactions.nonce})` })
      .from(transactions)
      .where(
        and(
          eq(transactions.walletId, wallet.id),
          eq(transactions.chainId, chainId),
          // A stuck transaction is still valid and still offered to the chain, so it keeps its
          // nonce: handing it to another approval would leave one of the two unmined for ever.
          // The nonce is held until one attempt is final at the confirmation depth, and only a
          // `rejected` first signature that never had another attempt gives it back.
          or(
            inArray(transactions.status, ["signed", "broadcast", "stuck"]),
            and(eq(transactions.status, "rejected"), sql`${transactions.latestAttempt} > 0`),
          ),
        ),
      );
    const [reserved] = await tx
      .select({ nonce: sql<number | null>`max(${nonceReservations.nonce})` })
      .from(nonceReservations)
      .where(
        and(eq(nonceReservations.walletId, wallet.id), eq(nonceReservations.chainId, chainId)),
      );
    const next = (value: number | null | undefined) =>
      value === null || value === undefined ? 0 : Number(value) + 1;
    const nonce = Math.max(
      await chains.pendingNonce(chainId, wallet.address),
      next(highest?.nonce),
      next(reserved?.nonce),
    );
    await tx.insert(nonceReservations).values({
      approvalId,
      walletId: wallet.id,
      chainId,
      nonce,
      createdAt: new Date(ctx.now() * 1000),
    });
    return nonce;
  });
}

/** An approval that ended without a stored signature gives its reserved nonce back. */
export async function releaseNonce(ctx: AppContext, approvalId: ApprovalId): Promise<void> {
  await ctx.db.delete(nonceReservations).where(eq(nonceReservations.approvalId, approvalId));
}

/**
 * Sign this approval's transaction once and store it. Runs in a workflow step, which may run
 * again after a crash: the caller returns early when a transaction row exists, and the signer
 * returns the transaction it already signed for this approval id, so a re-run cannot create a
 * second transaction. A permanent signer refusal releases the nonce and ends the request with
 * the signer's code (for `policy_denied` and `mandate_denied`, the policy's or mandate's reason).
 */
export async function signOnce(
  ctx: AppContext,
  input: {
    approval: ApprovalRow;
    wallet: WalletRow;
    chainId: ChainId;
    maxFeeWei: bigint;
    gasEstimate: bigint;
    /** The intent this transaction carries out; null for a sweep. */
    intentId: IntentId | null;
    sign(transaction: TransactionParams): Promise<SignResponse>;
    /** Runs in the database transaction that stores the signed transaction. */
    stored(tx: Transaction): Promise<unknown>;
  },
): Promise<void> {
  const { approval, wallet, chainId } = input;
  const nonce = await reserveNonce(ctx, approval.id, wallet, chainId);
  const quote = await chainAccess(ctx).fees(chainId);
  let chosen: FeeChoice;
  try {
    chosen = chooseFees(input.maxFeeWei, input.gasEstimate, quote);
  } catch (error) {
    if (error instanceof ApprovalFailure) await releaseNonce(ctx, approval.id);
    throw error;
  }

  let signed: SignResponse;
  try {
    signed = await input.sign({
      nonce,
      gas: chosen.gas.toString(),
      maxFeePerGas: chosen.maxFeePerGas.toString(),
      maxPriorityFeePerGas: chosen.maxPriorityFeePerGas.toString(),
    });
  } catch (error) {
    if (error instanceof SignerError && !RETRYABLE_SIGNER_CODES.includes(error.code)) {
      // A permanent refusal: nothing was signed, so the nonce is free for the next approval.
      await releaseNonce(ctx, approval.id);
      throw new ApprovalFailure(
        (error.code === "policy_denied" || error.code === "mandate_denied") && error.detail
          ? error.detail
          : error.code,
        "the signer refused to sign",
      );
    }
    throw error;
  }
  // A repeated request returns the transaction signed the first time, with its own nonce.
  const parsed = parseTransaction(signed.signedTransaction as ViemHex);
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(transactions)
      .values({
        approvalId: approval.id,
        intentId: input.intentId,
        walletId: wallet.id,
        chainId,
        nonce: parsed.nonce ?? nonce,
        hash: signed.transactionHash,
        raw: await ctx.sealer.seal(
          approval.workspaceId,
          rawLocation(approval.id),
          signed.signedTransaction,
        ),
        createdAt: new Date(ctx.now() * 1000),
        updatedAt: new Date(ctx.now() * 1000),
      })
      .onConflictDoNothing();
    await tx.delete(nonceReservations).where(eq(nonceReservations.approvalId, approval.id));
    await input.stored(tx);
  });
}

/**
 * What a kind does along with its transaction's follow-up. A sweep does nothing beyond the
 * transaction row; an intent moves its own status, and its transactions can be repriced.
 */
export interface FollowUpHooks {
  /**
   * Runs in the database transaction that changes the transaction's status. `cancelAttempted`
   * says a cancel was signed for it, so a payment mined anyway can be told apart.
   */
  moved?(
    status: TransactionStatusColumn,
    tx: Transaction,
    outcome: { cancelAttempted: boolean },
  ): Promise<unknown>;
  /**
   * Reprice now if one is due. Present only for a kind whose transactions can be repriced while
   * automatic repricing is on (a sweep's cannot: the signer has no intent to rebuild it from).
   * Handles the signer's refusals itself, recording them as the stuck reason.
   */
  reprice?(): Promise<unknown>;
}

/** The block whose account nonce counts as final: the head, less the confirmation depth. */
function finalBlock(head: bigint, confirmations: number): bigint {
  const block = head - BigInt(confirmations) + 1n;
  return block < 0n ? 0n : block;
}

/**
 * After signing: broadcast, then watch every attempt until one is final, or the account nonce
 * was used by a transaction that is none of them. Runs in a workflow step, repeatedly; each run
 * looks once and says how long to wait before the next.
 *
 * While no attempt is mined: if the wallet's account nonce at the confirmation depth is below
 * this transaction's, an earlier transaction of the wallet is not mined yet and repricing would
 * not help (`waiting_behind_nonce`); if it is equal, `hooks.reprice` may add an attempt with
 * higher fees. Either way the newest attempt is offered to the chain again every minute, since a
 * node may drop what it held. `stuck` keeps its meaning: not mined within the reconcile timeout
 * of the first signature; it is looked at again slowly, or when the next reprice is due.
 */
export async function followUpTransaction(
  ctx: AppContext,
  approval: ApprovalRow,
  transaction: TransactionRow,
  options: ExecutionOptions,
  hooks: FollowUpHooks = {},
): Promise<{ done: boolean; waitSeconds: number }> {
  const chains = chainAccess(ctx);
  const chainId = transaction.chainId as ChainId;
  const now = ctx.now();
  const at = new Date(now * 1000);
  const done = { done: true, waitSeconds: 0 };
  /** Final: a cancel request still waiting for it has nothing left to cancel. */
  const finished = async () => {
    await endWaitingCancels(ctx, approval.id);
    return done;
  };
  /** Move the transaction on from the status it was read with, and its kind with it. */
  const move = (status: TransactionStatusColumn, set: Partial<TransactionRow> = {}) =>
    ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transactions)
        .set({ ...set, status, updatedAt: at })
        .where(
          and(
            eq(transactions.approvalId, approval.id),
            eq(transactions.status, transaction.status),
          ),
        )
        .returning({ approvalId: transactions.approvalId });
      if (updated) await hooks.moved?.(status, tx, { cancelAttempted: false });
    });
  /**
   * The outcome, once: `mined` is the attempt the chain mined at the confirmation depth, or null
   * when another transaction used the nonce. Every other attempt is marked replaced. Holds the
   * attempts lock, so no attempt is added while the outcome is written.
   */
  const settle = (
    status: TransactionStatusColumn,
    mined: { attempt: number; blockNumber: number } | null,
  ) =>
    ctx.db.transaction(async (tx) => {
      await lockAttempts(tx, approval.id);
      const [updated] = await tx
        .update(transactions)
        .set({
          status,
          updatedAt: at,
          stuckReason: null,
          minedAttempt: mined?.attempt ?? null,
          ...(mined === null ? {} : { blockNumber: mined.blockNumber }),
        })
        .where(
          and(
            eq(transactions.approvalId, approval.id),
            inArray(transactions.status, ["broadcast", "stuck"]),
          ),
        )
        .returning({ approvalId: transactions.approvalId });
      if (!updated) return;
      await tx
        .update(transactionAttempts)
        .set({
          status:
            mined === null
              ? "replaced"
              : sql`CASE WHEN ${transactionAttempts.attempt} = ${mined.attempt} THEN 'mined' ELSE 'replaced' END`,
        })
        .where(eq(transactionAttempts.approvalId, approval.id));
      const [cancel] = await tx
        .select({ attempt: transactionAttempts.attempt })
        .from(transactionAttempts)
        .where(
          and(
            eq(transactionAttempts.approvalId, approval.id),
            eq(transactionAttempts.kind, "cancel"),
          ),
        )
        .limit(1);
      await hooks.moved?.(status, tx, { cancelAttempted: cancel !== undefined });
    });

  const age = now - seconds(transaction.createdAt);
  const overdue = age >= ctx.config.reconcileTimeoutSeconds;
  const retryLater = (code: string, waitSeconds: number) => {
    ctx.log.warn("chain access failed", { approvalId: approval.id, code });
    return { done: false, waitSeconds };
  };

  if (transaction.status === "signed") {
    const raw = (await ctx.sealer.open(
      approval.workspaceId,
      rawLocation(approval.id),
      transaction.raw,
    )) as ViemHex;
    try {
      await chains.broadcast(chainId, raw, transaction.hash as ViemHex);
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      if (!overdue) {
        // Back off as the attempts age, up to a minute, until the reconcile timeout.
        const backoff = Math.min(
          MAX_BROADCAST_BACKOFF_SECONDS,
          Math.max(options.pollSeconds, Math.floor(age / 4)),
        );
        return retryLater(error.code, backoff);
      }
      // Out of time. Only a chain that answers "unknown" ends it; an RPC error is no answer.
      let known: boolean;
      try {
        known = await chains.known(chainId, transaction.hash as ViemHex);
      } catch (lookup) {
        if (lookup instanceof ChainError) return retryLater(lookup.code, options.pollSeconds);
        throw lookup;
      }
      if (!known) {
        // Never accepted and no longer offered, and no other attempt exists before broadcast:
        // its nonce is free again for this wallet.
        await move("rejected");
        return done;
      }
    }
    await move("broadcast", { lastBroadcastAt: at });
    return { done: false, waitSeconds: options.pollSeconds };
  }
  // Ended before by this follow-up; repeated so a crash right after cannot leave a cancel
  // request waiting.
  if (FINAL.includes(transaction.status)) return finished();

  // `broadcast` or `stuck`. A stuck transaction is still valid and may be mined any time, so it
  // is looked at again for as long as the run lives.
  const wait = transaction.status === "stuck" ? STUCK_POLL_SECONDS : options.pollSeconds;
  const [wallet] = await ctx.db
    .select({ address: wallets.address })
    .from(wallets)
    .where(eq(wallets.id, transaction.walletId));
  if (!wallet) throw new Error("a transaction's wallet no longer exists");
  const attempts = await attemptsOf(ctx, approval.workspaceId, transaction);
  let mined: { attempt: Attempt; receipt: Exclude<ReceiptState, { state: "missing" }> } | null =
    null;
  let accountNonce = transaction.nonce;
  try {
    // The head first: an attempt mined at or below it has a receipt by the time it is read, so a
    // nonce used at the confirmation depth while none of ours has a receipt was used by another
    // transaction.
    const head = await chains.head(chainId);
    // Newest first: a reprice is the likelier one, and at most one can be mined.
    for (const attempt of [...attempts].reverse()) {
      const receipt = await chains.receipt(chainId, attempt.hash);
      if (receipt.state !== "missing") {
        mined = { attempt, receipt };
        break;
      }
    }
    if (mined === null) {
      accountNonce = await chains.latestNonce(
        chainId,
        wallet.address,
        finalBlock(head, chains.config(chainId).confirmations),
      );
    }
  } catch (error) {
    if (error instanceof ChainError) return retryLater(error.code, wait);
    throw error;
  }

  if (mined !== null) {
    const { attempt, receipt } = mined;
    // Mined, but not yet at the confirmation depth: a reorg could still swap it for another
    // attempt, so nothing is decided, repriced or sent until it is.
    if (receipt.state === "pending") return { done: false, waitSeconds: options.pollSeconds };
    await settle(attempt.kind === "cancel" ? "cancelled" : receipt.state, {
      attempt: attempt.attempt,
      blockNumber: receipt.blockNumber,
    });
    return finished();
  }
  if (accountNonce > transaction.nonce) {
    await settle("superseded", null);
    return finished();
  }

  const behind = accountNonce < transaction.nonce;
  if (!behind) await hooks.reprice?.();
  const current = await transactionOf(ctx, approval.id);
  if (!current || current.status !== transaction.status) {
    return { done: false, waitSeconds: options.pollSeconds };
  }
  const [workspace] = await ctx.db
    .select({ paused: workspaces.paused })
    .from(workspaces)
    .where(eq(workspaces.id, approval.workspaceId));
  // A reason that stopped automatic repricing stands until another attempt exists.
  const stopped =
    current.stuckReason !== null && REPRICE_STOPPED.includes(current.stuckReason)
      ? current.stuckReason
      : null;
  const reason: StuckReason =
    stopped ??
    (behind ? "waiting_behind_nonce" : workspace?.paused ? "workspace_paused" : "fee_too_low");
  const becomesStuck = current.status === "broadcast" && overdue;
  if (becomesStuck) {
    await move("stuck", { stuckReason: reason });
  } else if (current.stuckReason !== reason) {
    await ctx.db
      .update(transactions)
      .set({ stuckReason: reason })
      .where(eq(transactions.approvalId, approval.id));
  }
  // A node may drop a transaction it has held for long. The newest attempt is offered again,
  // also while stuck: later transactions of the wallet wait behind this nonce.
  const lastBroadcast = current.lastBroadcastAt === null ? 0 : seconds(current.lastBroadcastAt);
  if (now - lastBroadcast >= REBROADCAST_SECONDS) {
    await broadcastNewest(ctx, approval.workspaceId, approval.id);
  }

  if (!becomesStuck && current.status === "broadcast") return { done: false, waitSeconds: wait };
  if (!hooks.reprice || behind || stopped !== null) {
    return { done: false, waitSeconds: STUCK_POLL_SECONDS };
  }
  // Stuck and repriced automatically: look again when the next reprice is due.
  let latestSignedAt = seconds(current.createdAt);
  if (current.latestAttempt > 0) {
    const [latest] = await ctx.db
      .select({ signedAt: transactionAttempts.signedAt })
      .from(transactionAttempts)
      .where(
        and(
          eq(transactionAttempts.approvalId, approval.id),
          eq(transactionAttempts.attempt, current.latestAttempt),
        ),
      );
    if (latest) latestSignedAt = seconds(latest.signedAt);
  }
  const tried = current.repriceTriedAt === null ? 0 : seconds(current.repriceTriedAt);
  const due = Math.max(latestSignedAt, tried) + ctx.config.reprice.afterSeconds;
  return {
    done: false,
    waitSeconds: Math.min(STUCK_POLL_SECONDS, Math.max(1, due - now)),
  };
}
