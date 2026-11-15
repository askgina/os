import { ApiError, type StuckReason } from "@askgina/os-api";
import type { MandateDenyCode, MandateGrantRefusal } from "@askgina/os-protocol";
import { PushSetupError, type PushSetupFailure } from "./push.ts";
import { stuckReasonSentence } from "./statuses.ts";

/**
 * Why an approval in advance (a mandate) did not cover a payment: the signer's `mandate_denied`
 * detail, which a payment an agent proposed under it carries as its failure code. Typed as a
 * complete record, so a new code in the protocol fails the type check here.
 */
const mandateDenials: Record<MandateDenyCode, string> = {
  mandate_wallet_mismatch: "The approval in advance is for a different wallet.",
  mandate_agent_mismatch: "The approval in advance is for a different agent.",
  mandate_operation_not_allowed:
    "An approval in advance covers only plain transfers, never a contract call.",
  mandate_asset_not_allowed: "The approval in advance does not cover this asset.",
  mandate_recipient_not_allowed: "The recipient is not one the approval in advance lists.",
  mandate_over_fee_cap:
    "The network fee ceiling is higher than the approval in advance allows per payment.",
  mandate_uses_exhausted: "The approval in advance has no payments left.",
  mandate_over_per_action_cap:
    "The amount is more than the approval in advance allows per payment.",
  mandate_over_window_cap:
    "This would take the payments under the approval in advance over its limit for the window.",
  mandate_over_total_cap:
    "This would take the payments under the approval in advance over its total limit.",
  mandate_grant_below_threshold:
    "Fewer of the people who approved it in advance still approve than an admin change now needs, so the signer no longer uses it.",
};

/**
 * Why the signer, or the server first, refuses to grant an approval in advance: the `detail` of
 * a refused draft (`invalid_request`) and the failure code of a grant request the signer turned
 * down. The policy codes mean something else for a mandate than for one payment, so they have
 * their own sentences here.
 */
const mandateRefusals: Record<MandateGrantRefusal | "agent_disabled", string> = {
  wallet_mismatch: "The approval in advance names a different wallet.",
  requester_not_allowed:
    "The wallet's limits do not let this agent use the wallet. Add the agent to its limits first.",
  chain_not_allowed: "The wallet's limits do not allow one of these networks.",
  asset_not_allowed:
    "The wallet's limits have no cap for one of these assets, so it may not leave the wallet.",
  over_per_tx_cap: "The most per payment is more than the wallet's limit per transaction.",
  over_daily_cap: "The most in the window is more than the wallet's limit for 24 hours.",
  recipient_not_allowed: "A recipient is not on the wallet's list of allowed recipients.",
  over_fee_cap: "The network fee per payment is more than the wallet's fee ceiling.",
  already_expired: "Its end time had already passed.",
  lifetime_too_long:
    "It would last longer than the signer allows (7 days unless the operator chose otherwise). Choose an earlier end.",
  too_many_live_mandates:
    "This wallet already has as many live approvals in advance as the signer allows. Revoke one first.",
  agent_disabled: "The agent was removed, so it cannot be approved in advance.",
};

/**
 * Why the server refused to speed up a payment (`speedUp`): the `conflict` refusal's `detail`,
 * which is `not_repriceable` or the reason the transaction cannot be repriced, and the
 * `internal` refusal's `retry_later`. A fee that is too low is what a speed-up cures, so it is
 * never a refusal.
 */
const speedUpRefusals: Record<
  Exclude<StuckReason, "fee_too_low"> | "not_repriceable" | "retry_later",
  string
> = {
  not_repriceable:
    "Only a payment that was sent and is not mined yet can be sped up. This one was not sent yet, is already final, or another transaction took its place in line.",
  waiting_behind_nonce: stuckReasonSentence.waiting_behind_nonce,
  workspace_paused:
    "The workspace is paused, so no fee is raised until it is resumed. Cancelling still works.",
  fee_ceiling_reached: stuckReasonSentence.fee_ceiling_reached,
  reprice_window_closed: stuckReasonSentence.reprice_window_closed,
  attempts_exhausted: stuckReasonSentence.attempts_exhausted,
  reprice_refused: stuckReasonSentence.reprice_refused,
  retry_later:
    "The network or the signer could not be reached, so nothing was sent. Try again in a moment.",
};

/**
 * Why the server refused to open a request to cancel a payment or a sweep (`requestCancel`,
 * `requestSweepCancel`): the refusal's `detail`. The same words explain a cancel request that
 * was approved but could not be signed (its failure code).
 */
const cancelRefusals: Record<
  | "not_sent"
  | "transaction_final"
  | "attempts_exhausted"
  | "fee_ceiling_reached"
  | "policy_missing",
  string
> = {
  not_sent: "Nothing was sent to the network yet, so there is nothing to cancel.",
  transaction_final:
    "The transaction was already mined or replaced, so there was nothing left to cancel.",
  attempts_exhausted:
    "The signer has signed this transaction as many times as it allows, so it cannot sign a cancel. The network may still include it.",
  fee_ceiling_reached:
    "The wallet's fee ceiling per transaction is not enough to outbid the newest attempt, so a cancel could never be included first.",
  policy_missing: "This wallet has no limits set, so no cancel can be approved for it.",
};

/**
 * Why the server refused to open a request to retire a wallet or delete the workspace: the
 * refusal's `detail`.
 */
const lifecycleRefusals: Record<"destroy_delay_out_of_range", string> = {
  destroy_delay_out_of_range:
    "The signer does not allow a delay that short or that long before keys are destroyed. Pick another.",
};

/**
 * Plain-language meanings for the failure codes the signer, the wallet policy and the chain
 * report. An unknown code is shown as it is, with a generic sentence, never hidden.
 */
const meanings: Record<string, string> = {
  ...mandateDenials,
  mandate_revoked: "The approval in advance was revoked, so the signer signed nothing under it.",
  mandate_expired: "The approval in advance had ended, so the signer signed nothing under it.",
  mandate_not_yet_valid: "The approval in advance had not started yet.",
  mandate_denied: "The approval in advance does not cover this payment.",
  mandate_invalid: "The signer refused to grant this approval in advance.",
  too_many_live_mandates: mandateRefusals.too_many_live_mandates,
  agent_disabled: "The agent was removed.",
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
  possession_unproven:
    "The person being added has not yet proven on the signer's page that the new passkey is theirs. They have to open the request's link and press \"This passkey is mine\" before anyone can approve it.",
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
  transaction_cancelled:
    "A cancel people approved was included in its place. Nothing moved; the network fee was paid.",
  cancel_too_late:
    "A cancel was signed, but the network included the payment first, so it went through as sent.",
  nonce_used_elsewhere:
    "Another transaction from this wallet took its place in line, so it can never be included. Nothing moved.",
  workspace_deleting:
    "The workspace is being deleted, so the signer signs nothing for it except cancelling a stuck transaction. Cancel the deletion first.",
  workspace_deleted:
    "The workspace was deleted and its keys destroyed, so the signer signs nothing.",
  wallet_retired:
    "The wallet is retired: the signer signs nothing for it, and its key is destroyed or soon will be.",
  wallet_set_mismatch:
    "The request does not name exactly the workspace's wallets as the signer holds them; one was added or its key destroyed since. Ask again.",
  destroy_delay_out_of_range: lifecycleRefusals.destroy_delay_out_of_range,
  destroy_not_due: "It is not yet time to destroy the keys.",
  not_sent: cancelRefusals.not_sent,
  transaction_final: cancelRefusals.transaction_final,
  attempts_exhausted: cancelRefusals.attempts_exhausted,
  fee_ceiling_reached: cancelRefusals.fee_ceiling_reached,
  internal: "Something went wrong on the server.",
};

/**
 * Why the server refused this browser as a device (`addPushSubscription`): the refusal's
 * `detail`.
 */
const pushRefusals: Record<"push_off" | "endpoint_refused" | "bad_subscription", string> = {
  push_off:
    "This server does not send notifications to devices: its operator has turned Web Push off.",
  endpoint_refused:
    "This server does not send to your browser's push service; its operator allows only some. Try another browser, or ask the operator.",
  bad_subscription:
    "Your browser gave a subscription the server cannot use. Turn notifications on again; if that fails too, try another browser.",
};

/** Why this browser could not be set up for notifications, before the server was asked. */
const pushSetupFailures: Record<PushSetupFailure, string> = {
  permission_denied:
    "Notifications are blocked for this site. Allow them in your browser's settings for this site, then try again.",
  permission_dismissed:
    "Your browser did not allow notifications. Press the button again and choose Allow.",
  worker_failed:
    "Your browser could not install this site's notification handler (its service worker). Reload the page and try again.",
  subscribe_failed:
    "Your browser could not reach its push service. Check the connection and try again.",
};

/**
 * Plain words for a failed change to notifications, in the browser or refused by the server;
 * null when the failure is not one of these (the API's own message then says what happened).
 */
export function explainNotificationError(error: unknown): string | null {
  if (error instanceof PushSetupError) return pushSetupFailures[error.failure];
  if (!(error instanceof ApiError)) return null;
  if (error.detail !== undefined && Object.hasOwn(pushRefusals, error.detail)) {
    return pushRefusals[error.detail as keyof typeof pushRefusals];
  }
  if (error.code === "forbidden") {
    return "Only an owner of this workspace can change what its notifications say.";
  }
  if (error.code === "not_found") {
    return "You are no longer a member of one of these workspaces. Reload the page.";
  }
  if (error.code === "conflict") {
    return "Someone else just turned on notifications in this browser. Try again.";
  }
  return null;
}

/** The words for a refusal's `detail` from one of the records above, or null for another. */
function refusalDetail(error: unknown, words: Record<string, string>): string | null {
  if (!(error instanceof ApiError) || error.detail === undefined) return null;
  return Object.hasOwn(words, error.detail) ? (words[error.detail] as string) : null;
}

/** Plain words for a refused speed-up; null leaves it to the API's own message. */
export function explainSpeedUpError(error: unknown): string | null {
  return refusalDetail(error, speedUpRefusals);
}

/** Plain words for a refused request to cancel; null leaves it to the API's own message. */
export function explainCancelError(error: unknown): string | null {
  return refusalDetail(error, cancelRefusals);
}

/** Plain words for a refused retirement or deletion; null leaves it to the API's own message. */
export function explainLifecycleError(error: unknown): string | null {
  return refusalDetail(error, lifecycleRefusals);
}

export function explainCode(code: string): string {
  return Object.hasOwn(meanings, code)
    ? (meanings[code] as string)
    : "The request could not be completed.";
}

/**
 * The meaning of a refusal to grant an approval in advance: a refused draft's detail or a grant
 * request's failure code. Codes that are not about the mandate itself (a paused workspace, an
 * expired request) keep their usual meaning.
 */
export function explainMandateRefusal(code: string): string {
  return Object.hasOwn(mandateRefusals, code)
    ? mandateRefusals[code as keyof typeof mandateRefusals]
    : explainCode(code);
}
