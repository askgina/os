import type { Cloid } from "@askgina/os-protocol";
import { formatUnits } from "viem";
import { z } from "zod";

/** Every call to the venue gives up after this long. */
export const VENUE_TIMEOUT_MS = 10_000;

/** The longest venue text kept or shown: a refusal reason or a cancel status. */
export const VENUE_TEXT_MAX = 200;

/** The largest venue answer read, in bytes; a longer one is a {@link VenueError}. */
export const VENUE_ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/** The venue answers at most this many book levels a side. */
export const BOOK_LEVELS_MAX = 20;

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

/** The venue's 14 candle intervals. */
export const CANDLE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/**
 * Each candle interval's length in milliseconds. A month is counted as 31 days, its longest, so a
 * time range sized from it holds every candle asked for.
 */
export const CANDLE_INTERVAL_MS = {
  "1m": MINUTE_MS,
  "3m": 3 * MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "30m": 30 * MINUTE_MS,
  "1h": HOUR_MS,
  "2h": 2 * HOUR_MS,
  "4h": 4 * HOUR_MS,
  "8h": 8 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "1d": DAY_MS,
  "3d": 3 * DAY_MS,
  "1w": 7 * DAY_MS,
  "1M": 31 * DAY_MS,
} as const satisfies { readonly [I in CandleInterval]: number };

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
 * An account at the venue as the venue reports it: its value, what can be withdrawn and the
 * margin in use, in USD, and its open positions (`size` signed: negative is short). A field the
 * venue left out is null. Never verified by anyone here.
 */
export interface AccountState {
  accountValue: string;
  withdrawable: string;
  marginUsed: string | null;
  positions: {
    coin: string;
    size: string;
    entryPrice: string;
    unrealizedPnl: string;
    /** In USD. */
    positionValue: string | null;
    leverage: number | null;
    /** The margin mode as the venue names it: "cross" or "isolated". */
    leverageType: string | null;
    /** The market's maximum leverage. */
    maxLeverage: number | null;
    /** Unrealised profit over the margin, as a decimal fraction. */
    returnOnEquity: string | null;
    /** Null when the venue names none. */
    liquidationPrice: string | null;
    /** In USD. */
    marginUsed: string | null;
    /** The position's funding in USD, signed as the venue writes it: in all, since it opened, since it last changed. */
    fundingAllTime: string | null;
    fundingSinceOpen: string | null;
    fundingSinceChange: string | null;
  }[];
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
  /** When it was placed, in milliseconds by the venue's clock; null when the venue left it out. */
  placedAt: number | null;
}

/**
 * One listed perpetual and its context, as the venue reports them: prices in USD, `funding` the
 * hourly rate, `openInterest` in the coin, `dayVolume` the notional of the last day in USD. A
 * field the venue left out is null. Never verified by anyone here.
 */
export interface Market {
  name: string;
  /** Its index in the venue's universe: the asset number an order is signed for. */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  markPrice: string | null;
  midPrice: string | null;
  oraclePrice: string | null;
  funding: string | null;
  openInterest: string | null;
  dayVolume: string | null;
  previousDayPrice: string | null;
}

/** One level of a book: its price, the size resting at it and how many orders make it up. */
export interface BookLevel {
  price: string;
  size: string;
  orders: number;
}

/** A market's book as the venue reports it: bids best first, asks best first. */
export interface Book {
  /** The venue's time of the book, in milliseconds. */
  time: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/** One candle as the venue reports it; times in milliseconds, `volume` in the coin. */
export interface Candle {
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** One fill of the account, as the venue reports it. Never verified by anyone here. */
export interface Fill {
  /** In milliseconds by the venue's clock. */
  time: number;
  coin: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  /** In USD. */
  fee: string;
  /** The profit the fill realised by closing a position, in USD. */
  closedPnl: string;
  /** Whether the fill took liquidity from the book. */
  crossed: boolean;
  venueOrderId: number;
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
  /**
   * The account's most recent fills, at most the venue's 2,000, fills of one order at one time
   * merged into one (`POST /info {"type":"userFills","aggregateByTime":true}`).
   */
  fills(user: `0x${string}`): Promise<Fill[]>;
  /** The listed perpetuals with their context (`POST /info {"type":"metaAndAssetCtxs"}`). */
  markets(): Promise<Market[]>;
  /** Every mid the venue lists, by market name (`POST /info {"type":"allMids"}`). */
  mids(): Promise<Map<string, string>>;
  /**
   * A market's book, at most {@link BOOK_LEVELS_MAX} levels a side; null for a market the venue
   * does not know (`POST /info {"type":"l2Book"}`).
   */
  book(coin: string): Promise<Book | null>;
  /**
   * A market's candles opening from `startTime` to `endTime`, in milliseconds, oldest first
   * (`POST /info {"type":"candleSnapshot"}`).
   */
  candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]>;
  /**
   * The account's taker fee rate less its referral discount, as a decimal fraction ("0.00045");
   * null when either is missing or not a decimal (`POST /info {"type":"userFees"}`).
   */
  takerFeeRate(user: `0x${string}`): Promise<string | null>;
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

/**
 * A field read only to show agents: one the venue left out, or wrote in a form this client does
 * not expect, is absent, so it never fails a read the wallet page or order handling needs.
 */
const orAbsent = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const AccountStateAnswer = z.looseObject({
  marginSummary: z.looseObject({
    accountValue: z.string(),
    totalMarginUsed: orAbsent(z.string()),
  }),
  withdrawable: z.string(),
  assetPositions: z.array(
    z.looseObject({
      position: z.looseObject({
        coin: z.string(),
        szi: z.string(),
        entryPx: z.string().nullable(),
        unrealizedPnl: z.string(),
        positionValue: orAbsent(z.string()),
        leverage: orAbsent(
          z.looseObject({ type: orAbsent(z.string()), value: orAbsent(z.number()) }),
        ),
        maxLeverage: orAbsent(z.number()),
        returnOnEquity: orAbsent(z.string()),
        liquidationPx: orAbsent(z.string().nullable()),
        marginUsed: orAbsent(z.string()),
        cumFunding: orAbsent(
          z.looseObject({
            allTime: orAbsent(z.string()),
            sinceOpen: orAbsent(z.string()),
            sinceChange: orAbsent(z.string()),
          }),
        ),
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
    timestamp: orAbsent(z.number().int().min(0)),
  }),
);

const UserFills = z.array(
  z.looseObject({
    time: z.number().int().min(0),
    coin: z.string(),
    side: z.enum(["A", "B"]),
    px: z.string(),
    sz: z.string(),
    fee: z.string(),
    closedPnl: z.string(),
    crossed: z.boolean(),
    oid: z.number().int().min(0),
  }),
);

const MarketsAnswer = z.tuple([
  z.looseObject({
    universe: z.array(
      z.looseObject({
        name: z.string(),
        szDecimals: z.number().int().min(0).max(8),
        maxLeverage: z.number().int().min(1),
        onlyIsolated: z.boolean().optional(),
        isDelisted: z.boolean().optional(),
      }),
    ),
  }),
  z.array(
    z.looseObject({
      markPx: z.string().nullable().optional(),
      midPx: z.string().nullable().optional(),
      oraclePx: z.string().nullable().optional(),
      funding: z.string().nullable().optional(),
      openInterest: z.string().nullable().optional(),
      dayNtlVlm: z.string().nullable().optional(),
      prevDayPx: z.string().nullable().optional(),
    }),
  ),
]);

const Mids = z.record(z.string(), z.string());

const Level = z.looseObject({ px: z.string(), sz: z.string(), n: z.number().int().min(0) });

const L2Book = z.union([
  z.null(),
  z.looseObject({
    time: z.number().int().min(0),
    levels: z.tuple([z.array(Level), z.array(Level)]),
  }),
]);

const Candles = z.array(
  z.looseObject({
    t: z.number().int().min(0),
    T: z.number().int().min(0),
    o: z.string(),
    h: z.string(),
    l: z.string(),
    c: z.string(),
    v: z.string(),
  }),
);

const UserFees = z.looseObject({
  userCrossRate: z.string().nullable().optional(),
  activeReferralDiscount: z.string().nullable().optional(),
});

/** A plain decimal of at most 20 whole and 20 fraction digits. */
const FEE_DECIMAL = /^(\d{1,20})(?:\.(\d{1,20}))?$/;

/** `rate × (1 − discount)`, exactly, as a decimal; null unless both are plain decimals. */
function discountedRate(rate: string, discount: string): string | null {
  const r = FEE_DECIMAL.exec(rate);
  const d = FEE_DECIMAL.exec(discount);

  if (r === null || d === null) return null;
  const rateDigits = r[2] ?? "";
  const discountDigits = d[2] ?? "";
  const rateScaled = BigInt(`${r[1]}${rateDigits}`);
  const discountScaled = BigInt(`${d[1]}${discountDigits}`);
  const one = 10n ** BigInt(discountDigits.length);

  if (discountScaled > one) return null;

  return formatUnits(
    rateScaled * (one - discountScaled),
    rateDigits.length + discountDigits.length,
  );
}

const LedgerUpdates = z.array(
  z.looseObject({
    time: z.number(),
    delta: z.looseObject({ type: z.string(), nonce: z.number().int().optional() }),
  }),
);

/** A read of `POST /info`, by its `type`. */
type InfoRequest =
  | { type: "meta" }
  | { type: "orderStatus"; user: `0x${string}`; oid: Cloid }
  | { type: "clearinghouseState" | "openOrders"; user: `0x${string}` }
  | { type: "userNonFundingLedgerUpdates"; user: `0x${string}`; startTime: number }
  | { type: "userFills"; user: `0x${string}`; aggregateByTime: true }
  | { type: "metaAndAssetCtxs" | "allMids" }
  | { type: "l2Book"; coin: string }
  | {
      type: "candleSnapshot";
      req: { coin: string; interval: CandleInterval; startTime: number; endTime: number };
    }
  | { type: "userFees"; user: `0x${string}` };

/** The venue's text, on one line and cut to {@link VENUE_TEXT_MAX} characters. */
export function venueText(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

  return Array.from(flat).slice(0, VENUE_TEXT_MAX).join("");
}

/** The answer's body as text, read through its stream; null once it passes `maxBytes`. */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;

    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);

      return null;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
}

/**
 * A client for Hyperliquid's HTTP API at `apiUrl`. Every call has a {@link VENUE_TIMEOUT_MS}
 * timeout and follows no redirect; a timeout, a refused connection, a redirect, a server error,
 * an answer over {@link VENUE_ANSWER_MAX_BYTES} or one this client cannot read is a
 * {@link VenueError}, so an unknown outcome is never taken for a refusal.
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
    let text: string | null;

    try {
      response = await send(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "askgina-os",
        },
        body,
        // A redirect could send the request, a signed order included, to another host.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await boundedText(response, VENUE_ANSWER_MAX_BYTES);
    } catch {
      throw new VenueError("the venue could not be reached");
    }

    if (text === null) throw new VenueError("the venue's answer is too large");

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

  const read = async <T extends z.ZodType>(body: InfoRequest, schema: T): Promise<z.infer<T>> => {
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

      if (data.status === "err") {
        // The venue's own string as it is, anything else as its JSON.
        const own = z.string().safeParse(data.response);
        const text = own.success ? own.data : JSON.stringify(data.response ?? null);

        return { kind: "refused", text: venueText(text) };
      }

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
        marginUsed: state.marginSummary.totalMarginUsed ?? null,
        positions: state.assetPositions.map(({ position }) => ({
          coin: position.coin,
          size: position.szi,
          entryPrice: position.entryPx ?? "0",
          unrealizedPnl: position.unrealizedPnl,
          positionValue: position.positionValue ?? null,
          leverage: position.leverage?.value ?? null,
          leverageType: position.leverage?.type ?? null,
          maxLeverage: position.maxLeverage ?? null,
          returnOnEquity: position.returnOnEquity ?? null,
          liquidationPrice: position.liquidationPx ?? null,
          marginUsed: position.marginUsed ?? null,
          fundingAllTime: position.cumFunding?.allTime ?? null,
          fundingSinceOpen: position.cumFunding?.sinceOpen ?? null,
          fundingSinceChange: position.cumFunding?.sinceChange ?? null,
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
        placedAt: order.timestamp ?? null,
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

    async fills(user) {
      const rows = await read({ type: "userFills", user, aggregateByTime: true }, UserFills);

      return rows.map((row) => ({
        time: row.time,
        coin: row.coin,
        side: row.side === "B" ? "buy" : "sell",
        price: row.px,
        size: row.sz,
        fee: row.fee,
        closedPnl: row.closedPnl,
        crossed: row.crossed,
        venueOrderId: row.oid,
      }));
    },

    async markets() {
      const [{ universe }, contexts] = await read({ type: "metaAndAssetCtxs" }, MarketsAnswer);

      return universe.flatMap((perp, asset) => {
        if (perp.isDelisted === true) return [];
        const context = contexts[asset];

        return [
          {
            name: perp.name,
            asset,
            szDecimals: perp.szDecimals,
            maxLeverage: perp.maxLeverage,
            onlyIsolated: perp.onlyIsolated ?? false,
            markPrice: context?.markPx ?? null,
            midPrice: context?.midPx ?? null,
            oraclePrice: context?.oraclePx ?? null,
            funding: context?.funding ?? null,
            openInterest: context?.openInterest ?? null,
            dayVolume: context?.dayNtlVlm ?? null,
            previousDayPrice: context?.prevDayPx ?? null,
          },
        ];
      });
    },

    async mids() {
      return new Map(Object.entries(await read({ type: "allMids" }, Mids)));
    },

    async book(coin) {
      const answer = await read({ type: "l2Book", coin }, L2Book);

      if (answer === null) return null;

      const levels = (side: z.infer<typeof Level>[]) =>
        side.slice(0, BOOK_LEVELS_MAX).map((level) => ({
          price: level.px,
          size: level.sz,
          orders: level.n,
        }));

      return { time: answer.time, bids: levels(answer.levels[0]), asks: levels(answer.levels[1]) };
    },

    async candles(coin, interval, startTime, endTime) {
      const rows = await read(
        { type: "candleSnapshot", req: { coin, interval, startTime, endTime } },
        Candles,
      );

      return rows.map((row) => ({
        openTime: row.t,
        closeTime: row.T,
        open: row.o,
        high: row.h,
        low: row.l,
        close: row.c,
        volume: row.v,
      }));
    },

    async takerFeeRate(user) {
      const fees = await read({ type: "userFees", user }, UserFees);

      if (fees.userCrossRate == null || fees.activeReferralDiscount == null) return null;

      return discountedRate(fees.userCrossRate, fees.activeReferralDiscount);
    },
  };
}
