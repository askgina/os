import type { WalletDetail, WorkspaceDetail } from "@askgina/os-api";

/** Where a sweep may go, and why the signer accepts it. */
export interface SweepDestination {
  address: `0x${string}`;
  label: string;
  reason: "treasury" | "allowlist";
}

/**
 * The destinations the signer accepts for a sweep of `wallet`: the workspace's treasury (unless
 * this is the treasury), then the addresses on the wallet's recipient allowlist. A wallet whose
 * limits let agents pay anyone has no allowlist, so only the treasury is offered. The signer
 * checks this again from its own records; this list only keeps a person from asking for a sweep
 * it will refuse.
 */
export function sweepDestinations(
  wallet: Pick<WalletDetail, "id" | "address" | "policy">,
  workspace: Pick<WorkspaceDetail, "wallets">,
): SweepDestination[] {
  const treasuries: SweepDestination[] = workspace.wallets
    .filter((candidate) => candidate.kind === "treasury" && candidate.id !== wallet.id)
    .map((treasury) => ({ address: treasury.address, label: treasury.label, reason: "treasury" }));
  const recipients = wallet.policy?.recipients;
  const allowed: SweepDestination[] =
    recipients?.mode === "allowlist"
      ? recipients.addresses
          .filter(
            (address) =>
              address !== wallet.address &&
              !treasuries.some((treasury) => treasury.address === address),
          )
          .map((address) => ({ address, label: "Allowed recipient", reason: "allowlist" }))
      : [];
  return [...treasuries, ...allowed];
}
