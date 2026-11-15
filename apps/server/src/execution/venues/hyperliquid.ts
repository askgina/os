import type { Cloid } from "@askgina/os-protocol";
import { z } from "zod";

/** Every call to the venue gives up after this long. */
export const VENUE_TIMEOUT_MS = 10_000;
/** The longest venue text kept or shown: a refusal reason or a cancel status. */
export const VENUE_TEXT_MAX = 200;

/**
 * The venue could not be reached or gave an answer that cannot be read (`venue_unreachable`):
 * what it did with a request is unknown, so the caller asks again before anything else. The
 * message never carries what was posted.
 */
export class VenueError extends Error {
  override readonly name = "VenueError";
  readonly code = "venue_unreachable";
}

/** One perpetual of the venue's `meta.universe`; its index is its asset number. */
export interface PerpMeta {
  name: string;
  szDecimals: number;
  isDelisted: boolean;
}

/**
 * What the venue reported for an order by its client order id: `unknown` when it has none, or
 * its status (`open`, `filled`, `canceled`, `marginCanceled`, `rejected`, …), its order id and
 * its original and remaining size.
 */
export type OrderStatusAnswer =
  | { found: false }
  | { found: true; status: string; venueOrderId: number; originalSize: string; remaining: string };

/**
 * What the venue answered a posted request with. `resting`, `filled` and `refused` are the
 * statuses of an order; `accepted` is a cancel's `success` or a withdrawal's plain `ok`.
 * `refused` carries the venue's own text: a refusal of the whole request (a used nonce, a passed
 * `expiresAfter`, a bad signature) or of the order (no liquidity for an immediate-or-cancel order,
 * a size under the minimum).
 */
export type ExchangeAnswer =
  | { kind: "resting"; venueOrderId: number }
  | { kind: "filled"; venueOrderId: number; totalSize: string; averagePrice: string }
  | { kind: "accepted" }
  | { kind: "refused"; text: string };

/**
 * An account at the venue as the venue reports it: its value and what can be withdrawn, in USD,
 * and its open positions (`size` signed: negative is short). Never verified by anyone here.
 */
export interface AccountState {
  accountValue: string;
  withdrawable: string;
  positions: { coin: string; size: string; entryPrice: string; unrealizedPnl: string }[];
}

/** An order resting on the venue's book, as the venue reports it. */
export interface OpenOrder {
  coin: string;
  side: "buy" | "sell";
  /** What is left of it. */
  remaining: string;
  limitPrice: string;
  venueOrderId: number;
  cloid: string | null;
}

export interface HyperliquidClient {
  /** The perpetuals, in asset order (`POST /info {"type":"meta"}`). */
  meta(): Promise<PerpMeta[]>;
  /** An order by its client order id (`POST /info {"type":"orderStatus"}`). */
  orderStatus(user: `0x${string}`, cloid: Cloid): Promise<OrderStatusAnswer>;
  /** Post a signed request to `/exchange`: `body` is sent byte for byte. */
  post(body: string): Promise<ExchangeAnswer>;
  /** The account's value in USD, as the venue reports it. Never verified by anyone here. */
  accountValue(user: `0x${string}`): Promise<string>;
  /** The account's value and positions (`POST /info {"type":"clearinghouseState"}`). */
  accountState(user: `0x${string}`): Promise<AccountState>;
  /** The account's resting orders (`POST /info {"type":"openOrders"}`). */
  openOrders(user: `0x${string}`): Promise<OpenOrder[]>;
  /**
   * The nonces of the account's withdrawals the venue took from `startTime` (milliseconds) on
   * (`POST /info {"type":"userNonFundingLedgerUpdates"}`): a withdrawal's nonce is its `time`.
   */
  withdrawalNonces(user: `0x${string}`, startTime: number): Promise<number[]>;
}

const Meta = z.looseObject({
  universe: z.array(
    z.looseObject({
      name: z.string(),
      szDecimals: z.number().int().min(0).max(8),
      isDelisted: z.boolean().optional(),
    }),
  ),
});

const OrderStatus = z.union([
  z.looseObject({ status: z.literal("unknownOid") }),
  z.looseObject({
    status: z.literal("order"),
    order: z.looseObject({
      order: z.looseObject({
        oid: z.number().int().min(0),
        sz: z.string(),
        origSz: z.string(),
      }),
      status: z.string(),
    }),
  }),
]);

const Resting = z.looseObject({ resting: z.looseObject({ oid: z.number().int().min(0) }) });
const Filled = z.looseObject({
  filled: z.looseObject({ oid: z.number().int().min(0), totalSz: z.string(), avgPx: z.string() }),
});
const Refused = z.looseObject({ error: z.string() });
const OrderStatusEntry = z.union([z.literal("success"), Resting, Filled, Refused]);

const Exchange = z.union([
  z.looseObject({ status: z.literal("err"), response: z.unknown() }),
  z.looseObject({
    status: z.literal("ok"),
    response: z.union([
      z.looseObject({
        type: z.enum(["order", "cancel"]),
        data: z.looseObject({ statuses: z.array(OrderStatusEntry).length(1) }),
      }),
      z.looseObject({ type: z.literal("default") }),
    ]),
  }),
]);

const ClearinghouseState = z.looseObject({
  marginSummary: z.looseObject({ accountValue: z.string() }),
});

const AccountStateAnswer = z.looseObject({
  marginSummary: z.looseObject({ accountValue: z.string() }),
  withdrawable: z.string(),
  assetPositions: z.array(
    z.looseObject({
      position: z.looseObject({
        coin: z.string(),
        szi: z.string(),
        entryPx: z.string().nullable(),
        unrealizedPnl: z.string(),
      }),
    }),
  ),
});

const OpenOrders = z.array(
  z.looseObject({
    coin: z.string(),
    side: z.enum(["A", "B"]),
    sz: z.string(),
    limitPx: z.string(),
    oid: z.number().int().min(0),
    cloid: z.string().nullable().optional(),
  }),
);

const LedgerUpdates = z.array(
  z.looseObject({
    time: z.number(),
    delta: z.looseObject({ type: z.string(), nonce: z.number().int().optional() }),
  }),
);

/** The venue's text, on one line and cut to {@link VENUE_TEXT_MAX} characters. */
export function venueText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return Array.from(flat).slice(0, VENUE_TEXT_MAX).join("");
}

/**
 * A client for Hyperliquid's HTTP API at `apiUrl`. Every call has a {@link VENUE_TIMEOUT_MS}
 * timeout; a timeout, a refused connection, a server error or an answer this client cannot read
 * is a {@link VenueError}, so an unknown outcome is never taken for a refusal.
 */
export function createHyperliquidClient(options: {
  apiUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): HyperliquidClient {
  const base = options.apiUrl.replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? VENUE_TIMEOUT_MS;

  const call = async <T extends z.ZodType>(
    path: "/info" | "/exchange",
    body: string,
    schema: T,
  ): Promise<{ refused: false; data: z.infer<T> } | { refused: true; text: string }> => {
    let response: Response;
    let text: string;
    try {
      response = await send(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new VenueError("the venue could not be reached");
    }
    // A client error is the venue's decision about this request; a server error is not.
    if (response.status >= 400 && response.status < 500) {
      return { refused: true, text: venueText(text) };
    }
    if (!response.ok) throw new VenueError(`the venue answered HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new VenueError("the venue's answer is not JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new VenueError("the venue's answer has an unexpected shape");
    return { refused: false, data: result.data };
  };

  const read = async <T extends z.ZodType>(body: unknown, schema: T): Promise<z.infer<T>> => {
    const answer = await call("/info", JSON.stringify(body), schema);
    if (answer.refused) throw new VenueError(`the venue refused a read: ${answer.text}`);
    return answer.data;
  };

  return {
    async meta() {
      const { universe } = await read({ type: "meta" }, Meta);
      return universe.map((perp) => ({
        name: perp.name,
        szDecimals: perp.szDecimals,
        isDelisted: perp.isDelisted ?? false,
      }));
    },

    async orderStatus(user, cloid) {
      const answer = await read({ type: "orderStatus", user, oid: cloid }, OrderStatus);
      if (answer.status === "unknownOid") return { found: false };
      return {
        found: true,
        status: answer.order.status,
        venueOrderId: answer.order.order.oid,
        originalSize: answer.order.order.origSz,
        remaining: answer.order.order.sz,
      };
    },

    async post(body) {
      const answer = await call("/exchange", body, Exchange);
      if (answer.refused) return { kind: "refused", text: answer.text };
      const { data } = answer;
      if (data.status === "err") return { kind: "refused", text: venueText(data.response) };
      if (data.response.type === "default") return { kind: "accepted" };
      const entry = data.response.data.statuses[0];
      if (entry === "success") return { kind: "accepted" };
      const resting = Resting.safeParse(entry);
      if (resting.success) return { kind: "resting", venueOrderId: resting.data.resting.oid };
      const filled = Filled.safeParse(entry);
      if (filled.success) {
        return {
          kind: "filled",
          venueOrderId: filled.data.filled.oid,
          totalSize: filled.data.filled.totalSz,
          averagePrice: filled.data.filled.avgPx,
        };
      }
      const refused = Refused.safeParse(entry);
      if (refused.success) return { kind: "refused", text: venueText(refused.data.error) };
      throw new VenueError("the venue's answer has no status");
    },

    async accountValue(user) {
      const state = await read({ type: "clearinghouseState", user }, ClearinghouseState);
      return state.marginSummary.accountValue;
    },

    async accountState(user) {
      const state = await read({ type: "clearinghouseState", user }, AccountStateAnswer);
      return {
        accountValue: state.marginSummary.accountValue,
        withdrawable: state.withdrawable,
        positions: state.assetPositions.map(({ position }) => ({
          coin: position.coin,
          size: position.szi,
          entryPrice: position.entryPx ?? "0",
          unrealizedPnl: position.unrealizedPnl,
        })),
      };
    },

    async openOrders(user) {
      const orders = await read({ type: "openOrders", user }, OpenOrders);
      return orders.map((order) => ({
        coin: order.coin,
        side: order.side === "B" ? "buy" : "sell",
        remaining: order.sz,
        limitPrice: order.limitPx,
        venueOrderId: order.oid,
        cloid: order.cloid ?? null,
      }));
    },

    async withdrawalNonces(user, startTime) {
      const updates = await read(
        { type: "userNonFundingLedgerUpdates", user, startTime },
        LedgerUpdates,
      );
      return updates.flatMap(({ delta }) =>
        delta.type === "withdraw" && delta.nonce !== undefined ? [delta.nonce] : [],
      );
    },
  };
}
