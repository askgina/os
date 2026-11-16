import { ApiError, IntentStatus } from "@askgina/os-api";
import {
  HyperliquidRules,
  POLICY_DENY_CODES,
  type VenueIntent,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { describe, expect, it } from "vitest";
import { explainCancelOrderError, explainCode } from "../src/lib/codes.ts";
import { intentSummarySentence, orderStatusSentence } from "../src/lib/statuses.ts";
import {
  formatDecimal,
  formatUsd6,
  limitPriceText,
  newMarketRow,
  orderCaps,
  orderFacts,
  orderTitle,
  toVenueRules,
  VENUE_LOSS_BOUND,
  type VenueOrderIntent,
  VenueRulesError,
  type VenueRulesState,
  venueNetworkChoices,
  venueRuleRows,
  venueRulesState,
} from "../src/lib/venue.ts";

const ULID = "01jd000000000000000000000";

const RULES: HyperliquidRules = HyperliquidRules.parse({
  network: "hyperliquid:testnet",
  markets: [
    { asset: 0, coin: "BTC", maxNotionalPerOrderUsd6: "50000000" },
    { asset: 1, coin: "ETH", maxNotionalPerOrderUsd6: "12500000" },
  ],
  maxNotionalPerDayUsd6: "100000000",
  timeInForce: ["Gtc", "Ioc"],
  submitWindowSeconds: 60,
  withdrawals: false,
});

function policy(venues: WalletPolicy["venues"]): WalletPolicy {
  return {
    v: 1,
    workspaceId: `ws_${ULID}1`,
    walletId: `wal_${ULID}2`,
    revision: 1,
    previousHash: null,
    chains: ["eip155:31337"],
    requesters: [],
    assets: [],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: "1000000000000000" },
    approvals: { threshold: 1, ttlSeconds: 600 },
    ...(venues ? { venues } : {}),
  };
}

function order(
  overrides: Partial<VenueOrderIntent["operation"]> = {},
  chainId: VenueIntent["chainId"] = "hyperliquid:testnet",
): VenueOrderIntent {
  return {
    v: 1,
    id: `int_${ULID}3`,
    workspaceId: `ws_${ULID}1`,
    agentId: `agt_${ULID}4`,
    walletId: `wal_${ULID}2`,
    chainId,
    operation: {
      type: "hyperliquid.order",
      asset: 0,
      isBuy: true,
      size: "0.01",
      limitPx: "65000",
      tif: "Ioc",
      reduceOnly: false,
      ...overrides,
    },
    memo: "",
    createdAt: 1_700_000_000,
  };
}

/** Both venue networks, as a server with both set up lists them. */
const BOTH = ["hyperliquid:testnet", "hyperliquid:mainnet"] as const;

/** The editor state for RULES, as typed, with `patch` applied. */
function typed(patch: Partial<VenueRulesState> = {}): VenueRulesState {
  return { ...venueRulesState(RULES, BOTH), ...patch };
}

describe("the policy editor's venue section", () => {
  it("starts off, with immediate or cancel only, a 60-second window and no withdrawals", () => {
    const state = venueRulesState(undefined, BOTH);
    expect(state).toMatchObject({
      enabled: false,
      network: "hyperliquid:testnet",
      maxPerDay: "",
      timeInForce: ["Ioc"],
      submitWindowSeconds: "60",
      withdrawals: false,
    });
    expect(state.markets).toHaveLength(1);
    expect(toVenueRules(state)).toBeUndefined();
  });

  it("starts new rules on testnet when both networks are set up, else on the one that is", () => {
    expect(venueRulesState(undefined, BOTH).network).toBe("hyperliquid:testnet");
    expect(venueRulesState(undefined, ["hyperliquid:mainnet", "hyperliquid:testnet"]).network).toBe(
      "hyperliquid:testnet",
    );
    expect(venueRulesState(undefined, ["hyperliquid:mainnet"]).network).toBe("hyperliquid:mainnet");
    expect(venueRulesState(undefined, ["hyperliquid:testnet"]).network).toBe("hyperliquid:testnet");
  });

  it("keeps the network of rules already in force, whatever the server sets up", () => {
    const mainnet = HyperliquidRules.parse({ ...RULES, network: "hyperliquid:mainnet" });
    expect(venueRulesState(mainnet, ["hyperliquid:testnet"]).network).toBe("hyperliquid:mainnet");
    expect(venueRulesState(RULES, ["hyperliquid:mainnet"]).network).toBe("hyperliquid:testnet");
    expect(toVenueRules(venueRulesState(mainnet, BOTH))).toEqual(mainnet);
  });

  it("offers the networks the server sets up, and the one rules in force already name", () => {
    const off = venueRulesState(undefined, []);
    expect(venueNetworkChoices([], off)).toEqual([]);
    expect(venueNetworkChoices(["hyperliquid:mainnet", "hyperliquid:testnet"], off)).toEqual([
      ...BOTH,
    ]);
    expect(venueNetworkChoices(["hyperliquid:mainnet"], off)).toEqual(["hyperliquid:mainnet"]);
    const kept = venueRulesState(RULES, ["hyperliquid:mainnet"]);
    expect(venueNetworkChoices(["hyperliquid:mainnet"], kept)).toEqual([...BOTH]);
    expect(venueNetworkChoices([], kept)).toEqual(["hyperliquid:testnet"]);
  });

  it("reads current rules back in whole dollars and writes them unchanged", () => {
    const state = venueRulesState(RULES, BOTH);
    expect(state.enabled).toBe(true);
    expect(state.markets.map((row) => [row.coin, row.asset, row.maxPerOrder])).toEqual([
      ["BTC", "0", "50"],
      ["ETH", "1", "12.5"],
    ]);
    expect(state.maxPerDay).toBe("100");
    expect(toVenueRules(state)).toEqual(RULES);
  });

  it("sorts markets by index and times in force as the policy holds them", () => {
    const [btc, eth] = venueRulesState(RULES, BOTH).markets;

    if (!btc || !eth) throw new Error("expected two markets");
    const rules = toVenueRules(typed({ markets: [eth, btc], timeInForce: ["Ioc", "Alo"] }));
    expect(rules?.markets.map((market) => market.asset)).toEqual([0, 1]);
    expect(rules?.timeInForce).toEqual(["Alo", "Ioc"]);
  });

  it("gives each new market row its own key", () => {
    expect(newMarketRow().key).not.toBe(newMarketRow().key);
  });

  it.each<[string, Partial<VenueRulesState>, RegExp]>([
    ["no market", { markets: [] }, /at least one Hyperliquid market/],
    [
      "a lower-case coin",
      { markets: [{ key: 1, coin: "btc", asset: "0", maxPerOrder: "5" }] },
      /Market 1: the coin is 1 to 16 capital letters/,
    ],
    [
      "an index past the last",
      { markets: [{ key: 1, coin: "BTC", asset: "10000", maxPerOrder: "5" }] },
      /Market 1: the market index is a whole number from 0 to 9999/,
    ],
    [
      "an index that is not a whole number",
      { markets: [{ key: 1, coin: "BTC", asset: "1.5", maxPerOrder: "5" }] },
      /market index/,
    ],
    [
      "a zero cap per order",
      { markets: [{ key: 1, coin: "BTC", asset: "0", maxPerOrder: "0" }] },
      /Market 1: the notional per order must be above zero/,
    ],
    [
      "a cap in a form a person would not type",
      { markets: [{ key: 1, coin: "BTC", asset: "0", maxPerOrder: "1e3" }] },
      /Market 1: the notional per order: enter whole dollars/,
    ],
    [
      "a cap per order above the daily cap",
      { markets: [{ key: 1, coin: "BTC", asset: "0", maxPerOrder: "101" }] },
      /cannot exceed the notional per 24 hours/,
    ],
    [
      "two markets with one index",
      {
        markets: [
          { key: 1, coin: "BTC", asset: "0", maxPerOrder: "5" },
          { key: 2, coin: "ETH", asset: "0", maxPerOrder: "5" },
        ],
      },
      /Market 2: another market already has index 0/,
    ],
    [
      "two markets with one coin",
      {
        markets: [
          { key: 1, coin: "BTC", asset: "0", maxPerOrder: "5" },
          { key: 2, coin: "BTC", asset: "3", maxPerOrder: "5" },
        ],
      },
      /Market 2: another market is already called BTC/,
    ],
    ["no daily cap", { maxPerDay: "" }, /Notional per 24 hours: enter whole dollars/],
    ["no time in force", { timeInForce: [] }, /at least one time in force/],
    ["a window under 5 seconds", { submitWindowSeconds: "4" }, /from 5 to 300/],
    ["a window over 300 seconds", { submitWindowSeconds: "301" }, /from 5 to 300/],
    ["a window in minutes", { submitWindowSeconds: "1.5" }, /from 5 to 300/],
  ])("refuses %s, naming the field", (_, patch, message) => {
    expect(() => toVenueRules(typed(patch))).toThrow(VenueRulesError);
    expect(() => toVenueRules(typed(patch))).toThrow(message);
  });

  it("writes withdrawals only when allowed", () => {
    expect(toVenueRules(typed({ withdrawals: true }))?.withdrawals).toBe(true);
  });
});

describe("venue rules as policy lines", () => {
  it("has no lines without venue rules, so a policy reads as before venues", () => {
    expect(venueRuleRows(undefined)).toEqual([]);
  });

  it("names each market by coin and index, and says the caps are not loss caps", () => {
    const rows = Object.fromEntries(venueRuleRows(RULES).map((row) => [row.label, row.value]));
    expect(rows).toMatchObject({
      "Hyperliquid network": "Hyperliquid testnet",
      "Hyperliquid BTC (index 0): per order": "50 USD notional",
      "Hyperliquid ETH (index 1): per order": "12.5 USD notional",
      "Hyperliquid: per 24 hours": "100 USD notional, reduce-only orders not counted",
      "Hyperliquid time in force": "good till cancelled, immediate or cancel",
      "Hyperliquid submit window": "60 seconds after signing",
      "Hyperliquid withdrawals": "Not allowed",
      "Hyperliquid losses": VENUE_LOSS_BOUND,
    });
    expect(VENUE_LOSS_BOUND).toMatch(/not losses/);
    expect(VENUE_LOSS_BOUND).toMatch(/whole account value at Hyperliquid/);
  });
});

describe("an order in words", () => {
  it("names the market through the policy and computes the worst-case notional", () => {
    const facts = orderFacts(order(), policy({ hyperliquid: RULES }));
    expect(facts).toMatchObject({
      network: "hyperliquid:testnet",
      coin: "BTC",
      asset: 0,
      side: "buy",
      notionalUsd6: 650_000_000n,
      timeInForce: "Ioc",
      reduceOnly: false,
    });
    expect(orderTitle(facts)).toBe("Buy 0.01 BTC perpetual");
    expect(formatUsd6(facts.notionalUsd6)).toBe("650 USD");
  });

  it("has no coin when the policy does not list the index or names another network", () => {
    const unlisted = orderFacts(order({ asset: 7, isBuy: false }), policy({ hyperliquid: RULES }));
    expect(unlisted.coin).toBeNull();
    expect(orderTitle(unlisted)).toBe("Sell 0.01 of market 7, not in the wallet's policy");
    expect(orderFacts(order({}, "hyperliquid:mainnet"), policy({ hyperliquid: RULES })).coin).toBe(
      null,
    );
    expect(orderFacts(order(), policy(undefined)).coin).toBeNull();
  });

  it("says what the limit price means for each side", () => {
    expect(limitPriceText({ side: "buy", limitPrice: "65000" })).toBe(
      "65,000 USD, the most it pays",
    );
    expect(limitPriceText({ side: "sell", limitPrice: "1670.1" })).toBe(
      "1,670.1 USD, the least it takes",
    );
    expect(formatDecimal("1234567.0001")).toBe("1,234,567.0001");
  });
});

describe("an order against the venue caps", () => {
  const caps = {
    maxPerOrderUsd6: "50000000",
    maxNotionalPerDayUsd6: "100000000",
    spentTodayUsd6: "30000000",
  };

  it("adds an order to the 24 hours and measures it against its market's cap", () => {
    expect(orderCaps({ notionalUsd6: 20_000_000n, reduceOnly: false }, caps)).toEqual({
      perOrder: { used: 20_000_000n, cap: 50_000_000n },
      daily: { used: 50_000_000n, cap: 100_000_000n, counts: true },
    });
  });

  it("caps a reduce-only order per order but leaves the 24 hours as they are", () => {
    expect(orderCaps({ notionalUsd6: 20_000_000n, reduceOnly: true }, caps).daily).toEqual({
      used: 30_000_000n,
      cap: 100_000_000n,
      counts: false,
    });
  });

  it("has no per-order bar when the market is not in the policy", () => {
    const result = orderCaps(
      { notionalUsd6: 1n, reduceOnly: false },
      { ...caps, maxPerOrderUsd6: null },
    );

    expect(result.perOrder).toBeNull();
  });
});

describe("an order's status", () => {
  it.each(IntentStatus.options)("%s reads as a sentence, signed or not", (status) => {
    for (const signed of [false, true]) {
      expect(orderStatusSentence(status, signed)).toMatch(/^[A-Z].+\.$/);
    }
  });

  it("tells an approval that ran out from a submit window that passed", () => {
    expect(orderStatusSentence("expired", false)).toMatch(/Not enough people approved it/);
    expect(orderStatusSentence("expired", true)).toMatch(/within its submit window/);
  });

  it("tells a request withdrawn before deciding from an order cancelled at the venue", () => {
    expect(orderStatusSentence("cancelled", false)).toMatch(/before anyone decided/);
    expect(orderStatusSentence("cancelled", true)).toMatch(/cancelled at the venue/);
  });

  it("never speaks of a network for an order on its way", () => {
    expect(orderStatusSentence("signed", true)).toMatch(/sent to the venue/);
    expect(orderStatusSentence("placed", true)).toMatch(/order book/);
  });

  it("reads an order as an order and a payment as a payment", () => {
    const base = { mandateId: null, status: "cancelled" as const };

    const orderDisplay = {
      kind: "order" as const,
      title: "Buy 0.01 BTC at 65000",
      network: "hyperliquid:testnet" as const,
      coin: "BTC",
      asset: 0,
      side: "buy" as const,
      size: "0.01",
      limitPrice: "65000",
      notionalUsd: "650",
      timeInForce: "Gtc" as const,
      reduceOnly: false,
      cancellableByAgent: true as const,
    };

    const view = {
      cloid: "0x0123456789abcdef0123456789abcdef" as const,
      venueOrderId: 1,
      filledSize: "0",
      averagePrice: null,
      submitBy: 1_700_000_060,
      venueError: null,
      canCancel: false,
    };

    expect(intentSummarySentence({ ...base, display: orderDisplay, order: view })).toMatch(
      /cancelled at the venue/,
    );

    const transfer = {
      kind: "transfer" as const,
      title: "Send 0.015 ETH",
      assetSymbol: "ETH",
      assetDecimals: 18,
      amount: "15000000000000000",
      amountFormatted: "0.015",
      to: "0x52908400098527886e0f7030069857d2e4169ee7" as const,
      token: null,
      rawCall: false,
    };

    expect(intentSummarySentence({ ...base, display: transfer, order: null })).toMatch(
      /withdrawn before anyone decided/,
    );
  });
});

describe("what venue codes mean", () => {
  const generic = explainCode("no_such_code");

  it.each([
    ...POLICY_DENY_CODES,
    "market_metadata_mismatch",
    "invalid_tick",
    "venue_unreachable",
    "venue_refused",
    "venue_cancelled",
    "venue_not_configured",
  ])("%s has its own sentence", (code) => {
    expect(explainCode(code)).not.toBe(generic);
  });

  it("explains a refused cancel of an order", () => {
    const refused = new ApiError("conflict", "not posted", 409, "not_cancellable");
    expect(explainCancelOrderError(refused)).toMatch(/cannot be cancelled now/);
    const unreachable = new ApiError("internal", "down", 500, "venue_unreachable");
    expect(explainCancelOrderError(unreachable)).toMatch(/could not reach Hyperliquid/);
    expect(explainCancelOrderError(new Error("other"))).toBeNull();
  });
});
