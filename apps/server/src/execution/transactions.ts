import type { TransactionInfo } from "@askgina/os-api";
import type { ApprovalId, ChainId, IntentId } from "@askgina/os-protocol";
import {
  SignerError,
  type SignResponse,
  type TransactionParams,
} from "@askgina/os-protocol/signer";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseTransaction, type Hex as ViemHex } from "viem";
import { ApprovalFailure, type ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext, Transaction } from "../context.ts";
import { nonceReservations, transactions, type wallets } from "../db/schema.ts";
import { ChainError, chainAccess, type ReceiptState } from "./chains.ts";

/**
 * One signed transaction per approval, whatever approved it: an agent's `approve-intent` or a
 * person's `sweep-wallet`. This module reserves the account nonce, picks fees inside the
 * approved ceiling, asks the signer once, stores the result, then broadcasts and watches it.
 * Each kind supplies how to ask the signer and what to move along with the transaction.
 */

export type TransactionRow = typeof transactions.$inferSelect;
type WalletRow = typeof wallets.$inferSelect;

export interface ExecutionOptions {
  /** How long the follow-up waits between receipt checks. */
  pollSeconds: number;
}

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

/** How a person sees a transaction: its hash, where it is, and a link to the explorer. */
export function transactionInfo(ctx: AppContext, row: TransactionRow): TransactionInfo {
  return {
    hash: row.hash as `0x${string}`,
    status: row.status,
    blockNumber: row.blockNumber,
    explorerUrl: chainAccess(ctx).explorerLink(row.chainId as ChainId, row.hash),
  };
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
const RETRYABLE_SIGNER_CODES: readonly string[] = ["internal", "vault_error", "unauthenticated"];

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
          inArray(transactions.status, ["signed", "broadcast", "stuck"]),
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
 * the signer's code (for `policy_denied`, the policy's reason).
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
        error.code === "policy_denied" && error.detail ? error.detail : error.code,
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
 * After signing: broadcast, then watch until the transaction is final or overdue. `moved` runs
 * after each change of the transaction's status, for a kind that tracks something with it (an
 * intent's status); a sweep tracks nothing beyond the transaction row.
 */
export async function followUpTransaction(
  ctx: AppContext,
  approval: ApprovalRow,
  transaction: TransactionRow,
  options: ExecutionOptions,
  moved: (status: TransactionRow["status"]) => Promise<unknown> = async () => {},
): Promise<{ done: boolean; waitSeconds: number }> {
  const chains = chainAccess(ctx);
  const chainId = transaction.chainId as ChainId;
  const raw = (await ctx.sealer.open(
    approval.workspaceId,
    rawLocation(approval.id),
    transaction.raw,
  )) as ViemHex;
  const now = ctx.now();
  const touch = async (status: TransactionRow["status"], blockNumber?: number) => {
    await ctx.db
      .update(transactions)
      .set({
        status,
        updatedAt: new Date(now * 1000),
        ...(blockNumber === undefined ? {} : { blockNumber }),
      })
      .where(eq(transactions.approvalId, approval.id));
  };

  const age = now - seconds(transaction.createdAt);
  const overdue = age >= ctx.config.reconcileTimeoutSeconds;
  const retryLater = (code: string, waitSeconds: number) => {
    ctx.log.warn("chain access failed", { approvalId: approval.id, code });
    return { done: false, waitSeconds };
  };

  if (transaction.status === "signed") {
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
        // Never accepted and no longer offered: its nonce is free again for this wallet.
        await touch("rejected");
        await moved("rejected");
        return { done: true, waitSeconds: 0 };
      }
    }
    await touch("broadcast");
    await moved("broadcast");
    return { done: false, waitSeconds: options.pollSeconds };
  }
  if (
    transaction.status === "confirmed" ||
    transaction.status === "reverted" ||
    transaction.status === "rejected"
  ) {
    return { done: true, waitSeconds: 0 };
  }

  // `broadcast` or `stuck`. A stuck transaction is still valid and may be mined any time, so it
  // is looked at again, slowly, for as long as the run lives.
  const wait = transaction.status === "stuck" ? STUCK_POLL_SECONDS : options.pollSeconds;
  let receipt: ReceiptState;
  try {
    receipt = await chains.receipt(chainId, transaction.hash as ViemHex);
  } catch (error) {
    if (error instanceof ChainError) return retryLater(error.code, wait);
    throw error;
  }
  if (receipt.state === "confirmed" || receipt.state === "reverted") {
    await touch(receipt.state, receipt.blockNumber);
    await moved(receipt.state);
    return { done: true, waitSeconds: 0 };
  }
  if (receipt.state === "missing") {
    if (transaction.status === "broadcast" && overdue) {
      await touch("stuck");
      await moved("stuck");
      return { done: false, waitSeconds: STUCK_POLL_SECONDS };
    }
    // A node may drop a transaction it has held for long. It is offered again, also while
    // stuck: later transactions of the wallet wait behind this nonce and need it mined.
    if (now - seconds(transaction.updatedAt) >= REBROADCAST_SECONDS) {
      await chains.broadcast(chainId, raw, transaction.hash as ViemHex).catch(() => {});
      await touch(transaction.status);
    }
  }
  return { done: false, waitSeconds: wait };
}
