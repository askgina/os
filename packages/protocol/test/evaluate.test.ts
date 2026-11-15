import { describe, expect, it } from "vitest";
import {
  decimalToScaled,
  evaluateIntent,
  type HyperliquidOrderOperation,
  type HyperliquidRules,
  type Intent,
  intentSpend,
  type Network,
  orderNotionalUsd6,
  POLICY_DENY_CODES,
  type SpendAsset,
  type WalletPolicy,
} from "../src/index.ts";
import {
  ALICE,
  BASE,
  BOB,
  BTC_ASSET,
  HL_TESTNET,
  hyperliquidRules,
  intent,
  MAINNET,
  OTHER_AGENT,
  policy,
  ROUTER,
  TOKEN,
  venueIntent,
  WS,
} from "./fixtures.ts";

const ONE_ETH = 10n ** 18n;
const nothingSpent = () => 0n;

function decide(
  p: WalletPolicy,
  i: Intent,
  spent: (c: Network, a: SpendAsset) => bigint = nothingSpent,
) {
  const decision = evaluateIntent(p, i, spent);
  return decision.allowed ? "allowed" : decision.code;
}

const send = (valueWei: bigint, to: `0x${string}` = ALICE) =>
  intent({ operation: { type: "evm.transfer", to, valueWei: valueWei.toString() } });
const call = (valueWei: bigint, to: `0x${string}` = ROUTER) =>
  intent({
    operation: { type: "evm.call", to, valueWei: valueWei.toString(), data: "0xa9059cbb" },
  });
const tokenSend = (amount: bigint) =>
  intent({
    operation: { type: "evm.erc20.transfer", token: TOKEN, to: ALICE, amount: amount.toString() },
  });

const routerAllowed = policy({ contractCalls: { mode: "allowlist", targets: [ROUTER] } });

describe("evaluateIntent", () => {
  it("allows the fixture and reports what it spends", () => {
    expect(evaluateIntent(policy(), send(ONE_ETH), nothingSpent)).toEqual({
      allowed: true,
      spend: { chainId: BASE, asset: "native", amount: ONE_ETH },
    });
  });

  it("wallet_mismatch: another wallet or another workspace", () => {
    expect(decide(policy(), intent({ walletId: "wal_01jd000000000000000000000z" }))).toBe(
      "wallet_mismatch",
    );
    expect(decide(policy({ workspaceId: "ws_01jd000000000000000000000z" }), intent())).toBe(
      "wallet_mismatch",
    );
    expect(decide(policy(), intent({ workspaceId: WS }))).toBe("allowed");
  });

  it("requester_not_allowed", () => {
    expect(decide(policy(), intent({ agentId: OTHER_AGENT }))).toBe("requester_not_allowed");
  });

  it("chain_not_allowed", () => {
    expect(decide(policy(), intent({ chainId: MAINNET }))).toBe("chain_not_allowed");
  });

  it("over_fee_cap on both sides of the boundary", () => {
    const cap = BigInt(policy().fees.maxPerTxWei);
    expect(decide(policy(), intent({ maxFeeWei: cap.toString() }))).toBe("allowed");
    expect(decide(policy(), intent({ maxFeeWei: (cap + 1n).toString() }))).toBe("over_fee_cap");
  });

  it("recipient_not_allowed only under an allowlist, for coins and tokens alike", () => {
    const allowlist = policy({ recipients: { mode: "allowlist", addresses: [ALICE] } });
    expect(decide(allowlist, send(1n, ALICE))).toBe("allowed");
    expect(decide(allowlist, send(1n, BOB))).toBe("recipient_not_allowed");
    expect(decide(policy(), send(1n, BOB))).toBe("allowed");
    const tokenToBob = intent({
      operation: { type: "evm.erc20.transfer", token: TOKEN, to: BOB, amount: "1" },
    });
    expect(decide(allowlist, tokenToBob)).toBe("recipient_not_allowed");
  });

  it("the recipient allowlist does not admit contract calls", () => {
    const recipients = policy({ recipients: { mode: "allowlist", addresses: [ROUTER] } });
    expect(decide(recipients, call(0n))).toBe("contract_call_not_allowed");
  });

  it("contract_call_not_allowed when calls are denied or the target is not listed", () => {
    expect(decide(policy(), call(0n))).toBe("contract_call_not_allowed");
    expect(decide(routerAllowed, call(0n, BOB))).toBe("contract_call_not_allowed");
    expect(decide(routerAllowed, call(0n))).toBe("allowed");
  });

  it("a zero-value call needs no asset entry", () => {
    const noAssets = policy({
      assets: [],
      contractCalls: { mode: "allowlist", targets: [ROUTER] },
    });
    expect(evaluateIntent(noAssets, call(0n), nothingSpent)).toEqual({
      allowed: true,
      spend: { chainId: BASE, asset: "native", amount: 0n },
    });
  });

  it("a call that sends value counts against the native caps", () => {
    expect(decide(routerAllowed, call(ONE_ETH))).toBe("allowed");
    expect(decide(routerAllowed, call(ONE_ETH + 1n))).toBe("over_per_tx_cap");
    expect(
      decide(policy({ assets: [], contractCalls: routerAllowed.contractCalls }), call(1n)),
    ).toBe("asset_not_allowed");
    expect(decide(routerAllowed, call(1n), () => 5n * ONE_ETH)).toBe("over_daily_cap");
  });

  it("asset_not_allowed for an asset with no limit", () => {
    expect(decide(policy(), tokenSend(1n))).toBe("asset_not_allowed");
    expect(decide(policy({ assets: [] }), send(1n))).toBe("asset_not_allowed");
  });

  it("over_per_tx_cap on both sides of the boundary", () => {
    expect(decide(policy(), send(ONE_ETH))).toBe("allowed");
    expect(decide(policy(), send(ONE_ETH + 1n))).toBe("over_per_tx_cap");
  });

  it("over_daily_cap counts prior spend for that chain and asset only", () => {
    const day = 5n * ONE_ETH;
    const asked: string[] = [];
    const spent = (chainId: Network, asset: SpendAsset) => {
      asked.push(`${chainId}|${asset}`);
      return chainId === BASE && asset === "native" ? day - ONE_ETH : 999n * ONE_ETH;
    };
    expect(decide(policy(), send(ONE_ETH), spent)).toBe("allowed");
    expect(decide(policy(), send(ONE_ETH), () => day - ONE_ETH + 1n)).toBe("over_daily_cap");
    expect(asked).toEqual([`${BASE}|native`]);
  });

  it("token limits apply to the token, not the native coin", () => {
    const withToken = policy({
      assets: [
        { chainId: BASE, asset: "native", maxPerTx: "1", maxPerDay: "1" },
        { chainId: BASE, asset: TOKEN, maxPerTx: "100", maxPerDay: "150" },
      ],
    });
    expect(decide(withToken, tokenSend(100n))).toBe("allowed");
    expect(decide(withToken, tokenSend(101n))).toBe("over_per_tx_cap");
    expect(decide(withToken, tokenSend(100n), (_c, a) => (a === TOKEN ? 51n : 0n))).toBe(
      "over_daily_cap",
    );
    expect(decide(withToken, tokenSend(100n), (_c, a) => (a === TOKEN ? 50n : 0n))).toBe("allowed");
  });

  it("checks run in a fixed order, so the first failing rule names the code", () => {
    const everythingWrong = intent({
      agentId: OTHER_AGENT,
      chainId: MAINNET,
      maxFeeWei: "999999999999999999999",
    });
    expect(decide(policy(), everythingWrong)).toBe("requester_not_allowed");
  });

  it("every deny code is reachable by the cases above", () => {
    expect([...POLICY_DENY_CODES].sort()).toEqual(
      [
        "wallet_mismatch",
        "requester_not_allowed",
        "chain_not_allowed",
        "recipient_not_allowed",
        "contract_call_not_allowed",
        "asset_not_allowed",
        "over_per_tx_cap",
        "over_daily_cap",
        "over_fee_cap",
        "venue_not_allowed",
        "market_not_allowed",
        "order_type_not_allowed",
        "withdrawal_not_allowed",
      ].sort(),
    );
  });
});

const venuePolicy = (rules: Partial<HyperliquidRules> = {}) =>
  policy({ venues: { hyperliquid: hyperliquidRules(rules) } });
const order = (changes: Partial<HyperliquidOrderOperation> = {}) =>
  venueIntent({
    operation: {
      type: "hyperliquid.order",
      asset: BTC_ASSET,
      isBuy: true,
      size: "0.01",
      limitPx: "65000",
      tif: "Ioc",
      reduceOnly: false,
      ...changes,
    },
  });
const withdraw = (amount = "25") =>
  venueIntent({ operation: { type: "hyperliquid.withdraw", amount } });
/** 650 USD, the fixture order's notional, in micro-USD. */
const ORDER_NOTIONAL = 650_000_000n;
const btcCap = (cap: bigint) =>
  venuePolicy({
    markets: [{ asset: BTC_ASSET, coin: "BTC", maxNotionalPerOrderUsd6: cap.toString() }],
  });

describe("evaluateIntent with a venue intent", () => {
  it("allows the fixture order and reports its notional in usd6 on its venue network", () => {
    expect(evaluateIntent(venuePolicy(), order(), nothingSpent)).toEqual({
      allowed: true,
      spend: { chainId: HL_TESTNET, asset: "usd6", amount: ORDER_NOTIONAL },
    });
  });

  it("checks the wallet and the requester first, as for an EVM intent", () => {
    expect(decide(venuePolicy(), order(), nothingSpent)).toBe("allowed");
    expect(decide(venuePolicy({}), venueIntent({ agentId: OTHER_AGENT }))).toBe(
      "requester_not_allowed",
    );
    expect(decide(venuePolicy(), venueIntent({ walletId: "wal_01jd000000000000000000000z" }))).toBe(
      "wallet_mismatch",
    );
  });

  it("venue_not_allowed: no venue rules, or rules for the other network", () => {
    expect(decide(policy(), order())).toBe("venue_not_allowed");
    expect(decide(venuePolicy({ network: "hyperliquid:mainnet" }), order())).toBe(
      "venue_not_allowed",
    );
    expect(decide(policy(), withdraw())).toBe("venue_not_allowed");
  });

  it("the EVM chains, fee cap and asset caps do not apply to a venue intent", () => {
    const noEvm = policy({
      chains: [],
      assets: [],
      fees: { maxPerTxWei: "1" },
      venues: { hyperliquid: hyperliquidRules() },
    });
    expect(decide(noEvm, order())).toBe("allowed");
  });

  it("market_not_allowed for an asset index that is not one of the policy's markets", () => {
    expect(decide(venuePolicy(), order({ asset: 4, size: "0.001" }))).toBe("allowed");
    expect(decide(venuePolicy(), order({ asset: 5 }))).toBe("market_not_allowed");
  });

  it("order_type_not_allowed for a time in force the policy does not list", () => {
    expect(decide(venuePolicy(), order({ tif: "Gtc" }))).toBe("allowed");
    expect(decide(venuePolicy(), order({ tif: "Alo" }))).toBe("order_type_not_allowed");
    expect(decide(venuePolicy({ timeInForce: ["Ioc"] }), order({ tif: "Gtc" }))).toBe(
      "order_type_not_allowed",
    );
  });

  it("over_per_tx_cap on both sides of the market's per-order cap", () => {
    expect(decide(btcCap(ORDER_NOTIONAL), order())).toBe("allowed");
    expect(decide(btcCap(ORDER_NOTIONAL - 1n), order())).toBe("over_per_tx_cap");
  });

  it("over_daily_cap on both sides of the daily notional cap, in usd6 on that network only", () => {
    const day = 2_000_000_000n;
    const asked: string[] = [];
    const spent = (chainId: Network, asset: SpendAsset) => {
      asked.push(`${chainId}|${asset}`);
      return day - ORDER_NOTIONAL;
    };
    expect(decide(venuePolicy(), order(), spent)).toBe("allowed");
    expect(decide(venuePolicy(), order(), () => day - ORDER_NOTIONAL + 1n)).toBe("over_daily_cap");
    expect(asked).toEqual([`${HL_TESTNET}|usd6`]);
  });

  it("a reduce-only order passes with the daily cap spent and is still held to its per-order cap", () => {
    const allSpent = () => 2_000_000_000n;
    expect(decide(venuePolicy(), order(), allSpent)).toBe("over_daily_cap");
    expect(decide(venuePolicy(), order({ reduceOnly: true }), allSpent)).toBe("allowed");
    expect(decide(btcCap(ORDER_NOTIONAL - 1n), order({ reduceOnly: true }), allSpent)).toBe(
      "over_per_tx_cap",
    );
  });

  it("withdrawal_not_allowed unless the venue rules allow withdrawals", () => {
    expect(decide(venuePolicy(), withdraw())).toBe("allowed");
    expect(decide(venuePolicy({ withdrawals: false }), withdraw())).toBe("withdrawal_not_allowed");
  });

  it("checks run in a fixed order for a venue intent too", () => {
    const strict = venuePolicy({
      markets: [{ asset: BTC_ASSET, coin: "BTC", maxNotionalPerOrderUsd6: "1" }],
      timeInForce: ["Ioc"],
    });
    expect(decide(strict, order({ asset: 5, tif: "Gtc" }))).toBe("market_not_allowed");
    expect(decide(strict, order({ tif: "Gtc" }), () => 10n ** 12n)).toBe("order_type_not_allowed");
    expect(decide(strict, order(), () => 10n ** 12n)).toBe("over_per_tx_cap");
  });
});

describe("intentSpend", () => {
  it("names the asset each operation moves, excluding fees", () => {
    expect(intentSpend(send(7n))).toEqual({ asset: "native", amount: 7n, daily: true });
    expect(intentSpend(tokenSend(9n))).toEqual({ asset: TOKEN, amount: 9n, daily: true });
    expect(intentSpend(call(3n))).toEqual({ asset: "native", amount: 3n, daily: true });
  });

  it("counts an order's notional in usd6, against the daily cap unless it is reduce-only", () => {
    expect(intentSpend(order())).toEqual({ asset: "usd6", amount: ORDER_NOTIONAL, daily: true });
    expect(intentSpend(order({ reduceOnly: true }))).toEqual({
      asset: "usd6",
      amount: ORDER_NOTIONAL,
      daily: false,
    });
    expect(intentSpend(withdraw())).toEqual({ asset: "usd6", amount: 0n, daily: false });
  });
});

describe("orderNotionalUsd6", () => {
  it("is ceil(size × limitPx × 10^6), exactly", () => {
    expect(orderNotionalUsd6("0.01", "65000")).toBe(650_000_000n);
    expect(orderNotionalUsd6("0.0147", "1670.1")).toBe(24_550_470n);
    // 0.00000001 × 0.00000001 = 10^-16 USD rounds up to one micro-USD.
    expect(orderNotionalUsd6("0.00000001", "0.00000001")).toBe(1n);
    expect(orderNotionalUsd6("0.00000003", "0.33333333")).toBe(1n);
    expect(orderNotionalUsd6("3", "0.3333333")).toBe(1_000_000n);
    expect(orderNotionalUsd6("99999999999999999999", "99999999999999999999")).toBe(
      99_999_999_999_999_999_999n * 99_999_999_999_999_999_999n * 1_000_000n,
    );
  });
});

describe("decimalToScaled", () => {
  it("scales exactly and refuses what it cannot represent", () => {
    expect(decimalToScaled("1.25", 2)).toBe(125n);
    expect(decimalToScaled("100", 0)).toBe(100n);
    expect(decimalToScaled("0.00000001", 8)).toBe(1n);
    expect(() => decimalToScaled("1.25", 1)).toThrow(RangeError);
    expect(() => decimalToScaled("1.0", 2)).toThrow(TypeError);
    expect(() => decimalToScaled("1e3", 2)).toThrow(TypeError);
  });
});
