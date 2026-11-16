import { z } from "zod";
import { DomainTag, digestHex } from "./canonical.ts";
import { type Intent, intentSpend, isVenueIntent, Memo } from "./intent.ts";
import { type AssetLimit, assetLimitKey, type WalletPolicy } from "./policy.ts";
import {
  Address,
  AgentId,
  ApprovalId,
  AssetRef,
  ChainId,
  Digest,
  EpochSeconds,
  isSortedUnique,
  MandateId,
  PositiveAmount,
  PROTOCOL_VERSION,
  sortedSet,
  sortedUnique,
  WalletId,
  WorkspaceId,
} from "./primitives.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The longest life the schema allows a mandate: 30 days. The signer's own ceiling is lower. */
export const MANDATE_MAX_SECONDS = 2_592_000;

/**
 * Caps for one asset on one chain under a mandate. `native` permits `evm.transfer` of the
 * chain's coin; a token address permits `evm.erc20.transfer` of that token. Nothing else.
 */
export const MandateAssetLimit = z.strictObject({
  chainId: ChainId,
  asset: AssetRef,
  /** Most one payment may move, in base units. */
  maxPerAction: PositiveAmount,
  /** Most all payments may move in any rolling `windowSeconds`, in base units. */
  maxPerWindow: PositiveAmount,
  /** Most all payments may move over the mandate's whole life, in base units. */
  maxTotal: PositiveAmount,
});

export type MandateAssetLimit = z.infer<typeof MandateAssetLimit>;

/**
 * What people approve once: one agent may transfer bounded amounts from one wallet to listed
 * recipients between `notBefore` and `notAfter`, with no passkey per payment. The signer holds
 * it, counts every use itself and checks the wallet's live policy at every use as well. Like an
 * intent it is immutable: its hash is what the `grant-mandate` envelope binds.
 */
export const Mandate = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id: MandateId,
    workspaceId: WorkspaceId,
    walletId: WalletId,
    /** The one agent whose proposals may be signed under this mandate. */
    agentId: AgentId,
    /** Sorted by `chainId|asset`, one entry per pair. */
    assets: z.array(MandateAssetLimit).min(1).max(16),
    /** The rolling span over which `maxPerWindow` is counted. */
    windowSeconds: z.number().int().min(3600).max(604_800),
    /** The only addresses a payment under this mandate may go to. */
    recipients: sortedSet(Address, 64).min(1),
    /** Most payments over the mandate's whole life. */
    maxUses: z.number().int().min(1).max(10_000),
    /** Largest fee ceiling (`maxFeeWei`) an intent under this mandate may carry. */
    maxFeePerActionWei: PositiveAmount,
    /** The first second a payment may be signed under it. */
    notBefore: EpochSeconds,
    /** The first second no payment may be signed under it any more. */
    notAfter: EpochSeconds,
    /** The granting person's stated reason. Hashed, so the text approved is the text stored. */
    purpose: Memo,
  })
  .superRefine((mandate, context) => {
    if (!isSortedUnique(mandate.assets.map(assetLimitKey))) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "must be sorted by chainId|asset without duplicates",
      });
    }

    mandate.assets.forEach((limit, index) => {
      if (limit.asset === ZERO_ADDRESS) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "asset"],
          message: "the zero address is not a token",
        });
      }

      // This refinement also runs when an amount already failed its own pattern; BigInt would
      // throw on such text, so compare only amounts that parsed.
      const parsed = [limit.maxPerAction, limit.maxPerWindow, limit.maxTotal].every(
        (amount) => PositiveAmount.safeParse(amount).success,
      );

      if (!parsed) return;

      if (BigInt(limit.maxPerAction) > BigInt(limit.maxPerWindow)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "maxPerAction"],
          message: "maxPerAction cannot exceed maxPerWindow",
        });
      }

      if (BigInt(limit.maxPerWindow) > BigInt(limit.maxTotal)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "maxPerWindow"],
          message: "maxPerWindow cannot exceed maxTotal",
        });
      }
    });

    if (mandate.notAfter <= mandate.notBefore) {
      context.addIssue({
        code: "custom",
        path: ["notAfter"],
        message: "notAfter must be after notBefore",
      });
    } else if (mandate.notAfter - mandate.notBefore > MANDATE_MAX_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["notAfter"],
        message: "a mandate cannot last longer than 30 days",
      });
    }

    mandate.recipients.forEach((recipient, index) => {
      if (recipient === ZERO_ADDRESS) {
        context.addIssue({
          code: "custom",
          path: ["recipients", index],
          message: "the zero address cannot be a recipient",
        });
      }
    });
  });

export type Mandate = z.infer<typeof Mandate>;

/** The digest a `grant-mandate` envelope binds. */
export function mandateHash(mandate: Mandate): Digest {
  return digestHex(DomainTag.mandate, Mandate.parse(mandate));
}

/** Put a mandate's sets into the one order the schema accepts. */
export function normalizeMandate(mandate: Mandate): Mandate {
  return Mandate.parse({
    ...mandate,
    assets: [...mandate.assets].sort((a, b) => (assetLimitKey(a) < assetLimitKey(b) ? -1 : 1)),
    recipients: sortedUnique(mandate.recipients),
  });
}

/**
 * Per asset, the most the mandate can let leave the wallet: `min(maxTotal, maxUses ×
 * maxPerAction)`. The wallet's policy bounds it further, to its 24-hour cap per day.
 */
export function mandateWorstCase(
  mandate: Mandate,
): { chainId: ChainId; asset: AssetRef; amount: bigint }[] {
  return mandate.assets.map((limit) => {
    let amount = BigInt(limit.maxTotal);
    const byUses = BigInt(mandate.maxUses) * BigInt(limit.maxPerAction);

    if (byUses < amount) amount = byUses;

    return { chainId: limit.chainId, asset: limit.asset, amount };
  });
}

export type MandateTimeState = "not_yet_valid" | "live" | "expired";

/** Where `now` falls in the mandate's span. `notAfter` itself is already expired. */
export function mandateTimeState(mandate: Mandate, now: number): MandateTimeState {
  if (now < mandate.notBefore) return "not_yet_valid";

  if (now >= mandate.notAfter) return "expired";

  return "live";
}

// --- granting ---------------------------------------------------------------------------------

/**
 * Why a mandate cannot be granted, the `detail` of the signer's `mandate_invalid`. The policy
 * codes keep the meaning they have in `evaluateIntent`. `too_many_live_mandates` comes from the
 * signer only: the wallet already has as many live mandates as it allows.
 */
export const MANDATE_GRANT_REFUSALS = [
  "wallet_mismatch",
  "requester_not_allowed",
  "chain_not_allowed",
  "asset_not_allowed",
  "over_per_tx_cap",
  "over_daily_cap",
  "recipient_not_allowed",
  "over_fee_cap",
  "already_expired",
  "lifetime_too_long",
  "too_many_live_mandates",
] as const;

export type MandateGrantRefusal = (typeof MANDATE_GRANT_REFUSALS)[number];

/**
 * `null` when the mandate fits the wallet's policy and the signer's lifetime ceiling, otherwise
 * the first reason it does not, in this order. Pure: the control plane calls it early to tell a
 * person, and the signer calls it with its own policy and clock and its answer is final.
 */
export function checkMandateAgainstPolicy(
  mandate: Mandate,
  policy: WalletPolicy,
  options: { now: number; maxSeconds: number },
): Exclude<MandateGrantRefusal, "too_many_live_mandates"> | null {
  if (policy.walletId !== mandate.walletId || policy.workspaceId !== mandate.workspaceId) {
    return "wallet_mismatch";
  }

  if (!policy.requesters.includes(mandate.agentId)) return "requester_not_allowed";

  if (mandate.assets.some((limit) => !policy.chains.includes(limit.chainId))) {
    return "chain_not_allowed";
  }

  const limits: { limit: MandateAssetLimit; policyLimit: AssetLimit }[] = [];

  for (const limit of mandate.assets) {
    const key = assetLimitKey(limit);
    const policyLimit = policy.assets.find((candidate) => assetLimitKey(candidate) === key);

    if (policyLimit === undefined) return "asset_not_allowed";
    limits.push({ limit, policyLimit });
  }

  if (
    limits.some(
      ({ limit, policyLimit }) => BigInt(limit.maxPerAction) > BigInt(policyLimit.maxPerTx),
    )
  ) {
    return "over_per_tx_cap";
  }

  // A window longer than a day may hold more than one day's cap; the policy's 24-hour cap still
  // applies to every use.
  if (
    mandate.windowSeconds <= 86_400 &&
    limits.some(
      ({ limit, policyLimit }) => BigInt(limit.maxPerWindow) > BigInt(policyLimit.maxPerDay),
    )
  ) {
    return "over_daily_cap";
  }

  const { recipients } = policy;

  if (
    recipients.mode === "allowlist" &&
    mandate.recipients.some((recipient) => !recipients.addresses.includes(recipient))
  ) {
    return "recipient_not_allowed";
  }

  if (BigInt(mandate.maxFeePerActionWei) > BigInt(policy.fees.maxPerTxWei)) return "over_fee_cap";

  if (mandate.notAfter <= options.now) return "already_expired";

  if (mandate.notAfter - Math.max(options.now, mandate.notBefore) > options.maxSeconds) {
    return "lifetime_too_long";
  }

  return null;
}

// --- using ------------------------------------------------------------------------------------

/**
 * Why a mandate does not cover an intent, the `detail` of the signer's `mandate_denied`.
 * `mandate_grant_below_threshold` comes from the signer only: fewer of the people who granted it
 * are still approvers than the workspace's admin threshold now requires.
 */
export const MANDATE_DENY_CODES = [
  "mandate_wallet_mismatch",
  "mandate_agent_mismatch",
  "mandate_operation_not_allowed",
  "mandate_asset_not_allowed",
  "mandate_recipient_not_allowed",
  "mandate_over_fee_cap",
  "mandate_uses_exhausted",
  "mandate_over_per_action_cap",
  "mandate_over_window_cap",
  "mandate_over_total_cap",
  "mandate_grant_below_threshold",
] as const;

export type MandateDenyCode = (typeof MANDATE_DENY_CODES)[number];

export type MandateDecision =
  | { allowed: true; spend: { chainId: ChainId; asset: AssetRef; amount: bigint } }
  | { allowed: false; code: MandateDenyCode };

/** What the signer already signed under one mandate, from its own records. */
export type MandateUsage = {
  /** Every use so far. */
  uses: number;
  /** Everything moved in this asset under the mandate. */
  total(chainId: ChainId, asset: AssetRef): bigint;
  /** What moved in this asset under the mandate in the last `windowSeconds`. */
  inWindow(chainId: ChainId, asset: AssetRef): bigint;
};

/**
 * Decide whether a mandate covers an intent. Pure and deterministic, like `evaluateIntent`; it
 * checks neither time (see {@link mandateTimeState}) nor the wallet's policy, which the signer
 * evaluates as well and which stays the outer limit. Rules in order; the first failure decides.
 */
export function evaluateMandate(
  mandate: Mandate,
  intent: Intent,
  usage: MandateUsage,
): MandateDecision {
  if (intent.workspaceId !== mandate.workspaceId || intent.walletId !== mandate.walletId) {
    return { allowed: false, code: "mandate_wallet_mismatch" };
  }

  if (intent.agentId !== mandate.agentId) {
    return { allowed: false, code: "mandate_agent_mismatch" };
  }

  // Mandates cover transfers only: an order or a withdrawal at a venue always needs people.
  if (isVenueIntent(intent)) {
    return { allowed: false, code: "mandate_operation_not_allowed" };
  }

  const { operation } = intent;

  // The signer cannot measure what calldata moves, so no call is ever signed under a mandate,
  // not even one that sends no coin.
  if (operation.type === "evm.call") {
    return { allowed: false, code: "mandate_operation_not_allowed" };
  }

  const { asset, amount } = intentSpend(intent);
  const key = assetLimitKey({ chainId: intent.chainId, asset });
  const limit = mandate.assets.find((candidate) => assetLimitKey(candidate) === key);

  if (limit === undefined) {
    return { allowed: false, code: "mandate_asset_not_allowed" };
  }

  if (!mandate.recipients.includes(operation.to)) {
    return { allowed: false, code: "mandate_recipient_not_allowed" };
  }

  if (BigInt(intent.maxFeeWei) > BigInt(mandate.maxFeePerActionWei)) {
    return { allowed: false, code: "mandate_over_fee_cap" };
  }

  if (usage.uses + 1 > mandate.maxUses) {
    return { allowed: false, code: "mandate_uses_exhausted" };
  }

  if (amount > BigInt(limit.maxPerAction)) {
    return { allowed: false, code: "mandate_over_per_action_cap" };
  }

  if (usage.inWindow(intent.chainId, asset) + amount > BigInt(limit.maxPerWindow)) {
    return { allowed: false, code: "mandate_over_window_cap" };
  }

  if (usage.total(intent.chainId, asset) + amount > BigInt(limit.maxTotal)) {
    return { allowed: false, code: "mandate_over_total_cap" };
  }

  return { allowed: true, spend: { chainId: intent.chainId, asset, amount } };
}

/** The three identifiers one use of a mandate is recorded under. */
export const MandateUseInput = z.strictObject({
  approvalId: ApprovalId,
  mandateId: MandateId,
  intentHash: Digest,
});

export type MandateUseInput = z.infer<typeof MandateUseInput>;

/**
 * The digest of `{ v, approvalId, mandateId, intentHash }` under its own tag. The signer stores
 * it in place of an envelope digest for a use, so a repeated use is recognized and a use can
 * never be taken for an envelope, nor an envelope for a use.
 */
export function mandateUseDigest(input: MandateUseInput): Digest {
  return digestHex(DomainTag.mandateUse, { v: PROTOCOL_VERSION, ...MandateUseInput.parse(input) });
}
