import { type Intent, intentSpend } from "./intent.ts";
import { assetLimitKey, type WalletPolicy } from "./policy.ts";
import type { AssetRef, ChainId } from "./primitives.ts";

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
] as const;
export type PolicyDenyCode = (typeof POLICY_DENY_CODES)[number];

export type PolicyDecision =
  | { allowed: true; spend: { chainId: ChainId; asset: AssetRef; amount: bigint } }
  | { allowed: false; code: PolicyDenyCode };

/** What the wallet has already signed for one asset on one chain in the last 24 hours. */
export type SpentLookup = (chainId: ChainId, asset: AssetRef) => bigint;

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
  if (!policy.chains.includes(intent.chainId)) {
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
