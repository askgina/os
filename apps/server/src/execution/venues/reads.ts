import type { AgentId, VenueNetwork } from "@askgina/os-protocol";
import type { Config } from "../../config.ts";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../http/errors.ts";
import { chargeTokens, takeTokens } from "../../rate-limit.ts";
import { venueClient, venueNetwork } from "../orders.ts";
import {
  type AccountState,
  type Book,
  CANDLE_INTERVAL_MS,
  type Candle,
  type CandleInterval,
  type Fill,
  type Market,
  type OpenOrder,
  VenueError,
} from "./hyperliquid.ts";

/**
 * The venue counts the request weight of each client address, reads and signed requests
 * together, against 1,200 a minute (its "Rate limits and user limits" page). Reads agents ask for
 * may use half of that on each network, shared by all agents; order handling takes from no
 * bucket and keeps the rest.
 */
export const VENUE_READ_WEIGHT_PER_MINUTE = 600;

export const AGENT_VENUE_READ_WEIGHT_PER_MINUTE = 600;

/** Each read's weight, from the venue's page. */
const WEIGHT = {
  markets: 20,
  mids: 2,
  book: 2,
  candles: 20,
  takerFeeRate: 20,
  accountState: 2,
  openOrders: 20,
  fills: 20,
} as const;

type Read = keyof typeof WEIGHT;

/** A fills read weighs one more for every this many fills the venue answers. */
const FILLS_PER_EXTRA_WEIGHT = 20;

/** The most fills the venue answers: its 2,000 most recent. */
const FILLS_ANSWERED_MAX = 2_000;

/** A candles read weighs one more for every this many candles the venue answers. */
const CANDLES_PER_EXTRA_WEIGHT = 60;

/** The most candles the venue answers: its 5,000 most recent of an interval. */
const CANDLES_ANSWERED_MAX = 5_000;

/** How long an answer of candles is reused, in milliseconds. */
export const CANDLES_FRESH_MS = 5_000;

/**
 * How long an answer is reused, in milliseconds. Account state, resting orders and fills are
 * never reused.
 */
const FRESH_MS = {
  markets: 15_000,
  mids: 1_000,
  book: 1_000,
  candles: CANDLES_FRESH_MS,
  takerFeeRate: 600_000,
} as const;

/** The most answers one process keeps, for every network together. */
const CACHE_MAX = 200;

/** An answer, or the request on its way, which identical reads share until it is stale. */
interface Cached<T> {
  /** In milliseconds; infinite while the request is on its way. */
  freshUntil: number;
  answer: Promise<T>;
}

interface NetworkCache {
  markets: Map<string, Cached<Market[]>>;
  mids: Map<string, Cached<Map<string, string>>>;
  book: Map<string, Cached<Book | null>>;
  candles: Map<string, Cached<Candle[]>>;
  takerFeeRate: Map<string, Cached<string | null>>;
}

/** Per process, by configuration, as the venue clients are. */
const caches = new WeakMap<Config, Map<VenueNetwork, NetworkCache>>();

function cacheOf(config: Config, network: VenueNetwork): NetworkCache {
  let byNetwork = caches.get(config);

  if (!byNetwork) {
    byNetwork = new Map();
    caches.set(config, byNetwork);
  }

  let cache = byNetwork.get(network);

  if (!cache) {
    cache = {
      markets: new Map(),
      mids: new Map(),
      book: new Map(),
      candles: new Map(),
      takerFeeRate: new Map(),
    };
    byNetwork.set(network, cache);
  }

  return cache;
}

/** How many answers the process keeps for every network of `config`. */
function cachedCount(config: Config): number {
  let count = 0;

  for (const cache of caches.get(config)?.values() ?? []) {
    count +=
      cache.markets.size +
      cache.mids.size +
      cache.book.size +
      cache.candles.size +
      cache.takerFeeRate.size;
  }

  return count;
}

/**
 * Keep `entry` under `key` unless the process is full: stale answers in `store` go first, then
 * its oldest. False when nothing could be made room for, and then the entry is not kept.
 */
function remember<T>(
  config: Config,
  store: Map<string, Cached<T>>,
  key: string,
  entry: Cached<T>,
  nowMs: number,
): boolean {
  for (const [stale, cached] of store) {
    if (cached.freshUntil <= nowMs) store.delete(stale);
  }

  for (const oldest of store.keys()) {
    if (cachedCount(config) < CACHE_MAX) break;
    store.delete(oldest);
  }

  if (cachedCount(config) >= CACHE_MAX) return false;
  store.set(key, entry);

  return true;
}

/**
 * How a read whose weight depends on its answer is weighed: admitted at `most`, the most its
 * answer can weigh, and settled at `of` its answer. A read without one weighs its base weight.
 */
interface Weighing<T> {
  most: number;
  of(answer: T): number;
}

/** An agent's reads of one configured venue network, within the read budget. */
export interface VenueReads {
  network: VenueNetwork;
  markets(): Promise<Market[]>;
  mids(): Promise<Map<string, string>>;
  book(coin: string): Promise<Book | null>;
  candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]>;
  takerFeeRate(user: `0x${string}`): Promise<string | null>;
  accountState(user: `0x${string}`): Promise<AccountState>;
  openOrders(user: `0x${string}`): Promise<OpenOrder[]>;
  fills(user: `0x${string}`): Promise<Fill[]>;
}

/**
 * The reads `agentId` may make of `network`. A read the process answered recently enough is
 * answered again (`FRESH_MS`), and identical reads at once share one request; neither costs
 * anything. Any other read takes its weight from the agent's bucket,
 * `venue-read:<network>:<agentId>`, then from the network's, `venue-read:<network>`, before it is
 * made: either one short is `rate_limited` (`venue_budget`) and nothing is sent. The agent's own
 * bucket goes first, so an agent past its budget takes nothing from the network's. A read whose
 * weight depends on its answer (candles, fills) is admitted at the most its answer can weigh, so
 * reads at once never overdraw a bucket, and gives the unused part back to both once the answer
 * is in; a read that fails keeps only its base weight, and one that shares another's request
 * gives back all of it. A venue that cannot be read is `internal` (`venue_unreachable`); a
 * network `VENUES_FILE` does not list is `invalid_request` (`venue_not_configured`).
 */
export function venueReads(ctx: AppContext, network: string, agentId: AgentId): VenueReads {
  const configured = venueNetwork(ctx, network);
  const client = venueClient(ctx, configured);
  const cache = cacheOf(ctx.config, configured);
  const networkBucket = `venue-read:${configured}`;
  const agentBucket = `venue-read:${configured}:${agentId}`;

  const refused = (read: Read, code: string) => {
    ctx.log.warn("venue read refused", { event: "venue.read", read, network: configured, code });
  };

  const admit = async (read: Read, weight: number) => {
    const admitted =
      (await takeTokens(
        ctx.db,
        agentBucket,
        AGENT_VENUE_READ_WEIGHT_PER_MINUTE,
        AGENT_VENUE_READ_WEIGHT_PER_MINUTE,
        weight,
      )) &&
      (await takeTokens(
        ctx.db,
        networkBucket,
        VENUE_READ_WEIGHT_PER_MINUTE,
        VENUE_READ_WEIGHT_PER_MINUTE,
        weight,
      ));

    if (!admitted) {
      refused(read, "venue_budget");
      throw new HttpError(
        "rate_limited",
        "the venue read budget is used up for now; try again in a minute",
        "venue_budget",
      );
    }
  };

  /** Give both buckets back what a read was admitted at and did not use, or take what it used past it. */
  const settle = async (admitted: number, used: number) => {
    if (used === admitted) return;
    await chargeTokens(
      ctx.db,
      agentBucket,
      AGENT_VENUE_READ_WEIGHT_PER_MINUTE,
      AGENT_VENUE_READ_WEIGHT_PER_MINUTE,
      used - admitted,
    );
    await chargeTokens(
      ctx.db,
      networkBucket,
      VENUE_READ_WEIGHT_PER_MINUTE,
      VENUE_READ_WEIGHT_PER_MINUTE,
      used - admitted,
    );
  };

  const reachable = async <T>(read: Read, answer: Promise<T>): Promise<T> => {
    try {
      return await answer;
    } catch (error) {
      if (!(error instanceof VenueError)) throw error;
      refused(read, "venue_unreachable");
      throw new HttpError("internal", "the venue could not be read", "venue_unreachable");
    }
  };

  /**
   * Await a request this read was admitted for at `weighing.most`, then settle at what its answer
   * weighs; a request that fails keeps the read's base weight.
   */
  const settled = async <T>(read: Read, answer: Promise<T>, weighing: Weighing<T>): Promise<T> => {
    let value: T;

    try {
      value = await reachable(read, answer);
    } catch (error) {
      await settle(weighing.most, WEIGHT[read]);
      throw error;
    }

    await settle(weighing.most, weighing.of(value));

    return value;
  };

  /** A read never reused: admitted, made, and settled at what its answer weighs. */
  const fresh = async <T>(
    read: Read,
    request: () => Promise<T>,
    weighing: Weighing<T> = { most: WEIGHT[read], of: () => WEIGHT[read] },
  ): Promise<T> => {
    await admit(read, weighing.most);

    return settled(read, request(), weighing);
  };

  /**
   * A read answered from `store` while fresh, at no weight; else admitted and made once for all
   * who ask, and settled at what its answer weighs.
   */
  const reused = async <T>(
    read: keyof typeof FRESH_MS,
    store: Map<string, Cached<T>>,
    key: string,
    request: () => Promise<T>,
    weighing: Weighing<T> = { most: WEIGHT[read], of: () => WEIGHT[read] },
  ): Promise<T> => {
    const kept = () => {
      const entry = store.get(key);

      return entry !== undefined && entry.freshUntil > ctx.now() * 1000 ? entry : undefined;
    };

    const before = kept();

    if (before) return reachable(read, before.answer);
    await admit(read, weighing.most);
    // Another identical read may have started while this one was admitted: it sends nothing.
    const during = kept();

    if (during) {
      await settle(weighing.most, 0);

      return reachable(read, during.answer);
    }

    const entry: Cached<T> = { freshUntil: Number.POSITIVE_INFINITY, answer: request() };

    if (remember(ctx.config, store, key, entry, ctx.now() * 1000)) {
      entry.answer.then(
        () => {
          entry.freshUntil = ctx.now() * 1000 + FRESH_MS[read];
        },
        () => {
          if (store.get(key) === entry) store.delete(key);
        },
      );
    }

    return settled(read, entry.answer, weighing);
  };

  return {
    network: configured,
    markets: () => reused("markets", cache.markets, "", () => client.markets()),
    mids: () => reused("mids", cache.mids, "", () => client.mids()),
    book: (coin) => reused("book", cache.book, coin, () => client.book(coin)),

    candles(coin, interval, startTime, endTime) {
      // The most candles that can open from `startTime` to `endTime`.
      const most = Math.min(
        CANDLES_ANSWERED_MAX,
        Math.floor(Math.max(0, endTime - startTime) / CANDLE_INTERVAL_MS[interval]) + 1,
      );

      return reused(
        "candles",
        cache.candles,
        `${coin}:${interval}:${startTime}:${endTime}`,
        () => client.candles(coin, interval, startTime, endTime),
        {
          most: WEIGHT.candles + Math.ceil(most / CANDLES_PER_EXTRA_WEIGHT),
          of: (candles) => WEIGHT.candles + Math.floor(candles.length / CANDLES_PER_EXTRA_WEIGHT),
        },
      );
    },

    takerFeeRate: (user) =>
      reused("takerFeeRate", cache.takerFeeRate, user.toLowerCase(), () =>
        client.takerFeeRate(user),
      ),
    accountState: (user) => fresh("accountState", () => client.accountState(user)),
    openOrders: (user) => fresh("openOrders", () => client.openOrders(user)),
    fills: (user) =>
      fresh("fills", () => client.fills(user), {
        most: WEIGHT.fills + FILLS_ANSWERED_MAX / FILLS_PER_EXTRA_WEIGHT,
        of: (fills) => WEIGHT.fills + Math.floor(fills.length / FILLS_PER_EXTRA_WEIGHT),
      }),
  };
}
