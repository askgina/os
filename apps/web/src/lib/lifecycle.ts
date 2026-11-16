import type {
  ApprovalDetail,
  ApprovalSummary,
  AssetBalance,
  DeletionBlocker,
  DeletionPreflight,
  WalletLifecycle,
} from "@askgina/os-api";
import { formatTimeLeft } from "./mandate.ts";

/**
 * Retiring a wallet and deleting a workspace: both destroy keys after a delay the signer
 * enforces, during which people can cancel. The signer cannot see balances, so whatever the
 * server reads of them is advice, never a check.
 */

const DAY = 86_400;

/** The signer's shortest delay by default (`SIGNER_MIN_DESTROY_DELAY_SECONDS`, 7 days). */
export const DEFAULT_MIN_DESTROY_DELAY_SECONDS = 7 * DAY;

/**
 * Added to the chosen delay when the request is made. The signer counts the delay from the moment
 * the server opens the request, a little after this page worked out `destroyAfter`, so asking for
 * exactly the shortest delay would be refused as too short.
 */
export const DESTROY_AFTER_MARGIN_SECONDS = 300;

/** The delays offered, shortest first: the signer's shortest (the default), 14 and 30 days. */
export function delayChoices(minDelaySeconds: number): number[] {
  return [...new Set([minDelaySeconds, 14 * DAY, 30 * DAY])]
    .filter((seconds) => seconds >= minDelaySeconds)
    .sort((a, b) => a - b);
}

/** "7 days", "1 day", "36 hours", "90 minutes": a delay a person picks. */
export function formatDelay(seconds: number): string {
  if (seconds % DAY === 0) return seconds === DAY ? "1 day" : `${seconds / DAY} days`;

  if (seconds % 3_600 === 0) return seconds === 3_600 ? "1 hour" : `${seconds / 3_600} hours`;

  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * How far the server's clock is ahead of this browser's, from a preflight read at `clientNow`:
 * the server reports its earliest `destroyAfter`, which is its own now plus the shortest delay.
 */
export function serverClockOffset(
  preflight: Pick<DeletionPreflight, "earliestDestroyAfter" | "minDestroyDelaySeconds">,
  clientNow: number,
): number {
  return preflight.earliestDestroyAfter - preflight.minDestroyDelaySeconds - clientNow;
}

/** The `destroyAfter` to ask for: `delaySeconds` from now on the server's clock, plus the margin. */
export function destroyAfterFor(delaySeconds: number, clientNow: number, offset: number): number {
  return clientNow + offset + delaySeconds + DESTROY_AFTER_MARGIN_SECONDS;
}

/** "6 days 23 h left", or that the time has come and the server finishes it soon. */
export function destroyCountdown(destroyAfter: number, now: number): string {
  return destroyAfter > now
    ? `${formatTimeLeft(destroyAfter - now)} left to cancel`
    : "Due now: it finishes once nothing is left waiting";
}

/** The balances that are not zero: what would be lost with the key. */
export function heldBalances(balances: readonly AssetBalance[]): AssetBalance[] {
  return balances.filter((balance) => balance.amount !== "0");
}

/** Why deleting now would lose something or wait, in words, as the server reports it. */
export const blockerText: Record<DeletionBlocker, string> = {
  pending_approvals: "Requests still wait for approval. Deleting cancels them.",
  unfinished_runs:
    "An approved request, or a payment under an approval in advance, is still being carried out. The deletion finishes after it.",
  unmined_transactions:
    "A signed transaction is not mined yet. The keys are destroyed only after it is mined or cancelled, so cancel it if it is stuck.",
  nonzero_balance:
    "A wallet still holds something the server can see. It is lost for good when the keys are destroyed, so empty the wallets first.",
};

/** A wallet's state in a short label for a badge, or null while it is active. */
export function walletLifecycleLabel(lifecycle: WalletLifecycle): string | null {
  switch (lifecycle.state) {
    case "active":
      return null;
    case "retiring":
      return "Retiring";
    case "held":
      return "Stopped";
    case "destroyed":
      return "Key destroyed";
  }
}

/**
 * Whether people can still set the wallet's limits or retire it: while it is active, or stopped
 * after a cancelled retirement. Never while it is retiring or its key is gone.
 */
export function walletChangeable(lifecycle: WalletLifecycle): boolean {
  return lifecycle.state === "active" || lifecycle.state === "held";
}

/** The waiting requests of one kind, oldest first, from a list of a workspace's approvals. */
export function waitingRequests<T extends Pick<ApprovalSummary, "kind" | "status" | "createdAt">>(
  items: readonly T[],
  kind: "retire-wallet" | "delete-workspace",
): T[] {
  return items
    .filter((item) => item.kind === kind && item.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The waiting request to retire this wallet, among requests read in full: a summary does not name
 * its wallet. Undefined entries are requests not read yet.
 */
export function waitingRetirementOf<T extends Pick<ApprovalDetail, "status" | "subject">>(
  details: readonly (T | undefined)[],
  walletId: string,
): T | null {
  return (
    details.find(
      (detail) =>
        detail?.status === "pending" &&
        detail.subject.kind === "retire-wallet" &&
        detail.subject.wallet.id === walletId,
    ) ?? null
  );
}
