/**
 * The seven venue read tools as an agent calls them, against the testkit's fake venue served over
 * HTTP on loopback: what each answers for a known state, which wallets an agent may read, how an
 * order is tied to the intent that placed it, and what keeps venue-written text out.
 */
import type { PolicyDraft } from "@askgina/os-api";
import type { AgentId, IntentId, WalletId } from "@askgina/os-protocol";
import { FAKE_TAKER_RATE, FakeHyperliquid } from "@askgina/os-testkit/fake-hyperliquid";
import type { Client } from "@modelcontextprotocol/client";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { intents, rateLimits } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import {
  createFixture,
  draftFor,
  type Fixture,
  intentIdOf,
  type ServedVenue,
  serveVenue,
  type TestAgent,
  type ToolArguments,
  toolJson,
} from "./fixture.ts";

let f: Fixture;

const UNIVERSE = [
  { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  { name: "APT", szDecimals: 2, maxLeverage: 10 },
  { name: "ATOM", szDecimals: 2, maxLeverage: 10 },
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
  { name: "OLD", szDecimals: 2, maxLeverage: 3, isDelisted: true },
];

const SOL = 0;

const BTC = 3;

const ETH = 4;

const venue = new FakeHyperliquid({
  network: "testnet",
  now: () => f.t.clock.now() * 1000,
  universe: UNIVERSE,
});

let served: ServedVenue;

/** Alice and Bob both may propose from the treasury; each has a wallet of its own. */
let alice: TestAgent;

let bob: TestAgent;

/** An agent of another workspace. */
let carol: TestAgent;

let treasury: { id: WalletId; address: `0x${string}` };

let aliceMcp: Client;

let bobMcp: Client;

/** The intents of the treasury's two fills and two resting orders, by who proposed them. */
const placed: Record<"aliceFill" | "bobFill" | "aliceResting" | "bobResting", IntentId | null> = {
  aliceFill: null,
  bobFill: null,
  aliceResting: null,
  bobResting: null,
};

const TESTNET = "hyperliquid:testnet";

function rules(markets: { asset: number; coin: string }[]): PolicyDraft["venues"] {
  return {
    hyperliquid: {
      network: TESTNET,
      markets: markets.map((market) => ({ ...market, maxNotionalPerOrderUsd6: "100000000" })),
      maxNotionalPerDayUsd6: "5000000000",
      timeInForce: ["Gtc", "Ioc"],
      submitWindowSeconds: 60,
      withdrawals: false,
    },
  };
}

async function call(as: Client, name: string, args: ToolArguments) {
  return toolJson(await as.callTool({ name, arguments: args }));
}

/** A refusal: the call failed, with this code and detail. */
async function refused(as: Client, name: string, args: ToolArguments) {
  const result = await as.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);

  return toolJson(result);
}

/** An ETH order from the treasury, approved with the owner's passkey and posted once. */
async function treasuryOrder(as: Client, limitPrice: string, timeInForce: "Ioc" | "Gtc") {
  const answer = await call(as, "propose_order", {
    network: TESTNET,
    coin: "ETH",
    side: "buy",
    size: "0.01",
    limitPrice,
    timeInForce,
    memo: "a treasury order",
    walletId: treasury.id,
  });

  const intentId = intentIdOf(answer);
  const [row] = await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId));

  if (!row?.approvalId) throw new Error("an intent without its approval");
  expect((await f.t.approve(row.approvalId, [f.t.owner])).status).toBe("executed");
  await engineOf(f.t.ctx).steps().followUp(row.approvalId);
  // Each order at its own venue time, so newest first is one order.
  f.t.clock.advance(1);

  return intentId;
}

beforeAll(async () => {
  served = await serveVenue(venue);
  f = await createFixture(
    "exec_venue_tools",
    1,
    {},
    { venues: [{ network: TESTNET, apiUrl: served.apiUrl }] },
  );
  alice = await f.newAgent("Alice");
  bob = await f.newAgent("Bob");
  carol = await f.newAgent("Carol", await f.newWorkspace("Elsewhere"));

  treasury = await f.t.owner.browser.api.call("createTreasury", {
    params: { workspaceId: f.workspaceId },
    body: { label: "Desk" },
  });

  await f.setPolicy(
    f.workspaceId,
    alice.walletId,
    draftFor(alice.id, { venues: rules([{ asset: BTC, coin: "BTC" }]) }),
  );

  await f.setPolicy(
    f.workspaceId,
    treasury.id,
    draftFor(alice.id, {
      requesters: [alice.id, bob.id],
      venues: rules([{ asset: ETH, coin: "ETH" }]),
    }),
  );

  venue.seedAccount(treasury.address, "100000");
  venue.setBook(ETH, { bid: "1990", ask: "2000" });
  aliceMcp = await f.mcp(alice.token);
  bobMcp = await f.mcp(bob.token);
  placed.aliceFill = await treasuryOrder(aliceMcp, "2000", "Ioc");
  placed.bobFill = await treasuryOrder(bobMcp, "2000", "Ioc");
  placed.aliceResting = await treasuryOrder(aliceMcp, "1900", "Gtc");
  placed.bobResting = await treasuryOrder(bobMcp, "1800", "Gtc");
});

afterAll(async () => {
  await f?.close();
  await served?.close();
});

beforeEach(async () => {
  // Answers are reused for a second at most by the server's clock; and every test starts with
  // full read budgets.
  f.t.clock.advance(60);
  venue.setClockOffset(0);
  await f.t.ctx.db.delete(rateLimits).where(sql`${rateLimits.bucket} LIKE 'venue-read:%'`);
});

describe("market reads", () => {
  it("lists the listed markets with allowed true only for a market a usable wallet's rules name", async () => {
    venue.setBook(BTC, { bid: "59000", ask: "60000" });
    const answer = await call(aliceMcp, "get_markets", { network: TESTNET });

    expect(answer).toMatchObject({
      network: TESTNET,
      observedAt: new Date(f.t.clock.now() * 1000).toISOString(),
      omitted: 0,
    });

    expect(answer.markets).toEqual([
      expect.objectContaining({ coin: "SOL", allowed: false }),
      expect.objectContaining({ coin: "APT", allowed: false }),
      expect.objectContaining({ coin: "ATOM", allowed: false }),
      {
        coin: "BTC",
        asset: 3,
        sizeDecimals: 5,
        maxLeverage: 40,
        isolatedOnly: false,
        markPrice: "59500",
        midPrice: "59500",
        oraclePrice: "59500",
        fundingRateHourly: "0.0",
        openInterest: "0.0",
        dayVolumeUsd: "0.0",
        previousDayPrice: "59500",
        allowed: true,
      },
      expect.objectContaining({ coin: "ETH", allowed: true }),
    ]);

    // Bob's own wallet has no rules; only the treasury's ETH is his.
    const his = await call(bobMcp, "get_markets", { network: TESTNET, coins: ["BTC", "ETH"] });

    expect(his.markets).toEqual([
      expect.objectContaining({ coin: "BTC", allowed: false }),
      expect.objectContaining({ coin: "ETH", allowed: true }),
    ]);

    expect(
      await refused(aliceMcp, "get_markets", { network: TESTNET, coins: ["XYZ"] }),
    ).toMatchObject({ error: "not_found", detail: "market_unknown" });
  });

  it("reads mids, a book and candles as the venue holds them", async () => {
    venue.setBook(BTC, {
      bids: [
        { px: "59000", sz: "1", n: 3 },
        { px: "58900", sz: "2" },
        { px: "58800", sz: "4" },
      ],
      asks: [
        { px: "60000", sz: "0.5" },
        { px: "60100", sz: "1" },
      ],
    });

    expect(
      await call(aliceMcp, "get_prices", { network: TESTNET, coins: ["BTC", "ETH"] }),
    ).toMatchObject({
      prices: [
        { coin: "BTC", mid: "59500" },
        { coin: "ETH", mid: "1995" },
      ],
    });

    const all = await call(aliceMcp, "get_prices", { network: TESTNET });
    expect(all.prices).toEqual([
      { coin: "BTC", mid: "59500" },
      { coin: "ETH", mid: "1995" },
    ]);

    expect(
      await refused(aliceMcp, "get_prices", { network: TESTNET, coins: ["SOL"] }),
    ).toMatchObject({ error: "not_found", detail: "market_unknown" });

    expect(
      await call(aliceMcp, "get_order_book", { network: TESTNET, coin: "BTC", depth: 2 }),
    ).toEqual({
      network: TESTNET,
      observedAt: new Date(f.t.clock.now() * 1000).toISOString(),
      coin: "BTC",
      venueTime: new Date(f.t.clock.now() * 1000).toISOString(),
      mid: "59500",
      spread: "1000",
      bids: [
        { price: "59000", size: "1", orders: 3 },
        { price: "58900", size: "2", orders: 1 },
      ],
      asks: [
        { price: "60000", size: "0.5", orders: 1 },
        { price: "60100", size: "1", orders: 1 },
      ],
      omitted: 0,
    });

    expect(
      await refused(aliceMcp, "get_order_book", { network: TESTNET, coin: "NOPE" }),
    ).toMatchObject({ error: "not_found", detail: "market_unknown" });

    const now = f.t.clock.now() * 1000;
    const hour = 3_600_000;
    const open = now - (now % hour);

    venue.setCandles("BTC", "1h", [
      {
        t: open - 2 * hour,
        T: open - hour - 1,
        o: "58000",
        h: "58500",
        l: "57500",
        c: "58200",
        v: "10",
      },
      { t: open - hour, T: open - 1, o: "58200", h: "59800", l: "58100", c: "59600", v: "8.5" },
      { t: open, T: open + hour - 1, o: "59600", h: "60100", l: "59400", c: "59500", v: "1.25" },
    ]);

    const candles = await call(aliceMcp, "get_candles", {
      network: TESTNET,
      coin: "BTC",
      interval: "1h",
      count: 2,
    });

    expect(candles).toMatchObject({ coin: "BTC", interval: "1h", omitted: 0 });
    expect(candles.candles).toEqual([
      {
        openTime: new Date(open - hour).toISOString(),
        closeTime: new Date(open - 1).toISOString(),
        open: "58200",
        high: "59800",
        low: "58100",
        close: "59600",
        volume: "8.5",
        closed: true,
      },
      {
        openTime: new Date(open).toISOString(),
        closeTime: new Date(open + hour - 1).toISOString(),
        open: "59600",
        high: "60100",
        low: "59400",
        close: "59500",
        volume: "1.25",
        closed: false,
      },
    ]);

    const earlier = await call(aliceMcp, "get_candles", {
      network: TESTNET,
      coin: "BTC",
      interval: "1h",
      count: 1,
      endTime: new Date(open - 2 * hour).toISOString(),
    });

    expect(earlier.candles).toEqual([expect.objectContaining({ open: "58000" })]);
  });

  it("answers default candle reads within five seconds from one request to the venue", async () => {
    venue.setBook(BTC, { bid: "59000", ask: "60000" });
    // Start at the beginning of a five-second window of the server's clock.
    f.t.clock.advance((5 - (f.t.clock.now() % 5)) % 5);

    const asked = () =>
      served.requests.filter((request) => request.body.includes('"candleSnapshot"')).length;

    const before = asked();
    const args = { network: TESTNET, coin: "BTC", interval: "1m", count: 3 };
    await call(aliceMcp, "get_candles", args);
    f.t.clock.advance(4);
    await call(aliceMcp, "get_candles", args);
    expect(asked()).toBe(before + 1);
    // The next window asks again.
    f.t.clock.advance(1);
    await call(aliceMcp, "get_candles", args);
    expect(asked()).toBe(before + 2);
  });

  it("previews an order against a three-level book, on scaled integers", async () => {
    venue.setBook(SOL, {
      bids: [{ px: "99", sz: "3" }],
      asks: [
        { px: "100", sz: "1" },
        { px: "101", sz: "2" },
        { px: "102", sz: "5" },
      ],
    });

    const preview = (args: ToolArguments) =>
      call(aliceMcp, "preview_order", { network: TESTNET, coin: "SOL", ...args });

    // 1 at 100 and 1.5 at 101: 251.5 for 2.5, an average of 100.6.
    expect(await preview({ side: "buy", size: "2.5" })).toMatchObject({
      walletId: alice.walletId,
      fillableSize: "2.5",
      unfilledSize: "0",
      fullyCovered: true,
      averagePrice: "100.6",
      worstPrice: "101",
      bestPrice: "100",
      mid: "99.5",
      // (100.6 − 99.5) / 99.5 × 10^4 = 110.552…
      slippageBps: "110.55",
      notionalUsd6: "251500000",
      takerFeeRate: FAKE_TAKER_RATE,
      // 251.5 × 0.00045 = 0.113175
      estimatedFeeUsd: "0.113175",
      levelsUsed: 2,
      venueTime: new Date(f.t.clock.now() * 1000).toISOString(),
    });

    // With a limit, only the level at 100 counts; the caps count size × limit: 2.5 × 100.5.
    expect(await preview({ side: "buy", size: "2.5", limitPrice: "100.5" })).toMatchObject({
      fillableSize: "1",
      unfilledSize: "1.5",
      fullyCovered: false,
      averagePrice: "100",
      worstPrice: "100",
      notionalUsd6: "251250000",
      levelsUsed: 1,
    });

    // A sell walks the bids, and the book has 3.
    expect(await preview({ side: "sell", size: "4" })).toMatchObject({
      fillableSize: "3",
      unfilledSize: "1",
      fullyCovered: false,
      averagePrice: "99",
      slippageBps: "50.25",
      notionalUsd6: "297000000",
    });

    expect(
      await refused(aliceMcp, "preview_order", {
        network: TESTNET,
        coin: "NOPE",
        side: "buy",
        size: "1",
      }),
    ).toMatchObject({
      error: "not_found",
      detail: "market_unknown",
    });
  });

  it("refuses a stale book, and answers without the fee when the fee rate cannot be read", async () => {
    venue.setBook(SOL, { bid: "99", ask: "100" });
    venue.setClockOffset(-11_000);

    expect(
      await refused(aliceMcp, "preview_order", {
        network: TESTNET,
        coin: "SOL",
        side: "buy",
        size: "1",
      }),
    ).toMatchObject({
      error: "internal",
      detail: "venue_stale",
    });

    venue.setClockOffset(0);
    // Past the ten minutes a fee rate is reused for.
    f.t.clock.advance(601);
    venue.failNext({ endpoint: "info", infoType: "userFees", mode: "http", status: 500 });

    expect(
      await call(aliceMcp, "preview_order", {
        network: TESTNET,
        coin: "SOL",
        side: "buy",
        size: "1",
      }),
    ).toMatchObject({
      fillableSize: "1",
      takerFeeRate: null,
      estimatedFeeUsd: null,
    });
  });
});

describe("account reads", () => {
  it("reads the treasury's account, each resting order with the intent of the agent that placed it", async () => {
    const answer = await call(aliceMcp, "get_venue_account", {
      network: TESTNET,
      walletId: treasury.id,
    });

    expect(answer).toEqual({
      network: TESTNET,
      observedAt: new Date(f.t.clock.now() * 1000).toISOString(),
      walletId: treasury.id,
      address: treasury.address,
      accountValueUsd: "100000",
      withdrawableUsd: expect.any(String),
      // 0.02 ETH at 2000, leverage 20.
      marginUsedUsd: "2",
      positions: [
        {
          coin: "ETH",
          side: "long",
          size: "0.02",
          entryPrice: "2000",
          positionValueUsd: "40",
          unrealizedPnlUsd: "0.0",
          leverage: 20,
          leverageType: "cross",
          maxLeverage: 25,
          returnOnEquity: "0.0",
          liquidationPrice: null,
          marginUsedUsd: "2",
          fundingAllTimeUsd: "0.0",
          fundingSinceOpenUsd: "0.0",
          fundingSinceChangeUsd: "0.0",
        },
      ],
      openOrders: [
        expect.objectContaining({
          coin: "ETH",
          side: "buy",
          size: "0.01",
          limitPrice: "1900",
          intentId: placed.aliceResting,
        }),
        expect.objectContaining({
          coin: "ETH",
          side: "buy",
          size: "0.01",
          limitPrice: "1800",
          intentId: null,
        }),
      ],
      omitted: 0,
    });

    const his = await call(bobMcp, "get_venue_account", {
      network: TESTNET,
      walletId: treasury.id,
    });

    expect(his.openOrders).toEqual([
      expect.objectContaining({ intentId: null }),
      expect.objectContaining({ intentId: placed.bobResting }),
    ]);

    // Alice's own wallet: no account at the venue yet.
    expect(await call(aliceMcp, "get_venue_account", { network: TESTNET })).toMatchObject({
      walletId: alice.walletId,
      accountValueUsd: "0.0",
      positions: [],
      openOrders: [],
    });
  });

  it("reads the treasury's fills newest first, each with the intent of the agent that placed it", async () => {
    const answer = await call(aliceMcp, "get_venue_fills", {
      network: TESTNET,
      walletId: treasury.id,
    });

    expect(answer).toMatchObject({ walletId: treasury.id, omitted: 0 });
    expect(answer.fills).toEqual([
      {
        time: expect.any(String),
        coin: "ETH",
        side: "buy",
        price: "2000",
        size: "0.01",
        feeUsd: "0.0",
        closedPnlUsd: "0.0",
        taker: true,
        venueOrderId: expect.any(Number),
        intentId: null,
      },
      expect.objectContaining({ coin: "ETH", intentId: placed.aliceFill }),
    ]);

    const his = await call(bobMcp, "get_venue_fills", {
      network: TESTNET,
      walletId: treasury.id,
      coin: "ETH",
      limit: 1,
    });

    expect(his.fills).toEqual([expect.objectContaining({ intentId: placed.bobFill })]);
    expect(
      await call(aliceMcp, "get_venue_fills", {
        network: TESTNET,
        walletId: treasury.id,
        coin: "BTC",
      }),
    ).toMatchObject({ fills: [] });
  });

  it("shows no market name outside the pattern orders use, and counts what it leaves out", async () => {
    venue.setUniverse(
      UNIVERSE.map((asset) => (asset.name === "ETH" ? { ...asset, name: "ETH/USD (new)" } : asset)),
    );

    try {
      const account = await call(aliceMcp, "get_venue_account", {
        network: TESTNET,
        walletId: treasury.id,
      });

      expect(account).toMatchObject({ positions: [], omitted: 1 });

      const fills = await call(aliceMcp, "get_venue_fills", {
        network: TESTNET,
        walletId: treasury.id,
      });

      expect(fills).toMatchObject({ fills: [], omitted: 2 });
      const markets = await call(aliceMcp, "get_markets", { network: TESTNET });
      expect(markets).toMatchObject({ omitted: 1 });
      expect(JSON.stringify([account, fills, markets])).not.toContain("USD (new)");
    } finally {
      venue.setUniverse(UNIVERSE);
    }
  });

  it("answers another agent's wallet and another workspace's exactly as a wallet that does not exist", async () => {
    for (const tool of ["get_venue_account", "get_venue_fills", "preview_order"]) {
      const args = tool === "preview_order" ? { coin: "SOL", side: "buy", size: "1" } : {};

      for (const walletId of [bob.walletId, carol.walletId]) {
        expect(await refused(aliceMcp, tool, { network: TESTNET, walletId, ...args })).toEqual({
          error: "not_found",
          message: "no such wallet",
        });
      }
    }
  });
});

describe("refusals", () => {
  it("refuses a network the server is not configured for", async () => {
    for (const [tool, args] of [
      ["get_markets", {}],
      ["get_prices", {}],
      ["get_order_book", { coin: "BTC" }],
      ["get_candles", { coin: "BTC", interval: "1h" }],
      ["preview_order", { coin: "BTC", side: "buy", size: "1" }],
      ["get_venue_account", {}],
      ["get_venue_fills", {}],
    ] as const) {
      expect(
        await refused(aliceMcp, tool, { network: "hyperliquid:mainnet", ...args }),
      ).toMatchObject({
        error: "invalid_request",
        detail: "venue_not_configured",
      });
    }
  });

  it("refuses an agent past its read budget, while another agent reads and the agent still proposes", async () => {
    const bucket = (agentId: AgentId) => `venue-read:${TESTNET}:${agentId}`;

    // Alice's bucket is spent and stays so.
    await f.t.ctx.db
      .insert(rateLimits)
      .values({ bucket: bucket(alice.id), tokens: 0, at: sql`now() + interval '1 hour'` });

    const sent = served.requests.length;
    expect(await refused(aliceMcp, "get_prices", { network: TESTNET })).toMatchObject({
      error: "rate_limited",
      detail: "venue_budget",
    });
    expect(served.requests.length).toBe(sent);

    expect(await call(bobMcp, "get_order_book", { network: TESTNET, coin: "ETH" })).toMatchObject({
      coin: "ETH",
    });

    expect(
      await call(aliceMcp, "propose_order", {
        network: TESTNET,
        coin: "BTC",
        side: "buy",
        size: "0.001",
        limitPrice: "59000",
        timeInForce: "Gtc",
        memo: "with the read budget spent",
      }),
    ).toMatchObject({ status: "pending_approval" });
  });
});
