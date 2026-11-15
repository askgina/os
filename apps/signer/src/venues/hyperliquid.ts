import { createHash } from "node:crypto";
import {
  Address,
  ApprovalId,
  Cloid,
  type Decimal,
  Hex32,
  HyperliquidOrderOperation,
  PositiveDecimal,
  VenueNetwork,
} from "@askgina/os-protocol";
import { concatBytes, hashTypedData, keccak256, numberToBytes } from "viem";
import { encodeMsgpack, MsgpackMap } from "./msgpack.ts";

/**
 * The builders for what the signer signs at Hyperliquid. Each takes only values the signer has
 * already checked against an approved intent and its own records, and each refuses (throws) any
 * value outside what Hyperliquid documents, so nothing malformed is ever hashed.
 *
 * The shapes follow `hyperliquid-python-sdk` at `2fdb18f9517675ea03695a0962bd19eece9c83f0`
 * (`hyperliquid/utils/signing.py`); `test/hyperliquid-encoding.test.ts` reproduces its vectors.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The EIP-712 domain every L1 action (`order`, `cancelByCloid`) is signed in. */
export const HYPERLIQUID_L1_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: ZERO_ADDRESS,
} as const;

/** The domain type both domains here use, written out for OWS (viem derives it from the domain). */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The chain id a user-signed action names in its domain and as `signatureChainId`. */
const USER_SIGNED_CHAIN_ID = {
  "hyperliquid:testnet": 421_614,
  "hyperliquid:mainnet": 42_161,
} as const satisfies Record<VenueNetwork, number>;

const HYPERLIQUID_CHAIN = {
  "hyperliquid:testnet": "Testnet",
  "hyperliquid:mainnet": "Mainnet",
} as const satisfies Record<VenueNetwork, string>;

const CLOID_TAG = "askgina.os/v1/hyperliquid-cloid\n";

/**
 * The client order id of the one order an approval may place: the first 16 bytes of
 * `SHA-256("askgina.os/v1/hyperliquid-cloid\n" + approvalId)`. Derived, not stored first, so the
 * order can be found at the venue by its approval id after a crash.
 */
export function cloidFor(approvalId: ApprovalId): Cloid {
  const id = ApprovalId.parse(approvalId);
  const digest = createHash("sha256")
    .update(CLOID_TAG + id)
    .digest("hex");
  return `0x${digest.slice(0, 32)}`;
}

/**
 * The `order` action for one limit order, keys in the order the venue hashes them. `grouping` is
 * always `"na"` (a priority grouping is charged from the account's staking balance) and there is
 * never a `builder`.
 */
export function orderAction(operation: HyperliquidOrderOperation, cloid: Cloid): MsgpackMap {
  const order = HyperliquidOrderOperation.parse(operation);
  return new MsgpackMap([
    ["type", "order"],
    [
      "orders",
      [
        new MsgpackMap([
          ["a", order.asset],
          ["b", order.isBuy],
          ["p", order.limitPx],
          ["s", order.size],
          ["r", order.reduceOnly],
          ["t", new MsgpackMap([["limit", new MsgpackMap([["tif", order.tif]])]])],
          ["c", Cloid.parse(cloid)],
        ]),
      ],
    ],
    ["grouping", "na"],
  ]);
}

/**
 * The `cancelByCloid` action for one order. No `f` key: Hyperliquid rejects `f: false`, and this
 * plan never asks for anything else.
 */
export function cancelByCloidAction(asset: number, cloid: Cloid): MsgpackMap {
  const index = HyperliquidOrderOperation.shape.asset.parse(asset);
  return new MsgpackMap([
    ["type", "cancelByCloid"],
    [
      "cancels",
      [
        new MsgpackMap([
          ["asset", index],
          ["cloid", Cloid.parse(cloid)],
        ]),
      ],
    ],
  ]);
}

function uint64(value: number, what: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
  }
  return numberToBytes(value, { size: 8 });
}

/**
 * The hash an L1 action's signature commits to, Hyperliquid's "connection id":
 * `keccak256(msgpack(action) ‖ uint64be(nonce) ‖ 0x00 ‖ [0x00 ‖ uint64be(expiresAfter)])`. The
 * `0x00` after the nonce says there is no vault address; this signer never trades for a vault.
 */
export function l1ActionHash(
  action: MsgpackMap,
  nonce: number,
  expiresAfter: number | null,
): Hex32 {
  const parts = [encodeMsgpack(action), uint64(nonce, "nonce"), Uint8Array.of(0)];
  if (expiresAfter !== null) parts.push(Uint8Array.of(0), uint64(expiresAfter, "expiresAfter"));
  return keccak256(concatBytes(parts));
}

/**
 * The EIP-712 typed data of an L1 action: an `Agent` whose `connectionId` is the action hash. In
 * viem's form, without the `EIP712Domain` type, which viem derives from the domain's fields;
 * `eip712Json` writes it out.
 */
export function l1TypedData(connectionId: Hex32, network: VenueNetwork) {
  return {
    domain: HYPERLIQUID_L1_DOMAIN,
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: VenueNetwork.parse(network) === "hyperliquid:mainnet" ? "a" : "b",
      connectionId: Hex32.parse(connectionId),
    },
  } as const;
}

function withdrawFields(
  network: VenueNetwork,
  destination: Address,
  amount: Decimal,
  time: number,
) {
  const venue = VenueNetwork.parse(network);
  uint64(time, "time");
  return {
    hyperliquidChain: HYPERLIQUID_CHAIN[venue],
    chainId: USER_SIGNED_CHAIN_ID[venue],
    destination: Address.parse(destination.toLowerCase()),
    amount: PositiveDecimal.parse(amount),
    time,
  };
}

/**
 * The EIP-712 typed data of a `withdraw3`, a user-signed action: domain
 * `HyperliquidSignTransaction`, chain id 421614 on testnet and 42161 on mainnet. In viem's form,
 * like `l1TypedData`.
 */
export function withdrawTypedData(
  network: VenueNetwork,
  destination: Address,
  amount: Decimal,
  time: number,
) {
  const fields = withdrawFields(network, destination, amount, time);
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: fields.chainId,
      verifyingContract: ZERO_ADDRESS,
    },
    types: {
      "HyperliquidTransaction:Withdraw": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:Withdraw",
    message: {
      hyperliquidChain: fields.hyperliquidChain,
      destination: fields.destination,
      amount: fields.amount,
      time: BigInt(fields.time),
    },
  } as const;
}

/** The `withdraw3` action as the request body carries it, matching `withdrawTypedData`. */
export function withdrawAction(
  network: VenueNetwork,
  destination: Address,
  amount: Decimal,
  time: number,
) {
  const fields = withdrawFields(network, destination, amount, time);
  return {
    type: "withdraw3",
    hyperliquidChain: fields.hyperliquidChain,
    signatureChainId: `0x${fields.chainId.toString(16)}`,
    amount: fields.amount,
    time: fields.time,
    destination: fields.destination,
  } as const;
}

/**
 * The nonce for the next action: the clock in milliseconds, but always above the last nonce this
 * wallet used, so two actions signed in one millisecond or after the clock stepped back still
 * get distinct, increasing nonces.
 */
export function nextNonce(lastNonce: number | null, nowMs: number): number {
  uint64(nowMs, "nowMs");
  if (lastNonce === null) return nowMs;
  uint64(lastNonce, "lastNonce");
  const next = Math.max(nowMs, lastNonce + 1);
  uint64(next, "nonce");
  return next;
}

/** What the vault may sign at Hyperliquid: an L1 action's hash or a withdrawal. */
export type HyperliquidPayload =
  | { kind: "l1"; network: VenueNetwork; connectionId: Hex32 }
  | {
      kind: "withdraw";
      network: VenueNetwork;
      destination: Address;
      amount: Decimal;
      time: number;
    };

/** A Hyperliquid signature in the form the venue's request body carries it. */
export type HyperliquidSignature = { r: Hex32; s: Hex32; v: 27 | 28 };

/** The typed data of a payload, built here and nowhere else. */
export function payloadTypedData(payload: HyperliquidPayload) {
  return payload.kind === "l1"
    ? l1TypedData(payload.connectionId, payload.network)
    : withdrawTypedData(payload.network, payload.destination, payload.amount, payload.time);
}

/** The EIP-712 digest of a payload, computed by viem: what its signature must recover over. */
export function payloadDigest(payload: HyperliquidPayload): Hex32 {
  return payload.kind === "l1"
    ? hashTypedData(l1TypedData(payload.connectionId, payload.network))
    : hashTypedData(
        withdrawTypedData(payload.network, payload.destination, payload.amount, payload.time),
      );
}

/**
 * A payload's typed data as `eth_signTypedData_v4` JSON for OWS: the `EIP712Domain` type written
 * out and every integer (chain id, `time`) a JSON number; each is a safe integer, checked when the
 * typed data was built. Returns the chain argument OWS checks the domain against.
 */
export function eip712Json(payload: HyperliquidPayload): {
  chain: `eip155:${number}`;
  json: string;
} {
  const typedData = payloadTypedData(payload);
  return {
    chain: `eip155:${typedData.domain.chainId}`,
    json: JSON.stringify(
      { ...typedData, types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...typedData.types } },
      (_key, value) => (typeof value === "bigint" ? Number(value) : value),
    ),
  };
}
