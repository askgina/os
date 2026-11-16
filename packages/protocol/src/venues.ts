import { z } from "zod";
import { AssetRef, ChainId } from "./primitives.ts";

/**
 * A place an order is executed that is not an EVM chain transaction. It takes the place of an
 * EVM chain id in a venue intent and its envelope. Only Hyperliquid's own chain ("HyperCore")
 * for now, on testnet and mainnet, both supported alike. The server pairs Hyperliquid's own API
 * hosts with their network at boot: `api.hyperliquid.xyz` must be configured as mainnet and
 * `api.hyperliquid-testnet.xyz` as testnet.
 */
export const VenueNetwork = z.enum(["hyperliquid:testnet", "hyperliquid:mainnet"]);

export type VenueNetwork = z.infer<typeof VenueNetwork>;

/** Where an intent acts: an EVM chain or a venue network. */
export const Network = z.union([ChainId, VenueNetwork]);

export type Network = z.infer<typeof Network>;

export function isVenueNetwork(value: unknown): value is VenueNetwork {
  return VenueNetwork.safeParse(value).success;
}

/**
 * The name the signer's confirmation view gives a venue network. From the signer's code, not
 * from the operator's chains file, which names only EVM chains.
 */
export const VENUE_NETWORK_NAMES: Record<VenueNetwork, string> = {
  "hyperliquid:testnet": "Hyperliquid testnet",
  "hyperliquid:mainnet": "Hyperliquid mainnet",
};

/** At most 8 fraction digits, the most Hyperliquid accepts for a size or a price. */
const DECIMAL_FRACTION_DIGITS = 8;

/**
 * A canonical decimal: no exponent, no sign, no leading zeros except `0.`, no trailing zeros and
 * no trailing point, at most 8 fraction digits; for example `0.0147`, `100`, `1670.1`. It is the
 * form the Hyperliquid SDK's `float_to_wire` sends, so one value has one string, which is what is
 * hashed and what the venue reads.
 */
export const Decimal = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{0,7}[1-9])?$/,
    "expected a canonical decimal such as 0.0147 or 100",
  );

export type Decimal = z.infer<typeof Decimal>;

export const PositiveDecimal = Decimal.refine(
  (value) => value !== "0",
  "must be greater than zero",
);

export type PositiveDecimal = z.infer<typeof PositiveDecimal>;

/** Hyperliquid's client order id: 16 bytes as 0x-prefixed lowercase hex. */
export const Cloid = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-f]{32}$/.test(value),
  "expected 16 bytes of lowercase hex with a 0x prefix",
);

export type Cloid = z.infer<typeof Cloid>;

/**
 * What a spend is counted in: an EVM chain's native coin or token, or `usd6`, micro-USD
 * (10^-6 USD) of order notional at a venue.
 */
export const SpendAsset = z.union([AssetRef, z.literal("usd6")]);

export type SpendAsset = z.infer<typeof SpendAsset>;

/** The highest perpetual asset index a policy, an intent or the signer accepts. */
export const HYPERLIQUID_MAX_PERP_ASSET = 9999;

/**
 * A decimal times `10^scale`, exactly: `decimalToScaled("1.25", 2)` is `125n`. Throws a
 * `RangeError` when the value has more fraction digits than `scale` and a `TypeError` when it is
 * not a canonical decimal.
 */
export function decimalToScaled(value: Decimal, scale: number): bigint {
  if (!Decimal.safeParse(value).success) {
    throw new TypeError(`not a canonical decimal: ${JSON.stringify(value)}`);
  }

  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError(`scale must be a non-negative integer, got ${scale}`);
  }

  const [whole = "0", fraction = ""] = value.split(".");

  if (fraction.length > scale) {
    throw new RangeError(`${value} has more than ${scale} fraction digits`);
  }

  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
}

/**
 * The worst-case notional of an order in micro-USD: `ceil(size × limitPx × 10^6)`, computed
 * exactly from both values scaled by `10^8`. Rounded up, so a cap is never passed by rounding.
 */
export function orderNotionalUsd6(size: Decimal, limitPx: Decimal): bigint {
  const product =
    decimalToScaled(size, DECIMAL_FRACTION_DIGITS) *
    decimalToScaled(limitPx, DECIMAL_FRACTION_DIGITS);

  // `product` is scaled by 10^16; micro-USD is 10^6, so divide by 10^10 and round up.
  const divisor = 10n ** BigInt(2 * DECIMAL_FRACTION_DIGITS - 6);

  return (product + divisor - 1n) / divisor;
}
