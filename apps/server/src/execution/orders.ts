import {
  type IntentStatus,
  type OrderDisplay,
  type TransferDisplay,
  VenueAccount,
} from "@askgina/os-api";
import {
  type Cloid,
  type HyperliquidOrderOperation,
  type HyperliquidTimeInForce,
  isVenueNetwork,
  type MandateId,
  newId,
  orderNotionalUsd6,
  PositiveDecimal,
  PROTOCOL_VERSION,
  VENUE_NETWORK_NAMES,
  VenueIntent,
  type VenueNetwork,
  type WalletId,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { SignerError, type SignVenueResponse, type WalletState } from "@askgina/os-protocol/signer";
import { and, eq, inArray, lt } from "drizzle-orm";
import { formatUnits } from "viem";
import { ApprovalFailure, type ApprovalRow } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import type { agents } from "../db/schema.ts";
import { type VenueOrderStatus, venueOrders, wallets } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { takeToken } from "../rate-limit.ts";
import {
  cancelIntent,
  checkPolicy,
  getIntentRow,
  type IntentRow,
  moveIntent,
  type ProposalResult,
  proposalBasis,
  readIntent,
  recordProposal,
  toBaseUnits,
  type VenueHooks,
} from "./intents.ts";
import { RETRYABLE_SIGNER_CODES } from "./transactions.ts";
import {
  createHyperliquidClient,
  type ExchangeAnswer,
  type HyperliquidClient,
  type OrderStatusAnswer,
  VenueError,
} from "./venues/hyperliquid.ts";

type AgentRow = typeof agents.$inferSelect;

type VenueOrderRow = typeof venueOrders.$inferSelect;

type Next = { done: boolean; waitSeconds: number };

/** How long the follow-up of a posted order watches it; the reconcile sweeper takes over after. */
export const ORDER_WATCH_SECONDS = 3_600;

/** How often the reconcile sweeper looks at orders the follow-up stopped watching. */
export const RECONCILE_INTERVAL_SECONDS = 300;

/** How long to wait before asking an unreachable venue again. */
const RETRY_SECONDS = 5;

const MAX_WATCH_WAIT_SECONDS = 60;

/** At most this many orders per reconcile round. */
const RECONCILE_BATCH = 100;

/** Hyperliquid perpetual prices: at most 5 significant figures and 6 − szDecimals decimals. */
const PRICE_SIGNIFICANT_FIGURES = 5;

const PERP_PRICE_DECIMALS = 6;

/** USDC at Hyperliquid has 6 decimals. */
const USDC_DECIMALS = 6;

/** Venue sizes and prices are compared exactly at this scale. */
const SCALE = 8;

/** A request the venue may still act on: not posted yet, or posted and not final. */
const OPEN: readonly VenueOrderStatus[] = ["signed", "submitted", "placed"];

const CANCELLABLE: readonly VenueOrderStatus[] = ["submitted", "placed"];

/** The intent's status for each of its venue request's. */
const INTENT_STATUS: Record<VenueOrderStatus, IntentStatus> = {
  signed: "signed",
  submitted: "submitted",
  placed: "placed",
  filled: "filled",
  partially_filled: "partially_filled",
  cancelled: "cancelled",
  failed: "failed",
  expired: "expired",
  accepted: "confirmed",
};

const bodyLocation = (approvalId: string) => `venue_orders.request:${approvalId}`;

// --- the venue client -------------------------------------------------------------------------

const clients = new WeakMap<AppContext["config"], Map<VenueNetwork, HyperliquidClient>>();

/** The client for a configured venue network; refused when `VENUES_FILE` does not name it. */
export function venueClient(ctx: AppContext, network: string): HyperliquidClient {
  const entry = ctx.config.venues.find((venue) => venue.network === network);

  if (!entry) {
    throw new HttpError(
      "invalid_request",
      "this venue is not configured on this server",
      "venue_not_configured",
    );
  }

  let byNetwork = clients.get(ctx.config);

  if (!byNetwork) {
    byNetwork = new Map();
    clients.set(ctx.config, byNetwork);
  }

  let client = byNetwork.get(entry.network);

  if (!client) {
    client = createHyperliquidClient({ apiUrl: entry.apiUrl });
    byNetwork.set(entry.network, client);
  }

  return client;
}

// --- decimals ---------------------------------------------------------------------------------

/** A plain decimal ("0.010", "65000.") in canonical form ("0.01", "65000"), or null. */
function canonicalDecimal(text: string): string | null {
  const match = /^(\d{1,20})(?:\.(\d{0,20}))?$/.exec(text.trim());

  if (!match) return null;
  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const value = fraction.length > 0 ? `${whole}.${fraction}` : whole;

  return PositiveDecimal.safeParse(value).success ? value : null;
}

/** A venue's decimal text times 10^8, exactly; null when it is not a plain decimal that fits. */
function scaled(text: string): bigint | null {
  const match = /^(\d{1,20})(?:\.(\d{1,8}))?$/.exec(text);

  if (!match) return null;

  return (
    BigInt(match[1] ?? "0") * 10n ** BigInt(SCALE) + BigInt((match[2] ?? "").padEnd(SCALE, "0"))
  );
}

const unscaled = (value: bigint) => formatUnits(value, SCALE);

/** Whether a price and a size fit the market's precision at the venue. */
function fitsTick(price: string, size: string, szDecimals: number): boolean {
  const fractionOf = (value: string) => value.split(".")[1]?.length ?? 0;

  if (fractionOf(size) > szDecimals) return false;

  // An integer price is always allowed, whatever its significant figures.
  if (!price.includes(".")) return true;

  if (fractionOf(price) > PERP_PRICE_DECIMALS - szDecimals) return false;
  const significant = price.replace(".", "").replace(/^0+/, "");

  return significant.length <= PRICE_SIGNIFICANT_FIGURES;
}

// --- proposing --------------------------------------------------------------------------------

function venueNetwork(ctx: AppContext, network: string): VenueNetwork {
  if (!isVenueNetwork(network)) {
    throw new HttpError("invalid_request", "this network is not a venue", "venue_not_configured");
  }

  venueClient(ctx, network);

  return network;
}

function decimalInput(name: string, value: string): string {
  const decimal = canonicalDecimal(value);

  if (decimal === null) {
    throw new HttpError(
      "invalid_request",
      `${name} must be a decimal number greater than zero with at most 8 decimals`,
    );
  }

  return decimal;
}

/**
 * An agent proposes a limit order on a Hyperliquid perpetual. The coin must be one of the
 * wallet policy's markets; the venue's metadata must still name it at the policy's index and not
 * list it as delisted (`market_metadata_mismatch`); the price and size must fit the market's
 * precision (`invalid_tick`); and the policy must allow it. A person always approves an order:
 * no mandate covers one (D7). Nothing is recorded when any check refuses.
 */
export async function proposeOrder(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    network: string;
    coin: string;
    side: "buy" | "sell";
    size: string;
    limitPrice: string;
    timeInForce?: HyperliquidTimeInForce | undefined;
    reduceOnly?: boolean | undefined;
    memo: string;
    walletId?: WalletId | undefined;
  },
): Promise<ProposalResult> {
  const network = venueNetwork(ctx, input.network);
  const size = decimalInput("size", input.size);
  const limitPrice = decimalInput("limitPrice", input.limitPrice);
  const timeInForce = input.timeInForce ?? "Ioc";
  const reduceOnly = input.reduceOnly ?? false;
  const basis = await proposalBasis(ctx, agent, input.walletId);
  const rules = basis.policy.venues?.hyperliquid;

  if (rules === undefined || rules.network !== network) {
    throw new HttpError(
      "policy_denied",
      "the wallet's policy allows no orders at this venue",
      "venue_not_allowed",
    );
  }

  const market = rules.markets.find((candidate) => candidate.coin === input.coin);

  if (market === undefined) {
    throw new HttpError(
      "policy_denied",
      "the wallet's policy does not list this market",
      "market_not_allowed",
    );
  }

  const universe = await venueClient(ctx, network)
    .meta()
    .catch((error: unknown) => {
      if (error instanceof VenueError) {
        throw new HttpError("internal", "the venue could not be read", "venue_unreachable");
      }

      throw error;
    });

  const perp = universe[market.asset];

  // The index is what is signed; the policy's name for it must still be the venue's.
  if (perp === undefined || perp.name !== market.coin || perp.isDelisted) {
    throw new HttpError(
      "conflict",
      "the venue no longer lists this market at the policy's index; the policy must be updated",
      "market_metadata_mismatch",
    );
  }

  if (!fitsTick(limitPrice, size, perp.szDecimals)) {
    throw new HttpError(
      "invalid_request",
      `the size may have at most ${perp.szDecimals} decimals, and the price at most ${PRICE_SIGNIFICANT_FIGURES} significant figures and ${PERP_PRICE_DECIMALS - perp.szDecimals} decimals unless it is a whole number`,
      "invalid_tick",
    );
  }

  const intent = VenueIntent.parse({
    v: PROTOCOL_VERSION,
    id: newId("int"),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    walletId: basis.wallet.id,
    chainId: network,
    operation: {
      type: "hyperliquid.order",
      asset: market.asset,
      isBuy: input.side === "buy",
      size,
      limitPx: limitPrice,
      tif: timeInForce,
      reduceOnly,
    },
    memo: input.memo,
    createdAt: ctx.now(),
  });

  checkPolicy(basis, intent);

  const display: OrderDisplay = {
    kind: "order",
    title: `${input.side === "buy" ? "Buy" : "Sell"} ${size} ${market.coin} at ${limitPrice}`,
    network,
    coin: market.coin,
    asset: market.asset,
    side: input.side,
    size,
    limitPrice,
    notionalUsd: formatUnits(orderNotionalUsd6(size, limitPrice), 6),
    timeInForce,
    reduceOnly,
    cancellableByAgent: true,
  };

  return recordProposal(ctx, agent, {
    basis,
    intent,
    presentation: { display, simulation: null },
    mandateId: null,
  });
}

/**
 * An agent proposes withdrawing USDC from the wallet's venue account (`propose_transfer` with a
 * venue network). The signer withdraws only to the wallet's own address, so `to` must be it;
 * never covered by a mandate.
 */
export async function proposeVenueWithdrawal(
  ctx: AppContext,
  agent: AgentRow,
  input: {
    chainId: string;
    to: `0x${string}`;
    amount: string;
    asset?: string | undefined;
    memo: string;
    walletId?: WalletId | undefined;
    mandateId?: MandateId | undefined;
  },
): Promise<ProposalResult> {
  const network = venueNetwork(ctx, input.chainId);

  if (input.mandateId !== undefined) {
    throw new HttpError(
      "policy_denied",
      "a mandate never covers a venue withdrawal",
      "mandate_operation_not_allowed",
    );
  }

  if (input.asset !== "usdc") {
    throw new HttpError("invalid_request", 'a venue withdrawal moves USDC: set asset to "usdc"');
  }

  const amount = decimalInput("amount", input.amount);
  const base = toBaseUnits(amount, USDC_DECIMALS);
  const basis = await proposalBasis(ctx, agent, input.walletId);
  const { wallet } = basis;

  if (input.to.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new HttpError(
      "invalid_request",
      "a withdrawal from a venue goes only to the wallet's own address",
      "withdrawal_not_own_address",
    );
  }

  const intent = VenueIntent.parse({
    v: PROTOCOL_VERSION,
    id: newId("int"),
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    walletId: wallet.id,
    chainId: network,
    operation: { type: "hyperliquid.withdraw", amount },
    memo: input.memo,
    createdAt: ctx.now(),
  });

  checkPolicy(basis, intent);

  const display: TransferDisplay = {
    kind: "transfer",
    title: `Withdraw ${amount} USDC from ${VENUE_NETWORK_NAMES[network]}`,
    assetSymbol: "USDC",
    assetDecimals: USDC_DECIMALS,
    amount: base.toString(),
    amountFormatted: amount,
    to: wallet.address,
    token: null,
    rawCall: false,
  };

  return recordProposal(ctx, agent, {
    basis,
    intent,
    presentation: { display, simulation: null },
    mandateId: null,
  });
}

// --- signing and posting ----------------------------------------------------------------------

async function orderRow(ctx: AppContext, approvalId: string): Promise<VenueOrderRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(venueOrders)
    .where(eq(venueOrders.approvalId, approvalId as VenueOrderRow["approvalId"]));

  return row;
}

/**
 * Have the signer build and sign the approved intent's one venue request, and store it sealed
 * with the intent moved to `signed`, in one transaction. A workflow step: after a crash between
 * the two the signer returns the same request, and the stored row ends a re-run.
 */
async function executeVenueIntent(
  ctx: AppContext,
  approval: ApprovalRow,
  authorization: Parameters<VenueHooks["execute"]>[2],
  row: IntentRow,
  intent: VenueIntent,
): Promise<void> {
  if (await orderRow(ctx, approval.id)) return;
  await moveIntent(ctx, row, ["pending_approval"], "approved");
  let signed: SignVenueResponse;

  try {
    signed = await ctx.signer.signVenue({ intent, authorization });
  } catch (error) {
    if (error instanceof SignerError && !RETRYABLE_SIGNER_CODES.includes(error.code)) {
      throw new ApprovalFailure(
        error.code === "policy_denied" && error.detail ? error.detail : error.code,
        "the signer refused to sign",
      );
    }

    throw error;
  }

  const body = JSON.stringify(signed.request);
  const sealed = await ctx.sealer.seal(row.workspaceId, bodyLocation(approval.id), body);
  await ctx.db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(venueOrders)
      .values({
        approvalId: approval.id,
        intentId: row.id,
        walletId: row.walletId,
        network: signed.network,
        cloid: signed.cloid,
        actionNonce: signed.request.nonce,
        expiresAfter: signed.request.expiresAfter,
        request: sealed,
      })
      .onConflictDoNothing()
      .returning({ approvalId: venueOrders.approvalId });

    if (stored) {
      await moveIntent(ctx, row, ["approved", "pending_approval"], "signed", { executor: tx });
    }
  });
}

/** What changes with a venue request's status: the venue's facts about it. */
interface Facts {
  venueOrderId?: number;
  filledSize?: string | null;
  averagePrice?: string | null;
  venueError?: string | null;
  submittedAt?: Date;
}

/**
 * Move a venue request from one of `from` to `to` with the venue's facts, and its intent with it,
 * in one transaction. False when the request was elsewhere (another round moved it first).
 */
async function record(
  ctx: AppContext,
  order: VenueOrderRow,
  intent: IntentRow,
  to: VenueOrderStatus,
  facts: Facts,
  options: { from?: readonly VenueOrderStatus[]; failureCode?: string } = {},
): Promise<boolean> {
  const now = new Date(ctx.now() * 1000);

  return ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(venueOrders)
      .set({ status: to, ...facts, checkedAt: now, updatedAt: now })
      .where(
        and(
          eq(venueOrders.approvalId, order.approvalId),
          inArray(venueOrders.status, [...(options.from ?? OPEN)]),
        ),
      )
      .returning({ approvalId: venueOrders.approvalId });

    if (!updated) return false;

    if (to !== order.status) {
      await moveIntent(ctx, intent, ["signed", "submitted", "placed"], INTENT_STATUS[to], {
        executor: tx,
        ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
      });
    }

    return true;
  });
}

/** Everything one round of following a venue request needs. */
interface Followed {
  order: VenueOrderRow;
  intent: IntentRow;
  operation: VenueIntent["operation"];
  account: `0x${string}`;
  body: string;
  client: HyperliquidClient;
}

async function followed(ctx: AppContext, order: VenueOrderRow): Promise<Followed> {
  const intent = await getIntentRow(ctx, order.intentId);

  const [{ intent: parsed }, [wallet], body] = await Promise.all([
    readIntent(ctx, intent),
    ctx.db.select({ address: wallets.address }).from(wallets).where(eq(wallets.id, order.walletId)),
    ctx.sealer.open(intent.workspaceId, bodyLocation(order.approvalId), order.request),
  ]);

  if (!("operation" in parsed) || !isVenueNetwork(parsed.chainId) || !wallet) {
    throw new Error("a venue request without its venue intent or wallet");
  }

  return {
    order,
    intent,
    operation: parsed.operation as VenueIntent["operation"],
    account: wallet.address,
    body: String(body),
    client: venueClient(ctx, order.network),
  };
}

const expired = (ctx: AppContext, order: VenueOrderRow) =>
  order.expiresAfter !== null && ctx.now() * 1000 >= order.expiresAfter;

/** The venue's report of an order, as this request's next status and facts; null: no change. */
function fromStatus(
  operation: HyperliquidOrderOperation,
  status: Extract<OrderStatusAnswer, { found: true }>,
): { to: VenueOrderStatus; facts: Facts; failureCode?: string } {
  const original = scaled(status.originalSize);
  const remaining = scaled(status.remaining);
  const filled = original !== null && remaining !== null ? original - remaining : null;

  const facts: Facts = {
    venueOrderId: status.venueOrderId,
    ...(filled === null ? {} : { filledSize: unscaled(filled) }),
  };

  if (status.status === "filled") {
    return { to: "filled", facts: { ...facts, filledSize: operation.size } };
  }

  if (status.status === "canceled" || status.status.endsWith("Canceled")) {
    const byVenue = status.status !== "canceled";

    return {
      to: filled !== null && filled > 0n ? "partially_filled" : "cancelled",
      facts: { ...facts, venueError: byVenue ? status.status : null },
      ...(byVenue ? { failureCode: "venue_cancelled" } : {}),
    };
  }

  if (/rejected$/i.test(status.status)) {
    return {
      to: "failed",
      facts: { ...facts, venueError: status.status },
      failureCode: "venue_refused",
    };
  }

  // `open`, and anything this server does not know yet, is watched as resting.
  return { to: "placed", facts };
}

/** Record what the venue answered a posted request with. */
async function recordAnswer(ctx: AppContext, f: Followed, answer: ExchangeAnswer): Promise<Next> {
  const { order, intent, operation } = f;

  if (answer.kind === "refused") {
    // A request past its window is refused for that reason, whatever words the venue uses.
    const late = expired(ctx, order) || /expire/i.test(answer.text);
    await record(
      ctx,
      order,
      intent,
      late ? "expired" : "failed",
      { venueError: answer.text },
      late ? {} : { failureCode: "venue_refused" },
    );

    return { done: true, waitSeconds: 0 };
  }

  if (operation.type === "hyperliquid.withdraw") {
    if (answer.kind !== "accepted") return { done: false, waitSeconds: RETRY_SECONDS };
    await record(ctx, order, intent, "accepted", {});

    return { done: true, waitSeconds: 0 };
  }

  switch (answer.kind) {
    case "resting":
      await record(ctx, order, intent, "placed", { venueOrderId: answer.venueOrderId });

      return { done: false, waitSeconds: RETRY_SECONDS };
    case "filled": {
      const total = scaled(answer.totalSize);
      const complete = total !== null && total >= (scaled(operation.size) ?? 0n);

      // An immediate-or-cancel order's rest is cancelled at once; any other rests on the book.
      const to: VenueOrderStatus = complete
        ? "filled"
        : operation.tif === "Ioc"
          ? "partially_filled"
          : "placed";

      await record(ctx, order, intent, to, {
        venueOrderId: answer.venueOrderId,
        filledSize: answer.totalSize,
        averagePrice: answer.averagePrice,
      });

      return to === "placed"
        ? { done: false, waitSeconds: RETRY_SECONDS }
        : { done: true, waitSeconds: 0 };
    }

    case "accepted":
      // Not an answer to an order: what happened is read back by its client order id.
      return { done: false, waitSeconds: RETRY_SECONDS };
  }
}

/** Post the stored request, byte for byte, and record the answer. */
async function post(ctx: AppContext, f: Followed): Promise<Next> {
  let answer: ExchangeAnswer;

  try {
    answer = await f.client.post(f.body);
  } catch (error) {
    if (!(error instanceof VenueError)) throw error;
    ctx.log.warn("venue request not answered", {
      event: "venue.post",
      approvalId: f.order.approvalId,
      network: f.order.network,
      outcome: "unreachable",
    });

    return { done: false, waitSeconds: RETRY_SECONDS };
  }

  ctx.log.info("venue request posted", {
    event: "venue.post",
    approvalId: f.order.approvalId,
    network: f.order.network,
    outcome: answer.kind,
  });

  return recordAnswer(ctx, f, answer);
}

/**
 * How far before a withdrawal's nonce its entry in the venue's ledger is looked for: the nonce is
 * the signer's clock at signing, and the venue's clock may differ from it.
 */
const LEDGER_LOOKBACK_MS = 300_000;

/**
 * Ask the venue's ledger for a withdrawal by its nonce, which no second withdrawal of the account
 * can share. Found: the venue took it, and the request ends accepted.
 */
async function checkWithdrawal(
  ctx: AppContext,
  f: Followed,
): Promise<Next | "unknown" | "unreachable"> {
  const { order, intent } = f;
  let nonces: number[];

  try {
    nonces = await f.client.withdrawalNonces(f.account, order.actionNonce - LEDGER_LOOKBACK_MS);
  } catch (error) {
    if (error instanceof VenueError) return "unreachable";
    throw error;
  }

  const found = nonces.includes(order.actionNonce);
  ctx.log.info("venue withdrawal read", {
    event: "venue.status",
    approvalId: order.approvalId,
    network: order.network,
    status: found ? "accepted" : "unknown",
  });

  if (!found) return "unknown";
  await record(ctx, order, intent, "accepted", {});

  return { done: true, waitSeconds: 0 };
}

/**
 * Ask the venue for the order by its client order id, or for a withdrawal by its nonce, and
 * record what it says.
 */
async function check(ctx: AppContext, f: Followed): Promise<Next | "unknown" | "unreachable"> {
  const { order, intent, operation } = f;

  if (operation.type === "hyperliquid.withdraw") return checkWithdrawal(ctx, f);

  if (order.cloid === null) return "unknown";
  let status: OrderStatusAnswer;

  try {
    status = await f.client.orderStatus(f.account, order.cloid as Cloid);
  } catch (error) {
    if (error instanceof VenueError) return "unreachable";
    throw error;
  }

  ctx.log.info("venue order read", {
    event: "venue.status",
    approvalId: order.approvalId,
    network: order.network,
    status: status.found ? status.status : "unknown",
  });

  if (!status.found) return "unknown";
  const next = fromStatus(operation, status);
  await record(
    ctx,
    order,
    intent,
    next.to,
    next.facts,
    next.failureCode === undefined ? {} : { failureCode: next.failureCode },
  );

  if (next.to !== "placed") return { done: true, waitSeconds: 0 };
  const elapsed = order.submittedAt ? ctx.now() - order.submittedAt.getTime() / 1000 : 0;

  return {
    done: false,
    waitSeconds: Math.min(
      MAX_WATCH_WAIT_SECONDS,
      Math.max(RETRY_SECONDS, Math.floor(elapsed / 10)),
    ),
  };
}

/**
 * One round of following a venue request. `signed`: posted now, or `expired` when its submit
 * window passed first. `submitted` (the answer was lost, or the process died after posting):
 * the venue is asked for the order by its client order id before anything is posted again, and
 * the identical request is posted again only while the window is open (the venue's nonce rule
 * refuses a second copy anyway); a withdrawal, which has no client order id, is looked for in the
 * venue's ledger by its nonce and posted again only when the venue has not taken it.
 * `placed`: read back with a wait growing from 5 to 60 seconds. `watch` false ends the round
 * after one look (the reconcile sweeper's use).
 */
async function advance(ctx: AppContext, order: VenueOrderRow, watch: boolean): Promise<Next> {
  let f: Followed;

  try {
    f = await followed(ctx, order);
  } catch (error) {
    // The venue was removed from VENUES_FILE after signing: nothing can be posted any more.
    if (!(error instanceof HttpError)) throw error;

    if (OPEN.includes(order.status) && expired(ctx, order) && order.status !== "placed") {
      const intent = await getIntentRow(ctx, order.intentId);
      await record(ctx, order, intent, "expired", {});

      return { done: true, waitSeconds: 0 };
    }

    return { done: !watch, waitSeconds: MAX_WATCH_WAIT_SECONDS };
  }

  const watchedFor = order.submittedAt ? ctx.now() - order.submittedAt.getTime() / 1000 : 0;

  if (watch && order.status !== "signed" && watchedFor > ORDER_WATCH_SECONDS) {
    return { done: true, waitSeconds: 0 };
  }

  switch (order.status) {
    case "signed": {
      if (expired(ctx, order)) {
        await record(ctx, order, f.intent, "expired", {}, { from: ["signed"] });

        return { done: true, waitSeconds: 0 };
      }

      // Recorded before posting, so a crash after the post is followed by a look, not a guess.
      const now = new Date(ctx.now() * 1000);

      if (
        !(await record(
          ctx,
          order,
          f.intent,
          "submitted",
          { submittedAt: now },
          { from: ["signed"] },
        ))
      ) {
        return { done: false, waitSeconds: 0 };
      }

      return post(ctx, { ...f, order: { ...order, status: "submitted", submittedAt: now } });
    }

    case "submitted": {
      const seen = await check(ctx, f);

      if (seen === "unreachable") return { done: false, waitSeconds: RETRY_SECONDS };

      if (seen !== "unknown") return seen;

      if (f.operation.type === "hyperliquid.order" && expired(ctx, order)) {
        await record(ctx, order, f.intent, "expired", {});

        return { done: true, waitSeconds: 0 };
      }

      return post(ctx, f);
    }

    case "placed": {
      const seen = await check(ctx, f);

      if (seen === "unreachable") return { done: false, waitSeconds: RETRY_SECONDS };

      // A resting order the venue no longer knows is not one this server can follow further.
      if (seen === "unknown") return { done: true, waitSeconds: 0 };

      return seen;
    }

    default:
      return { done: true, waitSeconds: 0 };
  }
}

async function followUpVenueIntent(ctx: AppContext, approval: ApprovalRow): Promise<Next | null> {
  const order = await orderRow(ctx, approval.id);

  if (!order) return null;

  return advance(ctx, order, true);
}

/**
 * The orders the follow-up stopped watching (posted more than {@link ORDER_WATCH_SECONDS} ago and
 * not final), each read back once, at most once per {@link RECONCILE_INTERVAL_SECONDS} across
 * every replica. One that fails does not stop the others.
 */
export async function reconcileOpenOrders(ctx: AppContext): Promise<number | null> {
  if (!(await takeToken(ctx.db, "sweep:venue-reconcile", 60 / RECONCILE_INTERVAL_SECONDS, 1))) {
    return null;
  }

  const due = await ctx.db
    .select()
    .from(venueOrders)
    .where(
      and(
        inArray(venueOrders.status, ["submitted", "placed"]),
        lt(venueOrders.submittedAt, new Date((ctx.now() - ORDER_WATCH_SECONDS) * 1000)),
      ),
    )
    .limit(RECONCILE_BATCH);

  for (const order of due) {
    await advance(ctx, order, false).catch((error: unknown) => {
      ctx.log.error("venue reconcile failed", {
        event: "venue.status",
        approvalId: order.approvalId,
        error: error instanceof Error ? error.name : "unknown",
      });
    });
  }

  return due.length;
}

// --- cancelling -------------------------------------------------------------------------------

/**
 * Cancel a posted venue order: the signer signs its cancel by client order id with no passkey,
 * also while the workspace is paused (D4), and the cancel is posted; the venue's own record of the
 * order then says how it ended (`cancelled`, or `partially_filled` or `filled` when fills came
 * first). Refused with `not_cancellable` unless the order was posted and is not final.
 */
export async function cancelVenueOrder(
  ctx: AppContext,
  row: IntentRow,
  actor: { type: "agent" | "user"; id: string },
): Promise<void> {
  const order = row.approvalId === null ? undefined : await orderRow(ctx, row.approvalId);

  if (!order || order.cloid === null || !CANCELLABLE.includes(order.status)) {
    throw new HttpError("conflict", "this order cannot be cancelled now", "not_cancellable");
  }

  const f = await followed(ctx, order);

  const signed = await ctx.signer
    .cancelVenueOrder(order.approvalId, row.workspaceId)
    .catch((error: unknown) => {
      if (error instanceof SignerError && !RETRYABLE_SIGNER_CODES.includes(error.code)) {
        throw new HttpError("signer_refused", "the signer refused the cancel", error.code);
      }

      throw new HttpError("internal", "the signer could not be reached", "retry_later");
    });

  await appendAudit(ctx, {
    workspaceId: row.workspaceId,
    actor,
    action: "intent.order_cancel_requested",
    subject: { type: "intent", id: row.id },
  });
  let answer: ExchangeAnswer;

  try {
    answer = await f.client.post(JSON.stringify(signed.request));
  } catch (error) {
    if (!(error instanceof VenueError)) throw error;
    throw new HttpError("internal", "the venue could not be reached", "venue_unreachable");
  }

  ctx.log.info("venue cancel posted", {
    event: "venue.cancel",
    approvalId: order.approvalId,
    network: order.network,
    outcome: answer.kind,
  });
  const seen = await check(ctx, f);

  if (seen === "unreachable" && answer.kind === "accepted") {
    // The venue accepted the cancel; how much filled before it is the last known size.
    const filled = order.filledSize === null ? null : scaled(order.filledSize);
    await record(
      ctx,
      order,
      row,
      filled !== null && filled > 0n ? "partially_filled" : "cancelled",
      {},
    );
  }
}

/**
 * `cancel_intent`: a proposal still waiting for people is withdrawn; a posted venue order is
 * cancelled at the venue. Anything else is left as it is. Answers the intent's status.
 */
export async function cancelIntentOrOrder(
  ctx: AppContext,
  row: IntentRow,
  actor: { type: "agent" | "user"; id: string },
): Promise<IntentStatus> {
  const order = row.approvalId === null ? undefined : await orderRow(ctx, row.approvalId);

  if (!order || !CANCELLABLE.includes(order.status)) return cancelIntent(ctx, row);
  await cancelVenueOrder(ctx, row, actor);

  return (await getIntentRow(ctx, row.id)).status;
}

// --- the wallet page --------------------------------------------------------------------------

/** At most this many positions and resting orders are shown; the rest are not read. */
const ACCOUNT_LIST_MAX = 100;

/**
 * The wallet's account at a configured venue: the one its policy has rules for, or else one it
 * has used. Null when there is none. What the venue reports is read here and passed on, never
 * checked; a venue that cannot be read, or answers what cannot be shown, is `reported: null`.
 */
export async function walletVenueAccount(
  ctx: AppContext,
  wallet: { id: WalletId; address: `0x${string}` },
  policy: WalletPolicy | null,
  venueSpent: WalletState["venueSpent"],
): Promise<VenueAccount | null> {
  const configured = ctx.config.venues.map((venue) => venue.network);

  if (configured.length === 0) return null;
  const rules = policy?.venues?.hyperliquid;

  let network: VenueNetwork | null =
    rules !== undefined && configured.includes(rules.network) ? rules.network : null;

  if (network === null) {
    const [used] = await ctx.db
      .select({ network: venueOrders.network })
      .from(venueOrders)
      .where(and(eq(venueOrders.walletId, wallet.id), inArray(venueOrders.network, configured)))
      .limit(1);

    network = used?.network ?? null;
  }

  if (network === null) return null;
  const client = venueClient(ctx, network);
  let reported: VenueAccount["reported"] = null;

  try {
    const [state, open] = await Promise.all([
      client.accountState(wallet.address),
      client.openOrders(wallet.address),
    ]);

    const parsed = VenueAccount.shape.reported.safeParse({
      accountValueUsd: state.accountValue,
      withdrawableUsd: state.withdrawable,
      positions: state.positions
        .filter((position) => scaled(position.size.replace(/^-/, "")) !== 0n)
        .slice(0, ACCOUNT_LIST_MAX)
        .map((position) => ({
          coin: position.coin,
          side: position.size.startsWith("-") ? "short" : "long",
          size: position.size.replace(/^-/, ""),
          entryPrice: position.entryPrice,
          unrealizedPnlUsd: position.unrealizedPnl,
        })),
      openOrders: open.slice(0, ACCOUNT_LIST_MAX).map((order) => ({
        coin: order.coin,
        side: order.side,
        size: order.remaining,
        limitPrice: order.limitPrice,
        venueOrderId: order.venueOrderId,
        cloid: order.cloid,
      })),
    });

    if (parsed.success) reported = parsed.data;
    else ctx.log.warn("venue account not shown", { event: "venue.account", network });
  } catch (error) {
    if (!(error instanceof VenueError)) throw error;
    ctx.log.warn("venue account not read", { event: "venue.account", network });
  }

  return {
    network,
    spentTodayUsd6: venueSpent.find((entry) => entry.chainId === network)?.amount ?? "0",
    maxNotionalPerDayUsd6: rules?.network === network ? rules.maxNotionalPerDayUsd6 : null,
    reported,
  };
}

// --- the approval page ------------------------------------------------------------------------

/** What `approve-intent` does for a venue intent (`registerIntentKind`). */
export const venueHooks: VenueHooks = {
  execute: executeVenueIntent,
  followUp: followUpVenueIntent,
  async describe(ctx, intent, wallet) {
    const rules = wallet.policy?.venues?.hyperliquid;

    if (rules === undefined || rules.network !== intent.chainId) return null;
    const { operation } = intent;

    const market =
      operation.type === "hyperliquid.order"
        ? rules.markets.find((candidate) => candidate.asset === operation.asset)
        : undefined;

    const [state, accountValue] = await Promise.all([
      ctx.signer.getWallet(wallet.id).catch(() => null),
      (async () => {
        try {
          return await venueClient(ctx, intent.chainId).accountValue(wallet.address);
        } catch {
          return null;
        }
      })(),
    ]);

    return {
      network: intent.chainId,
      maxPerOrderUsd6: market?.maxNotionalPerOrderUsd6 ?? null,
      maxNotionalPerDayUsd6: rules.maxNotionalPerDayUsd6,
      spentTodayUsd6:
        state?.venueSpent.find((entry) => entry.chainId === intent.chainId)?.amount ?? "0",
      submitWindowSeconds: rules.submitWindowSeconds,
      withdrawals: rules.withdrawals,
      accountValueUsd: accountValue,
    };
  },
};
