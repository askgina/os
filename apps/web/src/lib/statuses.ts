import type { IntentDetail, IntentStatus, IntentSummary, StuckReason } from "@askgina/os-api";

export type TransactionStatus = NonNullable<IntentDetail["transaction"]>["status"];

/**
 * One plain sentence for every state a payment can be in. Typed as a complete record, so a new
 * status in the contract fails the type check here instead of showing a person a blank or a code.
 */
export const intentSentence: Record<IntentStatus, string> = {
  proposed: "The agent asked for this; the server is checking it against the wallet's limits.",
  pending_approval: "Waiting for people to approve it with their passkeys.",
  approved: "Enough people approved it. The signer is signing it next.",
  signed: "The signer signed it. It is about to be sent to the network.",
  broadcast: "Sent to the network and waiting to be included in a block.",
  submitted: "Signed and sent to the venue; waiting for its answer.",
  placed: "Resting on the venue's order book until it fills or is cancelled.",
  filled: "The venue filled the whole order.",
  partially_filled: "The venue filled part of the order. The rest will not fill.",
  confirmed: "Included in a block. The payment went through.",
  reverted:
    "Included in a block, but the contract refused it. Nothing moved, but the network fee was paid.",
  stuck:
    "Signed and sent, but not included in a block yet. It may still be included later. Later payments from this wallet on this network wait behind it.",
  rejected: "Someone rejected it. Nothing was signed.",
  expired: "Not enough people approved it in time. Nothing was signed.",
  cancelled: "It was withdrawn before anyone decided. Nothing was signed.",
  denied: "The wallet's limits or the signer refused it. Nothing was signed.",
  failed: "It did not go through, and nothing more will be sent for it.",
  voided:
    "A person cancelled it after it was sent. A zero-value transaction took its place. Nothing moved; a network fee was paid.",
};

/**
 * The sentence for a payment an approval in advance (a mandate) covered: nobody was asked, so the
 * states that speak of people say what happened instead.
 */
export function intentStatusSentence(status: IntentStatus, mandated: boolean): string {
  if (!mandated) return intentSentence[status];

  if (status === "approved") {
    return "An approval in advance covers it, so nobody was asked. The signer is signing it next.";
  }

  if (status === "denied") {
    return "The approval in advance or the wallet's limits did not cover it at the signer. Nothing was signed.";
  }

  return intentSentence[status];
}

/**
 * The sentence for an order at a venue. An order can end `expired` or `cancelled` after it was
 * signed (its submit window passed, or it was cancelled at the venue), and `failed` at the venue,
 * so those say what that means once `signed` (the order's venue record exists only once the
 * signer signed it); before, an order reads like any request.
 */
export function orderStatusSentence(status: IntentStatus, signed: boolean): string {
  if (status === "approved") return "Enough people approved it. The signer is signing it next.";

  if (status === "signed") return "The signer signed it. It is about to be sent to the venue.";

  if (!signed) return intentSentence[status];

  switch (status) {
    case "expired":
      return "It did not reach the venue within its submit window, so the venue refuses it for good. Nothing was traded.";
    case "cancelled":
      return "It was cancelled at the venue before any of it filled.";
    case "failed":
      return "The venue did not take it, and it will not be sent again.";
    default:
      return intentSentence[status];
  }
}

/**
 * The sentence for any intent, as a list or a page shows it: an order's, a payment's, or that of
 * a payment an approval in advance covered.
 */
export function intentSummarySentence(
  intent: Pick<IntentSummary, "status" | "mandateId" | "display" | "order">,
): string {
  return intent.display.kind === "order"
    ? orderStatusSentence(intent.status, intent.order !== null)
    : intentStatusSentence(intent.status, intent.mandateId !== null);
}

export const transactionSentence: Record<TransactionStatus, string> = {
  signed: "Signed and about to be sent to the network.",
  broadcast: "Sent to the network and waiting to be included in a block.",
  confirmed: "Included in a block.",
  reverted: "Included in a block, but the contract refused it. The network fee was still paid.",
  stuck:
    "Signed and sent, but not included in a block yet. It may still be included later. Later payments from this wallet on this network wait behind it.",
  rejected: "The network never accepted it, and it will not be sent again. Nothing moved.",
  cancelled:
    "A zero-value transaction from the wallet to itself was included in its place. Nothing moved; the network fee was paid.",
  superseded:
    "Another transaction from this wallet took its place in line, so it can never be included. Nothing moved.",
};

/**
 * Why a sent transaction is not mined yet, in words, as the control plane last found it. Says
 * what a person can still do about it: a higher fee helps only when the fee is the reason.
 */
export const stuckReasonSentence: Record<StuckReason, string> = {
  fee_too_low:
    "Its network fee is too low for the network right now. Speeding it up offers a higher one, within the fee ceiling people approved.",
  waiting_behind_nonce:
    "An earlier transaction from this wallet on this network is not mined yet, and this one waits behind it. A higher fee here would not help.",
  workspace_paused: "The workspace is paused, so its fee is not raised. It can still be cancelled.",
  fee_ceiling_reached:
    "A higher fee would pass the fee ceiling people approved, so it is not raised again. It can still be cancelled.",
  reprice_window_closed:
    "The signer raises a fee only for a limited time after the first signature, and that time has passed. It can still be cancelled.",
  attempts_exhausted:
    "The signer has signed it as many times as it allows, so it can be neither sped up nor cancelled. The network may still include it.",
  reprice_refused:
    "The signer refuses to raise its fee, for example because the approval in advance it was signed under was revoked. It can still be cancelled.",
};
