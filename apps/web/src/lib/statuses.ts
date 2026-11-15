import type { IntentDetail, IntentStatus } from "@askgina/os-api";

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
