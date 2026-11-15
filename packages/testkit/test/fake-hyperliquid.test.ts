/**
 * TEST EQUIPMENT'S OWN TESTS. The fake venue is only worth something if it verifies like the
 * venue, so it is first held to the venue's own SDK: the signed requests of
 * hyperliquid-python-sdk at 2fdb18f9 (apps/signer/test/vectors/hyperliquid-python-sdk.json) are
 * posted to it as the SDK would post them, and must be taken from the SDK test key's account,
 * refused from any other account, and refused when any one byte changes. The behaviour tests
 * after that sign their own requests with the hash those vectors proved.
 */
import { bytesToHex, type Hex, parseSignature, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import vectors from "../../../apps/signer/test/vectors/hyperliquid-python-sdk.json" with {
  type: "json",
};
import {
  type ExchangeRecord,
  FakeHyperliquid,
  type FakeNetwork,
  l1ActionHash,
  recoverExchangeSigner,
  type SignedAction,
} from "../src/fake-hyperliquid.ts";
import { referenceMsgpackEncode } from "../src/msgpack.ts";

const sdkKey = privateKeyToAccount(vectors.privateKey as Hex);
const SDK_ADDRESS = sdkKey.address.toLowerCase();
const stranger = privateKeyToAccount(`0x${"11".repeat(32)}`);
const DAY_MS = 86_400_000;

const notFound = (address: string) => `User or API Wallet ${address} does not exist.`;
const venueError = (pattern: RegExp) => ({
  status: "err",
  response: expect.stringMatching(pattern),
});
const ok = (type: "order" | "cancel", statuses: unknown[]) => ({
  status: "ok",
  response: { type, data: { statuses } },
});

interface VectorSignature {
  r: string;
  s: string;
  v: number;
}

/** A body as hyperliquid-python-sdk's `Exchange._post_action` posts it. */
interface SdkRequest {
  action: unknown;
  nonce: number;
  signature: VectorSignature;
  vaultAddress: null;
  expiresAfter: number | null;
}

function sdkBody(
  action: unknown,
  nonce: number,
  signature: VectorSignature,
  expiresAfter: number | null,
): SdkRequest {
  return { action, nonce, signature, vaultAddress: null, expiresAfter };
}

/** The vectors' `r` and `s` are hex strings, as the SDK writes them (leading zeros dropped). */
function signed(body: SdkRequest): SignedAction {
  const { r, s, v } = body.signature;
  return { ...body, signature: { r: r as Hex, s: s as Hex, v } };
}

const generated = vectors.generated.output;
const orderVector = sdkBody(
  generated.order.action,
  generated.order.nonce,
  generated.order.testnet,
  generated.order.expiresAfter,
);
const cancelVector = sdkBody(
  generated.cancel.action,
  generated.cancel.nonce,
  generated.cancel.testnet,
  generated.cancel.expiresAfter,
);
/** The SDK's `withdraw_from_bridge` action, as `sign_user_signed_action` completes it. */
const withdraw = vectors.sdkTests.withdraw;
const withdrawAction = {
  destination: withdraw.destination,
  amount: withdraw.amount,
  time: withdraw.time,
  type: "withdraw3",
  signatureChainId: "0x66eee",
  hyperliquidChain: "Testnet",
};
const withdrawVector = sdkBody(withdrawAction, withdraw.time, withdraw.testnet, null);
const [dummyVector, gtcVector, gtcCloidVector] = vectors.sdkTests.signatures;

function venueAt(time: number, network: FakeNetwork = "testnet") {
  return new FakeHyperliquid({ network, now: () => time });
}

async function post(venue: FakeHyperliquid, path: string, body: unknown) {
  const response = await venue.fetch(`http://fake-hyperliquid:8080${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const isJson = response.headers.get("content-type")?.startsWith("application/json") ?? false;
  const answer: unknown = isJson ? await response.json() : await response.text();
  return { status: response.status, body: answer };
}

function lastRecord(venue: FakeHyperliquid): ExchangeRecord | undefined {
  return venue.exchangeLog().at(-1);
}

describe("the venue SDK's own signed requests", () => {
  it("hash to the SDK's connection ids, through msgpack bytes equal to the SDK's", () => {
    const check = vectors.sdkTests.connectionId;
    expect(l1ActionHash(check.action, check.nonce, null, null)).toBe(check.connectionId);
    expect(generated.check_ioc_connection_id).toBe(check.connectionId);
    for (const vector of [generated.order, generated.cancel]) {
      expect(bytesToHex(referenceMsgpackEncode(vector.action))).toBe(`0x${vector.msgpack}`);
      expect(l1ActionHash(vector.action, vector.nonce, null, vector.expiresAfter)).toBe(
        vector.connectionId,
      );
    }
  });

  it("recover to the SDK key on the network they were signed for, and to another on the other", async () => {
    const cases: { body: SdkRequest; network: FakeNetwork }[] = [];
    for (const vector of vectors.sdkTests.signatures) {
      for (const network of ["mainnet", "testnet"] as const) {
        cases.push({
          body: sdkBody(vector.action, vector.nonce, vector[network], vector.expiresAfter),
          network,
        });
      }
    }
    cases.push(
      { body: orderVector, network: "testnet" },
      {
        body: sdkBody(
          generated.order.action,
          generated.order.nonce,
          generated.order.mainnet,
          generated.order.expiresAfter,
        ),
        network: "mainnet",
      },
      { body: cancelVector, network: "testnet" },
    );
    expect(cases).toHaveLength(9);
    for (const { body, network } of cases) {
      const other = network === "mainnet" ? "testnet" : "mainnet";
      expect(await recoverExchangeSigner(signed(body), network)).toBe(SDK_ADDRESS);
      expect(await recoverExchangeSigner(signed(body), other)).not.toBe(SDK_ADDRESS);
    }
    expect(await recoverExchangeSigner(signed(withdrawVector), "testnet")).toBe(SDK_ADDRESS);
    expect(dummyVector?.action.type).toBe("dummy");
  });

  it("are taken from the SDK key's account and refused from an account nobody seeded", async () => {
    const venue = venueAt(generated.order.nonce);
    venue.setBook(3, { bid: null, ask: "64000" });

    expect((await post(venue, "/exchange", orderVector)).body).toEqual({
      status: "err",
      response: notFound(SDK_ADDRESS),
    });
    expect(venue.orders()).toEqual([]);

    venue.seedAccount(SDK_ADDRESS, "1000");
    const cloid = generated.order.action.orders[0]?.c;
    expect((await post(venue, "/exchange", orderVector)).body).toEqual(
      ok("order", [{ filled: { totalSz: "0.01", avgPx: "65000", oid: 1, cloid } }]),
    );
    expect(venue.orders()).toMatchObject([
      {
        user: SDK_ADDRESS,
        cloid,
        asset: 3,
        coin: "BTC",
        isBuy: true,
        limitPx: "65000",
        size: "0.01",
        filledSize: "0.01",
        tif: "Ioc",
        status: "filled",
        nonce: generated.order.nonce,
        expiresAfter: generated.order.expiresAfter,
      },
    ]);
    expect(lastRecord(venue)).toMatchObject({ signer: SDK_ADDRESS, accepted: true });

    // The cancel the SDK signed for the same cloid is taken (its nonce is used), but the order
    // filled, so the venue's answer for it is an error.
    expect((await post(venue, "/exchange", cancelVector)).body).toEqual(
      ok("cancel", [{ error: "Order was never placed, already canceled, or filled. asset=3" }]),
    );
    expect(lastRecord(venue)).toMatchObject({ signer: SDK_ADDRESS, accepted: true });
  });

  it("are refused when the same order was signed for mainnet", async () => {
    const venue = venueAt(generated.order.nonce);
    venue.seedAccount(SDK_ADDRESS, "1000");
    const mainnet = sdkBody(
      generated.order.action,
      generated.order.nonce,
      generated.order.mainnet,
      generated.order.expiresAfter,
    );
    const answer = await post(venue, "/exchange", mainnet);
    const signer = lastRecord(venue)?.signer;
    expect(signer).not.toBe(SDK_ADDRESS);
    expect(answer.body).toEqual({ status: "err", response: notFound(String(signer)) });
    expect(venue.orders()).toEqual([]);
  });

  it("are refused when any one byte of the order changes, and nothing is recorded", async () => {
    const venue = venueAt(generated.order.nonce);
    venue.seedAccount(SDK_ADDRESS, "1000");
    venue.setBook(3, { bid: null, ask: "64000" });
    const original = JSON.stringify(orderVector);
    let mutations = 0;
    let bySignature = 0;
    for (let index = 0; index < original.length; index++) {
      const char = original.charAt(index);
      let replacement: string;
      if (/[0-9]/.test(char)) replacement = String((Number(char) + 1) % 10);
      else if (/[a-f]/.test(char)) {
        replacement = char === "f" ? "a" : String.fromCharCode(char.charCodeAt(0) + 1);
      } else continue;
      const mutated = original.slice(0, index) + replacement + original.slice(index + 1);
      const answer = await post(venue, "/exchange", mutated);
      mutations++;
      const record = lastRecord(venue);
      expect(record?.accepted, `byte ${index}: ${mutated}`).toBe(false);
      if (answer.status !== 200) {
        expect(answer.status, `byte ${index}`).toBe(422);
        continue;
      }
      expect(answer.body, `byte ${index}`).toMatchObject({ status: "err" });
      const signer = record?.signer ?? null;
      if (signer !== null) {
        expect(signer).not.toBe(SDK_ADDRESS);
        expect(answer.body).toEqual({ status: "err", response: notFound(signer) });
        bySignature++;
      }
    }
    expect(venue.orders()).toEqual([]);
    expect(mutations).toBeGreaterThan(150);
    // Nearly every changed byte of r, s, the nonce, the expiry and the action's values still
    // parses and recovers someone else.
    expect(bySignature).toBeGreaterThan(130);

    expect((await post(venue, "/exchange", original)).body).toMatchObject({ status: "ok" });
    expect(venue.orders()).toHaveLength(1);
  });

  it("include the SDK's resting order by cloid, which orderStatus finds, and its nonce rule", async () => {
    if (gtcCloidVector === undefined || gtcVector === undefined) throw new Error("vectors");
    const venue = venueAt(0);
    venue.seedAccount(SDK_ADDRESS, "2000");
    const cloid = "0x00000000000000000000000000000001";
    const body = sdkBody(gtcCloidVector.action, 0, gtcCloidVector.testnet, null);
    expect((await post(venue, "/exchange", body)).body).toEqual(
      ok("order", [{ resting: { oid: 1, cloid } }]),
    );
    const status = await post(venue, "/info", {
      type: "orderStatus",
      user: SDK_ADDRESS,
      oid: cloid,
    });
    expect(status.body).toEqual({
      status: "order",
      order: {
        order: {
          coin: "APT",
          side: "B",
          limitPx: "100",
          sz: "100",
          oid: 1,
          timestamp: 0,
          triggerCondition: "N/A",
          isTrigger: false,
          triggerPx: "0.0",
          children: [],
          isPositionTpsl: false,
          reduceOnly: false,
          orderType: "Limit",
          origSz: "100",
          tif: "Gtc",
          cloid,
        },
        status: "open",
        statusTimestamp: 0,
      },
    });
    // The SDK's other order was signed with the same nonce, 0.
    const second = sdkBody(gtcVector.action, 0, gtcVector.testnet, null);
    expect((await post(venue, "/exchange", second)).body).toEqual({
      status: "err",
      response: "Invalid nonce: duplicate nonce 0",
    });
  });

  it("include the SDK's withdrawal, which the venue takes and refuses as smaller than its fee", async () => {
    const venue = venueAt(withdraw.time);
    expect((await post(venue, "/exchange", withdrawVector)).body).toEqual({
      status: "err",
      response: notFound(SDK_ADDRESS),
    });
    venue.seedAccount(SDK_ADDRESS, "1000");
    expect((await post(venue, "/exchange", withdrawVector)).body).toEqual({
      status: "err",
      response: "Withdrawal is smaller than fee.",
    });
    expect(lastRecord(venue)).toMatchObject({ signer: SDK_ADDRESS, accepted: true });

    const later = withdraw.time + 1;
    const tampered = sdkBody({ ...withdrawAction, time: later }, later, withdraw.testnet, null);
    const answer = await post(venue, "/exchange", tampered);
    const signer = lastRecord(venue)?.signer;
    expect(signer).not.toBe(SDK_ADDRESS);
    expect(answer.body).toEqual({ status: "err", response: notFound(String(signer)) });
    expect(venue.withdrawals()).toEqual([]);
  });
});

// --- behaviour, with requests signed here --------------------------------------------------

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

const NOW = 1_794_787_200_000;
const ETH = 4;
const CLOID_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLOID_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function signL1(
  action: unknown,
  nonce: number,
  expiresAfter: number | null,
  account = sdkKey,
) {
  const connectionId = l1ActionHash(action, nonce, null, expiresAfter);
  const signature = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: "b", connectionId },
  });
  const { r, s, yParity } = parseSignature(signature);
  return { action, nonce, signature: { r, s, v: 27 + yParity }, vaultAddress: null, expiresAfter };
}

async function signWithdraw(amount: string, time: number) {
  const action = {
    type: "withdraw3",
    hyperliquidChain: "Testnet",
    signatureChainId: "0x66eee",
    amount,
    time,
    destination: SDK_ADDRESS,
  };
  const signature = await sdkKey.signTypedData({
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 0x66eee,
      verifyingContract: zeroAddress,
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
    message: { hyperliquidChain: "Testnet", destination: SDK_ADDRESS, amount, time: BigInt(time) },
  });
  const { r, s, yParity } = parseSignature(signature);
  return {
    action,
    nonce: time,
    signature: { r, s, v: 27 + yParity },
    vaultAddress: null,
    expiresAfter: null,
  };
}

function order(
  tif: "Gtc" | "Ioc" | "Alo",
  fields: { b?: boolean; p?: string; s?: string; r?: boolean; c?: string } = {},
) {
  return {
    type: "order",
    orders: [
      {
        a: ETH,
        b: fields.b ?? true,
        p: fields.p ?? "1670.1",
        s: fields.s ?? "0.1",
        r: fields.r ?? false,
        t: { limit: { tif } },
        c: fields.c ?? CLOID_A,
      },
    ],
    grouping: "na",
  };
}

function cancel(cloid: string) {
  return { type: "cancelByCloid", cancels: [{ asset: ETH, cloid }] };
}

function seeded(usdc = "1000") {
  const venue = venueAt(NOW);
  venue.seedAccount(SDK_ADDRESS, usdc);
  return venue;
}

describe("the fake venue's rules", () => {
  it("refuses a signed order sent twice by its nonce, and keeps one order", async () => {
    const venue = seeded();
    const body = await signL1(order("Gtc"), NOW, NOW + 60_000);
    expect((await post(venue, "/exchange", body)).body).toEqual(
      ok("order", [{ resting: { oid: 1, cloid: CLOID_A } }]),
    );
    expect((await post(venue, "/exchange", body)).body).toEqual({
      status: "err",
      response: `Invalid nonce: duplicate nonce ${NOW}`,
    });
    expect(venue.orders()).toHaveLength(1);
  });

  it("refuses an action after its expiresAfter without using its nonce", async () => {
    const venue = seeded();
    const body = await signL1(order("Gtc"), NOW, NOW + 5_000);
    venue.setClockOffset(5_001);
    expect((await post(venue, "/exchange", body)).body).toEqual(venueError(/^Action expired/));
    expect(venue.orders()).toEqual([]);
    venue.setClockOffset(5_000);
    expect((await post(venue, "/exchange", body)).body).toEqual(
      ok("order", [{ resting: { oid: 1, cloid: CLOID_A } }]),
    );
  });

  it("refuses a nonce outside (T − 2 days, T + 1 day) and one lower than all of the 100 highest", async () => {
    const venue = seeded();
    for (const nonce of [NOW - 2 * DAY_MS, NOW + DAY_MS]) {
      const answer = await post(venue, "/exchange", await signL1(cancel(CLOID_B), nonce, null));
      expect(answer.body).toEqual(venueError(/^Invalid nonce/));
    }
    for (let step = 1; step <= 100; step++) {
      const answer = await post(
        venue,
        "/exchange",
        await signL1(cancel(CLOID_B), NOW + step, null),
      );
      expect(answer.body).toMatchObject({ status: "ok" });
    }
    const low = await post(venue, "/exchange", await signL1(cancel(CLOID_B), NOW, null));
    expect(low.body).toEqual(venueError(/^Invalid nonce/));
    const high = await post(venue, "/exchange", await signL1(cancel(CLOID_B), NOW + 101, null));
    expect(high.body).toMatchObject({ status: "ok" });
  });

  it("applies the perpetual tick, lot, notional, margin and time-in-force rules", async () => {
    const venue = seeded();
    const cloid = (n: number) => `0x${n.toString(16).padStart(32, "0")}`;
    const cases: [action: unknown, status: unknown][] = [
      [
        order("Gtc", { p: "1670.15", c: cloid(16) }),
        { error: "Price must be divisible by tick size. asset=4" },
      ],
      [order("Gtc", { s: "0.00001", c: cloid(17) }), { error: "Order has invalid size." }],
      [
        order("Gtc", { p: "1000", s: "0.001", c: cloid(18) }),
        { error: "Order must have minimum value of $10. asset=4" },
      ],
      [
        order("Ioc", { c: cloid(19) }),
        { error: "Order could not immediately match against any resting orders. asset=4" },
      ],
      [
        order("Gtc", { r: true, c: cloid(20) }),
        { error: "Reduce only order would increase position. asset=4" },
      ],
      [
        order("Gtc", { s: "100", c: cloid(21) }),
        { error: "Insufficient margin to place order. asset=4" },
      ],
    ];
    let nonce = NOW;
    for (const [action, expected] of cases) {
      const answer = await post(venue, "/exchange", await signL1(action, nonce++, null));
      expect(answer.body).toEqual(ok("order", [expected]));
    }
    // A refused order is kept with the venue's historical status; one it could not read is not.
    const tick = await post(venue, "/info", {
      type: "orderStatus",
      user: SDK_ADDRESS,
      oid: cloid(16),
    });
    expect(tick.body).toMatchObject({ status: "order", order: { status: "tickRejected" } });
    const lot = await post(venue, "/info", {
      type: "orderStatus",
      user: SDK_ADDRESS,
      oid: cloid(17),
    });
    expect(lot.body).toEqual({ status: "unknownOid" });
  });

  it("fills across the book at the limit price, rests otherwise, and cancels by cloid", async () => {
    const venue = seeded();
    venue.setBook(ETH, { bid: "1660", ask: "1670" });
    const alo = await post(
      venue,
      "/exchange",
      await signL1(order("Alo", { c: CLOID_B }), NOW, null),
    );
    expect(alo.body).toEqual(
      ok("order", [
        { error: "Post only order would have immediately matched, bbo was 1660@1670. asset=4" },
      ]),
    );
    const ioc = await post(venue, "/exchange", await signL1(order("Ioc"), NOW + 1, null));
    expect(ioc.body).toEqual(
      ok("order", [{ filled: { totalSz: "0.1", avgPx: "1670.1", oid: 2, cloid: CLOID_A } }]),
    );
    const resting = "0x0000000000000000000000000000cafe";
    const sell = order("Gtc", { b: false, p: "1700", s: "0.05", c: resting });
    const gtc = await post(venue, "/exchange", await signL1(sell, NOW + 2, null));
    expect(gtc.body).toEqual(ok("order", [{ resting: { oid: 3, cloid: resting } }]));

    const state = await post(venue, "/info", { type: "clearinghouseState", user: SDK_ADDRESS });
    expect(state.body).toMatchObject({
      marginSummary: { accountValue: "1000", totalNtlPos: "167.01" },
      assetPositions: [
        { type: "oneWay", position: { coin: "ETH", szi: "0.1", entryPx: "1670.1" } },
      ],
    });

    const cancelled = await post(venue, "/exchange", await signL1(cancel(resting), NOW + 3, null));
    expect(cancelled.body).toEqual(ok("cancel", ["success"]));
    const again = await post(venue, "/exchange", await signL1(cancel(resting), NOW + 4, null));
    const refusal = "Order was never placed, already canceled, or filled. asset=4";
    expect(again.body).toEqual(ok("cancel", [{ error: refusal }]));
    expect(venue.cancels().map((entry) => entry.result)).toEqual(["success", refusal]);
    const status = await post(venue, "/info", { type: "orderStatus", user: SDK_ADDRESS, oid: 3 });
    expect(status.body).toMatchObject({ order: { status: "canceled", order: { sz: "0.05" } } });
  });

  it("fills a resting order on request and closes the position with its realised profit", async () => {
    const venue = seeded();
    await post(venue, "/exchange", await signL1(order("Gtc", { p: "1600" }), NOW, null));
    expect(venue.fillOrder(SDK_ADDRESS, CLOID_A)).toMatchObject({ status: "filled" });
    const close = order("Gtc", { b: false, p: "1700", r: true, c: CLOID_B });
    const answer = await post(venue, "/exchange", await signL1(close, NOW + 1, null));
    expect(answer.body).toEqual(ok("order", [{ resting: { oid: 2, cloid: CLOID_B } }]));
    venue.fillOrder(SDK_ADDRESS, CLOID_B);
    const state = await post(venue, "/info", { type: "clearinghouseState", user: SDK_ADDRESS });
    expect(state.body).toMatchObject({
      marginSummary: { accountValue: "1010" },
      assetPositions: [],
    });
  });

  it("answers 422 to a request it cannot read, as the venue does", async () => {
    const venue = seeded();
    const { orders } = order("Gtc");
    const reordered = await signL1({ orders, type: "order", grouping: "na" }, NOW, null);
    expect((await post(venue, "/exchange", reordered)).status).toBe(422);
    const trailingZero = await signL1(order("Gtc", { p: "1670.10" }), NOW, null);
    expect((await post(venue, "/exchange", trailingZero)).status).toBe(422);
    expect((await post(venue, "/exchange", "{")).status).toBe(422);
    expect((await post(venue, "/info", { type: "allMids" })).status).toBe(422);
    expect(venue.orders()).toEqual([]);
  });

  it("withdraws to the signed destination and records it", async () => {
    const venue = seeded("10");
    expect((await post(venue, "/exchange", await signWithdraw("2", NOW))).body).toEqual({
      status: "ok",
      response: { type: "default" },
    });
    expect((await post(venue, "/exchange", await signWithdraw("9", NOW + 1))).body).toEqual({
      status: "err",
      response: "Insufficient balance for withdrawal.",
    });
    expect(venue.withdrawals()).toEqual([
      { user: SDK_ADDRESS, destination: SDK_ADDRESS, amount: "2", nonce: NOW, receivedAt: NOW },
    ]);
    const ledger = { type: "userNonFundingLedgerUpdates", user: SDK_ADDRESS, startTime: NOW };
    expect((await post(venue, "/info", ledger)).body).toEqual([
      {
        time: NOW,
        hash: `0x${NOW.toString(16).padStart(64, "0")}`,
        delta: { type: "withdraw", usdc: "1", nonce: NOW, fee: "1" },
      },
    ]);
    expect((await post(venue, "/info", { ...ledger, startTime: NOW + 1 })).body).toEqual([]);
    const other = stranger.address.toLowerCase();
    expect(
      (
        await post(venue, "/info", {
          type: "userNonFundingLedgerUpdates",
          user: other,
          startTime: 0,
        })
      ).body,
    ).toEqual([]);
    expect(
      (await post(venue, "/info", { type: "userNonFundingLedgerUpdates", user: SDK_ADDRESS }))
        .status,
    ).toBe(422);
  });

  it("lists an account's resting orders with what is left of them", async () => {
    const venue = seeded();
    venue.setBook(ETH, { bid: "1660", ask: "1670" });
    await post(venue, "/exchange", await signL1(order("Gtc", { p: "1600" }), NOW, null));
    await post(venue, "/exchange", await signL1(order("Ioc", { c: CLOID_B }), NOW + 1, null));
    expect((await post(venue, "/info", { type: "openOrders", user: SDK_ADDRESS })).body).toEqual([
      { coin: "ETH", limitPx: "1600", oid: 1, side: "B", sz: "0.1", timestamp: NOW },
    ]);
    venue.fillOrder(SDK_ADDRESS, CLOID_A);
    expect((await post(venue, "/info", { type: "openOrders", user: SDK_ADDRESS })).body).toEqual(
      [],
    );
  });

  it("answers meta from the metadata a test sets", async () => {
    const venue = seeded();
    const put = await venue.fetch("http://fake-hyperliquid/control/meta", {
      method: "PUT",
      body: JSON.stringify({
        universe: [
          { name: "BTC", szDecimals: 5, maxLeverage: 40 },
          { name: "OLD", szDecimals: 1, maxLeverage: 3, isDelisted: true },
        ],
      }),
    });
    expect(put.status).toBe(204);
    expect((await post(venue, "/info", { type: "meta" })).body).toEqual({
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "OLD", szDecimals: 1, maxLeverage: 3, isDelisted: true },
      ],
    });
  });

  it("fails on request: a venue error, an HTTP error, or a dropped answer after taking the order", async () => {
    const venue = seeded();
    venue.failNext({ mode: "error", response: "Something went wrong." });
    venue.failNext({ mode: "http", status: 502 });
    venue.failNext({ endpoint: "info", mode: "drop" });
    const body = await signL1(order("Gtc"), NOW, null);
    expect((await post(venue, "/exchange", body)).body).toEqual({
      status: "err",
      response: "Something went wrong.",
    });
    expect((await post(venue, "/exchange", body)).status).toBe(502);
    expect(venue.orders()).toEqual([]);
    await expect(post(venue, "/info", { type: "meta" })).rejects.toThrow(TypeError);

    expect((await post(venue, "/control/failures", { mode: "drop" })).status).toBe(204);
    await expect(post(venue, "/exchange", body)).rejects.toThrow("fetch failed");
    expect(venue.orders()).toHaveLength(1);
    expect(lastRecord(venue)).toMatchObject({ dropped: true, accepted: true, status: 0 });
    expect((await post(venue, "/exchange", body)).body).toEqual({
      status: "err",
      response: `Invalid nonce: duplicate nonce ${NOW}`,
    });
  });

  it("is controlled over HTTP: seed an account, read the orders and the log, reset", async () => {
    const venue = venueAt(NOW);
    const seed = { address: stranger.address, usdc: "50" };
    expect((await post(venue, "/control/accounts", seed)).status).toBe(204);
    const body = await signL1(order("Gtc", { s: "0.01" }), NOW, null, stranger);
    expect((await post(venue, "/exchange", body)).body).toEqual(
      ok("order", [{ resting: { oid: 1, cloid: CLOID_A } }]),
    );
    const orders = await venue.fetch("http://fake-hyperliquid/control/orders");
    expect(await orders.json()).toMatchObject([
      { user: stranger.address.toLowerCase(), cloid: CLOID_A, status: "open" },
    ]);
    const log = await venue.fetch("http://fake-hyperliquid/control/exchange");
    expect(await log.json()).toMatchObject([{ body: JSON.stringify(body), accepted: true }]);
    expect((await post(venue, "/control/reset", "")).status).toBe(204);
    expect(venue.orders()).toEqual([]);
    expect((await post(venue, "/exchange", body)).body).toEqual({
      status: "err",
      response: notFound(stranger.address.toLowerCase()),
    });
  });
});
