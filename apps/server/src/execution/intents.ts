import {
  type ApprovalSubject,
  type IntentDetail,
  IntentDisplay,
  type IntentStatus,
  type IntentSummary,
  Simulation,
  type VenueOrderView,
  type WalletSummary,
} from "@askgina/os-api";
import {
  Address,
  type AgentId,
  type ApprovalId,
  AssetRef,
  type Authorization,
  type ChainId,
  Cloid,
  type Digest,
  EvmIntent,
  evaluateIntent,
  Hex,
  Intent,
  IntentId,
  intentHash,
  intentSpend,
  isVenueIntent,
  MANDATE_DENY_CODES,
  type MandateId,
  newId,
  type Operation,
  POLICY_DENY_CODES,
  PROTOCOL_VERSION,
  type VenueIntent,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  SignerError,
  type SignResponse,
  type TransactionParams,
  type WalletState,
} from "@askgina/os-protocol/signer";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, formatUnits, type Hex as ViemHex } from "viem";
import { z } from "zod";
import {
  ApprovalFailure,
  type ApprovalKindHandler,
  type ApprovalRow,
  type MandateUseHandler,
} from "../approvals/kinds.ts";
import { type AuditInput, appendAudit } from "../audit.ts";
import type { AppContext, Executor } from "../context.ts";
import { agents, intents, venueOrders, wallets, workspaces } from "../db/schema.ts";
import type { JsonValue } from "../db/sealed.ts";
import { StoredDataError, stored } from "../db/stored.ts";
import { walletLifecycle } from "../directory/views.ts";
import { HttpError } from "../http/errors.ts";
import { approvalLink } from "../notify/content.ts";
import { engineOf } from "./approvals.ts";
import { ChainError, chainAccess } from "./chains.ts";
import { findCoveringMandate } from "./mandates.ts";
import type { RepriceOutcome } from "./repricing.ts";
import {
  type ExecutionOptions,
  FALLBACK_GAS,
  type FollowUpHooks,
  followUpTransaction,
  GAS_MARGIN_PERCENT,
  releaseNonce,
  shownHash,
  signOnce,
  transactionInfo,
  transactionOf,
} from "./transactions.ts";

type IntentRow = typeof intents.$inferSelect;

type AgentRow = typeof agents.$inferSelect;

type WalletRow = typeof wallets.$inferSelect;

/** What people are shown about an intent, sealed beside it. A venue intent has no simulation. */
export interface Presentation {
  display: IntentDisplay;
  simulation: Simulation | null;
}

/** What `approve-intent` and `mandate-use` keep sealed in their approval's detail. */
const IntentApprovalDetail = z.object({ intentId: IntentId });

type IntentApprovalDetail = z.infer<typeof IntentApprovalDetail>;

function intentApprovalDetail(detail: JsonValue): IntentApprovalDetail {
  return stored(IntentApprovalDetail, detail, "intent approval detail");
}

/** What {@link recordProposal} seals as an intent's presentation, its display as stored. */
const SealedPresentation = z.object({
  display: z.record(z.string(), z.json()),
  simulation: Simulation.nullable(),
});

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
  const [intent, opened] = await Promise.all([
    ctx.sealer.open(row.workspaceId, payloadLocation(row.id), row.payload),
    ctx.sealer.open(row.workspaceId, presentationLocation(row.id), row.presentation),
  ]);

  const sealed = stored(SealedPresentation, opened, "intent presentation");

  // Displays stored before venue intents existed were all transfers and carry no `kind`.
  const display = stored(
    IntentDisplay,
    { kind: "transfer", ...sealed.display },
    "intent presentation display",
  );

  return {
    intent: stored(Intent, intent, "intent payload"),
    presentation: { display, simulation: sealed.simulation },
  };
}

/** An intent that can only be an EVM one here (a transaction's, a reprice's). */
export async function readEvmIntent(ctx: AppContext, row: IntentRow): Promise<EvmIntent> {
  const { intent } = await readIntent(ctx, row);

  if (isVenueIntent(intent)) throw new Error("expected an EVM intent, found a venue intent");

  return intent;
}

async function intentRow(ctx: AppContext, id: string, executor: Executor = ctx.db) {
  // A string that is no intent id names no intent, and is refused as one that does not exist.
  const intentId = IntentId.safeParse(id);

  if (!intentId.success) throw new HttpError("not_found", "no such intent");

  const [row] = await executor.select().from(intents).where(eq(intents.id, intentId.data));

  if (!row) throw new HttpError("not_found", "no such intent");

  return row;
}

/** The order a venue intent's approval signed, as the venue last reported it; null otherwise. */
async function venueOrderView(
  ctx: AppContext,
  approvalId: ApprovalId | null,
): Promise<VenueOrderView | null> {
  if (approvalId === null) return null;

  const [order] = await ctx.db
    .select()
    .from(venueOrders)
    .where(eq(venueOrders.approvalId, approvalId));

  if (!order || order.cloid === null || order.expiresAfter === null) return null;

  return {
    // Stored from the signer's answer, which its client parsed as a Cloid.
    cloid: stored(Cloid, order.cloid, "venue order cloid"),
    venueOrderId: order.venueOrderId,
    filledSize: order.filledSize,
    averagePrice: order.averagePrice,
    submitBy: Math.floor(order.expiresAfter / 1000),
    venueError: order.venueError,
    canCancel: order.status === "submitted" || order.status === "placed",
  };
}

export async function intentSummary(ctx: AppContext, row: IntentRow): Promise<IntentSummary> {
  const [{ intent, presentation }, [agent], transaction, order] = await Promise.all([
    readIntent(ctx, row),
    ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId)),
    transactionOf(ctx, row.approvalId),
    venueOrderView(ctx, row.approvalId),
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
    transactionHash: transaction ? await shownHash(ctx, transaction) : null,
    failureCode: row.failureCode,
    order,
  };
}

/**
 * The summaries of a list's rows. A row whose stored details cannot be read is left out,
 * counted and logged, so one damaged intent does not take the whole list with it and the
 * reader still learns that something is missing.
 */
export async function intentSummaries(
  ctx: AppContext,
  rows: IntentRow[],
): Promise<{ items: IntentSummary[]; unreadable: number }> {
  const summaries = await Promise.all(
    rows.map(async (row) => {
      try {
        return await intentSummary(ctx, row);
      } catch (error) {
        if (!(error instanceof StoredDataError)) throw error;
        ctx.log.error("an intent left out of a list: its stored data could not be read", {
          intentId: row.id,
          message: error.message,
        });

        return null;
      }
    }),
  );

  const items = summaries.filter((summary) => summary !== null);

  return { items, unreadable: summaries.length - items.length };
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
    transaction: transaction ? await transactionInfo(ctx, row.workspaceId, transaction) : null,
  };
}

export async function getIntentRow(ctx: AppContext, id: string): Promise<IntentRow> {
  return intentRow(ctx, id);
}

/** One line for an intent, for example "Send 0.01 ETH to 0x12ab…89ef" or "Buy 0.01 BTC at 65000". */
export async function intentTitle(ctx: AppContext, row: IntentRow): Promise<string> {
  const { display } = (await readIntent(ctx, row)).presentation;

  return display.kind === "order"
    ? display.title
    : `${display.title} to ${shortAddress(display.to)}`;
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

    // SAFETY: the cursor's id is only compared with `<` against intents.id to order the page;
    // any string orders, and one that names no intent still starts the page there.
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
export async function moveIntent(
  ctx: AppContext,
  row: Pick<IntentRow, "id" | "workspaceId">,
  from: readonly IntentRow["status"][],
  to: IntentRow["status"],
  extra: { failureCode?: string | undefined; executor?: Executor } = {},
): Promise<boolean> {
  const write = async (executor: Executor) => {
    const changes: Partial<IntentRow> = { status: to, updatedAt: new Date(ctx.now() * 1000) };

    const event: AuditInput = {
      workspaceId: row.workspaceId,
      actor: { type: "system", id: null },
      action: `intent.${to}`,
      subject: { type: "intent", id: row.id },
    };

    if (extra.failureCode !== undefined) {
      changes.failureCode = extra.failureCode;
      event.detail = { code: extra.failureCode };
    }

    const [updated] = await executor
      .update(intents)
      .set(changes)
      .where(and(eq(intents.id, row.id), inArray(intents.status, [...from])))
      .returning({ id: intents.id });

    if (!updated) return false;
    await appendAudit(ctx, event, executor);

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

/** What every proposal is checked against: the wallet, and its policy as the signer holds it. */
export interface ProposalBasis {
  wallet: WalletRow;
  state: WalletState;
  policy: WalletPolicy;
  policyHash: Digest;
}

/**
 * The wallet an agent proposes from, refused while the workspace is paused (the signer would
 * refuse every signature; say so now rather than after someone approved) or while the wallet
 * has no approved policy. The signer's copy of the policy is the one that will decide, so it is
 * the one returned.
 */
export async function proposalBasis(
  ctx: AppContext,
  agent: AgentRow,
  walletId: WalletId | undefined,
): Promise<ProposalBasis> {
  const wallet = await resolveWallet(ctx, agent, walletId);

  const [workspace] = await ctx.db
    .select({ paused: workspaces.paused })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId));

  if (workspace?.paused) {
    throw new HttpError("conflict", "this workspace is paused", "workspace_paused");
  }

  const state = await ctx.signer.getWallet(wallet.id).catch((cause: unknown) => {
    throw new HttpError(
      "internal",
      "the signer could not be reached",
      cause instanceof SignerError ? cause.code : undefined,
    );
  });

  if (state.policy === null || state.policyHash === null) {
    throw new HttpError(
      "policy_denied",
      "this wallet has no approved policy yet",
      "policy_missing",
    );
  }

  return { wallet, state, policy: state.policy, policyHash: state.policyHash };
}

/** The policy's verdict on `intent`, with what the signer counted in the last 24 hours. */
export function checkPolicy(basis: ProposalBasis, intent: Intent): void {
  const spent = new Map<string, string>();

  for (const entry of [...basis.state.spent, ...basis.state.venueSpent]) {
    spent.set(`${entry.chainId}|${entry.asset}`, entry.amount);
  }

  const decision = evaluateIntent(basis.policy, intent, (chain, asset) =>
    BigInt(spent.get(`${chain}|${asset}`) ?? "0"),
  );

  if (!decision.allowed) {
    throw new HttpError("policy_denied", "the wallet's policy would refuse this", decision.code);
  }
}

/**
 * Record a checked intent and what people are shown about it: as a use of `mandateId`, already
 * approved and on its way to the signer, or as an `approve-intent` request people decide on,
 * with its audit entry and its notifications in the same transaction.
 */
export async function recordProposal(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    basis: ProposalBasis;
    intent: Intent;
    presentation: Presentation;
    mandateId: MandateId | null;
  },
): Promise<ProposalResult> {
  const { basis, intent, presentation, mandateId } = input;
  const { wallet } = basis;
  const id = intent.id;
  const hash = intentHash(intent);

  // The intent's sealed columns, in whichever transaction records it below.
  const sealed = async () => ({
    payload: await ctx.sealer.seal(agent.workspaceId, payloadLocation(id), intent),
    presentation: await ctx.sealer.seal(agent.workspaceId, presentationLocation(id), presentation),
  });

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
          chainId: intent.chainId,
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
      chainId: intent.chainId,
      policyHash: basis.policyHash,
    },
    threshold: basis.policy.approvals.threshold,
    ttlSeconds: basis.policy.approvals.ttlSeconds,
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
        chainId: intent.chainId,
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
  const basis = await proposalBasis(ctx, agent, input.walletId);
  const { wallet, policy } = basis;

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

  const { operation, display, simulated, fees } = await read().catch((cause: unknown) => {
    if (cause instanceof ChainError) {
      throw new HttpError("internal", "the chain could not be read", cause.code);
    }

    throw cause;
  });

  const gas = ((simulated.gasEstimate ?? FALLBACK_GAS) * GAS_MARGIN_PERCENT) / 100n;
  const wanted = 2n * gas * (2n * fees.baseFeePerGas + fees.maxPriorityFeePerGas);
  const ceiling = BigInt(policy.fees.maxPerTxWei);
  // biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints
  const maxFeeWei = wanted < ceiling ? wanted : ceiling;
  const id = newId("int");

  const intent = EvmIntent.parse({
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

  checkPolicy(basis, intent);

  const presentation: Presentation = {
    display,
    simulation: {
      ok: simulated.ok,
      blockNumber: simulated.blockNumber,
      gasEstimate: simulated.gasEstimate?.toString() ?? null,
      error: simulated.error,
    },
  };

  const mandateId = await findCoveringMandate(ctx, agent, wallet.id, intent, input.mandateId);

  return recordProposal(ctx, agent, { basis, intent, presentation, mandateId });
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
  const to = Address.parse(input.to.toLowerCase());
  const asset = AssetRef.parse((input.asset ?? "native").toLowerCase());

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
            kind: "transfer",
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
          kind: "transfer",
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
  const to = Address.parse(input.to.toLowerCase());
  const data = Hex.parse(input.data.toLowerCase());
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
          kind: "transfer",
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
    lifecycle: walletLifecycle(wallet),
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
  sign: (intent: EvmIntent, transaction: TransactionParams) => Promise<SignResponse>,
): Promise<void> {
  const row = await intentRow(ctx, detail.intentId);

  if (await transactionOf(ctx, approval.id)) return;
  const { intent, presentation } = await readIntent(ctx, row);

  // A venue intent is signed through its own route, and never under a mandate.
  if (isVenueIntent(intent)) {
    throw new ApprovalFailure("invalid_request", "a venue intent is never a transaction");
  }

  await moveIntent(ctx, row, ["pending_approval"], "approved");
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

/** Asks for a reprice of an approval's transaction when one is due (`repricing.ts`). */
export type Reprice = (ctx: AppContext, approvalId: ApprovalId) => Promise<RepriceOutcome>;

/** The approval page's section for a venue intent. */
export type VenueSubject = Extract<ApprovalSubject, { kind: "approve-intent" }>["venue"];

/**
 * What `orders.ts` does for a venue intent, passed in so this module does not import it back.
 */
export interface VenueHooks {
  /** Have the signer sign the one venue request and store it. A workflow step: safe twice. */
  execute(
    ctx: AppContext,
    approval: ApprovalRow,
    authorization: Authorization,
    row: IntentRow,
    intent: VenueIntent,
  ): Promise<void>;
  /** Post and follow the stored request; null when the approval signed no venue request. */
  followUp(
    ctx: AppContext,
    approval: ApprovalRow,
  ): Promise<{ done: boolean; waitSeconds: number } | null>;
  /**
   * The venue's rules and where the intent stands against them, for the approval page; null
   * when the wallet's policy has no rules for the intent's venue (the signer will refuse it).
   */
  describe(ctx: AppContext, intent: VenueIntent, wallet: WalletSummary): Promise<VenueSubject>;
}

/**
 * After signing: broadcast and watch the transaction, moving the intent along with it in the
 * same database transaction. While automatic repricing is on, a payment that is not mined is
 * repriced on schedule. The outcomes after the first signature:
 * - the payment (any of its attempts) mined: `confirmed` or `reverted`, with `failureCode`
 *   `cancel_too_late` when a cancel had been signed for it;
 * - a cancel mined in its place: `voided`, `failureCode` `transaction_cancelled`;
 * - another transaction used its nonce: `failed`, `failureCode` `nonce_used_elsewhere`;
 * - never accepted by the chain: `failed`, `failureCode` `broadcast_rejected`.
 */
async function followUpIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  options: ExecutionOptions,
  reprice: Reprice,
): Promise<{ done: boolean; waitSeconds: number }> {
  const transaction = await transactionOf(ctx, approval.id);

  if (!transaction?.intentId) return { done: true, waitSeconds: 0 };
  const intent = await intentRow(ctx, transaction.intentId);
  const sent: IntentRow["status"][] = ["broadcast", "stuck", "signed"];

  const hooks: FollowUpHooks = {
    async moved(status, tx, { cancelAttempted }) {
      switch (status) {
        case "rejected":
          // Never accepted and no longer offered: its nonce is free again for this wallet.
          await moveIntent(ctx, intent, ["signed"], "failed", {
            failureCode: "broadcast_rejected",
            executor: tx,
          });

          return;
        case "broadcast":
          await moveIntent(ctx, intent, ["signed"], "broadcast", { executor: tx });

          return;
        case "stuck":
          await moveIntent(ctx, intent, ["broadcast"], "stuck", { executor: tx });

          return;
        case "confirmed":
        case "reverted":
          await moveIntent(ctx, intent, sent, status, {
            executor: tx,
            failureCode: cancelAttempted ? "cancel_too_late" : undefined,
          });

          return;
        case "cancelled":
          await moveIntent(ctx, intent, sent, "voided", {
            failureCode: "transaction_cancelled",
            executor: tx,
          });

          return;
        case "superseded":
          await moveIntent(ctx, intent, sent, "failed", {
            failureCode: "nonce_used_elsewhere",
            executor: tx,
          });

          return;
        case "signed":
          return;
      }
    },
  };

  if (ctx.config.reprice.auto) {
    hooks.reprice = async () => {
      await reprice(ctx, approval.id);
    };
  }

  return followUpTransaction(ctx, approval, transaction, options, hooks);
}

export function approveIntentKind(venue: VenueHooks): ApprovalKindHandler<"approve-intent"> {
  return {
    kind: "approve-intent",
    async title(ctx, _approval, detail) {
      return intentTitle(ctx, await intentRow(ctx, intentApprovalDetail(detail).intentId));
    },
    async describe(ctx, _approval, detail) {
      const row = await intentRow(ctx, intentApprovalDetail(detail).intentId);

      const [intent, wallet] = await Promise.all([
        intentDetail(ctx, row),
        walletSummary(ctx, row.walletId),
      ]);

      if (isVenueIntent(intent.intent)) {
        const subject = await venue.describe(ctx, intent.intent, wallet);

        return { kind: "approve-intent", intent, wallet, limits: null, venue: subject };
      }

      const spend = intentSpend(intent.intent);

      const limit = wallet.policy?.assets.find(
        (candidate) =>
          candidate.chainId === intent.intent.chainId && candidate.asset === spend.asset,
      );

      let limits: { maxPerTx: string; maxPerDay: string; spentToday: string } | null = null;
      const rawCall = intent.display.kind === "transfer" && intent.display.rawCall;

      if (limit && !(rawCall && spend.amount === 0n)) {
        const state = await ctx.signer.getWallet(row.walletId).catch(() => null);

        const spentToday =
          state?.spent.find(
            (entry) => entry.chainId === intent.intent.chainId && entry.asset === spend.asset,
          )?.amount ?? "0";

        limits = { maxPerTx: limit.maxPerTx, maxPerDay: limit.maxPerDay, spentToday };
      }

      return { kind: "approve-intent", intent, wallet, limits, venue: null };
    },
    async confirmationSubject(ctx, _approval, detail) {
      const row = await intentRow(ctx, intentApprovalDetail(detail).intentId);
      const { intent } = await readIntent(ctx, row);

      return { kind: "approve-intent", intent };
    },
    async execute(ctx, approval, authorization, detail) {
      const parsed = intentApprovalDetail(detail);
      const row = await intentRow(ctx, parsed.intentId);
      const { intent } = await readIntent(ctx, row);

      if (isVenueIntent(intent)) {
        await venue.execute(ctx, approval, authorization, row, intent);

        return;
      }

      await executeIntent(ctx, approval, parsed, (evm, transaction) =>
        ctx.signer.sign({ intent: evm, authorization, transaction }),
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
      await executeIntent(ctx, use, intentApprovalDetail(detail), (intent, transaction) =>
        ctx.signer.signUnderMandate(mandateId, { approvalId: use.id, intent, transaction }),
      );
    },
    abandon: abandonIntent,
  };
}

/**
 * The intent an ended request or use was for. The request's detail names it; when that detail
 * cannot be read, the intent that points back at the request is the same one.
 */
async function abandonedIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  detail: JsonValue,
): Promise<IntentRow> {
  try {
    return await intentRow(ctx, intentApprovalDetail(detail).intentId);
  } catch (error) {
    if (!(error instanceof StoredDataError)) throw error;

    const [row] = await ctx.db.select().from(intents).where(eq(intents.approvalId, approval.id));

    if (!row) throw error;

    return row;
  }
}

/** An intent's request or use ended without a signature: the intent ends with it. */
async function abandonIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  status: "rejected" | "expired" | "cancelled" | "failed",
  detail: JsonValue,
): Promise<void> {
  // Ended without a signature we stored: a reserved nonce goes back to the wallet.
  await releaseNonce(ctx, approval.id);
  const row = await abandonedIntent(ctx, approval, detail);

  if (status === "failed") {
    const code = approval.failureCode ?? "failed";

    // A policy's or a mandate's reason, which the signer passes on as the detail of
    // `policy_denied` and `mandate_denied`, means it was refused, not that something broke.
    const refused =
      code === "policy_denied" ||
      POLICY_DENY_CODES.some((denied) => denied === code) ||
      MANDATE_DENY_CODES.some((denied) => denied === code);

    await moveIntent(ctx, row, ["pending_approval", "approved"], refused ? "denied" : "failed", {
      failureCode: code,
    });

    return;
  }

  await moveIntent(ctx, row, ["pending_approval", "approved"], status);
}

/**
 * `approve-intent` and `mandate-use`: both sign an intent and follow its transaction, which
 * `reprice` (`repricing.ts`, passed in so this module does not import it back) prices up. A venue
 * intent's request is signed, posted and followed by `venue` (`orders.ts`, passed in likewise).
 */
export function registerIntentKind(
  ctx: AppContext,
  options: ExecutionOptions,
  reprice: Reprice,
  venue: VenueHooks,
): void {
  const engine = engineOf(ctx);
  engine.register(approveIntentKind(venue));
  engine.registerUse(mandateUseKind());

  const followUp = (context: AppContext, approval: ApprovalRow) =>
    followUpIntent(context, approval, options, reprice);

  engine.registerFollowUp(
    "approve-intent",
    async (context, approval) =>
      (await venue.followUp(context, approval)) ?? followUp(context, approval),
  );
  engine.registerFollowUp("mandate-use", followUp);
}

export type { IntentRow };
