import { z } from "zod";
import { DomainTag, digestHex } from "./canonical.ts";
import {
  Address,
  AgentId,
  AssetRef,
  ChainId,
  Digest,
  isSortedUnique,
  PositiveAmount,
  PROTOCOL_VERSION,
  sortedSet,
  sortedUnique,
  WalletId,
  WorkspaceId,
} from "./primitives.ts";

/** Caps for one asset on one chain. An asset with no entry cannot leave the wallet. */
export const AssetLimit = z.strictObject({
  chainId: ChainId,
  asset: AssetRef,
  /** Most a single transaction may move, in base units. */
  maxPerTx: PositiveAmount,
  /** Most the wallet may move in any rolling 24 hours, in base units. */
  maxPerDay: PositiveAmount,
});
export type AssetLimit = z.infer<typeof AssetLimit>;

export const assetLimitKey = (limit: Pick<AssetLimit, "chainId" | "asset">): string =>
  `${limit.chainId}|${limit.asset}`;

export const RecipientRule = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("any") }),
  z.strictObject({ mode: z.literal("allowlist"), addresses: sortedSet(Address, 256) }),
]);
export type RecipientRule = z.infer<typeof RecipientRule>;

export const ContractCallRule = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("deny") }),
  z.strictObject({ mode: z.literal("allowlist"), targets: sortedSet(Address, 256) }),
]);
export type ContractCallRule = z.infer<typeof ContractCallRule>;

/**
 * Everything a wallet is allowed to do. The signer holds the authoritative copy and enforces it
 * at signing time. Revisions form a hash chain: revision 1 has `previousHash: null`, and each
 * later revision names the hash of the one it replaces.
 */
export const WalletPolicy = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    workspaceId: WorkspaceId,
    walletId: WalletId,
    revision: z.number().int().min(1),
    previousHash: Digest.nullable(),
    /** Chains this wallet may act on. */
    chains: sortedSet(ChainId, 32),
    /** Agents that may propose from this wallet. */
    requesters: sortedSet(AgentId, 64),
    /** Sorted by `chainId|asset`, one entry per pair. */
    assets: z.array(AssetLimit).max(128),
    /** Who may receive transfers. Does not apply to contract-call targets. */
    recipients: RecipientRule,
    contractCalls: ContractCallRule,
    fees: z.strictObject({
      /** Largest fee ceiling (`maxFeeWei`) an intent may carry. */
      maxPerTxWei: PositiveAmount,
    }),
    approvals: z.strictObject({
      /** How many different people must approve each transaction. */
      threshold: z.number().int().min(1).max(16),
      /** Longest time an approval of an intent may stay usable. */
      ttlSeconds: z.number().int().min(60).max(86_400),
    }),
  })
  .superRefine((policy, context) => {
    if ((policy.revision === 1) !== (policy.previousHash === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousHash"],
        message: "revision 1 has no previous hash; every later revision must name one",
      });
    }
    if (!isSortedUnique(policy.assets.map(assetLimitKey))) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "must be sorted by chainId|asset without duplicates",
      });
    }
    policy.assets.forEach((limit, index) => {
      if (!policy.chains.includes(limit.chainId)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "chainId"],
          message: "asset limit names a chain that is not in `chains`",
        });
      }
      // This refinement also runs when an amount already failed its own pattern; BigInt would
      // throw on such text, so compare only amounts that parsed.
      const amountsParsed =
        PositiveAmount.safeParse(limit.maxPerTx).success &&
        PositiveAmount.safeParse(limit.maxPerDay).success;
      if (amountsParsed && BigInt(limit.maxPerTx) > BigInt(limit.maxPerDay)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "maxPerTx"],
          message: "maxPerTx cannot exceed maxPerDay",
        });
      }
    });
    // A contract call is capped only by its native value, so if a capped token is also a call
    // target, `transfer(...)` sent as raw calldata to that token would move it with no cap at
    // all. A token is either capped or callable, never both.
    if (policy.contractCalls.mode === "allowlist") {
      const tokens = new Set(policy.assets.map((limit) => limit.asset));
      policy.contractCalls.targets.forEach((target, index) => {
        if (tokens.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["contractCalls", "targets", index],
            message: "a capped asset token cannot also be a contract-call target",
          });
        }
      });
    }
  });
export type WalletPolicy = z.infer<typeof WalletPolicy>;

/** The digest that identifies one exact policy revision. Approvals are bound to it. */
export function policyHash(policy: WalletPolicy): Digest {
  return digestHex(DomainTag.policy, WalletPolicy.parse(policy));
}

/** Put a policy's sets into the one order the schema accepts. */
export function normalizePolicy(policy: WalletPolicy): WalletPolicy {
  return WalletPolicy.parse({
    ...policy,
    chains: sortedUnique(policy.chains),
    requesters: sortedUnique(policy.requesters),
    assets: [...policy.assets].sort((a, b) => (assetLimitKey(a) < assetLimitKey(b) ? -1 : 1)),
    recipients:
      policy.recipients.mode === "allowlist"
        ? { mode: "allowlist", addresses: sortedUnique(policy.recipients.addresses) }
        : policy.recipients,
    contractCalls:
      policy.contractCalls.mode === "allowlist"
        ? { mode: "allowlist", targets: sortedUnique(policy.contractCalls.targets) }
        : policy.contractCalls,
  });
}
