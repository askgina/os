/**
 * The venue client's reads and the hardening every venue request passes through, and the read
 * budget and cache of `venueReads`, against the testkit's fake venue served over HTTP on
 * loopback, as the server's own client would reach the venue.
 */
import type { AgentId } from "@askgina/os-protocol";
import {
  FAKE_TAKER_RATE,
  FakeHyperliquid,
  l1ActionHash,
} from "@askgina/os-testkit/fake-hyperliquid";
import { eq, like, sql } from "drizzle-orm";
import { parseSignature, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimits } from "../../src/db/schema.ts";
import {
  createHyperliquidClient,
  type HyperliquidClient,
  VENUE_ANSWER_MAX_BYTES,
  VenueError,
} from "../../src/execution/venues/hyperliquid.ts";
import { venueReads } from "../../src/execution/venues/reads.ts";
import { HttpError } from "../../src/http/errors.ts";
import {
  createFixture,
  draftFor,
  type Fixture,
  type ServedVenue,
  serveVenue,
  type TestAgent,
  toolJson,
} from "./fixture.ts";

let f: Fixture;

const venue = new FakeHyperliquid({
  network: "testnet",
  now: () => f.t.clock.now() * 1000,
  universe: [
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
    { name: "APT", szDecimals: 2, maxLeverage: 10, onlyIsolated: true },
    { name: "ATOM", szDecimals: 2, maxLeverage: 10 },
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "OLD", szDecimals: 2, maxLeverage: 3, isDelisted: true },
  ],
});

/** Another fake on another port: where a redirect points. Nothing may ever reach it. */
const elsewhere = new FakeHyperliquid({ network: "testnet" });

let served: ServedVenue;

let redirectTarget: ServedVenue;

let client: HyperliquidClient;

/** Keys of this test's own, which sign orders straight to the fake venue. */
const trader = privateKeyToAccount(`0x${"22".repeat(32)}`);

const filler = privateKeyToAccount(`0x${"33".repeat(32)}`);

const FILLED_LATER = "0x000000000000000000000000000000aa";

const STILL_RESTING = "0x000000000000000000000000000000bb";

const BTC = 3;

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

let nonce = 0;

/** Sign one BTC limit order as the venue's SDK does and post it to the fake, in process. */
async function placeBtc(
  side: "buy" | "sell",
  price: string,
  size: string,
  tif: "Ioc" | "Gtc",
  options: { account?: typeof trader; cloid?: string } = {},
) {
  const wire = { a: BTC, b: side === "buy", p: price, s: size, r: false, t: { limit: { tif } } };
  // An order with a client order id can be filled on request while it rests.
  const orders = options.cloid === undefined ? [wire] : [{ ...wire, c: options.cloid }];
  const action = { type: "order", orders, grouping: "na" };
  const account = options.account ?? trader;
  nonce = Math.max(nonce + 1, venue.now());
  const connectionId = l1ActionHash(action, nonce, null, null);

  const signature = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: "b", connectionId },
  });

  const { r, s, yParity } = parseSignature(signature);

  const answer = await venue.handle({
    method: "POST",
    path: "/exchange",
    body: JSON.stringify({
      action,
      nonce,
      signature: { r, s, v: 27 + yParity },
      vaultAddress: null,
      expiresAfter: null,
    }),
  });

  if (answer.kind !== "answer" || answer.status !== 200) throw new Error("the order was not taken");
}

/** The info requests the served fake received of one `type`. */
const infoRequests = (type: string) =>
  served.requests.filter(
    (request) => request.path === "/info" && request.body.includes(`"${type}"`),
  ).length;

beforeAll(async () => {
  served = await serveVenue(venue);
  redirectTarget = await serveVenue(elsewhere);
  f = await createFixture(
    "exec_venue_reads",
    1,
    {},
    { venues: [{ network: "hyperliquid:testnet", apiUrl: served.apiUrl }] },
  );
  client = createHyperliquidClient({ apiUrl: served.apiUrl });
  venue.seedAccount(trader.address, "100000");
  venue.seedAccount(filler.address, "100000");
});

afterAll(async () => {
  await f?.close();
  await served?.close();
  await redirectTarget?.close();
});

beforeEach(() => {
  // The cache keeps an answer for a second at most by the server's clock; move past it.
  f.t.clock.advance(60);
  venue.setBook(BTC, {
    bids: [
      { px: "59000", sz: "1", n: 3 },
      { px: "58900", sz: "2" },
    ],
    asks: [
      { px: "60000", sz: "0.5", n: 2 },
      { px: "60100", sz: "1" },
    ],
  });
});

describe("the venue client", () => {
  it("reads the markets, mids, a book, candles, fees, account, resting orders and fills the venue holds", async () => {
    // One fill that took liquidity, one resting order filled later, one that still rests.
    await placeBtc("buy", "60000", "0.01", "Ioc");
    await placeBtc("sell", "61000", "0.004", "Gtc", { cloid: FILLED_LATER });
    const resting = venue.fillOrder(trader.address, FILLED_LATER);
    expect(resting).toMatchObject({ status: "filled" });
    await placeBtc("sell", "62000", "0.002", "Gtc", { cloid: STILL_RESTING });
    const now = venue.now();

    venue.setCandles("BTC", "1h", [
      {
        t: now - 7_200_000,
        T: now - 3_600_001,
        o: "58000",
        h: "59500",
        l: "57900",
        c: "59000",
        v: "12.5",
      },
      { t: now - 3_600_000, T: now - 1, o: "59000", h: "60500", l: "58800", c: "59500", v: "3.25" },
    ]);

    const markets = await client.markets();
    // The delisted market is not listed.
    expect(markets.map((market) => market.name)).toEqual(["SOL", "APT", "ATOM", "BTC", "ETH"]);
    expect(markets[1]).toMatchObject({ name: "APT", asset: 1, onlyIsolated: true });

    expect(markets[3]).toEqual({
      name: "BTC",
      asset: 3,
      szDecimals: 5,
      maxLeverage: 40,
      onlyIsolated: false,
      markPrice: "59500",
      midPrice: "59500",
      oraclePrice: "59500",
      funding: "0.0",
      openInterest: "0.006",
      // 0.01 × 60000 + 0.004 × 61000.
      dayVolume: "844",
      previousDayPrice: "59500",
    });

    expect((await client.mids()).get("BTC")).toBe("59500");

    expect(await client.book("BTC")).toEqual({
      time: now,
      bids: [
        { price: "59000", size: "1", orders: 3 },
        { price: "58900", size: "2", orders: 1 },
      ],
      asks: [
        { price: "60000", size: "0.5", orders: 2 },
        { price: "60100", size: "1", orders: 1 },
      ],
    });

    expect(await client.book("NOPE")).toBeNull();

    expect(await client.candles("BTC", "1h", now - 3_600_000, now)).toEqual([
      {
        openTime: now - 3_600_000,
        closeTime: now - 1,
        open: "59000",
        high: "60500",
        low: "58800",
        close: "59500",
        volume: "3.25",
      },
    ]);

    expect(await client.takerFeeRate(trader.address)).toBe(FAKE_TAKER_RATE);

    expect(await client.accountState(trader.address)).toMatchObject({
      accountValue: expect.any(String),
      // 0.006 BTC at 60000 and leverage 20.
      marginUsed: "18",
      positions: [
        {
          coin: "BTC",
          size: "0.006",
          entryPrice: "60000",
          positionValue: "360",
          leverage: 20,
          leverageType: "cross",
          maxLeverage: 40,
          returnOnEquity: "0.0",
          liquidationPrice: null,
          marginUsed: "18",
          fundingAllTime: "0.0",
          fundingSinceOpen: "0.0",
          fundingSinceChange: "0.0",
        },
      ],
    });

    expect(await client.openOrders(trader.address)).toEqual([
      {
        coin: "BTC",
        side: "sell",
        remaining: "0.002",
        limitPrice: "62000",
        venueOrderId: expect.any(Number),
        cloid: null,
        placedAt: now,
      },
    ]);

    const fills = await client.fills(trader.address);
    expect(fills).toEqual([
      expect.objectContaining({
        coin: "BTC",
        side: "sell",
        price: "61000",
        size: "0.004",
        crossed: false,
        closedPnl: "4",
      }),
      expect.objectContaining({
        coin: "BTC",
        side: "buy",
        price: "60000",
        size: "0.01",
        crossed: true,
        closedPnl: "0.0",
        fee: "0.0",
      }),
    ]);
    expect(fills.map((fill) => fill.venueOrderId)).toEqual([resting?.oid, expect.any(Number)]);
  });

  it("keeps a row the venue left optional fields out of, and names itself", async () => {
    const sent: RequestInit[] = [];

    const stub = createHyperliquidClient({
      apiUrl: "http://venue.invalid",
      fetch: async (_input, init) => {
        sent.push(init ?? {});

        return Response.json({
          marginSummary: { accountValue: "10.5" },
          withdrawable: "10.5",
          assetPositions: [
            { position: { coin: "ETH", szi: "-0.1", entryPx: "2000", unrealizedPnl: "-1.5" } },
          ],
        });
      },
    });

    expect(await stub.accountState(trader.address)).toEqual({
      accountValue: "10.5",
      withdrawable: "10.5",
      marginUsed: null,
      positions: [
        {
          coin: "ETH",
          size: "-0.1",
          entryPrice: "2000",
          unrealizedPnl: "-1.5",
          positionValue: null,
          leverage: null,
          leverageType: null,
          maxLeverage: null,
          returnOnEquity: null,
          liquidationPrice: null,
          marginUsed: null,
          fundingAllTime: null,
          fundingSinceOpen: null,
          fundingSinceChange: null,
        },
      ],
    });

    expect(new Headers(sent[0]?.headers).get("accept")).toBe("application/json");
    expect(new Headers(sent[0]?.headers).get("user-agent")).toBe("askgina-os");
  });

  it("takes an optional field written in a form it does not expect as absent, and still reads the account and orders", async () => {
    const stub = createHyperliquidClient({
      apiUrl: "http://venue.invalid",
      fetch: async (_input, init) => {
        const body = String(init?.body);

        if (body.includes('"openOrders"')) {
          return Response.json([
            { coin: "ETH", side: "B", sz: "0.1", limitPx: "1900", oid: 7, timestamp: "soon" },
          ]);
        }

        return Response.json({
          marginSummary: { accountValue: "10.5", totalMarginUsed: 3 },
          withdrawable: "10.5",
          assetPositions: [
            {
              position: {
                coin: "ETH",
                szi: "0.1",
                entryPx: "2000",
                unrealizedPnl: "1.5",
                positionValue: null,
                leverage: { type: "cross", value: "20" },
                maxLeverage: "25",
                cumFunding: { allTime: 1, sinceOpen: "-0.25", sinceChange: "0.0" },
              },
            },
          ],
        });
      },
    });

    expect(await stub.accountState(trader.address)).toEqual({
      accountValue: "10.5",
      withdrawable: "10.5",
      marginUsed: null,
      positions: [
        {
          coin: "ETH",
          size: "0.1",
          entryPrice: "2000",
          unrealizedPnl: "1.5",
          positionValue: null,
          leverage: null,
          leverageType: "cross",
          maxLeverage: null,
          returnOnEquity: null,
          liquidationPrice: null,
          marginUsed: null,
          fundingAllTime: null,
          fundingSinceOpen: "-0.25",
          fundingSinceChange: "0.0",
        },
      ],
    });

    expect(await stub.openOrders(trader.address)).toEqual([
      {
        coin: "ETH",
        side: "buy",
        remaining: "0.1",
        limitPrice: "1900",
        venueOrderId: 7,
        cloid: null,
        placedAt: null,
      },
    ]);
  });

  it("refuses a redirected answer, to a read or a post, and sends nothing to its target", async () => {
    const location = `${redirectTarget.apiUrl}/info`;
    venue.failNext({ endpoint: "info", mode: "redirect", location });
    await expect(client.mids()).rejects.toBeInstanceOf(VenueError);
    venue.failNext({ endpoint: "exchange", mode: "redirect", location });
    await expect(client.post("{}")).rejects.toBeInstanceOf(VenueError);
    expect(redirectTarget.requests).toEqual([]);
  });

  it("reads an answer up to the size limit and refuses a longer one", async () => {
    venue.failNext({ endpoint: "info", mode: "oversize", bytes: VENUE_ANSWER_MAX_BYTES });
    // An empty array padded with spaces to the limit is read.
    expect(await client.openOrders(trader.address)).toEqual([]);
    venue.failNext({ endpoint: "info", mode: "oversize", bytes: VENUE_ANSWER_MAX_BYTES + 1 });
    await expect(client.openOrders(trader.address)).rejects.toBeInstanceOf(VenueError);
    venue.failNext({ endpoint: "exchange", mode: "oversize" });
    await expect(client.post("{}")).rejects.toBeInstanceOf(VenueError);
  });

  it("refuses an answer of the wrong shape", async () => {
    const answering = (body: string) =>
      createHyperliquidClient({
        apiUrl: "http://venue.invalid",
        fetch: async () => new Response(body, { status: 200 }),
      });

    await expect(answering("{}").fills(trader.address)).rejects.toBeInstanceOf(VenueError);
    await expect(answering('[{"time":"soon"}]').fills(trader.address)).rejects.toBeInstanceOf(
      VenueError,
    );
    await expect(answering('{"levels":[[]]}').book("BTC")).rejects.toBeInstanceOf(VenueError);
    await expect(answering("not json").mids()).rejects.toBeInstanceOf(VenueError);
  });
});

describe("the read budget", () => {
  let reader: TestAgent;

  let other: TestAgent;

  const NETWORK_BUCKET = "venue-read:hyperliquid:testnet";

  const agentBucket = (agentId: AgentId) => `${NETWORK_BUCKET}:${agentId}`;

  /** What a bucket holds as stored. */
  const stored = async (bucket: string) => {
    const [row] = await f.t.ctx.db
      .select({ tokens: rateLimits.tokens })
      .from(rateLimits)
      .where(eq(rateLimits.bucket, bucket));

    return row?.tokens;
  };

  /**
   * Give a bucket `tokens` and stop its clock, as `freeze` in `rate-limit.test.ts` does: its
   * refill counts from `at`, which no take moves back, so every value read after is exact.
   */
  const frozen = async (bucket: string, tokens: number) => {
    const at = sql`now() + interval '1 hour'`;

    await f.t.ctx.db
      .insert(rateLimits)
      .values({ bucket, tokens, at })
      .onConflictDoUpdate({ target: rateLimits.bucket, set: { tokens, at } });
  };

  /** Every agent's and network's read bucket gone, then these two full and frozen. */
  const fullBudgets = async (agentId: AgentId) => {
    await f.t.ctx.db.delete(rateLimits).where(like(rateLimits.bucket, "venue-read:%"));
    await frozen(agentBucket(agentId), 240);
    await frozen(NETWORK_BUCKET, 600);
  };

  beforeAll(async () => {
    reader = await f.newAgent("Reader");
    other = await f.newAgent("Other reader");

    await f.setPolicy(
      f.workspaceId,
      reader.walletId,
      draftFor(reader.id, {
        venues: {
          hyperliquid: {
            network: "hyperliquid:testnet",
            markets: [{ asset: BTC, coin: "BTC", maxNotionalPerOrderUsd6: "1000000000" }],
            maxNotionalPerDayUsd6: "5000000000",
            timeInForce: ["Gtc", "Ioc"],
            submitWindowSeconds: 60,
            withdrawals: false,
          },
        },
      }),
    );
  });

  it("answers an identical price or book read from the last second, and identical reads at once with one request", async () => {
    const reads = venueReads(f.t.ctx, "hyperliquid:testnet", reader.id);
    const before = infoRequests("allMids");
    await reads.mids();
    await reads.mids();
    expect(infoRequests("allMids")).toBe(before + 1);
    f.t.clock.advance(2);
    await reads.mids();
    expect(infoRequests("allMids")).toBe(before + 2);

    const books = infoRequests("l2Book");
    await Promise.all([reads.book("BTC"), reads.book("BTC"), reads.book("BTC")]);
    expect(infoRequests("l2Book")).toBe(books + 1);
    // An account is never answered from the cache.
    const states = infoRequests("clearinghouseState");
    await reads.accountState(reader.address);
    await reads.accountState(reader.address);
    expect(infoRequests("clearinghouseState")).toBe(states + 2);
  });

  it("refuses reads past an agent's budget, sending nothing, while another agent's reads and an order still go out", async () => {
    await fullBudgets(reader.id);
    const reads = venueReads(f.t.ctx, "hyperliquid:testnet", reader.id);

    // Resting orders weigh 20: twelve of them spend the agent's 240.
    for (let i = 0; i < 12; i += 1) await reads.openOrders(reader.address);
    expect(await stored(agentBucket(reader.id))).toBe(0);
    expect(await stored(NETWORK_BUCKET)).toBe(360);
    const sent = served.requests.length;

    await expect(reads.openOrders(reader.address)).rejects.toMatchObject({
      code: "rate_limited",
      detail: "venue_budget",
    });
    await expect(reads.mids()).rejects.toBeInstanceOf(HttpError);
    expect(served.requests.length).toBe(sent);
    // Neither bucket was charged for the refused reads.
    expect(await stored(agentBucket(reader.id))).toBe(0);
    expect(await stored(NETWORK_BUCKET)).toBe(360);

    const theirs = venueReads(f.t.ctx, "hyperliquid:testnet", other.id);
    expect(await theirs.openOrders(other.address)).toEqual([]);
    expect(await stored(NETWORK_BUCKET)).toBe(340);

    // Order handling takes from no bucket.
    const mcp = await f.mcp(reader.token);

    const proposal = toolJson(
      await mcp.callTool({
        name: "propose_order",
        arguments: {
          network: "hyperliquid:testnet",
          coin: "BTC",
          side: "buy",
          size: "0.001",
          limitPrice: "59000",
          timeInForce: "Gtc",
          memo: "while the read budget is spent",
        },
      }),
    );

    expect(proposal).toMatchObject({ status: "pending_approval" });
    expect(served.requests.length).toBeGreaterThan(sent);
  });

  it("charges a fills read one more for every 20 fills: 100 fills cost 25", async () => {
    for (let i = 0; i < 100; i += 1) {
      await placeBtc("buy", "60000", "0.0002", "Ioc", { account: filler });
    }

    await fullBudgets(other.id);
    const reads = venueReads(f.t.ctx, "hyperliquid:testnet", other.id);
    expect(await reads.fills(filler.address)).toHaveLength(100);
    // Admitted at its worst case, 20 + 2,000 / 20, and given back all but 20 + 100 / 20.
    expect(await stored(agentBucket(other.id))).toBe(215);
    expect(await stored(NETWORK_BUCKET)).toBe(575);
  });

  it("admits fills reads at once only as far as their worst cases fit, and refuses the rest before any request", async () => {
    await fullBudgets(other.id);
    const reads = venueReads(f.t.ctx, "hyperliquid:testnet", other.id);
    const asked = infoRequests("userFills");
    // The venue answers nothing until every read was admitted or refused.
    const release = served.hold();
    let refused = 0;

    const attempts = Array.from({ length: 5 }, async () => {
      try {
        return (await reads.fills(filler.address)).length;
      } catch (error) {
        refused += 1;

        return error;
      }
    });

    await vi.waitFor(
      () => {
        expect(refused).toBe(3);
        expect(infoRequests("userFills")).toBe(asked + 2);
      },
      { timeout: 5_000 },
    );

    // Two worst cases, 2 × 120, took the agent's whole 240; the three past it sent nothing.
    expect(await stored(agentBucket(other.id))).toBe(0);
    expect(await stored(NETWORK_BUCKET)).toBe(360);
    release();
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((outcome) => outcome === 100)).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome instanceof HttpError)).toEqual([
      expect.objectContaining({ code: "rate_limited", detail: "venue_budget" }),
      expect.objectContaining({ code: "rate_limited", detail: "venue_budget" }),
      expect.objectContaining({ code: "rate_limited", detail: "venue_budget" }),
    ]);

    // Each read gave back what its answer did not use: 240 − 2 × 25, and 600 − 2 × 25.
    expect(await stored(agentBucket(other.id))).toBe(190);
    expect(await stored(NETWORK_BUCKET)).toBe(550);
    expect(infoRequests("userFills")).toBe(asked + 2);
  });

  it("refuses a network the server is not configured for, before any budget is taken", async () => {
    expect(() => venueReads(f.t.ctx, "hyperliquid:mainnet", reader.id)).toThrow(
      expect.objectContaining({ detail: "venue_not_configured" }),
    );

    const rows = await f.t.ctx.db
      .select()
      .from(rateLimits)
      .where(like(rateLimits.bucket, "venue-read:hyperliquid:mainnet%"));

    expect(rows).toEqual([]);
  });
});
