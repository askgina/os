import { z } from "zod";
import { DomainTag, digestHex } from "./canonical.ts";
import {
  Address,
  AssetRef,
  ChainId,
  type Digest,
  PositiveAmount,
  PROTOCOL_VERSION,
  WalletId,
  WorkspaceId,
} from "./primitives.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Empty a wallet without an agent: move `amount` of one asset to `to`, in one transaction. A
 * person asks for it and the workspace's approvers approve it at the admin threshold. The
 * wallet's caps do not apply, so the signer sends only to an address already on the wallet's
 * recipient allowlist or to a treasury wallet of the same workspace, and builds the transfer
 * itself from this structure. Like an intent, it is immutable: its hash is what is approved.
 */
export const Sweep = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    workspaceId: WorkspaceId,
    walletId: WalletId,
    chainId: ChainId,
    /** The native coin, or the ERC-20 contract whose `transfer(to, amount)` is called. */
    asset: AssetRef,
    /** In the asset's base units. */
    amount: PositiveAmount,
    to: Address,
    /** Ceiling on `gas * maxFeePerGas`. */
    maxFeeWei: PositiveAmount,
  })
  .superRefine((sweep, context) => {
    // The same two mistakes an intent's transfer refuses: burning, and a token sent to itself.
    if (sweep.to === ZERO_ADDRESS) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "the zero address cannot receive a sweep",
      });
    }
    if (sweep.asset === ZERO_ADDRESS) {
      context.addIssue({
        code: "custom",
        path: ["asset"],
        message: "the zero address is not a token",
      });
    }
    if (sweep.asset === sweep.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "a token cannot be swept to its own contract",
      });
    }
  });
export type Sweep = z.infer<typeof Sweep>;

/** The digest a `sweep-wallet` envelope binds. */
export function sweepHash(sweep: Sweep): Digest {
  return digestHex(DomainTag.sweep, Sweep.parse(sweep));
}
