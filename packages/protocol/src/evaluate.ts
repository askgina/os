import {
  type EvmIntent,
  type Intent,
  intentSpend,
  isVenueIntent,
  type VenueIntent,
} from "./intent.ts";
import { assetLimitKey, type WalletPolicy } from "./policy.ts";
import { isVenueNetwork, type Network, type SpendAsset } from "./venues.ts";

export const POLICY_DENY_CODES = [
  "wallet_mismatch",
  "requester_not_allowed",
  "chain_not_allowed",
  "recipient_not_allowed",
  "contract_call_not_allowed",
  "asset_not_allowed",
  "over_per_tx_cap",
  "over_daily_cap",
  "over_fee_cap",
  /** The policy has no rules for the intent's venue network. */
  "venue_not_allowed",
  /** The order's asset index is not one of the policy's markets. */
  "market_not_allowed",
  /** The order's time in force is not one the policy allows. */
  "order_type_not_allowed",
  /** The policy's venue rules do not allow withdrawals. */
  "withdrawal_not_allowed",
] as const;
export type PolicyDenyCode = (typeof POLICY_DENY_CODES)[number];

export type PolicyDecision =
  | { allowed: true; spend: { chainId: Network; asset: SpendAsset; amount: bigint } }
  | { allowed: false; code: PolicyDenyCode };

/**
 * What the wallet has already signed for one asset on one chain, or in `usd6` on one venue
 * network, in the last 24 hours.
 */
export type SpentLookup = (chainId: Network, asset: SpendAsset) => bigint;

/**
 * Decide whether a policy allows an intent. Pure and deterministic: the signer runs it with its
 * own ledger as `spent` and its answer is final; the control plane runs the same function only to
 * tell an agent early that a proposal cannot pass.
 */
export function evaluateIntent(
  policy: WalletPolicy,
  intent: Intent,
  spent: SpentLookup,
): PolicyDecision {
  if (policy.walletId !== intent.walletId || policy.workspaceId !== intent.workspaceId) {
    return { allowed: false, code: "wallet_mismatch" };
  }
  if (!policy.requesters.includes(intent.agentId)) {
    return { allowed: false, code: "requester_not_allowed" };
  }
  return isVenueIntent(intent)
    ? evaluateVenueIntent(policy, intent, spent)
    : evaluateEvmIntent(policy, intent, spent);
}

function evaluateEvmIntent(
  policy: WalletPolicy,
  intent: EvmIntent,
  spent: SpentLookup,
): PolicyDecision {
  // The schema keeps venue networks out of an EVM intent; refused here as well, never trusted.
  if (isVenueNetwork(intent.chainId) || !policy.chains.includes(intent.chainId)) {
    return { allowed: false, code: "chain_not_allowed" };
  }
  if (BigInt(intent.maxFeeWei) > BigInt(policy.fees.maxPerTxWei)) {
    return { allowed: false, code: "over_fee_cap" };
  }

  const { operation } = intent;
  if (operation.type === "evm.call") {
    const rule = policy.contractCalls;
    if (rule.mode !== "allowlist" || !rule.targets.includes(operation.to)) {
      return { allowed: false, code: "contract_call_not_allowed" };
    }
  } else {
    const rule = policy.recipients;
    if (rule.mode === "allowlist" && !rule.addresses.includes(operation.to)) {
      return { allowed: false, code: "recipient_not_allowed" };
    }
  }

  const { asset, amount } = intentSpend(intent);
  const spend = { chainId: intent.chainId, asset, amount };
  // A contract call that sends no native coin moves nothing the caps can measure.
  if (amount === 0n) {
    return { allowed: true, spend };
  }
  const key = assetLimitKey({ chainId: intent.chainId, asset });
  const limit = policy.assets.find((candidate) => assetLimitKey(candidate) === key);
  if (limit === undefined) {
    return { allowed: false, code: "asset_not_allowed" };
  }
  if (amount > BigInt(limit.maxPerTx)) {
    return { allowed: false, code: "over_per_tx_cap" };
  }
  if (spent(intent.chainId, asset) + amount > BigInt(limit.maxPerDay)) {
    return { allowed: false, code: "over_daily_cap" };
  }
  return { allowed: true, spend };
}

// `policy.chains`, `policy.fees` and the per-asset caps do not apply to a venue intent: it pays
// no gas and moves nothing on an EVM chain. Its caps are the venue rules' notional caps.
function evaluateVenueIntent(
  policy: WalletPolicy,
  intent: VenueIntent,
  spent: SpentLookup,
): PolicyDecision {
  const rules = policy.venues?.hyperliquid;
  if (rules === undefined || rules.network !== intent.chainId) {
    return { allowed: false, code: "venue_not_allowed" };
  }
  const { asset, amount, daily } = intentSpend(intent);
  const spend = { chainId: intent.chainId, asset, amount };
  const { operation } = intent;
  switch (operation.type) {
    case "hyperliquid.order": {
      const market = rules.markets.find((candidate) => candidate.asset === operation.asset);
      if (market === undefined) {
        return { allowed: false, code: "market_not_allowed" };
      }
      if (!rules.timeInForce.includes(operation.tif)) {
        return { allowed: false, code: "order_type_not_allowed" };
      }
      if (amount > BigInt(market.maxNotionalPerOrderUsd6)) {
        return { allowed: false, code: "over_per_tx_cap" };
      }
      // A reduce-only order counts against its market's per-order cap only, so a position can
      // still be closed when the daily cap is spent.
      if (daily && spent(intent.chainId, asset) + amount > BigInt(rules.maxNotionalPerDayUsd6)) {
        return { allowed: false, code: "over_daily_cap" };
      }
      return { allowed: true, spend };
    }
    case "hyperliquid.withdraw":
      if (!rules.withdrawals) {
        return { allowed: false, code: "withdrawal_not_allowed" };
      }
      return { allowed: true, spend };
  }
}
