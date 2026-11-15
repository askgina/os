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
  type ChainId,
  evaluateIntent,
  type Hex,
  Intent,
  type IntentId,
  intentHash,
  intentSpend,
  MANDATE_DENY_CODES,
  type MandateId,
  newId,
  type Operation,
  POLICY_DENY_CODES,
  PROTOCOL_VERSION,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  SignerError,
  type SignResponse,
  type TransactionParams,
} from "@askgina/os-protocol/signer";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, formatUnits, type Hex as ViemHex } from "viem";
import {
  ApprovalFailure,
  type ApprovalKindHandler,
  type ApprovalRow,
  type MandateUseHandler,
} from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Executor } from "../context.ts";
import { agents, intents, wallets, workspaces } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { approvalLink } from "../notify/content.ts";
import { engineOf } from "./approvals.ts";
import { ChainError, chainAccess } from "./chains.ts";
import { findCoveringMandate } from "./mandates.ts";
import {
  type ExecutionOptions,
  FALLBACK_GAS,
  followUpTransaction,
  GAS_MARGIN_PERCENT,
  releaseNonce,
  signOnce,
  transactionInfo,
  transactionOf,
} from "./transactions.ts";

type IntentRow = typeof intents.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type WalletRow = typeof wallets.$inferSelect;

interface Presentation {
  display: IntentDisplay;
  simulation: Simulation | null;
}

/** What `approve-intent` and `mandate-use` keep sealed in their approval's detail. */
interface IntentApprovalDetail {
  intentId: IntentId;
}

const PAGE_SIZE = 50;
/** Proposals one agent may have waiting for people at once; more is a loop, not a request. */
export const MAX_PENDING_PER_AGENT = 20;

const payloadLocation = (id: string) => `intents.payload:${id}`;
const presentationLocation = (id: string) => `intents.presentation:${id}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

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
    // A use of a mandate is no approval people see: the intent names its mandate instead.
    approvalId: row.mandateId === null ? row.approvalId : null,
    mandateId: row.mandateId,
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
    transaction: transaction ? transactionInfo(ctx, transaction) : null,
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
    mandateId?: MandateId | undefined;
    status?: IntentStatus;
    cursor?: string | undefined;
    limit?: number;
  },
): Promise<{ rows: IntentRow[]; nextCursor: string | null }> {
  const limit = filter.limit ?? PAGE_SIZE;
  const conditions = [eq(intents.workspaceId, filter.workspaceId)];
  if (filter.agentId !== undefined) conditions.push(eq(intents.agentId, filter.agentId));
  if (filter.mandateId !== undefined) conditions.push(eq(intents.mandateId, filter.mandateId));
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

/**
 * What a proposal became: a request people approve (`person`, with its link and expiry), or a
 * payment a mandate covers (`mandate`), already approved and on its way to the signer.
 */
export interface ProposalResult {
  intentId: IntentId;
  status: IntentStatus;
  authorizedBy: "mandate" | "person";
  mandateId: MandateId | null;
  approvalUrl: string | null;
  expiresAt: number | null;
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
    /** Use exactly this mandate of the agent, or refuse. */
    mandateId?: MandateId | undefined;
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
  // The intent's sealed columns, in whichever transaction records it below.
  const sealed = async () => ({
    payload: await ctx.sealer.seal(agent.workspaceId, payloadLocation(id), intent),
    presentation: await ctx.sealer.seal(agent.workspaceId, presentationLocation(id), presentation),
  });

  const mandateId = await findCoveringMandate(ctx, agent, wallet.id, intent, input.mandateId);
  if (mandateId !== null) {
    // Covered: no person is asked. The use runs through the same workflow as an approved
    // request, and the signer decides whether the mandate covers it when it signs.
    await engineOf(ctx).openUse({
      workspaceId: agent.workspaceId,
      mandateId,
      subjectId: id,
      detail: { intentId: id } satisfies IntentApprovalDetail,
      requestedBy: { type: "agent", id: agent.id },
      alongside: async (tx, approvalId) => {
        await tx.insert(intents).values({
          id,
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          walletId: wallet.id,
          chainId,
          status: "approved",
          intentHash: hash,
          ...(await sealed()),
          approvalId,
          mandateId,
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
            detail: { memo: intent.memo, operation: intent.operation, mandateId },
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
      status: stored?.status ?? "approved",
      authorizedBy: "mandate",
      mandateId,
      approvalUrl: null,
      expiresAt: null,
    };
  }

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
        ...(await sealed()),
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
    authorizedBy: "person",
    mandateId: null,
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
    mandateId?: MandateId | undefined;
  },
): Promise<ProposalResult> {
  const to = input.to.toLowerCase() as `0x${string}`;
  const asset = (input.asset ?? "native").toLowerCase() as "native" | `0x${string}`;
  return propose(ctx, agent, {
    chainId: input.chainId,
    walletId: input.walletId,
    mandateId: input.mandateId,
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

/**
 * Sign the intent's transaction once, with `sign`: the signer's `sign` with people's
 * authorization, or its `signUnderMandate` for a use. Runs in a workflow step, which may run
 * again after a crash: an existing transaction row ends it, and the signer returns the
 * transaction it already signed for this approval id, so a re-run cannot create a second
 * transaction.
 */
async function executeIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  detail: IntentApprovalDetail,
  sign: (intent: Intent, transaction: TransactionParams) => Promise<SignResponse>,
): Promise<void> {
  const row = await intentRow(ctx, detail.intentId);
  if (await transactionOf(ctx, approval.id)) return;
  await moveIntent(ctx, row, ["pending_approval"], "approved");
  const { intent, presentation } = await readIntent(ctx, row);
  const [wallet] = await ctx.db.select().from(wallets).where(eq(wallets.id, row.walletId));
  if (!wallet) throw new ApprovalFailure("wallet_missing", "the wallet no longer exists");
  await signOnce(ctx, {
    approval,
    wallet,
    chainId: intent.chainId,
    maxFeeWei: BigInt(intent.maxFeeWei),
    gasEstimate: BigInt(presentation.simulation?.gasEstimate ?? FALLBACK_GAS.toString()),
    intentId: row.id,
    sign: (transaction) => sign(intent, transaction),
    stored: (tx) =>
      moveIntent(ctx, row, ["approved", "pending_approval"], "signed", { executor: tx }),
  });
}

/** After signing: broadcast and watch the transaction, moving the intent along with it. */
async function followUpIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  options: ExecutionOptions,
): Promise<{ done: boolean; waitSeconds: number }> {
  const transaction = await transactionOf(ctx, approval.id);
  if (!transaction?.intentId) return { done: true, waitSeconds: 0 };
  const intent = await intentRow(ctx, transaction.intentId);
  return followUpTransaction(ctx, approval, transaction, options, async (status) => {
    switch (status) {
      case "rejected":
        // Never accepted and no longer offered: its nonce is free again for this wallet.
        return moveIntent(ctx, intent, ["signed"], "failed", { failureCode: "broadcast_rejected" });
      case "broadcast":
        return moveIntent(ctx, intent, ["signed"], "broadcast");
      case "stuck":
        return moveIntent(ctx, intent, ["broadcast"], "stuck");
      case "confirmed":
      case "reverted":
        return moveIntent(ctx, intent, ["broadcast", "stuck", "signed"], status);
      case "signed":
        return false;
    }
  });
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
    async confirmationSubject(ctx, _approval, detail) {
      const row = await intentRow(ctx, (detail as IntentApprovalDetail).intentId);
      const { intent } = await readIntent(ctx, row);
      return { kind: "approve-intent", intent };
    },
    async execute(ctx, approval, authorization, detail) {
      await executeIntent(ctx, approval, detail as IntentApprovalDetail, (intent, transaction) =>
        ctx.signer.sign({ intent, authorization, transaction }),
      );
    },
    abandon: abandonIntent,
  };
}

/**
 * `mandate-use`: one payment a mandate covers, signed with no person asked. The signer checks
 * the mandate and the wallet's policy against its own records and counts the use in the same
 * database transaction as the signature; a refusal (for example `mandate_over_window_cap` when
 * another use took the last of the window) ends the intent `denied` with that code.
 */
export function mandateUseKind(): MandateUseHandler {
  return {
    kind: "mandate-use",
    async execute(ctx, use, detail) {
      const { mandateId } = use;
      if (mandateId === null) throw new Error("a mandate use without its mandate");
      await executeIntent(ctx, use, detail as IntentApprovalDetail, (intent, transaction) =>
        ctx.signer.signUnderMandate(mandateId, { approvalId: use.id, intent, transaction }),
      );
    },
    abandon: abandonIntent,
  };
}

/** An intent's request or use ended without a signature: the intent ends with it. */
async function abandonIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  status: "rejected" | "expired" | "cancelled" | "failed",
  detail: unknown,
): Promise<void> {
  // Ended without a signature we stored: a reserved nonce goes back to the wallet.
  await releaseNonce(ctx, approval.id);
  const row = await intentRow(ctx, (detail as IntentApprovalDetail).intentId);
  if (status === "failed") {
    const code = approval.failureCode ?? "failed";
    // A policy's or a mandate's reason, which the signer passes on as the detail of
    // `policy_denied` and `mandate_denied`, means it was refused, not that something broke.
    const refused =
      code === "policy_denied" ||
      (POLICY_DENY_CODES as readonly string[]).includes(code) ||
      (MANDATE_DENY_CODES as readonly string[]).includes(code);
    await moveIntent(ctx, row, ["pending_approval", "approved"], refused ? "denied" : "failed", {
      failureCode: code,
    });
    return;
  }
  await moveIntent(ctx, row, ["pending_approval", "approved"], status);
}

/** `approve-intent` and `mandate-use`: both sign an intent and follow its transaction. */
export function registerIntentKind(ctx: AppContext, options: ExecutionOptions): void {
  const engine = engineOf(ctx);
  engine.register(approveIntentKind());
  engine.registerUse(mandateUseKind());
  const followUp = (context: AppContext, approval: ApprovalRow) =>
    followUpIntent(context, approval, options);
  engine.registerFollowUp("approve-intent", followUp);
  engine.registerFollowUp("mandate-use", followUp);
}

export type { IntentRow };
