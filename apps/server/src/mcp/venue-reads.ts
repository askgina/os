import { setTimeout as delay } from "node:timers/promises";
import {
  type IntentId,
  orderNotionalUsd6,
  type VenueNetwork,
  type WalletId,
} from "@askgina/os-protocol";
import type { McpServer } from "@modelcontextprotocol/server";
import { and, eq, inArray } from "drizzle-orm";
import { formatUnits } from "viem";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { type agents, intents, venueOrders } from "../db/schema.ts";
import { decimalInput, scaled, unscaled } from "../execution/orders.ts";
import {
  type BookLevel,
  CANDLE_INTERVAL_MS,
  CANDLE_INTERVALS,
} from "../execution/venues/hyperliquid.ts";
import { CANDLES_FRESH_MS, venueReads } from "../execution/venues/reads.ts";
import { HttpError } from "../http/errors.ts";
import { answer, json, WalletIdInput, walletsFor } from "./gateway.ts";

type AgentRow = typeof agents.$inferSelect;

/** How an MCP host may classify these tools: they change nothing, and they reach the venue. */
const READS_VENUE = { readOnlyHint: true, openWorldHint: true } as const;

/** At most this many markets or prices are listed; the rest are counted. */
const MARKETS_MAX = 500;

/** At most this many positions and resting orders are listed; the rest are counted. */
const ACCOUNT_LIST_MAX = 100;

const FILLS_DEFAULT = 50;

const BOOK_DEPTH_DEFAULT = 10;

const CANDLES_DEFAULT = 60;

/** A book older than this, by the venue's time against the server's clock, is not previewed. */
const BOOK_STALE_MS = 10_000;

/** How long a preview waits for the wallet's fee rate before answering without it. */
const FEE_WAIT_MS = 3_000;

/** The latest time a `Date` can hold, in milliseconds. */
const DATE_MAX_MS = 8.64e15;

// What a result may carry. The venue's rows are checked against these before anything is sent:
// a market name outside the pattern `propose_order` accepts, or a number that is not a plain
// decimal, keeps the row out, so no text the venue wrote reaches an agent.
const COIN = /^[A-Za-z0-9]{1,16}$/;

const Coin = z.string().regex(COIN);

const Decimal = z.string().regex(/^\d{1,30}(\.\d{1,30})?$/);

const SignedDecimal = z.string().regex(/^-?\d{1,30}(\.\d{1,30})?$/);

/** A book's price or size: what this server computes with exactly (`scaled`). */
const LevelAmount = z.string().regex(/^\d{1,20}(\.\d{1,8})?$/);

/** A venue time in milliseconds, shown in ISO 8601. */
const VenueTime = z
  .number()
  .int()
  .min(0)
  .max(DATE_MAX_MS)
  .transform((ms) => new Date(ms).toISOString());

const MarketRow = z.strictObject({
  coin: Coin,
  asset: z.number().int().min(0),
  sizeDecimals: z.number().int().min(0).max(8),
  maxLeverage: z.number().int().positive(),
  isolatedOnly: z.boolean(),
  markPrice: Decimal.nullable(),
  midPrice: Decimal.nullable(),
  oraclePrice: Decimal.nullable(),
  fundingRateHourly: SignedDecimal.nullable(),
  openInterest: Decimal.nullable(),
  dayVolumeUsd: Decimal.nullable(),
  previousDayPrice: Decimal.nullable(),
  allowed: z.boolean(),
});

const PriceRow = z.strictObject({ coin: Coin, mid: Decimal });

const LevelRow = z.strictObject({
  price: LevelAmount,
  size: LevelAmount,
  orders: z.number().int().min(0),
});

const CandleRow = z.strictObject({
  openTime: VenueTime,
  closeTime: VenueTime,
  open: Decimal,
  high: Decimal,
  low: Decimal,
  close: Decimal,
  volume: Decimal,
  closed: z.boolean(),
});

const Totals = z.strictObject({
  accountValueUsd: SignedDecimal,
  withdrawableUsd: SignedDecimal,
  marginUsedUsd: Decimal.nullable(),
});

const Position = z.strictObject({
  coin: Coin,
  side: z.enum(["long", "short"]),
  size: Decimal,
  entryPrice: Decimal,
  positionValueUsd: Decimal.nullable(),
  unrealizedPnlUsd: SignedDecimal,
  leverage: z.number().int().positive().nullable(),
  leverageType: z.enum(["cross", "isolated"]).nullable(),
  maxLeverage: z.number().int().positive().nullable(),
  returnOnEquity: SignedDecimal.nullable(),
  liquidationPrice: Decimal.nullable(),
  marginUsedUsd: Decimal.nullable(),
  fundingAllTimeUsd: SignedDecimal.nullable(),
  fundingSinceOpenUsd: SignedDecimal.nullable(),
  fundingSinceChangeUsd: SignedDecimal.nullable(),
});

const RestingOrder = z.strictObject({
  coin: Coin,
  side: z.enum(["buy", "sell"]),
  size: Decimal,
  limitPrice: Decimal,
  placedAt: VenueTime.nullable(),
  venueOrderId: z.number().int().min(0),
});

const FillRow = z.strictObject({
  time: VenueTime,
  coin: Coin,
  side: z.enum(["buy", "sell"]),
  price: Decimal,
  size: Decimal,
  feeUsd: SignedDecimal,
  closedPnlUsd: SignedDecimal,
  taker: z.boolean(),
  venueOrderId: z.number().int().min(0),
});

/** A position the venue lists at size zero holds nothing. */
const ZERO = /^-?0+(\.0+)?$/;

/** A fee rate as `takerFeeRate` writes it. */
const RATE = /^(\d+)(?:\.(\d+))?$/;

// Inputs, written as plain patterns as in the gateway.
const NetworkInput = z
  .string()
  .describe(
    'The venue network from whoami: "hyperliquid:testnet" or "hyperliquid:mainnet". The data comes from that network.',
  );

const CoinInput = z.string().regex(COIN);

const CoinsInput = z
  .array(CoinInput)
  .min(1)
  .max(50)
  .optional()
  .describe('Only these markets, at most 50, for example ["BTC", "ETH"]. Default: all of them.');

const DecimalInput = z.string().regex(/^\d+(\.\d+)?$/);

const REPORT_NOTE =
  "This is the venue's own report, read now from the network you name; nothing here verifies it. Prices, sizes and USD amounts are decimal strings. Reads of the venue share a budget: past it the answer is rate_limited with detail venue_budget, and a minute later reads work again. A market the venue does not list is not_found with detail market_unknown.";

const INTENT_NOTE =
  "intentId is your proposal that placed the order, or null for an order another agent proposed or that was placed outside this system.";

/** The venue's rows that fit `schema`, in order, and how many did not. */
function readable<S extends z.ZodType, Row>(schema: S, rows: readonly Row[]) {
  const fit = rows.flatMap((row) => {
    const parsed = schema.safeParse(row);

    return parsed.success ? [parsed.data] : [];
  });

  return { fit, unfit: rows.length - fit.length };
}

const marketUnknown = () => new HttpError("not_found", "no such market", "market_unknown");

/** The ISO 8601 form of a venue time; a time that cannot be one means an unreadable answer. */
function venueTime(ms: number): string {
  const parsed = VenueTime.safeParse(ms);

  if (!parsed.success) {
    throw new HttpError("internal", "the venue's answer could not be read", "venue_unreachable");
  }

  return parsed.data;
}

/** The midpoint of two prices times 10^8, written exactly: it may need a ninth decimal. */
const midpoint = (bid: bigint, ask: bigint) => formatUnits((bid + ask) * 5n, 9);

/** What walking one side of a book for `size` would fill. */
interface Walk {
  /** Times 10^8. */
  filled: bigint;
  /** Size times price, times 10^16. */
  notional: bigint;
  /** The last level's price, times 10^8. */
  worst: bigint | null;
  levels: number;
}

/**
 * Walk `levels`, best first, for `size` (times 10^8); with `limit`, only levels at that price or
 * better count. Stops at the first level whose price or size this server cannot read exactly.
 */
function walk(
  levels: readonly BookLevel[],
  side: "buy" | "sell",
  size: bigint,
  limit: bigint | null,
): Walk {
  const result: Walk = { filled: 0n, notional: 0n, worst: null, levels: 0 };

  for (const level of levels) {
    const price = scaled(level.price);
    const available = scaled(level.size);

    if (price === null || available === null || result.filled >= size) break;

    if (limit !== null && (side === "buy" ? price > limit : price < limit)) break;
    // What is still wanted, or the level's whole size when that is less (bigints: no Math.min).
    let take = size - result.filled;

    if (available < take) take = available;
    result.filled += take;
    result.notional += take * price;
    result.worst = price;
    result.levels += 1;
  }

  return result;
}

/**
 * The agent's own intents whose venue requests have these venue order ids, on this wallet and
 * network, by order id. An order another agent proposed, or one placed outside this system, has
 * none.
 */
async function ownIntentsByOrder(
  ctx: AppContext,
  agent: AgentRow,
  walletId: WalletId,
  network: VenueNetwork,
  venueOrderIds: readonly number[],
): Promise<Map<number | null, IntentId>> {
  if (venueOrderIds.length === 0) return new Map();

  const rows = await ctx.db
    .select({ venueOrderId: venueOrders.venueOrderId, intentId: venueOrders.intentId })
    .from(venueOrders)
    .innerJoin(intents, eq(intents.id, venueOrders.intentId))
    .where(
      and(
        eq(venueOrders.walletId, walletId),
        eq(venueOrders.network, network),
        eq(intents.agentId, agent.id),
        inArray(venueOrders.venueOrderId, [...new Set(venueOrderIds)]),
      ),
    );

  return new Map(rows.map((row): [number | null, IntentId] => [row.venueOrderId, row.intentId]));
}

/**
 * The read tools of the venue: markets, prices, a book, candles, an order preview, and the
 * account and fills of a wallet the agent may use. Every read goes through the read budget
 * (`venueReads`) to the host `VENUES_FILE` names for the network in the call. What the venue
 * answers is passed on, never checked.
 */
export function registerVenueReads(server: McpServer, ctx: AppContext, agent: AgentRow): void {
  // The gateway imports this module, so its exports are read here, when a server is built, and
  // never while the modules load.
  const WalletInput = WalletIdInput.optional().describe(
    "A wallet id from whoami; defaults to yours.",
  );

  const observedAt = () => new Date(ctx.now() * 1000).toISOString();

  /** A wallet the agent may use, the agent's own by default; any other is `not_found`. */
  const usableWallet = async (walletId: WalletId | undefined) => {
    const usable = await walletsFor(ctx, agent);
    const wallet = usable.find((candidate) => candidate.id === (walletId ?? agent.walletId));

    if (!wallet) throw new HttpError("not_found", "no such wallet");

    return wallet;
  };

  server.registerTool(
    "get_markets",
    {
      description: `List the venue's perpetual markets: coin, asset index, size decimals, maximum leverage, whether isolated margin only, mark, mid and oracle price, hourly funding rate, open interest (in the coin), the last day's volume in USD, the price a day ago, and allowed: whether a wallet you may use lists the market in its venue rules for this network, so you may propose orders on it. At most 500; omitted counts markets not listed. ${REPORT_NOTE}`,
      inputSchema: z.object({ network: NetworkInput, coins: CoinsInput }),
      annotations: READS_VENUE,
    },
    async ({ network, coins }) =>
      answer(ctx, "get_markets", async () => {
        const reads = venueReads(ctx, network, agent.id);
        const markets = await reads.markets();

        if (coins?.some((coin) => !markets.some((market) => market.name === coin))) {
          throw marketUnknown();
        }

        const usable = await walletsFor(ctx, agent);

        const rows = readable(
          MarketRow,
          markets
            .filter((market) => coins === undefined || coins.includes(market.name))
            .map((market) => ({
              coin: market.name,
              asset: market.asset,
              sizeDecimals: market.szDecimals,
              maxLeverage: market.maxLeverage,
              isolatedOnly: market.onlyIsolated,
              markPrice: market.markPrice,
              midPrice: market.midPrice,
              oraclePrice: market.oraclePrice,
              fundingRateHourly: market.funding,
              openInterest: market.openInterest,
              dayVolumeUsd: market.dayVolume,
              previousDayPrice: market.previousDayPrice,
              allowed: usable.some((wallet) => {
                const rules = wallet.policy?.venues?.hyperliquid;

                return (
                  rules?.network === reads.network &&
                  rules.markets.some(
                    (allowed) => allowed.coin === market.name && allowed.asset === market.asset,
                  )
                );
              }),
            })),
        );

        return json({
          network: reads.network,
          observedAt: observedAt(),
          markets: rows.fit.slice(0, MARKETS_MAX),
          omitted: rows.unfit + Math.max(0, rows.fit.length - MARKETS_MAX),
        });
      }),
  );

  server.registerTool(
    "get_prices",
    {
      description: `Read the venue's current mid prices: for each market, the midpoint of its best bid and best ask. A mid is not a price an order will get: an order fills against the book (see get_order_book and preview_order). Without coins, every perpetual market, at most 500; omitted counts prices not listed. ${REPORT_NOTE}`,
      inputSchema: z.object({ network: NetworkInput, coins: CoinsInput }),
      annotations: READS_VENUE,
    },
    async ({ network, coins }) =>
      answer(ctx, "get_prices", async () => {
        const reads = venueReads(ctx, network, agent.id);
        const mids = await reads.mids();

        // Spot markets are named "@<index>" in the venue's mids, so the market-name pattern
        // keeps the perpetuals.
        const wanted =
          coins === undefined
            ? [...mids].flatMap(([coin, mid]) => (COIN.test(coin) ? [{ coin, mid }] : []))
            : coins.map((coin) => {
                const mid = mids.get(coin);

                if (mid === undefined) throw marketUnknown();

                return { coin, mid };
              });

        const rows = readable(PriceRow, wanted);

        return json({
          network: reads.network,
          observedAt: observedAt(),
          prices: rows.fit.slice(0, MARKETS_MAX),
          omitted: rows.unfit + Math.max(0, rows.fit.length - MARKETS_MAX),
        });
      }),
  );

  server.registerTool(
    "get_order_book",
    {
      description: `Read a market's order book: bids (best, highest, first) and asks (best, lowest, first), each level with its price, size and number of orders, at most 20 a side (the venue sends no more); the mid, the spread between best ask and best bid, and venueTime, the venue's time of the book. omitted counts levels not shown. ${REPORT_NOTE}`,
      inputSchema: z.object({
        network: NetworkInput,
        coin: CoinInput.describe('The market, for example "BTC".'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`Levels a side, 1 to 20; default ${BOOK_DEPTH_DEFAULT}.`),
      }),
      annotations: READS_VENUE,
    },
    async ({ network, coin, depth }) =>
      answer(ctx, "get_order_book", async () => {
        const reads = venueReads(ctx, network, agent.id);
        const book = await reads.book(coin);

        if (book === null) throw marketUnknown();

        const side = (levels: readonly BookLevel[]) =>
          readable(
            LevelRow,
            levels.map((level) => ({ price: level.price, size: level.size, orders: level.orders })),
          );

        const bids = side(book.bids);
        const asks = side(book.asks);
        const bestBid = bids.fit[0] === undefined ? null : scaled(bids.fit[0].price);
        const bestAsk = asks.fit[0] === undefined ? null : scaled(asks.fit[0].price);
        const both = bestBid !== null && bestAsk !== null;

        return json({
          network: reads.network,
          observedAt: observedAt(),
          coin,
          venueTime: venueTime(book.time),
          mid: both ? midpoint(bestBid, bestAsk) : null,
          spread: both ? unscaled(bestAsk - bestBid) : null,
          bids: bids.fit.slice(0, depth ?? BOOK_DEPTH_DEFAULT),
          asks: asks.fit.slice(0, depth ?? BOOK_DEPTH_DEFAULT),
          omitted: bids.unfit + asks.unfit,
        });
      }),
  );

  server.registerTool(
    "get_candles",
    {
      description: `Read a market's price history: candles of one interval, oldest first, each with its open and close time, open, high, low and close price, volume (in the coin), and closed: false for the candle still forming. count candles ending at endTime (default now). The venue keeps the 5,000 most recent candles of each interval. omitted counts candles not shown. ${REPORT_NOTE}`,
      inputSchema: z.object({
        network: NetworkInput,
        coin: CoinInput.describe('The market, for example "BTC".'),
        interval: z.enum(CANDLE_INTERVALS).describe("The candle length."),
        count: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`How many candles, 1 to 500; default ${CANDLES_DEFAULT}.`),
        endTime: z.iso
          .datetime()
          .optional()
          .describe("The latest candle's open time, ISO 8601; default now."),
      }),
      annotations: READS_VENUE,
    },
    async ({ network, coin, interval, count, endTime }) =>
      answer(ctx, "get_candles", async () => {
        const reads = venueReads(ctx, network, agent.id);

        if (!(await reads.mids()).has(coin)) throw marketUnknown();
        const nowMs = Math.floor(ctx.now() * 1000);

        // A default end is now, rounded down to the window an answer of candles is reused for,
        // so calls within it ask the same and share one answer. Every interval opens on such a
        // boundary, so the rounding never drops the candle still forming.
        const end =
          endTime === undefined ? nowMs - (nowMs % CANDLES_FRESH_MS) : Date.parse(endTime);

        const wanted = count ?? CANDLES_DEFAULT;
        const start = Math.max(0, end - wanted * CANDLE_INTERVAL_MS[interval]);
        const candles = await reads.candles(coin, interval, start, end);

        const rows = readable(
          CandleRow,
          candles.map((candle) => ({
            openTime: candle.openTime,
            closeTime: candle.closeTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            closed: candle.closeTime < nowMs,
          })),
        );

        return json({
          network: reads.network,
          observedAt: observedAt(),
          coin,
          interval,
          candles: rows.fit.slice(-wanted),
          omitted: rows.unfit,
        });
      }),
  );

  server.registerTool(
    "preview_order",
    {
      description: `Preview what an order would fill at now, from the book (at most 20 levels a side): it walks the asks for a buy and the bids for a sell; with limitPrice only levels at that price or better count. Answers fillableSize, unfilledSize, fullyCovered, averagePrice, worstPrice, bestPrice, mid, slippageBps (the average price's distance from the mid, against you, in basis points), notionalUsd6 (micro-USD: with limitPrice, size times limitPrice, the number the wallet's caps count for propose_order; without it, the walked notional), the wallet's takerFeeRate and estimatedFeeUsd on the walked notional (null when the rate cannot be read within 3 seconds), levelsUsed and venueTime. Nothing is sent: a preview is not a promise, and the book moves. A book older than 10 seconds is refused with detail venue_stale. ${REPORT_NOTE} Omit walletId for your own wallet.`,
      inputSchema: z.object({
        network: NetworkInput,
        coin: CoinInput.describe('The market, for example "BTC".'),
        side: z.enum(["buy", "sell"]),
        size: DecimalInput.describe('How much of the coin, for example "0.01".'),
        limitPrice: DecimalInput.optional().describe(
          'The worst price you would accept, in USD, for example "65000".',
        ),
        walletId: WalletInput,
      }),
      annotations: READS_VENUE,
    },
    async (input) =>
      answer(ctx, "preview_order", async () => {
        const reads = venueReads(ctx, input.network, agent.id);
        const wallet = await usableWallet(input.walletId);
        const size = decimalInput("size", input.size);

        const limitPrice =
          input.limitPrice === undefined ? null : decimalInput("limitPrice", input.limitPrice);

        // The fee rate is best effort: any failure, or no answer in time, leaves it out.
        const rate = Promise.race([
          reads.takerFeeRate(wallet.address).catch(() => null),
          delay(FEE_WAIT_MS, null, { ref: false }),
        ]);

        const book = await reads.book(input.coin);

        if (book === null) throw marketUnknown();

        if (ctx.now() * 1000 - book.time > BOOK_STALE_MS) {
          ctx.log.warn("venue read refused", {
            event: "venue.read",
            read: "book",
            network: reads.network,
            code: "venue_stale",
          });
          throw new HttpError(
            "internal",
            "the venue's book is out of date; try again",
            "venue_stale",
          );
        }

        const sizeScaled = scaled(size) ?? 0n;
        const limitScaled = limitPrice === null ? null : scaled(limitPrice);
        const levels = input.side === "buy" ? book.asks : book.bids;
        const walked = walk(levels, input.side, sizeScaled, limitScaled);
        const bestBid = book.bids[0] === undefined ? null : scaled(book.bids[0].price);
        const bestAsk = book.asks[0] === undefined ? null : scaled(book.asks[0].price);
        const best = input.side === "buy" ? bestAsk : bestBid;
        const filled = walked.filled > 0n;

        // Rounded against the order: up for a buy, down for a sell.
        const average = !filled
          ? null
          : input.side === "buy"
            ? (walked.notional + walked.filled - 1n) / walked.filled
            : walked.notional / walked.filled;

        let slippageBps: string | null = null;

        if (filled && bestBid !== null && bestAsk !== null) {
          // (average − mid) / mid × 10^4, in hundredths, from the exact notional; mid times 10^9.
          const mid = (bestBid + bestAsk) * 5n;
          const over = walked.notional * 10n - mid * walked.filled;
          const hundredths = (over * 1_000_000n) / (mid * walked.filled);
          slippageBps = formatUnits(input.side === "buy" ? hundredths : -hundredths, 2);
        }

        // Micro-USD: the walked notional is times 10^16; rounded up, as the caps count.
        const notionalUsd6 =
          limitPrice === null
            ? (walked.notional + 10n ** 10n - 1n) / 10n ** 10n
            : orderNotionalUsd6(size, limitPrice);

        const takerFeeRate = await rate;
        const parts = takerFeeRate === null ? null : RATE.exec(takerFeeRate);
        let estimatedFeeUsd: string | null = null;

        if (parts !== null && filled) {
          const digits = parts[2] ?? "";
          const divisor = 10n ** BigInt(10 + digits.length);
          const fee = walked.notional * BigInt(`${parts[1]}${digits}`);
          estimatedFeeUsd = formatUnits((fee + divisor - 1n) / divisor, 6);
        }

        return json({
          network: reads.network,
          observedAt: observedAt(),
          walletId: wallet.id,
          coin: input.coin,
          side: input.side,
          size,
          limitPrice,
          fillableSize: unscaled(walked.filled),
          unfilledSize: unscaled(sizeScaled - walked.filled),
          fullyCovered: walked.filled === sizeScaled,
          averagePrice: average === null ? null : unscaled(average),
          worstPrice: walked.worst === null ? null : unscaled(walked.worst),
          bestPrice: best === null ? null : unscaled(best),
          mid: bestBid !== null && bestAsk !== null ? midpoint(bestBid, bestAsk) : null,
          slippageBps,
          notionalUsd6: notionalUsd6.toString(),
          takerFeeRate: parts === null ? null : takerFeeRate,
          estimatedFeeUsd,
          levelsUsed: walked.levels,
          venueTime: venueTime(book.time),
        });
      }),
  );

  server.registerTool(
    "get_venue_account",
    {
      description: `Read the account of one of your wallets at the venue: its value, what can be withdrawn and the margin in use, in USD; up to 100 open positions (coin, long or short, size, entry price, position value, unrealized profit, leverage and whether it is cross or isolated, the market's maximum leverage, return on equity as a fraction, liquidation price, margin used, and the position's funding in USD in all, since it opened and since it last changed, signed as the venue writes it); and up to 100 resting orders (coin, side, size left, limit price, when placed, the venue's order id, intentId). ${INTENT_NOTE} A field the venue left out is null; omitted counts the positions and orders not listed. ${REPORT_NOTE} Omit walletId for your own wallet.`,
      inputSchema: z.object({ network: NetworkInput, walletId: WalletInput }),
      annotations: READS_VENUE,
    },
    async ({ network, walletId }) =>
      answer(ctx, "get_venue_account", async () => {
        const reads = venueReads(ctx, network, agent.id);
        const wallet = await usableWallet(walletId);
        const state = await reads.accountState(wallet.address);
        const resting = await reads.openOrders(wallet.address);

        const totals = Totals.safeParse({
          accountValueUsd: state.accountValue,
          withdrawableUsd: state.withdrawable,
          marginUsedUsd: state.marginUsed,
        });

        if (!totals.success) {
          throw new HttpError(
            "internal",
            "the venue's answer could not be read",
            "venue_unreachable",
          );
        }

        const positions = readable(
          Position,
          state.positions
            .filter((position) => !ZERO.test(position.size))
            .map((position) => ({
              coin: position.coin,
              side: position.size.startsWith("-") ? "short" : "long",
              size: position.size.replace(/^-/, ""),
              entryPrice: position.entryPrice,
              positionValueUsd: position.positionValue,
              unrealizedPnlUsd: position.unrealizedPnl,
              leverage: position.leverage,
              leverageType: position.leverageType,
              maxLeverage: position.maxLeverage,
              returnOnEquity: position.returnOnEquity,
              liquidationPrice: position.liquidationPrice,
              marginUsedUsd: position.marginUsed,
              fundingAllTimeUsd: position.fundingAllTime,
              fundingSinceOpenUsd: position.fundingSinceOpen,
              fundingSinceChangeUsd: position.fundingSinceChange,
            })),
        );

        const orders = readable(
          RestingOrder,
          resting.map((order) => ({
            coin: order.coin,
            side: order.side,
            size: order.remaining,
            limitPrice: order.limitPrice,
            placedAt: order.placedAt,
            venueOrderId: order.venueOrderId,
          })),
        );

        const listed = orders.fit.slice(0, ACCOUNT_LIST_MAX);

        const intentOf = await ownIntentsByOrder(
          ctx,
          agent,
          wallet.id,
          reads.network,
          listed.map((order) => order.venueOrderId),
        );

        const omitted =
          positions.unfit +
          Math.max(0, positions.fit.length - ACCOUNT_LIST_MAX) +
          orders.unfit +
          Math.max(0, orders.fit.length - ACCOUNT_LIST_MAX);

        return json({
          network: reads.network,
          observedAt: observedAt(),
          walletId: wallet.id,
          address: wallet.address,
          ...totals.data,
          positions: positions.fit.slice(0, ACCOUNT_LIST_MAX),
          openOrders: listed.map((order) => ({
            ...order,
            intentId: intentOf.get(order.venueOrderId) ?? null,
          })),
          omitted,
        });
      }),
  );

  server.registerTool(
    "get_venue_fills",
    {
      description: `Read the recent fills of one of your wallets at the venue, newest first: time, coin, side, price, size, fee and realized profit in USD, whether it took liquidity (taker), the venue's order id, and intentId. ${INTENT_NOTE} The venue keeps an account's 2,000 most recent fills. omitted counts fills that could not be shown. ${REPORT_NOTE} Omit walletId for your own wallet.`,
      inputSchema: z.object({
        network: NetworkInput,
        walletId: WalletInput,
        coin: CoinInput.optional().describe('Only fills of this market, for example "BTC".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`How many, newest first, 1 to 200; default ${FILLS_DEFAULT}.`),
      }),
      annotations: READS_VENUE,
    },
    async ({ network, walletId, coin, limit }) =>
      answer(ctx, "get_venue_fills", async () => {
        const reads = venueReads(ctx, network, agent.id);
        const wallet = await usableWallet(walletId);
        const fills = await reads.fills(wallet.address);

        const matching = fills
          .filter((fill) => coin === undefined || fill.coin === coin)
          .toSorted((a, b) => b.time - a.time);

        const rows = readable(
          FillRow,
          matching.map((fill) => ({
            time: fill.time,
            coin: fill.coin,
            side: fill.side,
            price: fill.price,
            size: fill.size,
            feeUsd: fill.fee,
            closedPnlUsd: fill.closedPnl,
            taker: fill.crossed,
            venueOrderId: fill.venueOrderId,
          })),
        );

        const listed = rows.fit.slice(0, limit ?? FILLS_DEFAULT);

        const intentOf = await ownIntentsByOrder(
          ctx,
          agent,
          wallet.id,
          reads.network,
          listed.map((fill) => fill.venueOrderId),
        );

        return json({
          network: reads.network,
          observedAt: observedAt(),
          walletId: wallet.id,
          address: wallet.address,
          fills: listed.map((fill) => ({
            ...fill,
            intentId: intentOf.get(fill.venueOrderId) ?? null,
          })),
          omitted: rows.unfit,
        });
      }),
  );
}
