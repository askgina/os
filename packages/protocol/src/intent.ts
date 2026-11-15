import { z } from "zod";
import { DomainTag, digestHex } from "./canonical.ts";
import {
  Address,
  AgentId,
  Amount,
  type AssetRef,
  ChainId,
  type Digest,
  EpochSeconds,
  Hex,
  IntentId,
  PositiveAmount,
  PROTOCOL_VERSION,
  WalletId,
  WorkspaceId,
} from "./primitives.ts";
import {
  HYPERLIQUID_MAX_PERP_ASSET,
  isVenueNetwork,
  orderNotionalUsd6,
  PositiveDecimal,
  type SpendAsset,
  VenueNetwork,
} from "./venues.ts";

/** Send the chain's native coin. */
export const TransferOperation = z.strictObject({
  type: z.literal("evm.transfer"),
  to: Address,
  valueWei: PositiveAmount,
});
export type TransferOperation = z.infer<typeof TransferOperation>;

/** Call `transfer(to, amount)` on an ERC-20 token contract. */
export const Erc20TransferOperation = z.strictObject({
  type: z.literal("evm.erc20.transfer"),
  token: Address,
  to: Address,
  amount: PositiveAmount,
});
export type Erc20TransferOperation = z.infer<typeof Erc20TransferOperation>;

/**
 * Call any contract with raw calldata. Per-asset caps cannot see what such a call moves, so a
 * wallet policy denies it unless the target contract is allowlisted.
 */
export const CallOperation = z.strictObject({
  type: z.literal("evm.call"),
  to: Address,
  valueWei: Amount,
  data: Hex.refine((value) => value.length >= 10, "calldata must carry a 4-byte selector"),
});
export type CallOperation = z.infer<typeof CallOperation>;

/** What an EVM intent does on its chain. */
export const Operation = z.discriminatedUnion("type", [
  TransferOperation,
  Erc20TransferOperation,
  CallOperation,
]);
export type Operation = z.infer<typeof Operation>;

// Control characters and bidirectional overrides could make an approval card show something
// other than what is stored, so a memo may not contain them.
function hasUnsafeMemoCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const isLineBreak = code === 0x2028 || code === 0x2029;
    const isBidiMark = code === 0x200e || code === 0x200f || code === 0x061c;
    const isBidiOverride = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (isControl || isLineBreak || isBidiMark || isBidiOverride) return true;
  }
  return false;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const Memo = z
  .string()
  .max(280)
  .refine((value) => !hasUnsafeMemoCharacter(value), "memo contains control or bidi characters");

/**
 * One operation an agent asks a wallet to perform on an EVM chain. An intent is immutable: its
 * hash is what a person approves and what the signer signs for, so changing any field makes a
 * different intent.
 */
export const EvmIntent = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id: IntentId,
    workspaceId: WorkspaceId,
    agentId: AgentId,
    walletId: WalletId,
    chainId: ChainId,
    operation: Operation,
    /** Ceiling on `gas * maxFeePerGas`. Nonce and gas fields may vary below it after approval. */
    maxFeeWei: PositiveAmount,
    /** The agent's stated reason. Hashed, so the text a person read is the text that was approved. */
    memo: Memo,
    createdAt: EpochSeconds,
  })
  .superRefine((intent, context) => {
    const { operation } = intent;
    // The zero address has no key: coins sent there are burned and a call there does nothing
    // useful, so it is almost always a mistake a person would not catch on an approval card.
    const addresses: [string, string][] =
      operation.type === "evm.erc20.transfer"
        ? [
            ["to", operation.to],
            ["token", operation.token],
          ]
        : [["to", operation.to]];
    for (const [field, value] of addresses) {
      if (value === ZERO_ADDRESS) {
        context.addIssue({
          code: "custom",
          path: ["operation", field],
          message: "the zero address cannot be a recipient, token or call target",
        });
      }
    }
    // Most tokens keep what is sent to their own contract for good.
    if (operation.type === "evm.erc20.transfer" && operation.to === operation.token) {
      context.addIssue({
        code: "custom",
        path: ["operation", "to"],
        message: "a token transfer cannot send the token to its own contract",
      });
    }
  });
export type EvmIntent = z.infer<typeof EvmIntent>;

/**
 * A limit order on a Hyperliquid perpetual market. The signer builds the venue's order action
 * from these fields alone, and picks its nonce, expiry and client order id itself.
 */
export const HyperliquidOrderOperation = z.strictObject({
  type: z.literal("hyperliquid.order"),
  /** The perpetual's index in the venue's `meta.universe`, bound to a coin name in the policy. */
  asset: z.number().int().min(0).max(HYPERLIQUID_MAX_PERP_ASSET),
  isBuy: z.boolean(),
  size: PositiveDecimal,
  limitPx: PositiveDecimal,
  /** Add liquidity only, good till cancelled, or immediate or cancel. */
  tif: z.enum(["Alo", "Gtc", "Ioc"]),
  reduceOnly: z.boolean(),
});
export type HyperliquidOrderOperation = z.infer<typeof HyperliquidOrderOperation>;

/**
 * Withdraw USDC from the wallet's Hyperliquid account. The destination is never a field: the
 * signer always withdraws to the wallet's own address.
 */
export const HyperliquidWithdrawOperation = z.strictObject({
  type: z.literal("hyperliquid.withdraw"),
  /** In USDC. */
  amount: PositiveDecimal,
});
export type HyperliquidWithdrawOperation = z.infer<typeof HyperliquidWithdrawOperation>;

/** What a venue intent does at its venue. */
export const VenueOperation = z.discriminatedUnion("type", [
  HyperliquidOrderOperation,
  HyperliquidWithdrawOperation,
]);
export type VenueOperation = z.infer<typeof VenueOperation>;

/**
 * One operation an agent asks a wallet to perform at a venue. It has no fee ceiling: a venue
 * action pays no gas. The network keeps the field name `chainId`, so the envelope check and every
 * existing digest stay as they are.
 */
export const VenueIntent = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  id: IntentId,
  workspaceId: WorkspaceId,
  agentId: AgentId,
  walletId: WalletId,
  chainId: VenueNetwork,
  operation: VenueOperation,
  /** The agent's stated reason. Hashed, so the text a person read is the text that was approved. */
  memo: Memo,
  createdAt: EpochSeconds,
});
export type VenueIntent = z.infer<typeof VenueIntent>;

/**
 * An intent on an EVM chain or at a venue. Both are hashed under the same tag: an EVM intent
 * hashes exactly as it did before venue intents existed, and a venue intent can never parse as
 * an EVM one or the other way round, because their `chainId` values never overlap.
 */
export const Intent = z.union([EvmIntent, VenueIntent]);
export type Intent = z.infer<typeof Intent>;

export function isVenueIntent(intent: Intent): intent is VenueIntent {
  return isVenueNetwork(intent.chainId);
}

/** The digest that an approval and a signature are bound to. */
export function intentHash(intent: Intent): Digest {
  return digestHex(DomainTag.intent, Intent.parse(intent));
}

/**
 * What an intent moves out of the wallet, for caps and budgets. Fees are not included. `daily`
 * says whether it counts against a daily cap: an EVM spend always does; an order's notional
 * (`usd6`) does unless the order is reduce-only; a withdrawal from the venue moves nothing the
 * caps measure, since it can only go to the wallet's own address.
 */
export function intentSpend(intent: EvmIntent): {
  asset: AssetRef;
  amount: bigint;
  daily: boolean;
};
export function intentSpend(intent: Intent): { asset: SpendAsset; amount: bigint; daily: boolean };
export function intentSpend(intent: Intent): { asset: SpendAsset; amount: bigint; daily: boolean } {
  const { operation } = intent;
  switch (operation.type) {
    case "evm.transfer":
      return { asset: "native", amount: BigInt(operation.valueWei), daily: true };
    case "evm.erc20.transfer":
      return { asset: operation.token, amount: BigInt(operation.amount), daily: true };
    case "evm.call":
      return { asset: "native", amount: BigInt(operation.valueWei), daily: true };
    case "hyperliquid.order":
      return {
        asset: "usd6",
        amount: orderNotionalUsd6(operation.size, operation.limitPx),
        daily: !operation.reduceOnly,
      };
    case "hyperliquid.withdraw":
      return { asset: "usd6", amount: 0n, daily: false };
  }
}
