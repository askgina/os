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
    const isControl = code <= 0x1f || code === 0x7f;
    const isBidiMark = code === 0x200e || code === 0x200f;
    const isBidiOverride = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (isControl || isBidiMark || isBidiOverride) return true;
  }
  return false;
}

export const Memo = z
  .string()
  .max(280)
  .refine((value) => !hasUnsafeMemoCharacter(value), "memo contains control or bidi characters");

/**
 * One operation an agent asks a wallet to perform. An intent is immutable: its hash is what a
 * person approves and what the signer signs for, so changing any field makes a different intent.
 */
export const Intent = z.strictObject({
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
});
export type Intent = z.infer<typeof Intent>;

/** The digest that an approval and a signature are bound to. */
export function intentHash(intent: Intent): Digest {
  return digestHex(DomainTag.intent, Intent.parse(intent));
}

/** What an intent moves out of the wallet, for caps and budgets. Fees are not included. */
export function intentSpend(intent: Intent): { asset: AssetRef; amount: bigint } {
  const { operation } = intent;
  switch (operation.type) {
    case "evm.transfer":
      return { asset: "native", amount: BigInt(operation.valueWei) };
    case "evm.erc20.transfer":
      return { asset: operation.token, amount: BigInt(operation.amount) };
    case "evm.call":
      return { asset: "native", amount: BigInt(operation.valueWei) };
  }
}
