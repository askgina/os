import { ulid } from "ulid";
import { z } from "zod";

/**
 * Version of every hashed structure in this package. Changing the shape of anything that is
 * hashed (an intent, a policy, an envelope) means a new version, never an edit in place.
 */
export const PROTOCOL_VERSION = 1;

const ULID_BODY = "[0-9a-hjkmnp-tv-z]{26}";

function prefixedId<P extends string>(prefix: P) {
  const pattern = new RegExp(`^${prefix}_${ULID_BODY}$`);
  return z.custom<`${P}_${string}`>(
    (value) => typeof value === "string" && pattern.test(value),
    `expected "${prefix}_" followed by a lowercase ULID`,
  );
}

export const WorkspaceId = prefixedId("ws");
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const UserId = prefixedId("usr");
export type UserId = z.infer<typeof UserId>;

export const AgentId = prefixedId("agt");
export type AgentId = z.infer<typeof AgentId>;

export const WalletId = prefixedId("wal");
export type WalletId = z.infer<typeof WalletId>;

export const IntentId = prefixedId("int");
export type IntentId = z.infer<typeof IntentId>;

export const ApprovalId = prefixedId("apr");
export type ApprovalId = z.infer<typeof ApprovalId>;

export const MandateId = prefixedId("mnd");
export type MandateId = z.infer<typeof MandateId>;

const ID_PREFIXES = ["ws", "usr", "agt", "wal", "int", "apr", "mnd"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Mint a new identifier, for example `newId("wal")` gives `wal_01k…`. */
export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid().toLowerCase()}`;
}

/** A 20-byte EVM address in lowercase hex. Checksummed (EIP-55) forms are for display only. */
export const Address = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value),
  "expected a lowercase 20-byte hex address",
);
export type Address = z.infer<typeof Address>;

/** Arbitrary bytes as lowercase hex with a 0x prefix. `0x` is the empty byte string. */
export const Hex = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/.test(value),
  "expected lowercase hex with a 0x prefix and an even number of digits",
);
export type Hex = z.infer<typeof Hex>;

/** A 32-byte value as 0x-prefixed lowercase hex, for example a transaction hash. */
export const Hex32 = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
  "expected 32 bytes of lowercase hex with a 0x prefix",
);
export type Hex32 = z.infer<typeof Hex32>;

/** A SHA-256 digest as 64 lowercase hex digits, no prefix. */
export const Digest = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 hex digest");
export type Digest = z.infer<typeof Digest>;

/**
 * A CAIP-2 identifier of an EVM chain, for example `eip155:8453`. At most 15 digits, so the
 * number always fits a JavaScript number exactly: a longer id would round in `evmChainNumber`
 * and two different chain ids could sign for the same chain.
 */
export const ChainId = z.custom<`eip155:${number}`>(
  (value) => typeof value === "string" && /^eip155:[1-9][0-9]{0,14}$/.test(value),
  "expected a CAIP-2 EVM chain id such as eip155:8453",
);
export type ChainId = z.infer<typeof ChainId>;

/** The numeric EVM chain id inside a CAIP-2 identifier. */
export function evmChainNumber(chainId: ChainId): number {
  return Number(chainId.slice("eip155:".length));
}

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * A non-negative integer in an asset's base units (wei, or a token's smallest unit), carried as
 * a decimal string so no JSON number ever rounds it.
 */
export const Amount = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,77})$/, "expected a base-unit integer as a decimal string")
  // Zod runs this refinement even when the pattern above failed, and BigInt throws on text such
  // as "1.0"; only compare values that are plain digits so bad input is refused, not thrown.
  .refine(
    (value) => !/^[0-9]+$/.test(value) || BigInt(value) <= UINT256_MAX,
    "amount exceeds uint256",
  );
export type Amount = z.infer<typeof Amount>;

export const PositiveAmount = Amount.refine(
  (value) => value !== "0",
  "amount must be greater than zero",
);
export type PositiveAmount = z.infer<typeof PositiveAmount>;

/** Seconds since the Unix epoch, as an integer. */
export const EpochSeconds = z.number().int().min(0).max(32_503_680_000);
export type EpochSeconds = z.infer<typeof EpochSeconds>;

/** Unpadded base64url text. */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "expected unpadded base64url");
export type Base64Url = z.infer<typeof Base64Url>;

/** 16 random bytes as unpadded base64url. Each authorization envelope carries exactly one. */
export const Nonce = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/, "expected 16 random bytes as unpadded base64url");
export type Nonce = z.infer<typeof Nonce>;

/** Either the chain's native coin or an ERC-20 token contract. */
export const AssetRef = z.union([z.literal("native"), Address]);
export type AssetRef = z.infer<typeof AssetRef>;

/**
 * True when `values` is strictly ascending under plain string comparison, which also makes it
 * free of duplicates. Hashed structures store their sets this way so that one set has one hash.
 */
export function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
}

/** Sort and de-duplicate, producing the form {@link isSortedUnique} accepts. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** A set as hashed structures store it: an array of at most `max` items in that one order. */
export const sortedSet = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((values) => isSortedUnique(values), "must be sorted ascending without duplicates");
