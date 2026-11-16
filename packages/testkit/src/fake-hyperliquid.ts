/**
 * TEST EQUIPMENT. A fake Hyperliquid venue for tests and the end-to-end release gates. It holds
 * no funds, talks to no network and must never be deployed or pointed at by a real wallet.
 *
 * It behaves like the venue's `POST /exchange` and `POST /info` closely enough to prove the
 * signer's signatures end to end without calling the real venue (specs/non-evm-operations.md,
 * Milestone 6). Its point is that it verifies on its own: it recomputes every signing hash with
 * `@msgpack/msgpack` (through `./msgpack.ts`) and viem from the JSON it receives, and never
 * imports the signer's encoder. The venue's own SDK vectors prove this module
 * (`packages/testkit/test/fake-hyperliquid.test.ts`).
 *
 * What it does, as the venue does:
 * - `order` and `cancelByCloid` are L1 actions: keccak256(msgpack(action) ‖ nonce u64 BE ‖ vault
 *   marker ‖ [0x00 ‖ expiresAfter u64 BE]) is the `connectionId` of an EIP-712 `Agent` message
 *   (domain `Exchange`, version 1, chain 1337), `source` "b" on testnet and "a" on mainnet.
 *   `withdraw3` is user-signed: its fields are an EIP-712 `HyperliquidTransaction:Withdraw`
 *   message in domain `HyperliquidSignTransaction`, chain `signatureChainId`.
 * - The recovered address is the account. An address nobody seeded answers
 *   "User or API Wallet 0x… does not exist.", the venue's answer to a wrong signature.
 * - Nonces: within (T − 2 days, T + 1 day) of the venue's clock; the 100 highest per signer are
 *   kept; a used nonce, or one below all of a full set, is refused. A nonce is used once the
 *   signature, account, expiry and window checks pass, whatever the action's own result.
 * - An L1 action after its `expiresAfter` is refused. A withdrawal's nonce is its `time`.
 * - Orders are kept by cloid. Price and size follow the perpetual tick and lot rules; the
 *   minimum notional is $10; IOC and GTC orders that cross the configured book fill at their
 *   limit price; GTC and ALO orders that do not cross rest; an ALO that would cross and an IOC
 *   that does not are rejected; refused orders are kept with the venue's historical status
 *   (`tickRejected`, `minTradeNtlRejected`, …) so `orderStatus` finds them by cloid.
 * - A withdrawal pays the bridge's 1 USDC out of its amount and must be larger than it.
 * - `/info` answers `meta`, `orderStatus` (by order id or cloid), `clearinghouseState`,
 *   `openOrders` and `userNonFundingLedgerUpdates`, whose entries here are the withdrawals
 *   taken, each with its nonce, from `startTime` (to `endTime`, when given) in milliseconds.
 *
 * Where it is stricter than the venue, so a request it accepts is one the venue would accept:
 * an action's keys must be exactly the venue's fields in the venue's order (the order the SDK
 * hashes); prices and sizes must be canonical decimals (no trailing zeros); `v` must be 27 or
 * 28; a withdrawal's destination must be lower-case; `vaultAddress` must be null; only grouping
 * "na" and limit orders exist. Anything else answers HTTP 422, as the venue answers a body it
 * cannot read.
 *
 * Wording: "User or API Wallet … does not exist.", "Invalid nonce: duplicate nonce N", the
 * order error statuses and the withdrawal refusals are the venue's. The texts for an expired
 * action, a nonce outside the window or too low, a wrong `hyperliquidChain` and an undecodable
 * signature are this fake's own; a client must not depend on any error text.
 *
 * Simplifications: one cross-margin account per address at leverage min(20, maxLeverage); a
 * position's mark is its entry price (no unrealised profit); no fees except the withdrawal's;
 * no funding, liquidation, trigger orders or partial fills.
 *
 * Control (for the gates; `/control/*` over HTTP, or the methods of the same name in process):
 * seed an account, set the asset metadata and the book, fill a resting order, move the clock,
 * make the next requests fail, and read every exchange request, order, cancel and withdrawal.
 */
import {
  type Address,
  concatBytes,
  type Hex,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverAddress,
} from "viem";
import { z } from "zod";
import { referenceMsgpackEncode } from "./msgpack.ts";

export type FakeNetwork = "testnet" | "mainnet";

/** One entry of `meta.universe`; the asset index is its position. */
export interface FakeAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export interface FakeHyperliquidOptions {
  /** Which network's signatures it accepts. Default testnet. */
  network?: FakeNetwork;
  /** The venue's clock in milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  /** The perpetual universe. Default `DEFAULT_FAKE_UNIVERSE`. */
  universe?: readonly FakeAsset[];
}

/**
 * The first entries of the testnet universe as the SDK's vectors use them (asset 3 BTC, 4 ETH).
 * Not read from the venue: a test that depends on metadata sets its own.
 */
export const DEFAULT_FAKE_UNIVERSE: readonly FakeAsset[] = [
  { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  { name: "APT", szDecimals: 2, maxLeverage: 10 },
  { name: "ATOM", szDecimals: 2, maxLeverage: 10 },
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
];

/** The largest request body read; a venue request is a few hundred bytes. */
export const FAKE_HYPERLIQUID_MAX_BODY_BYTES = 64 * 1024;

/**
 * A failure the next matching requests get instead of the normal answer.
 * - `error`: `/exchange` answers `{"status":"err","response": response}` and does nothing.
 * - `http`: answers HTTP `status` and does nothing.
 * - `drop`: no answer, the connection is dropped; on `/exchange` the action is applied first,
 *   as when the venue took an order and the response was lost.
 */
export type FakeFailure =
  | { endpoint?: "exchange"; mode: "error"; response: string; count?: number }
  | { endpoint?: "exchange" | "info"; mode: "http"; status: number; count?: number }
  | { endpoint?: "exchange" | "info"; mode: "drop"; count?: number };

export interface FakeHttpRequest {
  method: string;
  /** The path only, without query. */
  path: string;
  body: string;
}

export type FakeHttpAnswer =
  | { kind: "answer"; status: number; contentType: string; body: string }
  | { kind: "drop" };

/** One request to `/exchange`, oldest first. */
export interface ExchangeRecord {
  /** Venue time, milliseconds since the epoch. */
  receivedAt: number;
  /** The body exactly as received. */
  body: string;
  /** The HTTP status answered; 0 when the connection was dropped. */
  status: number;
  /** The body answered, or the one that would have been when dropped. */
  response: string;
  dropped: boolean;
  /** The recovered signer, lower-case, when the signature recovered. */
  signer: Address | null;
  actionType: string | null;
  nonce: number | null;
  /**
   * The venue took the action: signature, account, expiry and nonce checks passed and the nonce
   * is used. The response still says what became of it (an order's status, a refused withdrawal).
   */
  accepted: boolean;
}

export type FakeOrderStatus =
  | "open"
  | "filled"
  | "canceled"
  | "tickRejected"
  | "minTradeNtlRejected"
  | "perpMarginRejected"
  | "reduceOnlyRejected"
  | "badAloPxRejected"
  | "iocCancelRejected";

export type FakeTif = "Gtc" | "Ioc" | "Alo";

export interface FakeOrder {
  user: Address;
  oid: number;
  /** Lower-case, or null for an order without one. */
  cloid: Hex | null;
  asset: number;
  coin: string;
  isBuy: boolean;
  limitPx: string;
  size: string;
  filledSize: string;
  reduceOnly: boolean;
  tif: FakeTif;
  status: FakeOrderStatus;
  timestamp: number;
  statusTimestamp: number;
  nonce: number;
  expiresAfter: number | null;
}

export interface FakeCancel {
  user: Address;
  asset: number;
  cloid: Hex;
  nonce: number;
  expiresAfter: number | null;
  receivedAt: number;
  /** "success", or the venue's error for this cancel. */
  result: string;
}

export interface FakeWithdrawal {
  user: Address;
  destination: Address;
  /** As signed; the bridge's 1 USDC fee comes out of it. */
  amount: string;
  nonce: number;
  receivedAt: number;
}

/** A limit order as the venue reads it: `a` asset, `b` buy, `p` price, `s` size, `r` reduce-only. */
export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: FakeTif } };
  c?: Hex;
}

export type ExchangeAction =
  | { type: "order"; orders: OrderWire[]; grouping: "na" }
  | { type: "cancelByCloid"; cancels: { asset: number; cloid: Hex }[] }
  | WithdrawAction;

export interface WithdrawAction {
  type: "withdraw3";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: Hex;
  amount: string;
  time: number;
  destination: Address;
}

/**
 * A request body as the venue reads it. `action` holds the received fields; an order's or a
 * cancel's keys are in the order received, the order the venue hashes.
 */
export interface ExchangeBody {
  action: ExchangeAction;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
  vaultAddress: Address | null;
  expiresAfter: number | null;
}

/** What `recoverExchangeSigner` needs; `action` may be any action the venue hashes as L1. */
export interface SignedAction {
  action: unknown;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
  vaultAddress?: Address | null;
  expiresAfter?: number | null;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Fixed-point scale for prices, sizes and USDC: 8 fraction digits, Hyperliquid's most. */
const SCALE = 100_000_000n;

const MAX_FRACTION_DIGITS = 8;

/** Perpetual prices take at most `6 − szDecimals` fraction digits. */
const MAX_PERP_PRICE_DECIMALS = 6;

const MAX_SIGNIFICANT_FIGURES = 5;

const NONCES_KEPT = 100;

const NONCE_WINDOW_BEFORE_MS = 2 * 86_400_000;

const NONCE_WINDOW_AFTER_MS = 86_400_000;

const DEFAULT_LEVERAGE = 20;

/** $10, in the scale of a size times a price. */
const MIN_NOTIONAL = 10n * SCALE * SCALE;

const WITHDRAWAL_FEE = 1n * SCALE;

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;

const CLOID = /^0x[0-9a-fA-F]{32}$/;

const SIGNATURE_WORD = /^0x[0-9a-fA-F]{1,64}$/;

const HEX_NUMBER = /^0x[0-9a-fA-F]{1,16}$/;

// --- signing hashes, independent of the signer's encoder -------------------------------------

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));

  return bytes;
}

/**
 * The L1 action hash (the phantom agent's `connectionId`), over the action exactly as given:
 * keccak256(msgpack(action) ‖ nonce ‖ 0x00, or 0x01 ‖ vault address ‖ [0x00 ‖ expiresAfter]).
 */
export function l1ActionHash<Action>(
  action: Action,
  nonce: number,
  vaultAddress: Address | null,
  expiresAfter: number | null,
): Hex {
  const parts: Uint8Array[] = [referenceMsgpackEncode(action), u64(nonce)];

  if (vaultAddress === null) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), hexToBytes(vaultAddress));

  if (expiresAfter !== null) parts.push(Uint8Array.of(0), u64(expiresAfter));

  return keccak256(concatBytes(parts));
}

function l1SigningHash(connectionId: Hex, network: FakeNetwork): Hex {
  return hashTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: network === "mainnet" ? "a" : "b", connectionId },
  });
}

function withdrawSigningHash(action: WithdrawAction): Hex {
  return hashTypedData({
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(action.signatureChainId, 16),
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
      hyperliquidChain: action.hyperliquidChain,
      destination: action.destination,
      amount: action.amount,
      time: BigInt(action.time),
    },
  });
}

/** Hex in lower case. Every hex text here starts with a lower-case `0x`; only digits change. */
function lowerHex(value: Hex): Hex {
  return `0x${value.slice(2).toLowerCase()}`;
}

/**
 * The address that signed a request, lower-case, as the venue of `network` recovers it. A
 * `withdraw3` is checked as user-signed, every other action as L1. Throws when the signature
 * cannot be recovered at all.
 */
export async function recoverExchangeSigner(
  request: SignedAction,
  network: FakeNetwork,
): Promise<Address> {
  let hash: Hex;
  const action = ReceivedObject.safeParse(request.action);

  if (action.success && action.data.fields.get("type") === "withdraw3") {
    const withdrawal = readWithdraw(action.data);

    if (!withdrawal.ok) throw new TypeError(`not a withdrawal: ${withdrawal.problem}`);
    hash = withdrawSigningHash(withdrawal.value);
  } else {
    const connectionId = l1ActionHash(
      request.action,
      request.nonce,
      request.vaultAddress ?? null,
      request.expiresAfter ?? null,
    );

    hash = l1SigningHash(connectionId, network);
  }

  const { r, s, v } = request.signature;
  const signer = await recoverAddress({ hash, signature: { r, s, v: BigInt(v) } });

  return lowerHex(signer);
}

// --- reading a request body ------------------------------------------------------------------

/** A JSON object's keys in the order received, and its fields by key. */
interface Received {
  keys: string[];
  fields: ReadonlyMap<string, unknown>;
}

/**
 * A JSON object, read from the object itself: a decoded copy would list the declared keys first
 * and drop a `__proto__` key, and the venue's rules here depend on the keys as received.
 */
const ReceivedObject = z
  .instanceof(Object)
  .refine((value) => !Array.isArray(value) && !(value instanceof Function))
  .transform((value): Received => {
    const entries = Object.entries(value);

    return { keys: entries.map(([key]) => key), fields: new Map(entries) };
  });

/** A non-empty JSON array; its items are read one by one. */
const NonEmptyList = z.array(z.unknown()).min(1);

/** A safe integer of at least 0: an asset index or milliseconds. */
const Uint = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);

const Decimal = z.string().regex(CANONICAL_DECIMAL);

/** `0x` text that matches `pattern`; every pattern here starts with `0x`. */
function hexText(pattern: RegExp) {
  return z.templateLiteral(["0x", z.string()]).refine((value) => pattern.test(value));
}

const AddressText = hexText(ADDRESS);

const LowerAddressText = hexText(LOWER_ADDRESS);

const CloidText = hexText(CLOID);

const SignatureWord = hexText(SIGNATURE_WORD);

const ChainIdText = hexText(HEX_NUMBER);

const Tif = z.enum(["Gtc", "Ioc", "Alo"]);

const HyperliquidChain = z.enum(["Mainnet", "Testnet"]);

const RecoveryId = z.union([z.literal(27), z.literal(28)]);

/** A value read from a request, or why it cannot be read. */
type Read<T> = { ok: true; value: T } | { ok: false; problem: string };

function accept<T>(value: T): Read<T> {
  return { ok: true, value };
}

function refuse<T>(problem: string): Read<T> {
  return { ok: false, problem };
}

/** Null when `value` has exactly `fields` in that order; `optional` fields may be missing. */
function fieldsProblem(
  value: Received,
  fields: readonly string[],
  optional: readonly string[] = [],
): string | null {
  const { keys } = value;
  const expected = fields.filter((field) => !optional.includes(field) || value.fields.has(field));

  if (keys.length === expected.length && keys.every((key, index) => key === expected[index])) {
    return null;
  }

  return `expected the fields ${expected.join(", ")} in that order, got ${keys.join(", ")}`;
}

/** One order, rebuilt from the checked fields in the order they were received. */
function readOrderWire(order: Received, where: string): Read<OrderWire> {
  const orderFields = fieldsProblem(order, ["a", "b", "p", "s", "r", "t", "c"], ["c"]);

  if (orderFields !== null) return refuse(`${where}: ${orderFields}`);
  const a = Uint.safeParse(order.fields.get("a"));

  if (!a.success) return refuse(`${where}.a: expected an asset index`);
  const b = z.boolean().safeParse(order.fields.get("b"));
  const r = z.boolean().safeParse(order.fields.get("r"));

  if (!b.success || !r.success) return refuse(`${where}: b and r must be booleans`);
  const p = Decimal.safeParse(order.fields.get("p"));
  const s = Decimal.safeParse(order.fields.get("s"));

  if (!p.success || !s.success) {
    return refuse(`${where}: p and s must be decimals with trailing zeros removed`);
  }

  const type = ReceivedObject.safeParse(order.fields.get("t"));

  if (!type.success || fieldsProblem(type.data, ["limit"]) !== null) {
    return refuse(`${where}.t: only limit orders exist here`);
  }

  const limit = ReceivedObject.safeParse(type.data.fields.get("limit"));

  if (!limit.success) return refuse(`${where}.t: only limit orders exist here`);
  const tif = Tif.safeParse(limit.data.fields.get("tif"));

  if (fieldsProblem(limit.data, ["tif"]) !== null || !tif.success) {
    return refuse(`${where}.t.limit: expected tif Gtc, Ioc or Alo`);
  }

  const wire: OrderWire = {
    a: a.data,
    b: b.data,
    p: p.data,
    s: s.data,
    r: r.data,
    t: { limit: { tif: tif.data } },
  };

  if (order.fields.has("c")) {
    const cloid = CloidText.safeParse(order.fields.get("c"));

    if (!cloid.success) return refuse(`${where}.c: expected 16 bytes of hex`);
    wire.c = cloid.data;
  }

  return accept(wire);
}

function readOrderAction(action: Received): Read<ExchangeAction> {
  const fields = fieldsProblem(action, ["type", "orders", "grouping"]);

  if (fields !== null) return refuse(fields);

  if (action.fields.get("grouping") !== "na") return refuse('grouping: only "na" exists here');
  const list = NonEmptyList.safeParse(action.fields.get("orders"));

  if (!list.success) return refuse("orders: expected a non-empty array");
  const orders: OrderWire[] = [];

  for (const [index, item] of list.data.entries()) {
    const where = `orders[${index}]`;
    const order = ReceivedObject.safeParse(item);

    if (!order.success) return refuse(`${where}: expected an object`);
    const wire = readOrderWire(order.data, where);

    if (!wire.ok) return wire;
    orders.push(wire.value);
  }

  return accept({ type: "order", orders, grouping: "na" });
}

function readCancelAction(action: Received): Read<ExchangeAction> {
  const fields = fieldsProblem(action, ["type", "cancels"]);

  if (fields !== null) return refuse(fields);
  const list = NonEmptyList.safeParse(action.fields.get("cancels"));

  if (!list.success) return refuse("cancels: expected a non-empty array");
  const cancels: { asset: number; cloid: Hex }[] = [];

  for (const [index, item] of list.data.entries()) {
    const cancel = ReceivedObject.safeParse(item);

    if (!cancel.success) return refuse(`cancels[${index}]: expected an object`);
    const cancelFields = fieldsProblem(cancel.data, ["asset", "cloid"]);

    if (cancelFields !== null) return refuse(`cancels[${index}]: ${cancelFields}`);
    const asset = Uint.safeParse(cancel.data.fields.get("asset"));

    if (!asset.success) return refuse(`cancels[${index}].asset: expected an asset index`);
    const cloid = CloidText.safeParse(cancel.data.fields.get("cloid"));

    if (!cloid.success) return refuse(`cancels[${index}].cloid: expected 16 bytes of hex`);
    cancels.push({ asset: asset.data, cloid: cloid.data });
  }

  return accept({ type: "cancelByCloid", cancels });
}

/** The fields are named in the typed data, so their order does not matter. */
function readWithdraw(action: Received): Read<WithdrawAction> {
  const keys = [...action.keys].sort();

  const expected = [
    "amount",
    "destination",
    "hyperliquidChain",
    "signatureChainId",
    "time",
    "type",
  ];

  if (keys.join() !== expected.join()) return refuse(`expected the fields ${expected.join(", ")}`);

  if (action.fields.get("type") !== "withdraw3") return refuse("type: expected withdraw3");
  const hyperliquidChain = HyperliquidChain.safeParse(action.fields.get("hyperliquidChain"));

  if (!hyperliquidChain.success) return refuse("hyperliquidChain: expected Mainnet or Testnet");
  const signatureChainId = ChainIdText.safeParse(action.fields.get("signatureChainId"));

  if (!signatureChainId.success) return refuse("signatureChainId: expected a hex chain id");
  const amount = Decimal.safeParse(action.fields.get("amount"));

  if (!amount.success) return refuse("amount: expected a decimal with trailing zeros removed");
  const time = Uint.safeParse(action.fields.get("time"));

  if (!time.success) return refuse("time: expected milliseconds");
  const destination = LowerAddressText.safeParse(action.fields.get("destination"));

  if (!destination.success) return refuse("destination: expected a lower-case address");

  return accept({
    type: "withdraw3",
    hyperliquidChain: hyperliquidChain.data,
    signatureChainId: signatureChainId.data,
    amount: amount.data,
    time: time.data,
    destination: destination.data,
  });
}

/** The action of a body, by its `type`, with the body's own rules for a withdrawal. */
function readAction(
  action: Received,
  nonce: number,
  expiresAfter: number | null,
): Read<ExchangeAction> {
  const type = action.fields.get("type");

  if (type === "order") return readOrderAction(action);

  if (type === "cancelByCloid") return readCancelAction(action);

  if (type !== "withdraw3") return refuse(`unknown variant \`${String(type)}\``);
  const withdrawal = readWithdraw(action);

  if (!withdrawal.ok) return withdrawal;

  if (expiresAfter !== null) return refuse("expiresAfter: a user-signed action has none");

  if (withdrawal.value.time !== nonce) return refuse("nonce: must equal action.time");

  return withdrawal;
}

/** `parseExchangeBody`, with the refusal kept apart from the body. */
function readExchangeBody(text: string): Read<ExchangeBody> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return refuse("expected a JSON object");
  }

  const body = ReceivedObject.safeParse(value);

  if (!body.success) return refuse("expected a JSON object");
  const known = ["action", "nonce", "signature", "vaultAddress", "expiresAfter"];
  const unknown = body.data.keys.find((key) => !known.includes(key));

  if (unknown !== undefined) return refuse(`unknown field \`${unknown}\``);
  const { fields } = body.data;
  const nonce = Uint.safeParse(fields.get("nonce"));

  if (!nonce.success) return refuse("nonce: expected milliseconds");
  const vaultAddress = AddressText.nullable().safeParse(fields.get("vaultAddress") ?? null);

  if (!vaultAddress.success) return refuse("vaultAddress: expected an address or null");
  const expiresAfter = Uint.nullable().safeParse(fields.get("expiresAfter") ?? null);

  if (!expiresAfter.success) return refuse("expiresAfter: expected milliseconds or null");
  const signature = ReceivedObject.safeParse(fields.get("signature"));

  if (!signature.success || [...signature.data.keys].sort().join() !== "r,s,v") {
    return refuse("signature: expected r, s and v");
  }

  const r = SignatureWord.safeParse(signature.data.fields.get("r"));

  if (!r.success) return refuse("signature.r: expected hex");
  const s = SignatureWord.safeParse(signature.data.fields.get("s"));

  if (!s.success) return refuse("signature.s: expected hex");
  const v = RecoveryId.safeParse(signature.data.fields.get("v"));

  if (!v.success) return refuse("signature.v: expected 27 or 28");
  const received = ReceivedObject.safeParse(fields.get("action"));

  if (!received.success) return refuse("action: expected an object");
  const action = readAction(received.data, nonce.data, expiresAfter.data);

  if (!action.ok) return refuse(`action: ${action.problem}`);

  return accept({
    action: action.value,
    nonce: nonce.data,
    signature: { r: r.data, s: s.data, v: v.data },
    vaultAddress: vaultAddress.data,
    expiresAfter: expiresAfter.data,
  });
}

/**
 * Reads an `/exchange` body as the venue would, or says why it cannot (the venue answers that
 * with HTTP 422). The returned `action` is rebuilt from its checked fields, keys in the order
 * the fake requires (for an order or a cancel, the order received).
 */
export function parseExchangeBody(text: string): ExchangeBody | string {
  const read = readExchangeBody(text);

  return read.ok ? read.value : read.problem;
}

// --- numbers ---------------------------------------------------------------------------------

function fractionDigits(value: string): number {
  const dot = value.indexOf(".");

  return dot === -1 ? 0 : value.length - dot - 1;
}

/** A canonical decimal times 10^8, or null when it has more than 8 fraction digits. */
function toFixed(value: string): bigint | null {
  if (!CANONICAL_DECIMAL.test(value) || fractionDigits(value) > MAX_FRACTION_DIGITS) return null;
  const [whole = "0", fraction = ""] = value.split(".");

  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(MAX_FRACTION_DIGITS, "0"));
}

/** The venue's way of writing a number: no trailing zeros, and "0.0" for zero. */
function formatFixed(value: bigint): string {
  if (value === 0n) return "0.0";
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % SCALE).toString().padStart(MAX_FRACTION_DIGITS, "0");
  const trimmed = fraction.replace(/0+$/, "");

  return `${sign}${magnitude / SCALE}${trimmed === "" ? "" : `.${trimmed}`}`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Integer prices are always valid; others take ≤ 5 significant figures and ≤ 6 − szDecimals places. */
function validPrice(price: string, szDecimals: number): boolean {
  if (!price.includes(".")) return true;

  if (fractionDigits(price) > MAX_PERP_PRICE_DECIMALS - szDecimals) return false;

  return price.replace(".", "").replace(/^0+/, "").length <= MAX_SIGNIFICANT_FIGURES;
}

function leverageOf(asset: FakeAsset | undefined): number {
  return Math.min(DEFAULT_LEVERAGE, asset?.maxLeverage ?? 1);
}

/** Margin for a size at a price, in the 10^8 scale, rounded up. */
function marginFor(size: bigint, price: bigint, leverage: number): bigint {
  const divisor = SCALE * BigInt(leverage);

  return (size * price + divisor - 1n) / divisor;
}

// --- state -----------------------------------------------------------------------------------

interface Position {
  /** Signed size: positive long, negative short. */
  szi: bigint;
  entryPx: bigint;
}

interface Account {
  address: Address;
  usdc: bigint;
  positions: Map<number, Position>;
  /** The highest nonces used, ascending, at most `NONCES_KEPT`. */
  nonces: number[];
}

interface OrderState extends FakeOrder {
  sizeFx: bigint;
  priceFx: bigint;
  filledFx: bigint;
  reservedMargin: bigint;
}

interface Book {
  bid: bigint | null;
  ask: bigint | null;
}

type QueuedFailure = FakeFailure & { remaining: number };

/** An order's ids in the venue's answer, `cloid` as the order sent it. */
interface PlacedIds {
  oid: number;
  cloid?: Hex;
}

/** One order's status in the venue's answer to `order`. */
type OrderResult =
  | { error: string }
  | { resting: PlacedIds }
  | { filled: PlacedIds & { totalSz: string; avgPx: string } };

/** One cancel's status in the venue's answer to `cancelByCloid`. */
type CancelResult = "success" | { error: string };

/** An entry of `meta.universe` as the venue answers it: `isDelisted` only when it is. */
interface MetaEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: true;
}

/** A universe entry before `readAsset` checks it: a caller's, or one posted to `/control/meta`. */
interface AssetFields {
  name?: unknown;
  szDecimals?: unknown;
  maxLeverage?: unknown;
  isDelisted?: unknown;
}

const AssetName = z.string().min(1);

const SzDecimals = z
  .number()
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 6);

const MaxLeverage = z.number().refine((value) => Number.isInteger(value) && value >= 1);

/** A checked copy of a universe entry; throws, naming the first field that is wrong. */
function readAsset(fields: AssetFields): FakeAsset {
  const name = AssetName.safeParse(fields.name);

  if (!name.success) throw new TypeError("name");
  const szDecimals = SzDecimals.safeParse(fields.szDecimals);

  if (!szDecimals.success) throw new TypeError("szDecimals: expected 0 to 6");
  const maxLeverage = MaxLeverage.safeParse(fields.maxLeverage);

  if (!maxLeverage.success) throw new TypeError("maxLeverage: expected a positive integer");
  const isDelisted = z.boolean().optional().safeParse(fields.isDelisted);

  if (!isDelisted.success) throw new TypeError("isDelisted: expected a boolean");

  const asset: FakeAsset = {
    name: name.data,
    szDecimals: szDecimals.data,
    maxLeverage: maxLeverage.data,
  };

  if (isDelisted.data !== undefined) asset.isDelisted = isDelisted.data;

  return asset;
}

/** An `/info` request: the fields any request type reads. */
const InfoRequest = z.object({
  type: z.unknown().optional(),
  user: z.unknown().optional(),
  oid: z.unknown().optional(),
  startTime: z.unknown().optional(),
  endTime: z.unknown().optional(),
});

/** The fields a `/control/*` request reads; a body that is not a JSON object has none. */
const ControlFields = z
  .object({
    address: z.unknown().optional(),
    usdc: z.unknown().optional(),
    universe: z.unknown().optional(),
    asset: z.unknown().optional(),
    bid: z.unknown().optional(),
    ask: z.unknown().optional(),
    user: z.unknown().optional(),
    cloid: z.unknown().optional(),
    offsetMs: z.unknown().optional(),
    endpoint: z.unknown().optional(),
    mode: z.unknown().optional(),
    response: z.unknown().optional(),
    status: z.unknown().optional(),
    count: z.unknown().optional(),
  })
  .catch({});

type ControlFields = z.infer<typeof ControlFields>;

/** `/control/meta`'s universe: an array of objects, each checked by `readAsset`. */
const ControlUniverse = z.array(
  z.object({
    name: z.unknown().optional(),
    szDecimals: z.unknown().optional(),
    maxLeverage: z.unknown().optional(),
    isDelisted: z.unknown().optional(),
  }),
);

function text(status: number, body: string): FakeHttpAnswer {
  return { kind: "answer", status, contentType: "text/plain; charset=utf-8", body };
}

function json<Body>(status: number, body: Body): FakeHttpAnswer {
  return { kind: "answer", status, contentType: "application/json", body: JSON.stringify(body) };
}

function venueError(response: string): FakeHttpAnswer {
  return json(200, { status: "err", response });
}

function unreadable(problem: string): FakeHttpAnswer {
  return text(422, `Failed to deserialize the JSON body into the target type: ${problem}`);
}

function publicOrder(order: OrderState): FakeOrder {
  const { sizeFx: _s, priceFx: _p, filledFx: _f, reservedMargin: _m, ...rest } = order;

  return { ...rest };
}

export class FakeHyperliquid {
  readonly network: FakeNetwork;
  readonly #clock: () => number;
  readonly #initialUniverse: readonly FakeAsset[];
  #offsetMs = 0;
  #universe: FakeAsset[] = [];
  /** Keyed by lower-case address; `/info` and control requests look accounts up by any text. */
  #accounts = new Map<string, Account>();
  #books = new Map<number, Book>();
  #orders: OrderState[] = [];
  #cancels: FakeCancel[] = [];
  #withdrawals: FakeWithdrawal[] = [];
  #log: ExchangeRecord[] = [];
  #failures: QueuedFailure[] = [];
  #nextOid = 1;
  /** Requests are handled one at a time, as the venue orders actions in blocks. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FakeHyperliquidOptions = {}) {
    this.network = options.network ?? "testnet";
    this.#clock = options.now ?? Date.now;
    this.#initialUniverse = options.universe ?? DEFAULT_FAKE_UNIVERSE;
    this.setUniverse(this.#initialUniverse);
  }

  /** The venue's clock: the configured clock plus the control offset. */
  now(): number {
    return this.#clock() + this.#offsetMs;
  }

  /** Handles one HTTP request: `/exchange`, `/info`, `/healthz` and `/control/*`. */
  handle(request: FakeHttpRequest): Promise<FakeHttpAnswer> {
    const run = this.#queue.then(() => this.#route(request));
    this.#queue = run.catch(() => undefined);

    return run;
  }

  /**
   * A `fetch` that reaches this venue in process, whatever the origin: give it to a client as
   * its `fetch`. A dropped connection rejects with a `TypeError`, as `fetch` does.
   */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request === null ? input.toString() : request.url);
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    let body = "";

    if (init?.body !== undefined && init.body !== null) body = await new Response(init.body).text();
    else if (request !== null) body = await request.text();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const answer = await this.handle({ method, path: url.pathname, body });
    signal?.throwIfAborted();

    if (answer.kind === "drop") {
      throw new TypeError("fetch failed", {
        cause: new Error("the fake venue dropped the connection"),
      });
    }

    const noBody = answer.status === 204 || answer.status === 205 || answer.status === 304;

    return new Response(noBody ? null : answer.body, {
      status: answer.status,
      headers: noBody ? {} : { "content-type": answer.contentType },
    });
  };

  // --- control ---------------------------------------------------------------------------------

  /** Creates the account, or sets its USDC balance (the testnet faucet's mock USDC). */
  seedAccount(address: string, usdc: string): void {
    const checked = AddressText.safeParse(address);

    if (!checked.success) throw new TypeError("address: expected an address");
    const amount = toFixed(usdc);

    if (amount === null) throw new TypeError("usdc: expected a decimal");
    const key = lowerHex(checked.data);
    const account = this.#accounts.get(key);

    if (account) account.usdc = amount;
    else this.#accounts.set(key, { address: key, usdc: amount, positions: new Map(), nonces: [] });
  }

  setUniverse(universe: readonly FakeAsset[]): void {
    this.#universe = universe.map(readAsset);
  }

  /** The best bid and ask of an asset; null for an empty side. Orders that cross fill. */
  setBook(asset: number, book: { bid: string | null; ask: string | null }): void {
    if (!Uint.safeParse(asset).success) throw new TypeError("asset: expected an asset index");

    const side = (value: string | null, name: string): bigint | null => {
      if (value === null) return null;
      const fixed = toFixed(value);

      if (fixed === null || fixed === 0n) throw new TypeError(`${name}: expected a price`);

      return fixed;
    };

    this.#books.set(asset, { bid: side(book.bid, "bid"), ask: side(book.ask, "ask") });
  }

  /** Fills a resting order completely at its limit price. Null when no such open order exists. */
  fillOrder(user: string, cloid: string): FakeOrder | null {
    const order = this.#findOrder(user.toLowerCase(), cloid.toLowerCase());
    const account = this.#accounts.get(user.toLowerCase());

    if (order === undefined || order.status !== "open" || account === undefined) return null;
    order.reservedMargin = 0n;
    this.#fill(account, order);

    return publicOrder(order);
  }

  /** Moves the venue's clock, for example past an action's `expiresAfter`. */
  setClockOffset(offsetMs: number): void {
    if (!Number.isSafeInteger(offsetMs)) throw new TypeError("offsetMs: expected an integer");
    this.#offsetMs = offsetMs;
  }

  /** The next `count` (default 1) matching requests fail this way. */
  failNext(failure: FakeFailure): void {
    const count = failure.count ?? 1;

    if (!Number.isInteger(count) || count < 1) throw new TypeError("count: expected at least 1");

    if (failure.mode === "http" && (!Number.isInteger(failure.status) || failure.status < 400)) {
      throw new TypeError("status: expected an HTTP error status");
    }

    if (failure.mode === "error" && !z.string().safeParse(failure.response).success) {
      throw new TypeError("response: expected the venue's error text");
    }

    this.#failures.push({ ...failure, remaining: count });
  }

  /** Forgets everything: accounts, nonces, orders, books, records, failures and the offset. */
  reset(): void {
    this.#offsetMs = 0;
    this.setUniverse(this.#initialUniverse);
    this.#accounts.clear();
    this.#books.clear();
    this.#orders = [];
    this.#cancels = [];
    this.#withdrawals = [];
    this.#log = [];
    this.#failures = [];
    this.#nextOid = 1;
  }

  exchangeLog(): ExchangeRecord[] {
    return this.#log.map((record) => ({ ...record }));
  }

  orders(): FakeOrder[] {
    return this.#orders.map(publicOrder);
  }

  cancels(): FakeCancel[] {
    return this.#cancels.map((cancel) => ({ ...cancel }));
  }

  withdrawals(): FakeWithdrawal[] {
    return this.#withdrawals.map((withdrawal) => ({ ...withdrawal }));
  }

  // --- routing ---------------------------------------------------------------------------------

  async #route(request: FakeHttpRequest): Promise<FakeHttpAnswer> {
    if (request.body.length > FAKE_HYPERLIQUID_MAX_BODY_BYTES) return text(413, "too large");

    try {
      if (request.method === "GET" && request.path === "/healthz") return text(200, "ok");

      if (request.method === "POST" && request.path === "/exchange") {
        return await this.#exchange(request.body);
      }

      if (request.method === "POST" && request.path === "/info") return this.#info(request.body);

      if (request.path.startsWith("/control/")) return this.#control(request);

      return text(404, "not found");
    } catch (error) {
      return text(500, `fake venue failure: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  #takeFailure(endpoint: "exchange" | "info"): QueuedFailure | undefined {
    const failure = this.#failures.find((entry) => (entry.endpoint ?? "exchange") === endpoint);

    if (failure === undefined) return undefined;
    failure.remaining -= 1;

    if (failure.remaining === 0) this.#failures.splice(this.#failures.indexOf(failure), 1);

    return failure;
  }

  async #exchange(body: string): Promise<FakeHttpAnswer> {
    const record: ExchangeRecord = {
      receivedAt: this.now(),
      body,
      status: 0,
      response: "",
      dropped: false,
      signer: null,
      actionType: null,
      nonce: null,
      accepted: false,
    };

    this.#log.push(record);
    const failure = this.#takeFailure("exchange");
    let answer: FakeHttpAnswer;

    if (failure?.mode === "error") answer = venueError(failure.response);
    else if (failure?.mode === "http")
      answer = text(failure.status, "fake venue: injected failure");
    else answer = await this.#apply(body, record);

    if (answer.kind === "answer") {
      record.status = answer.status;
      record.response = answer.body;
    }

    if (failure?.mode === "drop") {
      record.status = 0;
      record.dropped = true;

      return { kind: "drop" };
    }

    return answer;
  }

  async #apply(text: string, record: ExchangeRecord): Promise<FakeHttpAnswer> {
    const read = readExchangeBody(text);

    if (!read.ok) return unreadable(read.problem);
    const body = read.value;
    record.actionType = body.action.type;
    record.nonce = body.nonce;

    const { action } = body;
    const chain = this.network === "mainnet" ? "Mainnet" : "Testnet";

    if (action.type === "withdraw3" && action.hyperliquidChain !== chain) {
      return venueError(
        `Invalid hyperliquidChain ${action.hyperliquidChain}: this venue is ${chain}`,
      );
    }

    let signer: Address;

    try {
      signer = await recoverExchangeSigner(body, this.network);
    } catch {
      return venueError("Invalid signature: no signer can be recovered");
    }

    record.signer = signer;
    const account = this.#accounts.get(signer);

    if (account === undefined) return venueError(`User or API Wallet ${signer} does not exist.`);

    if (body.vaultAddress !== null) {
      return venueError(`Vault not registered: ${body.vaultAddress.toLowerCase()}`);
    }

    const now = this.now();

    if (body.expiresAfter !== null && now > body.expiresAfter) {
      return venueError(`Action expired: expiresAfter ${body.expiresAfter} is before ${now}`);
    }

    const nonceProblem = this.#useNonce(account, body.nonce, now);

    if (nonceProblem !== null) return venueError(nonceProblem);
    record.accepted = true;

    if (action.type === "order") {
      const statuses = action.orders.map((wire) =>
        this.#placeOrder(account, wire, body.nonce, body.expiresAfter, now),
      );

      return json(200, { status: "ok", response: { type: "order", data: { statuses } } });
    }

    if (action.type === "cancelByCloid") {
      const statuses = action.cancels.map(({ asset, cloid }) =>
        this.#cancel(account, asset, cloid, body.nonce, body.expiresAfter, now),
      );

      return json(200, { status: "ok", response: { type: "cancel", data: { statuses } } });
    }

    return this.#withdraw(account, action, body.nonce, now);
  }

  /** The venue's nonce rule. Returns why a nonce is refused, or uses it. */
  #useNonce(account: Account, nonce: number, now: number): string | null {
    if (nonce <= now - NONCE_WINDOW_BEFORE_MS || nonce >= now + NONCE_WINDOW_AFTER_MS) {
      return `Invalid nonce: ${nonce} is outside the window around the venue time ${now}`;
    }

    if (account.nonces.includes(nonce)) return `Invalid nonce: duplicate nonce ${nonce}`;
    const lowest = account.nonces[0];

    if (account.nonces.length >= NONCES_KEPT && lowest !== undefined && nonce < lowest) {
      return `Invalid nonce: ${nonce} is lower than all of the ${NONCES_KEPT} highest nonces used`;
    }

    account.nonces.push(nonce);
    account.nonces.sort((a, b) => a - b);

    if (account.nonces.length > NONCES_KEPT) account.nonces.shift();

    return null;
  }

  #withdrawable(account: Account): bigint {
    let locked = 0n;

    for (const [asset, position] of account.positions) {
      locked += marginFor(abs(position.szi), position.entryPx, leverageOf(this.#universe[asset]));
    }

    for (const order of this.#orders) {
      if (order.user === account.address && order.status === "open") locked += order.reservedMargin;
    }

    const free = account.usdc - locked;

    return free > 0n ? free : 0n;
  }

  #findOrder(user: string, cloid: string): OrderState | undefined {
    return this.#orders.find((order) => order.user === user && order.cloid === cloid);
  }

  #placeOrder(
    account: Account,
    wire: OrderWire,
    nonce: number,
    expiresAfter: number | null,
    now: number,
  ): OrderResult {
    const suffix = ` asset=${wire.a}`;
    const asset = this.#universe[wire.a];

    if (asset === undefined) return { error: `Asset ${wire.a} does not exist.` };

    if (asset.isDelisted === true) return { error: `Trading is halted.${suffix}` };
    const sizeFx = toFixed(wire.s);

    if (sizeFx === null || sizeFx === 0n || fractionDigits(wire.s) > asset.szDecimals) {
      return { error: "Order has invalid size." };
    }

    const priceFx = toFixed(wire.p);

    if (priceFx === null || priceFx === 0n) return { error: "Order has invalid price." };
    const cloid = wire.c === undefined ? null : lowerHex(wire.c);

    if (cloid !== null && this.#findOrder(account.address, cloid) !== undefined) {
      return { error: `Duplicate cloid.${suffix}` };
    }

    const order: OrderState = {
      user: account.address,
      oid: this.#nextOid++,
      cloid,
      asset: wire.a,
      coin: asset.name,
      isBuy: wire.b,
      limitPx: wire.p,
      size: wire.s,
      filledSize: "0.0",
      reduceOnly: wire.r,
      tif: wire.t.limit.tif,
      status: "open",
      timestamp: now,
      statusTimestamp: now,
      nonce,
      expiresAfter,
      sizeFx,
      priceFx,
      filledFx: 0n,
      reservedMargin: 0n,
    };

    this.#orders.push(order);

    const reject = (status: FakeOrderStatus, error: string) => {
      order.status = status;

      return { error: `${error}${suffix}` };
    };

    if (!validPrice(wire.p, asset.szDecimals)) {
      return reject("tickRejected", "Price must be divisible by tick size.");
    }

    if (sizeFx * priceFx < MIN_NOTIONAL) {
      return reject("minTradeNtlRejected", "Order must have minimum value of $10.");
    }

    const position = account.positions.get(wire.a);

    if (wire.r) {
      const reduces =
        position !== undefined && position.szi > 0n !== wire.b && sizeFx <= abs(position.szi);

      if (!reduces)
        return reject("reduceOnlyRejected", "Reduce only order would increase position.");
    }

    const book = this.#books.get(wire.a);
    const bestBid = book?.bid ?? null;
    const bestAsk = book?.ask ?? null;

    const crosses = wire.b
      ? bestAsk !== null && priceFx >= bestAsk
      : bestBid !== null && priceFx <= bestBid;

    if (order.tif === "Alo" && crosses) {
      const bid = bestBid === null ? "None" : formatFixed(bestBid);
      const ask = bestAsk === null ? "None" : formatFixed(bestAsk);

      return reject(
        "badAloPxRejected",
        `Post only order would have immediately matched, bbo was ${bid}@${ask}.`,
      );
    }

    if (order.tif === "Ioc" && !crosses) {
      return reject(
        "iocCancelRejected",
        "Order could not immediately match against any resting orders.",
      );
    }

    const margin = wire.r ? 0n : marginFor(sizeFx, priceFx, leverageOf(asset));

    if (margin > this.#withdrawable(account)) {
      return reject("perpMarginRejected", "Insufficient margin to place order.");
    }

    const ids = cloid === null ? { oid: order.oid } : { oid: order.oid, cloid: wire.c };

    if (crosses) {
      this.#fill(account, order);

      return { filled: { totalSz: wire.s, avgPx: wire.p, ...ids } };
    }

    order.reservedMargin = margin;

    return { resting: ids };
  }

  /** Fills an order completely at its limit price and moves the account's position. */
  #fill(account: Account, order: OrderState): void {
    const now = this.now();
    const signed = order.isBuy ? order.sizeFx : -order.sizeFx;
    const price = order.priceFx;
    const position = account.positions.get(order.asset);

    if (position === undefined || position.szi === 0n) {
      account.positions.set(order.asset, { szi: signed, entryPx: price });
    } else if (position.szi > 0n === signed > 0n) {
      const size = abs(position.szi) + order.sizeFx;
      position.entryPx = (abs(position.szi) * position.entryPx + order.sizeFx * price) / size;
      position.szi += signed;
    } else {
      let closed = abs(position.szi);

      if (order.sizeFx < closed) closed = order.sizeFx;
      const pnl = (closed * (price - position.entryPx)) / SCALE;
      account.usdc += position.szi > 0n ? pnl : -pnl;
      position.szi += signed;

      if (position.szi === 0n) account.positions.delete(order.asset);
      else if (order.sizeFx > closed) position.entryPx = price;
    }

    order.filledFx = order.sizeFx;
    order.filledSize = order.size;
    order.status = "filled";
    order.statusTimestamp = now;
  }

  #cancel(
    account: Account,
    asset: number,
    cloid: Hex,
    nonce: number,
    expiresAfter: number | null,
    now: number,
  ): CancelResult {
    const order = this.#findOrder(account.address, cloid.toLowerCase());
    let result = "success";

    if (order === undefined || order.status !== "open" || order.asset !== asset) {
      result = `Order was never placed, already canceled, or filled. asset=${asset}`;
    } else {
      order.status = "canceled";
      order.statusTimestamp = now;
      order.reservedMargin = 0n;
    }

    this.#cancels.push({
      user: account.address,
      asset,
      cloid: lowerHex(cloid),
      nonce,
      expiresAfter,
      receivedAt: now,
      result,
    });

    return result === "success" ? "success" : { error: result };
  }

  #withdraw(account: Account, action: WithdrawAction, nonce: number, now: number): FakeHttpAnswer {
    const amount = toFixed(action.amount);

    if (amount === null || amount <= WITHDRAWAL_FEE) {
      return venueError("Withdrawal is smaller than fee.");
    }

    if (amount > this.#withdrawable(account)) {
      return venueError("Insufficient balance for withdrawal.");
    }

    account.usdc -= amount;
    this.#withdrawals.push({
      user: account.address,
      destination: action.destination,
      amount: action.amount,
      nonce,
      receivedAt: now,
    });

    return json(200, { status: "ok", response: { type: "default" } });
  }

  // --- info ------------------------------------------------------------------------------------

  #info(body: string): FakeHttpAnswer {
    const failure = this.#takeFailure("info");

    if (failure?.mode === "drop") return { kind: "drop" };

    if (failure?.mode === "http") return text(failure.status, "fake venue: injected failure");
    let request: unknown;

    try {
      request = JSON.parse(body);
    } catch {
      return unreadable("expected a JSON object");
    }

    const read = InfoRequest.safeParse(request);

    if (!read.success) return unreadable("expected a JSON object");
    const fields = read.data;

    if (fields.type === "meta") return json(200, { universe: this.#universe.map(metaEntry) });

    if (fields.type === "orderStatus") {
      const user = AddressText.safeParse(fields.user);

      if (!user.success) return unreadable("user: expected an address");
      const byOid = Uint.safeParse(fields.oid);
      const byCloid = CloidText.safeParse(fields.oid);
      const owner = user.data.toLowerCase();
      let order: OrderState | undefined;

      if (byOid.success) {
        order = this.#orders.find((entry) => entry.user === owner && entry.oid === byOid.data);
      } else if (byCloid.success) order = this.#findOrder(owner, byCloid.data.toLowerCase());
      else return unreadable("oid: expected an order id or a cloid");

      if (order === undefined) return json(200, { status: "unknownOid" });

      return json(200, {
        status: "order",
        order: {
          order: {
            coin: order.coin,
            side: order.isBuy ? "B" : "A",
            limitPx: order.limitPx,
            sz: formatFixed(order.sizeFx - order.filledFx),
            oid: order.oid,
            timestamp: order.timestamp,
            triggerCondition: "N/A",
            isTrigger: false,
            triggerPx: "0.0",
            children: [],
            isPositionTpsl: false,
            reduceOnly: order.reduceOnly,
            orderType: "Limit",
            origSz: order.size,
            tif: order.tif,
            cloid: order.cloid,
          },
          status: order.status,
          statusTimestamp: order.statusTimestamp,
        },
      });
    }

    if (fields.type === "clearinghouseState") {
      const user = AddressText.safeParse(fields.user);

      if (!user.success) return unreadable("user: expected an address");

      return json(200, this.#clearinghouseState(user.data.toLowerCase()));
    }

    if (fields.type === "openOrders") {
      const user = AddressText.safeParse(fields.user);

      if (!user.success) return unreadable("user: expected an address");
      const owner = user.data.toLowerCase();

      return json(
        200,
        this.#orders
          .filter((order) => order.user === owner && order.status === "open")
          .map((order) => ({
            coin: order.coin,
            limitPx: order.limitPx,
            oid: order.oid,
            side: order.isBuy ? "B" : "A",
            sz: formatFixed(order.sizeFx - order.filledFx),
            timestamp: order.timestamp,
          })),
      );
    }

    if (fields.type === "userNonFundingLedgerUpdates") {
      // Only withdrawals move this fake's ledger.
      const user = AddressText.safeParse(fields.user);

      if (!user.success) return unreadable("user: expected an address");
      const start = Uint.safeParse(fields.startTime);

      if (!start.success) return unreadable("startTime: expected milliseconds");
      const end = Uint.nullish().safeParse(fields.endTime);

      if (!end.success) return unreadable("endTime: expected milliseconds");
      const startTime = start.data;
      const endTime = end.data ?? null;
      const owner = user.data.toLowerCase();

      return json(
        200,
        this.#withdrawals
          .filter(
            (entry) =>
              entry.user === owner &&
              entry.receivedAt >= startTime &&
              (endTime === null || entry.receivedAt <= endTime),
          )
          .map((entry) => ({
            time: entry.receivedAt,
            hash: `0x${entry.nonce.toString(16).padStart(64, "0")}`,
            delta: {
              type: "withdraw",
              usdc: formatFixed((toFixed(entry.amount) ?? 0n) - WITHDRAWAL_FEE),
              nonce: entry.nonce,
              fee: formatFixed(WITHDRAWAL_FEE),
            },
          })),
      );
    }

    return unreadable(`unknown variant \`${String(fields.type)}\``);
  }

  /** `user` is a lower-case address. */
  #clearinghouseState(user: string) {
    const account = this.#accounts.get(user);
    let notional = 0n;
    let marginUsed = 0n;
    let rawUsd = account?.usdc ?? 0n;

    const assetPositions = Array.from(account?.positions ?? []).map(([index, position]) => {
      const asset = this.#universe[index];
      const leverage = leverageOf(asset);
      const value = (abs(position.szi) * position.entryPx) / SCALE;
      const margin = marginFor(abs(position.szi), position.entryPx, leverage);
      notional += value;
      marginUsed += margin;
      rawUsd -= (position.szi * position.entryPx) / SCALE;

      return {
        type: "oneWay",
        position: {
          coin: asset?.name ?? `asset ${index}`,
          szi: formatFixed(position.szi),
          leverage: { type: "cross", value: leverage },
          entryPx: formatFixed(position.entryPx),
          positionValue: formatFixed(value),
          unrealizedPnl: "0.0",
          returnOnEquity: "0.0",
          liquidationPx: null,
          marginUsed: formatFixed(margin),
          maxLeverage: asset?.maxLeverage ?? leverage,
          cumFunding: { allTime: "0.0", sinceOpen: "0.0", sinceChange: "0.0" },
        },
      };
    });

    const summary = {
      accountValue: formatFixed(account?.usdc ?? 0n),
      totalNtlPos: formatFixed(notional),
      totalRawUsd: formatFixed(rawUsd),
      totalMarginUsed: formatFixed(marginUsed),
    };

    return {
      marginSummary: summary,
      crossMarginSummary: summary,
      crossMaintenanceMarginUsed: "0.0",
      withdrawable: formatFixed(account === undefined ? 0n : this.#withdrawable(account)),
      assetPositions,
      time: this.now(),
    };
  }

  // --- control over HTTP -----------------------------------------------------------------------

  #control({ method, path, body }: FakeHttpRequest): FakeHttpAnswer {
    if (method === "GET") {
      if (path === "/control/exchange") return json(200, this.exchangeLog());

      if (path === "/control/orders") return json(200, this.orders());

      if (path === "/control/cancels") return json(200, this.cancels());

      if (path === "/control/withdrawals") return json(200, this.withdrawals());

      return text(404, "not found");
    }

    let input: unknown;

    try {
      input = body === "" ? null : JSON.parse(body);
    } catch {
      return text(400, "expected JSON");
    }

    const fields = ControlFields.parse(input);

    try {
      if (method === "POST" && path === "/control/accounts") {
        this.seedAccount(String(fields.address), String(fields.usdc));

        return text(204, "");
      }

      if (method === "PUT" && path === "/control/meta") {
        const universe = ControlUniverse.safeParse(fields.universe);

        if (!universe.success) return text(400, "universe: expected an array of assets");

        this.setUniverse(universe.data.map(readAsset));

        return text(204, "");
      }

      if (method === "PUT" && path === "/control/book") {
        const bid = fields.bid ?? null;
        const ask = fields.ask ?? null;

        this.setBook(Number(fields.asset), {
          bid: bid === null ? null : String(bid),
          ask: ask === null ? null : String(ask),
        });

        return text(204, "");
      }

      if (method === "POST" && path === "/control/fill") {
        const order = this.fillOrder(String(fields.user), String(fields.cloid));

        return order === null ? text(404, "no such open order") : json(200, order);
      }

      if (method === "PUT" && path === "/control/clock") {
        this.setClockOffset(Number(fields.offsetMs));

        return text(204, "");
      }

      if (method === "POST" && path === "/control/failures") {
        const failure = controlFailure(fields);

        if (failure === null) return text(400, "expected a failure");
        this.failNext(failure);

        return text(204, "");
      }

      if (method === "POST" && path === "/control/reset") {
        this.reset();

        return text(204, "");
      }
    } catch (error) {
      return text(400, error instanceof Error ? error.message : "bad request");
    }

    return text(404, "not found");
  }
}

function metaEntry(asset: FakeAsset): MetaEntry {
  const entry: MetaEntry = {
    name: asset.name,
    szDecimals: asset.szDecimals,
    maxLeverage: asset.maxLeverage,
  };

  if (asset.isDelisted === true) entry.isDelisted = true;

  return entry;
}

function controlFailure(fields: ControlFields): FakeFailure | null {
  const endpoint = fields.endpoint ?? "exchange";

  if (endpoint !== "exchange" && endpoint !== "info") return null;
  const count = fields.count === undefined ? 1 : Number(fields.count);
  const response = z.string().safeParse(fields.response);

  if (fields.mode === "error" && endpoint === "exchange" && response.success) {
    return { endpoint, mode: "error", response: response.data, count };
  }

  if (fields.mode === "http")
    return { endpoint, mode: "http", status: Number(fields.status), count };

  if (fields.mode === "drop") return { endpoint, mode: "drop", count };

  return null;
}
