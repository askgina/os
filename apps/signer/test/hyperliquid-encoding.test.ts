import {
  Address,
  type ApprovalId,
  Cloid,
  Hex32,
  HyperliquidOrderOperation,
  VenueNetwork,
} from "@askgina/os-protocol";
import { referenceMsgpackEncode } from "@askgina/os-testkit/msgpack";
import { parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  cancelByCloidAction,
  cloidFor,
  eip712Json,
  HYPERLIQUID_L1_DOMAIN,
  l1ActionHash,
  l1TypedData,
  nextNonce,
  orderAction,
  withdrawAction,
  withdrawTypedData,
} from "../src/venues/hyperliquid.ts";
import { encodeMsgpack, MsgpackMap, type MsgpackValue } from "../src/venues/msgpack.ts";
import { mapFromJson } from "./hyperliquid-vectors.ts";
import vectors from "./vectors/hyperliquid-python-sdk.json" with { type: "json" };

const account = privateKeyToAccount(Hex32.parse(vectors.privateKey));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A `MsgpackMap` tree as plain objects, for the reference encoder (it keeps insertion order). */
function toPlain(value: MsgpackValue): unknown {
  if (value instanceof MsgpackMap) {
    return Object.fromEntries(value.entries.map(([key, entry]) => [key, toPlain(entry)]));
  }

  if (Array.isArray(value)) return value.map(toPlain);

  return value;
}

/** Our bytes for `ours` equal the reference encoder's bytes for `plain`. */
function expectSameBytes(ours: MsgpackValue, plain: unknown) {
  expect(hex(encodeMsgpack(ours))).toBe(hex(referenceMsgpackEncode(plain)));
}

async function expectSdkSignature(
  typedData: Parameters<typeof account.signTypedData>[0],
  expected: { r: string; s: string; v: number },
) {
  const { r, s, v } = parseSignature(await account.signTypedData(typedData));
  // The SDK's to_hex drops leading zero digits, so compare the numbers.
  expect({ r: BigInt(r), s: BigInt(s), v: Number(v) }).toEqual({
    r: BigInt(expected.r),
    s: BigInt(expected.s),
    v: expected.v,
  });
}

const NETWORKS = [
  ["mainnet", "hyperliquid:mainnet"],
  ["testnet", "hyperliquid:testnet"],
] as const satisfies readonly (readonly [string, VenueNetwork])[];

describe("the Hyperliquid Python SDK's vectors", () => {
  it("reproduces the connection id of its IOC order, built from the intent's own fields", () => {
    const vector = vectors.sdkTests.connectionId;
    const operation = HyperliquidOrderOperation.parse(vector.operation);
    expectSameBytes(mapFromJson(vector.action), vector.action);
    expect(l1ActionHash(mapFromJson(vector.action), vector.nonce, null)).toBe(vector.connectionId);
    // The SDK's order had no cloid; the signer's always has one, appended as the last order key.
    const cloid = Cloid.parse("0x000102030405060708090a0b0c0d0e0f");
    const [order] = vector.action.orders;
    expectSameBytes(orderAction(operation, cloid), {
      ...vector.action,
      orders: [{ ...order, c: cloid }],
    });
  });

  for (const vector of vectors.sdkTests.signatures) {
    for (const [name, network] of NETWORKS) {
      it(`reproduces ${vector.test} (lines ${vector.lines}) on ${name}`, async () => {
        let action = mapFromJson(vector.action);

        if (vector.operation !== null && vector.cloid !== null) {
          action = orderAction(
            HyperliquidOrderOperation.parse(vector.operation),
            Cloid.parse(vector.cloid),
          );
          expectSameBytes(action, vector.action);
        } else if (vector.operation !== null && "orders" in vector.action) {
          // The intent's fields give the SDK's order with the signer's cloid added.
          const cloid = Cloid.parse("0xffeeddccbbaa99887766554433221100");
          const [order] = vector.action.orders;
          expectSameBytes(orderAction(HyperliquidOrderOperation.parse(vector.operation), cloid), {
            ...vector.action,
            orders: [{ ...order, c: cloid }],
          });
        }

        const connectionId = l1ActionHash(action, vector.nonce, vector.expiresAfter);
        await expectSdkSignature(l1TypedData(connectionId, network), vector[name]);
      });
    }
  }

  it("reproduces the generated order with expiresAfter on both networks, byte for byte", async () => {
    const { inputs, output } = vectors.generated;

    const action = orderAction(
      HyperliquidOrderOperation.parse(inputs.order.operation),
      Cloid.parse(inputs.order.cloid),
    );

    expect(hex(encodeMsgpack(action))).toBe(output.order.msgpack);
    expectSameBytes(action, output.order.action);
    const connectionId = l1ActionHash(action, output.order.nonce, output.order.expiresAfter);
    expect(connectionId).toBe(output.order.connectionId);
    expect(l1ActionHash(action, output.order.nonce, null)).not.toBe(connectionId);

    for (const [name, network] of NETWORKS) {
      await expectSdkSignature(l1TypedData(connectionId, network), output.order[name]);
    }
  });

  it("reproduces the generated cancel by cloid with expiresAfter", async () => {
    const { inputs, output } = vectors.generated;
    const action = cancelByCloidAction(inputs.cancel.asset, Cloid.parse(inputs.cancel.cloid));
    expect(hex(encodeMsgpack(action))).toBe(output.cancel.msgpack);
    const connectionId = l1ActionHash(action, output.cancel.nonce, output.cancel.expiresAfter);
    expect(connectionId).toBe(output.cancel.connectionId);
    await expectSdkSignature(
      l1TypedData(connectionId, "hyperliquid:testnet"),
      output.cancel.testnet,
    );
  });

  it("reproduces its testnet withdrawal, and the request body names the same fields", async () => {
    const vector = vectors.sdkTests.withdraw;
    const network = VenueNetwork.parse(vector.network);
    const destination = Address.parse(vector.destination);
    await expectSdkSignature(
      withdrawTypedData(network, destination, vector.amount, vector.time),
      vector.testnet,
    );
    const action = withdrawAction(network, destination, vector.amount, vector.time);
    expect(Object.entries(action)).toEqual([
      ["type", "withdraw3"],
      ["hyperliquidChain", "Testnet"],
      ["signatureChainId", "0x66eee"],
      ["amount", "1"],
      ["time", 1687816341423],
      ["destination", destination],
    ]);
    expect(
      withdrawAction("hyperliquid:mainnet", destination, "1", vector.time).signatureChainId,
    ).toBe("0xa4b1");
  });
});

/** A small seeded generator, so a failure names a reproducible case. */
function random(seed: number) {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (max: number) => Math.floor(next() * max);
  const digits = (count: number) => Array.from({ length: count }, () => int(10)).join("");

  return {
    int,
    pick: <T>(values: readonly T[]) => values[int(values.length)] as T,
    hexBytes: (count: number) =>
      Array.from({ length: count }, () => int(256).toString(16).padStart(2, "0")).join(""),
    decimal: (): string => {
      const whole = String(int(10 ** int(7)));
      const fraction = `${digits(int(8))}${int(9) + 1}`.slice(0, 8).replace(/0+$/, "");
      const value = int(3) === 0 ? whole : `${whole}.${fraction}`;

      return value === "0" ? "1" : value;
    },
  };
}

describe("encodeMsgpack against @msgpack/msgpack 3.1.3", () => {
  it("encodes 1,000 generated order and cancel actions byte for byte", () => {
    const rng = random(0x0d15ea5e);

    for (let index = 0; index < 1000; index++) {
      const cloid = Cloid.parse(`0x${rng.hexBytes(16)}`);

      const action =
        index % 2 === 0
          ? orderAction(
              {
                type: "hyperliquid.order",
                asset: rng.int(10_000),
                isBuy: rng.int(2) === 0,
                size: rng.decimal(),
                limitPx: rng.decimal(),
                tif: rng.pick(["Alo", "Gtc", "Ioc"] as const),
                reduceOnly: rng.int(2) === 0,
              },
              cloid,
            )
          : cancelByCloidAction(rng.int(10_000), cloid);

      expectSameBytes(action, toPlain(action));
    }
  });

  it("agrees on every width of integer, string, array and map", () => {
    const integers = [0, 1, 127, 128, 255, 256, 65_535, 65_536, 2 ** 32 - 1, 2 ** 32];

    for (const value of [...integers, Number.MAX_SAFE_INTEGER]) expectSameBytes(value, value);

    for (const length of [0, 1, 31, 32, 255, 256, 65_535, 65_536]) {
      for (const unit of ["a", "é", "€", "😀"]) {
        const value = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

        if (value.isWellFormed()) expectSameBytes(value, value);
      }
    }

    for (const length of [0, 15, 16, 65_535, 65_536]) {
      const values = Array.from({ length }, (_, index) => index % 300);
      expectSameBytes(values, values);
      const entries = values.map((value, index): [string, MsgpackValue] => [`k${index}`, value]);
      expectSameBytes(new MsgpackMap(entries), Object.fromEntries(entries));
    }

    expectSameBytes([true, false, null, "x"], [true, false, null, "x"]);
  });
});

describe("encodeMsgpack refuses what it does not define", () => {
  const refused: [string, unknown][] = [
    ["a float", 1.5],
    ["a negative number", -1],
    ["negative zero", -0],
    ["2^53", 2 ** 53],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["undefined", undefined],
    ["a plain object", { a: 1 }],
    ["a Map", new Map([["a", 1]])],
    ["bytes", new Uint8Array([1])],
    ["a lone surrogate", "\ud800"],
    ["a float inside an array", [1, 2.5]],
    ["a plain object inside a map", new MsgpackMap([["a", { b: 1 } as unknown as MsgpackValue]])],
  ];

  for (const [name, value] of refused) {
    it(`throws on ${name}`, () => {
      expect(() => encodeMsgpack(value as MsgpackValue)).toThrow();
    });
  }

  it("throws on a map with a repeated key", () => {
    expect(
      () =>
        new MsgpackMap([
          ["a", 1],
          ["a", 2],
        ]),
    ).toThrow(/duplicate/);
  });
});

describe("the builders refuse values outside the intent's shape", () => {
  const order: HyperliquidOrderOperation = {
    type: "hyperliquid.order",
    asset: 4,
    isBuy: true,
    size: "0.0147",
    limitPx: "1670.1",
    tif: "Ioc",
    reduceOnly: false,
  };

  const cloid = Cloid.parse("0x0123456789abcdef0123456789abcdef");

  it("refuses a non-canonical size or price, an unknown key, time in force or asset", () => {
    for (const bad of [
      { ...order, size: "0.01470" },
      { ...order, limitPx: "0" },
      { ...order, limitPx: "1e3" },
      { ...order, tif: "Fok" },
      { ...order, asset: 10_000 },
      { ...order, builder: { b: "0x0", f: 1 } },
    ]) {
      expect(() => orderAction(bad as HyperliquidOrderOperation, cloid)).toThrow();
    }

    expect(() => orderAction(order, "0x0123456789ABCDEF0123456789ABCDEF")).toThrow();
    expect(() => cancelByCloidAction(-1, cloid)).toThrow();
    expect(() => cancelByCloidAction(1.5, cloid)).toThrow();
  });

  it("never writes a builder or a cancel flag, and always groups as na", () => {
    expect(toPlain(orderAction(order, cloid))).toEqual({
      type: "order",
      orders: [
        {
          a: 4,
          b: true,
          p: "1670.1",
          s: "0.0147",
          r: false,
          t: { limit: { tif: "Ioc" } },
          c: cloid,
        },
      ],
      grouping: "na",
    });
    expect(toPlain(cancelByCloidAction(4, cloid))).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 4, cloid }],
    });
  });

  it("refuses a nonce or expiry that is not a non-negative safe integer", () => {
    const action = orderAction(order, cloid);

    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN]) {
      expect(() => l1ActionHash(action, bad, null)).toThrow(RangeError);
      expect(() => l1ActionHash(action, 1, bad)).toThrow(RangeError);
    }
  });

  it("refuses a malformed connection id, network, destination or amount", () => {
    expect(() => l1TypedData("0x12" as `0x${string}`, "hyperliquid:testnet")).toThrow();
    const id = `0x${"ab".repeat(32)}` as const;
    expect(() => l1TypedData(id, "eip155:1" as VenueNetwork)).toThrow();
    const destination = `0x${"11".repeat(20)}` as const;
    expect(() => withdrawAction("hyperliquid:testnet", "0x11" as `0x${string}`, "1", 1)).toThrow();
    expect(() => withdrawAction("hyperliquid:testnet", destination, "0", 1)).toThrow();
    expect(() => withdrawAction("hyperliquid:testnet", destination, "-1", 1)).toThrow();
    expect(() => withdrawTypedData("hyperliquid:testnet", destination, "1", -1)).toThrow();
  });
});

describe("typed data", () => {
  const connectionId = `0x${"ab".repeat(32)}` as const;

  it("signs an L1 action in the Exchange domain with source a on mainnet and b on testnet", () => {
    for (const [network, source] of [
      ["hyperliquid:mainnet", "a"],
      ["hyperliquid:testnet", "b"],
    ] as const) {
      const typedData = l1TypedData(connectionId, network);
      expect(typedData.domain).toEqual(HYPERLIQUID_L1_DOMAIN);
      expect(typedData.message).toEqual({ source, connectionId });
    }
  });

  it("hands OWS the domain type written out, chain ids as numbers and the domain's chain", () => {
    const l1 = eip712Json({ kind: "l1", network: "hyperliquid:testnet", connectionId });
    expect(l1.chain).toBe("eip155:1337");
    const parsed = JSON.parse(l1.json);
    expect(Object.keys(parsed.types)).toEqual(["EIP712Domain", "Agent"]);
    expect(parsed.domain.chainId).toBe(1337);
    expect(parsed.primaryType).toBe("Agent");

    const destination = `0x${"11".repeat(20)}` as const;

    for (const [network, chain] of [
      ["hyperliquid:testnet", "eip155:421614"],
      ["hyperliquid:mainnet", "eip155:42161"],
    ] as const) {
      const withdraw = eip712Json({
        kind: "withdraw",
        network,
        destination,
        amount: "1.5",
        time: 1687816341423,
      });

      expect(withdraw.chain).toBe(chain);
      const body = JSON.parse(withdraw.json);
      expect(body.domain.chainId).toBe(Number(chain.slice("eip155:".length)));
      expect(body.message.time).toBe(1687816341423);
    }
  });
});

describe("cloidFor and nextNonce", () => {
  it("derives the pinned cloid from the fixture approval id (computed with OpenSSL)", () => {
    // printf 'askgina.os/v1/hyperliquid-cloid\napr_01jd0000000000000000000005' | openssl dgst -sha256
    expect(cloidFor("apr_01jd0000000000000000000005")).toBe("0xe5da13111af22225733abeac5ca991ba");
    expect(cloidFor("apr_01jd0000000000000000000006")).not.toBe(
      cloidFor("apr_01jd0000000000000000000005"),
    );
    expect(() => cloidFor("int_01jd0000000000000000000005" as ApprovalId)).toThrow();
  });

  it("is strictly increasing across calls with the same or a smaller clock", () => {
    let last: number | null = null;
    const nonces: number[] = [];

    for (const now of [1000, 1000, 999, 500, 1001, 1001, 5000, 4999]) {
      last = nextNonce(last, now);
      nonces.push(last);
    }

    expect(nonces).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 5000, 5001]);
    expect(() => nextNonce(null, -1)).toThrow(RangeError);
    expect(() => nextNonce(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});
