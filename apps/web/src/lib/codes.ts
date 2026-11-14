/**
 * Plain-language meanings for the failure codes the signer, the wallet policy and the chain
 * report. An unknown code is shown as it is, with a generic sentence, never hidden.
 */
const meanings: Record<string, string> = {
  workspace_paused: "The workspace is paused, so the signer signs nothing until it is resumed.",
  approval_revoked: "This approval was withdrawn before the signer acted on it.",
  envelope_mismatch: "What was approved does not match what was sent to the signer, so it refused.",
  envelope_expired: "The approval ran out of time before the signer acted on it.",
  envelope_not_yet_valid: "The approval was dated in the future; the clocks may disagree.",
  envelope_ttl_too_long: "The approval was valid for longer than the wallet allows.",
  envelope_fenced:
    "The signer was restored from a backup after this was requested, so it refuses every older request. Ask for it again.",
  nonce_reused: "This approval was already used once. An approval signs only once.",
  intent_mismatch: "The transaction did not match the approved request, so the signer refused.",
  policy_missing: "The wallet has no limits set yet, so it can sign nothing.",
  policy_changed:
    "The wallet's limits changed after this was requested. Ask the agent to try again.",
  policy_denied: "The wallet's limits do not allow this.",
  policy_invalid: "The proposed limits are not valid.",
  fee_cap_exceeded: "The network fee would be higher than the approved ceiling.",
  insufficient_approvals: "Not enough people approved.",
  assertion_invalid: "A passkey approval could not be verified.",
  approver_unknown: "A passkey that approved is not one the signer knows for this workspace.",
  threshold_unreachable: "There would be fewer approvers than approvals required.",
  sweep_destination_not_allowed:
    "A sweep may only go to the workspace's treasury or to a recipient the wallet's limits allow.",
  vault_error: "The signer could not use the wallet's key.",
  wallet_mismatch: "The request names a different wallet.",
  requester_not_allowed: "This agent is not allowed to use this wallet.",
  chain_not_allowed: "The wallet may not act on this network.",
  recipient_not_allowed: "The recipient is not on the wallet's list of allowed recipients.",
  contract_call_not_allowed: "The wallet may not call this contract.",
  asset_not_allowed: "The wallet has no limit for this asset, so it may not send it.",
  over_per_tx_cap: "The amount is more than the wallet's limit per transaction.",
  over_daily_cap: "This would take the wallet over its limit for the last 24 hours.",
  over_fee_cap: "The fee ceiling is higher than the wallet allows.",
  reverted: "The transaction was mined but the contract refused it. Fees were still paid.",
  rejected: "The network never accepted the transaction, and it will not be sent again.",
  internal: "Something went wrong on the server.",
};

export function explainCode(code: string): string {
  return meanings[code] ?? "The request could not be completed.";
}
