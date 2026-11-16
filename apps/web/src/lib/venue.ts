import {
  HYPERLIQUID_MAX_PERP_ASSET,
  type HyperliquidOrderOperation,
  HyperliquidRules,
  HyperliquidTimeInForce,
  orderNotionalUsd6,
  VENUE_NETWORK_NAMES,
  type VenueIntent,
  VenueNetwork,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { formatUnits, parseUnits, UnitsError } from "./format.ts";

/**
 * What a person must know before trusting a venue's caps, in the words the policy editor, the
 * policy views and the order card use: the caps limit the notional of new orders, never losses.
 */
export const VENUE_LOSS_BOUND =
  "These caps limit the notional of new orders, not losses. What can be lost is the wallet's whole account value at Hyperliquid: leverage, funding payments and positions opened earlier are not limited by them.";

/** Where the server's view of the venue account comes from, wherever it is shown. */
export const VENUE_REPORTED =
  "Reported by Hyperliquid through this server, not verified by the signer.";

/** Each time in force, in the words the signer's confirmation page uses. */
export const timeInForceText: Record<HyperliquidTimeInForce, { name: string; effect: string }> = {
  Alo: { name: "add liquidity only", effect: "cancelled if it would fill at once" },
  Gtc: { name: "good till cancelled", effect: "rests on the book until filled or cancelled" },
  Ioc: { name: "immediate or cancel", effect: "whatever does not fill at once is cancelled" },
};

/** The submit window a new policy's venue rules start with, in seconds. */
export const DEFAULT_SUBMIT_WINDOW_SECONDS = 60;

/** Micro-USD (`usd6`) in whole dollars: "1250500000" → "1,250.5 USD". */
export function formatUsd6(amount: string | bigint): string {
  return `${formatUnits(amount, 6)} USD`;
}

/** A canonical decimal with its whole part grouped, as the signer shows sizes and prices. */
export function formatDecimal(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

// --- the policy editor's venue section --------------------------------------------------------

/** One market as typed: what the index is called, its index at the venue, and its cap. */
export interface MarketRow {
  key: number;
  coin: string;
  /** The perpetual's index in Hyperliquid's market list, as typed. */
  asset: string;
  /** Most notional of one order, in whole USD, as typed. */
  maxPerOrder: string;
}

export interface VenueRulesState {
  /** Whether the wallet may act on Hyperliquid at all; off leaves `venues` out of the policy. */
  enabled: boolean;
  /** Kept from the current rules; new rules start on the first network this server has set up. */
  network: VenueNetwork;
  markets: MarketRow[];
  /** Most notional per 24 hours, in whole USD, as typed. */
  maxPerDay: string;
  timeInForce: HyperliquidTimeInForce[];
  submitWindowSeconds: string;
  withdrawals: boolean;
}

export class VenueRulesError extends Error {
  override readonly name = "VenueRulesError";
}

let nextMarketKey = 1;

/** An empty market row with a key no other row has. */
export function newMarketRow(): MarketRow {
  return { key: nextMarketKey++, coin: "", asset: "", maxPerOrder: "" };
}

/**
 * What the venue section starts from: the current rules, which keep their network, or none, with
 * the defaults a new set of rules starts with when turned on: the first network the server has
 * set up (`configured`, testnet before mainnet), immediate or cancel only (an order that cannot
 * rest cannot be left behind at the venue), a 60-second submit window and no withdrawals.
 */
export function venueRulesState(
  rules: HyperliquidRules | undefined,
  configured: readonly VenueNetwork[],
): VenueRulesState {
  if (!rules) {
    return {
      enabled: false,
      network:
        VenueNetwork.options.find((network) => configured.includes(network)) ??
        "hyperliquid:testnet",
      markets: [newMarketRow()],
      maxPerDay: "",
      timeInForce: ["Ioc"],
      submitWindowSeconds: String(DEFAULT_SUBMIT_WINDOW_SECONDS),
      withdrawals: false,
    };
  }
  return {
    enabled: true,
    network: rules.network,
    markets: rules.markets.map((market) => ({
      key: nextMarketKey++,
      coin: market.coin,
      asset: String(market.asset),
      // Whole dollars for the field, without the grouping commas `formatUnits` adds.
      maxPerOrder: formatUnits(market.maxNotionalPerOrderUsd6, 6).replaceAll(",", ""),
    })),
    maxPerDay: formatUnits(rules.maxNotionalPerDayUsd6, 6).replaceAll(",", ""),
    timeInForce: [...rules.timeInForce],
    submitWindowSeconds: String(rules.submitWindowSeconds),
    withdrawals: rules.withdrawals,
  };
}

/**
 * The networks the venue section offers: those the server has set up, testnet before mainnet,
 * plus the network of rules already in force when the server no longer sets it up, so the
 * section shows what the policy says. The server refuses rules for a network it has not set up.
 */
export function venueNetworkChoices(
  configured: readonly VenueNetwork[],
  state: Pick<VenueRulesState, "enabled" | "network">,
): VenueNetwork[] {
  return VenueNetwork.options.filter(
    (network) => configured.includes(network) || (state.enabled && network === state.network),
  );
}

function usd6(text: string, what: string): bigint {
  try {
    const amount = parseUnits(text, 6);
    if (amount === 0n) throw new VenueRulesError(`${what} must be above zero.`);
    return amount;
  } catch (error) {
    if (error instanceof UnitsError) {
      throw new VenueRulesError(`${what}: enter whole dollars such as 500 or 12.5.`);
    }
    throw error;
  }
}

/**
 * The venue rules a person typed, as the policy holds them, or `undefined` when the wallet may
 * not act on a venue. Throws a `VenueRulesError` naming the field to fix. The signer checks the
 * same rules again; this only keeps a person from submitting a policy it would refuse.
 */
export function toVenueRules(state: VenueRulesState): HyperliquidRules | undefined {
  if (!state.enabled) return undefined;
  if (state.markets.length === 0) throw new VenueRulesError("Add at least one Hyperliquid market.");
  const maxPerDay = usd6(state.maxPerDay, "Notional per 24 hours");
  const markets = state.markets.map((row, index) => {
    const label = `Market ${index + 1}`;
    const coin = row.coin.trim();
    if (!/^[A-Z0-9]{1,16}$/.test(coin)) {
      throw new VenueRulesError(
        `${label}: the coin is 1 to 16 capital letters or digits, as Hyperliquid names it, such as BTC.`,
      );
    }
    const assetText = row.asset.trim();
    const asset = Number(assetText);
    if (!/^\d{1,4}$/.test(assetText) || asset > HYPERLIQUID_MAX_PERP_ASSET) {
      throw new VenueRulesError(
        `${label}: the market index is a whole number from 0 to ${HYPERLIQUID_MAX_PERP_ASSET}, its place in Hyperliquid's list of perpetuals.`,
      );
    }
    const maxPerOrder = usd6(row.maxPerOrder, `${label}: the notional per order`);
    if (maxPerOrder > maxPerDay) {
      throw new VenueRulesError(
        `${label}: the notional per order cannot exceed the notional per 24 hours.`,
      );
    }
    return { asset, coin, maxNotionalPerOrderUsd6: maxPerOrder.toString() };
  });
  markets.forEach((market, index) => {
    const label = `Market ${index + 1}`;
    if (markets.findIndex((other) => other.asset === market.asset) !== index) {
      throw new VenueRulesError(`${label}: another market already has index ${market.asset}.`);
    }
    if (markets.findIndex((other) => other.coin === market.coin) !== index) {
      throw new VenueRulesError(`${label}: another market is already called ${market.coin}.`);
    }
  });
  const timeInForce = HyperliquidTimeInForce.options.filter((tif) =>
    state.timeInForce.includes(tif),
  );
  if (timeInForce.length === 0) {
    throw new VenueRulesError("Allow at least one time in force.");
  }
  const windowText = state.submitWindowSeconds.trim();
  const submitWindowSeconds = Number(windowText);
  if (!/^\d+$/.test(windowText) || submitWindowSeconds < 5 || submitWindowSeconds > 300) {
    throw new VenueRulesError("The submit window is a whole number of seconds from 5 to 300.");
  }
  const parsed = HyperliquidRules.safeParse({
    network: state.network,
    markets: markets.sort((a, b) => a.asset - b.asset),
    maxNotionalPerDayUsd6: maxPerDay.toString(),
    timeInForce,
    submitWindowSeconds,
    withdrawals: state.withdrawals,
  });
  if (!parsed.success) {
    throw new VenueRulesError(
      `Hyperliquid rules: ${parsed.error.issues[0]?.message ?? "not valid"}.`,
    );
  }
  return parsed.data;
}

/**
 * Venue rules as labelled lines, for the policy table and its before-and-after. Labels name the
 * market by coin and index, so a market whose cap changed lines up with itself. A policy without
 * venue rules has no lines, so it reads as it did before venues existed.
 */
export function venueRuleRows(
  rules: HyperliquidRules | undefined,
): { label: string; value: string }[] {
  if (!rules) return [];
  return [
    { label: "Hyperliquid network", value: VENUE_NETWORK_NAMES[rules.network] },
    ...rules.markets.map((market) => ({
      label: `Hyperliquid ${market.coin} (index ${market.asset}): per order`,
      value: `${formatUsd6(market.maxNotionalPerOrderUsd6)} notional`,
    })),
    {
      label: "Hyperliquid: per 24 hours",
      value: `${formatUsd6(rules.maxNotionalPerDayUsd6)} notional, reduce-only orders not counted`,
    },
    {
      label: "Hyperliquid time in force",
      value: rules.timeInForce.map((tif) => timeInForceText[tif].name).join(", "),
    },
    {
      label: "Hyperliquid submit window",
      value: `${rules.submitWindowSeconds} seconds after signing`,
    },
    {
      label: "Hyperliquid withdrawals",
      value: rules.withdrawals ? "Allowed, to the wallet's own address only" : "Not allowed",
    },
    { label: "Hyperliquid losses", value: VENUE_LOSS_BOUND },
  ];
}

// --- an order -------------------------------------------------------------------------------

export type VenueOrderIntent = VenueIntent & { operation: HyperliquidOrderOperation };

export function isOrderIntent(intent: { operation: { type: string } }): intent is VenueOrderIntent {
  return intent.operation.type === "hyperliquid.order";
}

/**
 * An order as a person reads it, from the hashed intent and the wallet's current policy. The
 * coin name comes from the policy, which binds it to the index the signer signs; `coin` is null
 * when the policy does not list the index, and the signer would then refuse the order.
 */
export interface OrderFacts {
  network: VenueNetwork;
  coin: string | null;
  asset: number;
  side: "buy" | "sell";
  size: string;
  limitPrice: string;
  notionalUsd6: bigint;
  timeInForce: HyperliquidTimeInForce;
  reduceOnly: boolean;
}

export function orderFacts(intent: VenueOrderIntent, policy: WalletPolicy | null): OrderFacts {
  const order = intent.operation;
  const rules = policy?.venues?.hyperliquid;
  const market =
    rules?.network === intent.chainId
      ? rules.markets.find((candidate) => candidate.asset === order.asset)
      : undefined;
  return {
    network: intent.chainId,
    coin: market?.coin ?? null,
    asset: order.asset,
    side: order.isBuy ? "buy" : "sell",
    size: order.size,
    limitPrice: order.limitPx,
    notionalUsd6: orderNotionalUsd6(order.size, order.limitPx),
    timeInForce: order.tif,
    reduceOnly: order.reduceOnly,
  };
}

/** The order in one line, as the signer's page titles it: "Buy 0.01 BTC perpetual". */
export function orderTitle(facts: OrderFacts): string {
  const side = facts.side === "buy" ? "Buy" : "Sell";
  const size = formatDecimal(facts.size);
  return facts.coin === null
    ? `${side} ${size} of market ${facts.asset}, not in the wallet's policy`
    : `${side} ${size} ${facts.coin} perpetual`;
}

/** What the limit price means for this side: the most a buy pays, the least a sell takes. */
export function limitPriceText(facts: Pick<OrderFacts, "side" | "limitPrice">): string {
  const price = `${formatDecimal(facts.limitPrice)} USD`;
  return facts.side === "buy" ? `${price}, the most it pays` : `${price}, the least it takes`;
}

/** The wallet's venue caps for one request, in micro-USD, as the server reads them. */
export interface VenueCaps {
  /** The order's market's cap per order; null when the policy does not list the market. */
  maxPerOrderUsd6: string | null;
  maxNotionalPerDayUsd6: string;
  /** What the signer counted in the last 24 hours. */
  spentTodayUsd6: string;
}

export interface OrderCaps {
  perOrder: { used: bigint; cap: bigint } | null;
  /** `used` includes this order unless it is reduce-only (`counts` false). */
  daily: { used: bigint; cap: bigint; counts: boolean };
}

/**
 * Where an order sits against the wallet's venue caps: its notional against its market's
 * per-order cap, and what the last 24 hours would add up to with it. A reduce-only order is
 * capped per order but does not count against the daily cap.
 */
export function orderCaps(
  facts: Pick<OrderFacts, "notionalUsd6" | "reduceOnly">,
  caps: VenueCaps,
): OrderCaps {
  const spent = BigInt(caps.spentTodayUsd6);
  return {
    perOrder:
      caps.maxPerOrderUsd6 === null
        ? null
        : { used: facts.notionalUsd6, cap: BigInt(caps.maxPerOrderUsd6) },
    daily: {
      used: facts.reduceOnly ? spent : spent + facts.notionalUsd6,
      cap: BigInt(caps.maxNotionalPerDayUsd6),
      counts: !facts.reduceOnly,
    },
  };
}
