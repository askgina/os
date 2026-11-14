import type {
  IntentDetail,
  IntentDisplay,
  IntentStatus,
  IntentSummary,
  Simulation,
  WalletSummary,
} from "@askgina/os-api";
import {
  type AgentId,
  type ApprovalId,
  type Authorization,
  type ChainId,
  evaluateIntent,
  type Hex,
  Intent,
  type IntentId,
  intentHash,
  intentSpend,
  newId,
  type Operation,
  PROTOCOL_VERSION,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError, type SignResponse } from "@askgina/os-protocol/signer";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseTransaction,
  type Hex as ViemHex,
} from "viem";
import { ApprovalFailure, type ApprovalKindHandler, type ApprovalRow } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Executor } from "../context.ts";
import {
  agents,
  intents,
  nonceReservations,
  transactions,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { approvalLink, engineOf } from "./approvals.ts";
import { ChainError, chainAccess, type ReceiptState } from "./chains.ts";

type IntentRow = typeof intents.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type WalletRow = typeof wallets.$inferSelect;

interface Presentation {
  display: IntentDisplay;
  simulation: Simulation | null;
}

/** What `approve-intent` keeps sealed in its approval's detail. */
interface IntentApprovalDetail {
  intentId: IntentId;
}

const PAGE_SIZE = 50;
const REBROADCAST_SECONDS = 60;
/** Longest wait between broadcast attempts while the chain will not take a transaction. */
const MAX_BROADCAST_BACKOFF_SECONDS = 60;
/** How often a `stuck` transaction is looked at again: it is still valid and may be mined. */
const STUCK_POLL_SECONDS = 600;
/** Proposals one agent may have waiting for people at once; more is a loop, not a request. */
export const MAX_PENDING_PER_AGENT = 20;
/** Gas the estimate is multiplied by, in percent, to absorb state changes before signing. */
const GAS_MARGIN_PERCENT = 125n;
/** Used when a simulation failed and gave no estimate; the fee ceiling still bounds the cost. */
const FALLBACK_GAS = 200_000n;

const payloadLocation = (id: string) => `intents.payload:${id}`;
const presentationLocation = (id: string) => `intents.presentation:${id}`;
const rawLocation = (approvalId: string) => `transactions.raw:${approvalId}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export interface ExecutionOptions {
  /** How long the follow-up waits between receipt checks. */
  pollSeconds: number;
}

// --- reading intents --------------------------------------------------------------------------

export async function readIntent(
  ctx: AppContext,
  row: IntentRow,
): Promise<{ intent: Intent; presentation: Presentation }> {
  const [intent, presentation] = await Promise.all([
    ctx.sealer.open(row.workspaceId, payloadLocation(row.id), row.payload),
    ctx.sealer.open(row.workspaceId, presentationLocation(row.id), row.presentation),
  ]);
  return { intent: Intent.parse(intent), presentation: presentation as Presentation };
}

async function intentRow(ctx: AppContext, id: string, executor: Executor = ctx.db) {
  const [row] = await executor
    .select()
    .from(intents)
    .where(eq(intents.id, id as IntentId));
  if (!row) throw new HttpError("not_found", "no such intent");
  return row;
}

async function transactionOf(ctx: AppContext, approvalId: ApprovalId | null) {
  if (approvalId === null) return null;
  const [row] = await ctx.db
    .select()
    .from(transactions)
    .where(eq(transactions.approvalId, approvalId));
  return row ?? null;
}

export async function intentSummary(ctx: AppContext, row: IntentRow): Promise<IntentSummary> {
  const [{ intent, presentation }, [agent], transaction] = await Promise.all([
    readIntent(ctx, row),
    ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId)),
    transactionOf(ctx, row.approvalId),
  ]);
  return {
    id: row.id,
    agent: { id: row.agentId, name: agent?.name ?? "" },
    walletId: row.walletId,
    chainId: intent.chainId,
    status: row.status,
    display: presentation.display,
    memo: intent.memo,
    createdAt: seconds(row.createdAt),
    approvalId: row.approvalId,
    transactionHash: (transaction?.hash as `0x${string}` | undefined) ?? null,
    failureCode: row.failureCode,
  };
}

export async function intentDetail(ctx: AppContext, row: IntentRow): Promise<IntentDetail> {
  const [summary, { intent, presentation }, transaction] = await Promise.all([
    intentSummary(ctx, row),
    readIntent(ctx, row),
    transactionOf(ctx, row.approvalId),
  ]);
  return {
    ...summary,
    intent,
    intentHash: row.intentHash,
    simulation: presentation.simulation,
    transaction: transaction
      ? {
          hash: transaction.hash as `0x${string}`,
          status: transaction.status,
          blockNumber: transaction.blockNumber,
          explorerUrl: chainAccess(ctx).explorerLink(intent.chainId, transaction.hash),
        }
      : null,
  };
}

export async function getIntentRow(ctx: AppContext, id: string): Promise<IntentRow> {
  return intentRow(ctx, id);
}

export async function listIntentRows(
  ctx: AppContext,
  filter: {
    workspaceId: WorkspaceId;
    agentId?: AgentId;
    status?: IntentStatus;
    cursor?: string | undefined;
    limit?: number;
  },
): Promise<{ rows: IntentRow[]; nextCursor: string | null }> {
  const limit = filter.limit ?? PAGE_SIZE;
  const conditions = [eq(intents.workspaceId, filter.workspaceId)];
  if (filter.agentId !== undefined) conditions.push(eq(intents.agentId, filter.agentId));
  if (filter.status !== undefined) conditions.push(eq(intents.status, filter.status));
  if (filter.cursor !== undefined) {
    const [at, id] = Buffer.from(filter.cursor, "base64url").toString("utf8").split("|");
    const time = Number(at);
    if (!id || !Number.isSafeInteger(time)) throw new HttpError("invalid_request", "bad cursor");
    const before = or(
      lt(intents.createdAt, new Date(time)),
      and(eq(intents.createdAt, new Date(time)), lt(intents.id, id as IntentId)),
    );
    if (before) conditions.push(before);
  }
  const rows = await ctx.db
    .select()
    .from(intents)
    .where(and(...conditions))
    .orderBy(desc(intents.createdAt), desc(intents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(`${last.createdAt.getTime()}|${last.id}`).toString("base64url")
        : null,
  };
}

// --- status changes ---------------------------------------------------------------------------

/** Move an intent from one of `from` to `to`, with an audit event. False when it was elsewhere. */
async function moveIntent(
  ctx: AppContext,
  row: Pick<IntentRow, "id" | "workspaceId">,
  from: readonly IntentRow["status"][],
  to: IntentRow["status"],
  extra: { failureCode?: string; executor?: Executor } = {},
): Promise<boolean> {
  const write = async (executor: Executor) => {
    const [updated] = await executor
      .update(intents)
      .set({
        status: to,
        updatedAt: new Date(ctx.now() * 1000),
        ...(extra.failureCode === undefined ? {} : { failureCode: extra.failureCode }),
      })
      .where(and(eq(intents.id, row.id), inArray(intents.status, [...from])))
      .returning({ id: intents.id });
    if (!updated) return false;
    await appendAudit(
      ctx,
      {
        workspaceId: row.workspaceId,
        actor: { type: "system", id: null },
        action: `intent.${to}`,
        subject: { type: "intent", id: row.id },
        ...(extra.failureCode === undefined ? {} : { detail: { code: extra.failureCode } }),
      },
      executor,
    );
    return true;
  };
  return extra.executor ? write(extra.executor) : ctx.db.transaction(write);
}

// --- proposing --------------------------------------------------------------------------------

export interface Proposer {
  agent: AgentRow;
}

export interface ProposalResult {
  intentId: IntentId;
  status: IntentStatus;
  approvalId: ApprovalId;
  approvalUrl: string;
  expiresAt: number;
}

/** The wallet an agent proposes from: its own, or a treasury whose policy names it. */
async function resolveWallet(
  ctx: AppContext,
  agent: AgentRow,
  walletId: WalletId | undefined,
): Promise<WalletRow> {
  const [wallet] = await ctx.db
    .select()
    .from(wallets)
    .where(
      and(eq(wallets.id, walletId ?? agent.walletId), eq(wallets.workspaceId, agent.workspaceId)),
    );
  if (!wallet) throw new HttpError("not_found", "no such wallet");
  const usable =
    wallet.id === agent.walletId ||
    (wallet.kind === "treasury" && (wallet.policy?.requesters.includes(agent.id) ?? false));
  if (!usable) throw new HttpError("not_found", "no such wallet");
  return wallet;
}

/** Whole units ("1.5") to base units with `decimals`, refusing more precision than the asset has. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d{1,78})(?:\.(\d{1,78}))?$/.exec(amount.trim());
  if (!match) throw new HttpError("invalid_request", "amount must be a decimal number");
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new HttpError("invalid_request", `amount has more than ${decimals} decimal places`);
  }
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value <= 0n) throw new HttpError("invalid_request", "amount must be greater than zero");
  return value;
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

async function propose(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    chainId: string;
    walletId?: WalletId | undefined;
    memo: string;
    build: (
      wallet: WalletRow,
      chainId: ChainId,
    ) => Promise<{
      operation: Operation;
      display: IntentDisplay;
      call: { to: `0x${string}`; value: bigint; data: ViemHex | undefined };
    }>;
  },
): Promise<ProposalResult> {
  const chains = chainAccess(ctx);
  if (!chains.has(input.chainId)) {
    throw new HttpError("invalid_request", "this chain is not configured");
  }
  const chainId = input.chainId;
  const wallet = await resolveWallet(ctx, agent, input.walletId);
  // The signer refuses every signature while the workspace is paused; say so now rather than
  // after someone approved.
  const [workspace] = await ctx.db
    .select({ paused: workspaces.paused })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId));
  if (workspace?.paused) {
    throw new HttpError("conflict", "this workspace is paused", "workspace_paused");
  }
  // The signer's copy of the policy is the one that will decide, so it is the one checked here.
  const state = await ctx.signer.getWallet(wallet.id).catch((error: unknown) => {
    throw new HttpError(
      "internal",
      "the signer could not be reached",
      error instanceof SignerError ? error.code : undefined,
    );
  });
  const policy: WalletPolicy | null = state.policy;
  if (policy === null || state.policyHash === null) {
    throw new HttpError(
      "policy_denied",
      "this wallet has no approved policy yet",
      "policy_missing",
    );
  }
  const read = async () => {
    const built = await input.build(wallet, chainId);
    const simulated = await chains.simulate({
      chainId,
      from: wallet.address,
      to: built.call.to,
      value: built.call.value,
      data: built.call.data,
    });
    return { ...built, simulated, fees: await chains.fees(chainId) };
  };
  const { operation, display, simulated, fees } = await read().catch((error: unknown) => {
    if (error instanceof ChainError) {
      throw new HttpError("internal", "the chain could not be read", error.code);
    }
    throw error;
  });
  const gas = ((simulated.gasEstimate ?? FALLBACK_GAS) * GAS_MARGIN_PERCENT) / 100n;
  const wanted = 2n * gas * (2n * fees.baseFeePerGas + fees.maxPriorityFeePerGas);
  const ceiling = BigInt(policy.fees.maxPerTxWei);
  // biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints
  const maxFeeWei = wanted < ceiling ? wanted : ceiling;
  const id = newId("int");
  const intent = Intent.parse({
    v: PROTOCOL_VERSION,
    id,
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    walletId: wallet.id,
    chainId,
    operation,
    maxFeeWei: maxFeeWei.toString(),
    memo: input.memo,
    createdAt: ctx.now(),
  });
  const spent = new Map(state.spent.map((entry) => [`${entry.chainId}|${entry.asset}`, entry]));
  const decision = evaluateIntent(policy, intent, (chain, asset) =>
    BigInt(spent.get(`${chain}|${asset}`)?.amount ?? "0"),
  );
  if (!decision.allowed) {
    throw new HttpError("policy_denied", "the wallet's policy would refuse this", decision.code);
  }
  const presentation: Presentation = {
    display,
    simulation: {
      ok: simulated.ok,
      blockNumber: simulated.blockNumber,
      gasEstimate: simulated.gasEstimate?.toString() ?? null,
      error: simulated.error,
    },
  };
  const hash = intentHash(intent);
  const summary = await engineOf(ctx).open({
    workspaceId: agent.workspaceId,
    kind: "approve-intent",
    subjectId: id,
    envelope: {
      intentHash: hash,
      walletId: wallet.id,
      agentId: agent.id,
      chainId,
      policyHash: state.policyHash,
    },
    threshold: policy.approvals.threshold,
    ttlSeconds: policy.approvals.ttlSeconds,
    detail: { intentId: id } satisfies IntentApprovalDetail,
    requestedBy: { type: "agent", id: agent.id },
    alongside: async (tx, approvalId) => {
      // Counted under a per-agent lock so concurrent proposals cannot all slip under the limit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pending:${agent.id}`}, 0))`,
      );
      const [waiting] = await tx
        .select({ n: count() })
        .from(intents)
        .where(and(eq(intents.agentId, agent.id), eq(intents.status, "pending_approval")));
      if ((waiting?.n ?? 0) >= MAX_PENDING_PER_AGENT) {
        throw new HttpError(
          "rate_limited",
          `you have ${MAX_PENDING_PER_AGENT} proposals waiting for approval; wait until some are decided`,
          "too_many_pending",
        );
      }
      await tx.insert(intents).values({
        id,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        walletId: wallet.id,
        chainId,
        status: "pending_approval",
        intentHash: hash,
        payload: await ctx.sealer.seal(agent.workspaceId, payloadLocation(id), intent),
        presentation: await ctx.sealer.seal(
          agent.workspaceId,
          presentationLocation(id),
          presentation,
        ),
        approvalId,
        createdAt: new Date(intent.createdAt * 1000),
        updatedAt: new Date(intent.createdAt * 1000),
      });
      await appendAudit(
        ctx,
        {
          workspaceId: agent.workspaceId,
          actor: { type: "agent", id: agent.id },
          action: "intent.proposed",
          subject: { type: "intent", id },
          detail: { memo: intent.memo, operation: intent.operation },
        },
        tx,
      );
    },
  });
  const [stored] = await ctx.db
    .select({ status: intents.status })
    .from(intents)
    .where(eq(intents.id, id));
  return {
    intentId: id,
    status: stored?.status ?? "pending_approval",
    approvalId: summary.id,
    approvalUrl: approvalLink(ctx.config.publicOrigin, agent.workspaceId, summary.id),
    expiresAt: summary.expiresAt,
  };
}

export function proposeTransfer(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    chainId: string;
    to: `0x${string}`;
    amount: string;
    asset?: "native" | `0x${string}` | undefined;
    memo: string;
    walletId?: WalletId | undefined;
  },
): Promise<ProposalResult> {
  const to = input.to.toLowerCase() as `0x${string}`;
  const asset = (input.asset ?? "native").toLowerCase() as "native" | `0x${string}`;
  return propose(ctx, agent, {
    chainId: input.chainId,
    walletId: input.walletId,
    memo: input.memo,
    build: async (_wallet, chainId) => {
      const chains = chainAccess(ctx);
      if (asset === "native") {
        const value = toBaseUnits(input.amount, 18);
        const symbol = chains.config(chainId).nativeSymbol;
        return {
          operation: { type: "evm.transfer", to, valueWei: value.toString() },
          display: {
            title: `Send ${formatUnits(value, 18)} ${symbol}`,
            assetSymbol: symbol,
            assetDecimals: 18,
            amount: value.toString(),
            amountFormatted: formatUnits(value, 18),
            to,
            token: null,
            rawCall: false,
          },
          call: { to, value, data: undefined },
        };
      }
      const token = await chains.token(chainId, asset).catch(() => {
        throw new HttpError("invalid_request", "this token could not be read on this chain");
      });
      const amount = toBaseUnits(input.amount, token.decimals);
      return {
        operation: { type: "evm.erc20.transfer", token: asset, to, amount: amount.toString() },
        display: {
          title: `Send ${formatUnits(amount, token.decimals)} ${token.symbol}`,
          assetSymbol: token.symbol,
          assetDecimals: token.decimals,
          amount: amount.toString(),
          amountFormatted: formatUnits(amount, token.decimals),
          to,
          token: asset,
          rawCall: false,
        },
        call: {
          to: asset,
          value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
        },
      };
    },
  });
}

export function proposeContractCall(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    chainId: string;
    to: `0x${string}`;
    data: Hex;
    valueWei?: string | undefined;
    memo: string;
    walletId?: WalletId | undefined;
  },
): Promise<ProposalResult> {
  const to = input.to.toLowerCase() as `0x${string}`;
  const data = input.data.toLowerCase() as `0x${string}`;
  const value = BigInt(input.valueWei ?? "0");
  return propose(ctx, agent, {
    chainId: input.chainId,
    walletId: input.walletId,
    memo: input.memo,
    build: async (_wallet, chainId) => {
      const symbol = chainAccess(ctx).config(chainId).nativeSymbol;
      return {
        operation: { type: "evm.call", to, valueWei: value.toString(), data },
        display: {
          title: `Call contract ${shortAddress(to)}`,
          assetSymbol: symbol,
          assetDecimals: 18,
          amount: value.toString(),
          amountFormatted: formatUnits(value, 18),
          to,
          token: null,
          rawCall: true,
        },
        call: { to, value, data },
      };
    },
  });
}

/** An agent withdraws its own proposal while it still waits for people. */
export async function cancelIntent(ctx: AppContext, row: IntentRow): Promise<IntentStatus> {
  if (row.status === "pending_approval" && row.approvalId !== null) {
    // Only a request that was still pending is cancelled; one already approved goes on to be
    // signed, so the intent moves in the same transaction as the request, or not at all.
    await engineOf(ctx).cancel(row.approvalId, (tx) =>
      moveIntent(ctx, row, ["pending_approval"], "cancelled", { executor: tx }),
    );
  }
  return (await intentRow(ctx, row.id)).status;
}

// --- the approve-intent kind ------------------------------------------------------------------

async function walletSummary(ctx: AppContext, walletId: WalletId): Promise<WalletSummary> {
  const [wallet] = await ctx.db.select().from(wallets).where(eq(wallets.id, walletId));
  if (!wallet) throw new HttpError("not_found", "no such wallet");
  const [owner] = await ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.walletId, walletId), eq(agents.workspaceId, wallet.workspaceId)));
  return {
    id: wallet.id,
    kind: wallet.kind,
    label: wallet.label,
    address: wallet.address,
    agentId: wallet.kind === "agent" ? (owner?.id ?? null) : null,
    policy: wallet.policy,
    policyHash: wallet.policyHash,
  };
}

interface FeeChoice {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Pick gas and fees for signing, inside the intent's approved fee ceiling. */
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

async function releaseNonce(ctx: AppContext, approvalId: ApprovalId): Promise<void> {
  await ctx.db.delete(nonceReservations).where(eq(nonceReservations.approvalId, approvalId));
}

/**
 * Sign the intent's transaction once. Runs in a workflow step, which may run again after a
 * crash: an existing transaction row ends it, and the signer returns the transaction it already
 * signed for this approval id, so a re-run cannot create a second transaction.
 */
async function executeIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  authorization: Authorization,
  detail: IntentApprovalDetail,
): Promise<void> {
  const row = await intentRow(ctx, detail.intentId);
  if (await transactionOf(ctx, approval.id)) return;
  await moveIntent(ctx, row, ["pending_approval"], "approved");
  const { intent, presentation } = await readIntent(ctx, row);
  const chains = chainAccess(ctx);
  const [wallet] = await ctx.db.select().from(wallets).where(eq(wallets.id, row.walletId));
  if (!wallet) throw new ApprovalFailure("wallet_missing", "the wallet no longer exists");

  const nonce = await reserveNonce(ctx, approval.id, wallet, intent.chainId);
  const quote = await chains.fees(intent.chainId);
  const estimate = BigInt(presentation.simulation?.gasEstimate ?? FALLBACK_GAS.toString());
  let chosen: FeeChoice;
  try {
    chosen = chooseFees(BigInt(intent.maxFeeWei), estimate, quote);
  } catch (error) {
    if (error instanceof ApprovalFailure) await releaseNonce(ctx, approval.id);
    throw error;
  }

  let signed: SignResponse;
  try {
    signed = await ctx.signer.sign({
      intent,
      authorization,
      transaction: {
        nonce,
        gas: chosen.gas.toString(),
        maxFeePerGas: chosen.maxFeePerGas.toString(),
        maxPriorityFeePerGas: chosen.maxPriorityFeePerGas.toString(),
      },
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
        intentId: row.id,
        walletId: wallet.id,
        chainId: intent.chainId,
        nonce: parsed.nonce ?? nonce,
        hash: signed.transactionHash,
        raw: await ctx.sealer.seal(
          row.workspaceId,
          rawLocation(approval.id),
          signed.signedTransaction,
        ),
        createdAt: new Date(ctx.now() * 1000),
        updatedAt: new Date(ctx.now() * 1000),
      })
      .onConflictDoNothing();
    await tx.delete(nonceReservations).where(eq(nonceReservations.approvalId, approval.id));
    await moveIntent(ctx, row, ["approved", "pending_approval"], "signed", { executor: tx });
  });
}

/** After signing: broadcast, then watch until the transaction is final or overdue. */
async function followUpIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  options: ExecutionOptions,
): Promise<{ done: boolean; waitSeconds: number }> {
  const transaction = await transactionOf(ctx, approval.id);
  if (!transaction) return { done: true, waitSeconds: 0 };
  const intent = await intentRow(ctx, transaction.intentId);
  const chains = chainAccess(ctx);
  const chainId = transaction.chainId as ChainId;
  const raw = (await ctx.sealer.open(
    intent.workspaceId,
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
        await moveIntent(ctx, intent, ["signed"], "failed", { failureCode: "broadcast_rejected" });
        return { done: true, waitSeconds: 0 };
      }
    }
    await touch("broadcast");
    await moveIntent(ctx, intent, ["signed"], "broadcast");
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
    await moveIntent(ctx, intent, ["broadcast", "stuck", "signed"], receipt.state);
    return { done: true, waitSeconds: 0 };
  }
  if (receipt.state === "missing") {
    if (transaction.status === "broadcast" && overdue) {
      await touch("stuck");
      await moveIntent(ctx, intent, ["broadcast"], "stuck");
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

export function approveIntentKind(): ApprovalKindHandler<"approve-intent"> {
  return {
    kind: "approve-intent",
    async title(ctx, _approval, detail) {
      const row = await intentRow(ctx, (detail as IntentApprovalDetail).intentId);
      const { presentation } = await readIntent(ctx, row);
      return `${presentation.display.title} to ${shortAddress(presentation.display.to)}`;
    },
    async describe(ctx, _approval, detail) {
      const row = await intentRow(ctx, (detail as IntentApprovalDetail).intentId);
      const [intent, wallet] = await Promise.all([
        intentDetail(ctx, row),
        walletSummary(ctx, row.walletId),
      ]);
      const spend = intentSpend(intent.intent);
      const limit = wallet.policy?.assets.find(
        (candidate) =>
          candidate.chainId === intent.intent.chainId && candidate.asset === spend.asset,
      );
      let limits: { maxPerTx: string; maxPerDay: string; spentToday: string } | null = null;
      if (limit && !(intent.display.rawCall && spend.amount === 0n)) {
        const state = await ctx.signer.getWallet(row.walletId).catch(() => null);
        const spentToday =
          state?.spent.find(
            (entry) => entry.chainId === intent.intent.chainId && entry.asset === spend.asset,
          )?.amount ?? "0";
        limits = { maxPerTx: limit.maxPerTx, maxPerDay: limit.maxPerDay, spentToday };
      }
      return { kind: "approve-intent", intent, wallet, limits };
    },
    async execute(ctx, approval, authorization, detail) {
      await executeIntent(ctx, approval, authorization, detail as IntentApprovalDetail);
    },
    async abandon(ctx, approval, status, detail) {
      // Ended without a signature we stored: a reserved nonce goes back to the wallet.
      await releaseNonce(ctx, approval.id);
      const row = await intentRow(ctx, (detail as IntentApprovalDetail).intentId);
      if (status === "failed") {
        const code = approval.failureCode ?? "failed";
        await moveIntent(
          ctx,
          row,
          ["pending_approval", "approved"],
          code === "policy_denied" || isPolicyCode(code) ? "denied" : "failed",
          { failureCode: code },
        );
        return;
      }
      await moveIntent(ctx, row, ["pending_approval", "approved"], status);
    },
  };
}

/** Codes from the policy engine, which the signer passes on as the detail of `policy_denied`. */
function isPolicyCode(code: string): boolean {
  return [
    "wallet_mismatch",
    "requester_not_allowed",
    "chain_not_allowed",
    "recipient_not_allowed",
    "contract_call_not_allowed",
    "asset_not_allowed",
    "over_per_tx_cap",
    "over_daily_cap",
    "over_fee_cap",
  ].includes(code);
}

export function registerIntentKind(ctx: AppContext, options: ExecutionOptions): void {
  const engine = engineOf(ctx);
  engine.register(approveIntentKind());
  engine.registerFollowUp("approve-intent", (context, approval) =>
    followUpIntent(context, approval, options),
  );
}

export type { IntentRow };
