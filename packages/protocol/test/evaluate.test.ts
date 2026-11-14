import { describe, expect, it } from "vitest";
import {
  type AssetRef,
  type ChainId,
  evaluateIntent,
  type Intent,
  intentSpend,
  POLICY_DENY_CODES,
  type WalletPolicy,
} from "../src/index.ts";
import {
  ALICE,
  BASE,
  BOB,
  intent,
  MAINNET,
  OTHER_AGENT,
  policy,
  ROUTER,
  TOKEN,
  WS,
} from "./fixtures.ts";

const ONE_ETH = 10n ** 18n;
const nothingSpent = () => 0n;

function decide(
  p: WalletPolicy,
  i: Intent,
  spent: (c: ChainId, a: AssetRef) => bigint = nothingSpent,
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
    const spent = (chainId: ChainId, asset: AssetRef) => {
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
      ].sort(),
    );
  });
});

describe("intentSpend", () => {
  it("names the asset each operation moves, excluding fees", () => {
    expect(intentSpend(send(7n))).toEqual({ asset: "native", amount: 7n });
    expect(intentSpend(tokenSend(9n))).toEqual({ asset: TOKEN, amount: 9n });
    expect(intentSpend(call(3n))).toEqual({ asset: "native", amount: 3n });
  });
});
