import type {
  Role,
  TransactionAttemptView,
  TransactionInfo,
  TransferDisplay,
} from "@askgina/os-api";
import { formatUnits, shortAddress } from "./format.ts";

/** A payment in one line, as its request's page heads it: "Send 0.015 ETH to 0x5290…". */
export function paymentTitle(
  display: Pick<TransferDisplay, "rawCall" | "amount" | "amountFormatted" | "assetSymbol" | "to">,
): string {
  const amount = `${display.amountFormatted} ${display.assetSymbol}`;

  return display.rawCall
    ? `Call contract ${shortAddress(display.to)}${display.amount === "0" ? "" : ` with ${amount}`}`
    : `Send ${amount} to ${shortAddress(display.to)}`;
}

/** Wei per gas in gwei, the unit wallets show it in: "2240000000" → "2.24 gwei". */
export function formatGwei(wei: string): string {
  return `${formatUnits(wei, 9)} gwei`;
}

/** The most an attempt can cost in network fees, in wei: its gas limit at its highest fee per gas. */
export function attemptFeeCeiling(
  attempt: Pick<TransactionAttemptView, "gas" | "maxFeePerGas">,
): bigint {
  return BigInt(attempt.gas) * BigInt(attempt.maxFeePerGas);
}

/** What each attempt is, in words. Typed as a complete record, so a new kind fails the type check. */
export const attemptKindLabel: Record<TransactionAttemptView["kind"], string> = {
  original: "First signature",
  reprice: "Same payment, higher fee",
  cancel: "Cancel: nothing sent to itself",
};

/** Where each attempt stands with the network. */
export const attemptStatusLabel: Record<TransactionAttemptView["status"], string> = {
  pending: "Waiting",
  mined: "Mined",
  not_mined: "Never mined",
};

/**
 * What the signed-in person may do with a sent transaction now. The transaction says what is
 * possible (`canSpeedUp`, `canCancel`); only owners and approvers may do it. A viewer reads the
 * attempts and the state, with no action.
 */
export function transactionActions(
  transaction: Pick<TransactionInfo, "canSpeedUp" | "canCancel">,
  role: Role,
) {
  const acts = role !== "viewer";

  return { speedUp: acts && transaction.canSpeedUp, cancel: acts && transaction.canCancel };
}

/** Whether the chain may still change a transaction, so a page showing it keeps reading it. */
export function transactionOpen(status: TransactionInfo["status"]): boolean {
  return status === "signed" || status === "broadcast" || status === "stuck";
}
