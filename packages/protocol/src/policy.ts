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
import { HYPERLIQUID_MAX_PERP_ASSET, VenueNetwork } from "./venues.ts";

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
 * One Hyperliquid perpetual a wallet may trade. The asset index is what is signed; the coin name
 * is how people and agents name it, bound to the index by the people who approve the policy.
 */
export const HyperliquidMarket = z.strictObject({
  asset: z.number().int().min(0).max(HYPERLIQUID_MAX_PERP_ASSET),
  coin: z.string().regex(/^[A-Z0-9]{1,16}$/, "expected 1 to 16 capital letters or digits"),
  /** Largest notional of one order, in micro-USD. A reduce-only order is capped by it too. */
  maxNotionalPerOrderUsd6: PositiveAmount,
});
export type HyperliquidMarket = z.infer<typeof HyperliquidMarket>;

export const HyperliquidTimeInForce = z.enum(["Alo", "Gtc", "Ioc"]);
export type HyperliquidTimeInForce = z.infer<typeof HyperliquidTimeInForce>;

/**
 * What a wallet may do on Hyperliquid. The caps limit the notional of new orders, counted when
 * signed; they do not limit losses, which only the account's value at the venue bounds.
 */
export const HyperliquidRules = z
  .strictObject({
    network: VenueNetwork,
    /** Sorted by asset, one entry per asset and per coin. */
    markets: z.array(HyperliquidMarket).min(1).max(64),
    /** Most notional of orders that are not reduce-only in any rolling 24 hours, in micro-USD. */
    maxNotionalPerDayUsd6: PositiveAmount,
    timeInForce: sortedSet(HyperliquidTimeInForce, 3).min(1),
    /** How long after signing an order the venue still accepts it (its `expiresAfter`). */
    submitWindowSeconds: z.number().int().min(5).max(300),
    /** Whether USDC may be withdrawn, always to the wallet's own address. */
    withdrawals: z.boolean(),
  })
  .superRefine((rules, context) => {
    rules.markets.forEach((market, index) => {
      const previous = rules.markets[index - 1];
      if (previous !== undefined && previous.asset >= market.asset) {
        context.addIssue({
          code: "custom",
          path: ["markets", index, "asset"],
          message: "markets must be sorted by asset without duplicates",
        });
      }
      if (rules.markets.findIndex((other) => other.coin === market.coin) !== index) {
        context.addIssue({
          code: "custom",
          path: ["markets", index, "coin"],
          message: "a coin is named by two markets",
        });
      }
      const capsParsed =
        PositiveAmount.safeParse(market.maxNotionalPerOrderUsd6).success &&
        PositiveAmount.safeParse(rules.maxNotionalPerDayUsd6).success;
      if (
        capsParsed &&
        BigInt(market.maxNotionalPerOrderUsd6) > BigInt(rules.maxNotionalPerDayUsd6)
      ) {
        context.addIssue({
          code: "custom",
          path: ["markets", index, "maxNotionalPerOrderUsd6"],
          message: "a market's per-order cap cannot exceed the daily cap",
        });
      }
    });
  });
export type HyperliquidRules = z.infer<typeof HyperliquidRules>;

/**
 * Venue rules, one member per venue. Optional and never empty, so a policy without venue rules
 * has exactly one form, the one it had before venues existed, and hashes as it did then.
 */
export const VenueRules = z
  .strictObject({ hyperliquid: HyperliquidRules.optional() })
  .refine((venues) => venues.hyperliquid !== undefined, "venues must name at least one venue");
export type VenueRules = z.infer<typeof VenueRules>;

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
    /** What the wallet may do at venues. Absent: nothing; every venue intent is refused. */
    venues: VenueRules.optional(),
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
    ...(policy.venues?.hyperliquid === undefined
      ? {}
      : {
          venues: {
            hyperliquid: {
              ...policy.venues.hyperliquid,
              markets: [...policy.venues.hyperliquid.markets].sort((a, b) => a.asset - b.asset),
              timeInForce: sortedUnique(policy.venues.hyperliquid.timeInForce),
            },
          },
        }),
  });
}
