import { describe, expect, it } from "vitest";
import {
  Address,
  Amount,
  ApproveIntentEnvelope,
  CancelTransactionEnvelope,
  ChainId,
  Cloid,
  Decimal,
  Envelope,
  EvmIntent,
  evmChainNumber,
  GrantMandateEnvelope,
  Hex,
  HyperliquidRules,
  Intent,
  isSortedUnique,
  isVenueIntent,
  isVenueNetwork,
  MandateId,
  Memo,
  mandateHash,
  Nonce,
  newId,
  normalizePolicy,
  PositiveAmount,
  PositiveDecimal,
  Sweep,
  SweepWalletEnvelope,
  sortedUnique,
  VenueIntent,
  WalletId,
  WalletPolicy,
  WorkspaceId,
} from "../src/index.ts";
import {
  ApprovalState,
  AttemptResponse,
  CancelTransactionRequest,
  GrantMandateRequest,
  MandateState,
  OpenConfirmationResponse,
  RepriceRequest,
  SignUnderMandateRequest,
  SubmitConfirmationResponse,
  TransactionAttempt,
} from "../src/signer/index.ts";
import {
  AGENT,
  ALICE,
  APPROVAL,
  approveIntent,
  BASE,
  BOB,
  cancelTransaction,
  DIGEST_A,
  grantMandate,
  HL_TESTNET,
  hyperliquidRules,
  intent,
  MAINNET,
  MANDATE,
  mandate,
  OTHER_AGENT,
  policy,
  ROUTER,
  sweep,
  sweepWallet,
  T0,
  TOKEN,
  venueIntent,
  WALLET,
  WS,
} from "./fixtures.ts";

const ok = <Value>(schema: { safeParse(value: Value): { success: boolean } }, value: Value) =>
  schema.safeParse(value).success;

describe("identifiers", () => {
  it("accept their own prefix with a lowercase ULID and nothing else", () => {
    const id = newId("wal");
    expect(ok(WalletId, id)).toBe(true);
    expect(ok(WorkspaceId, id)).toBe(false);
    expect(ok(WalletId, id.toUpperCase())).toBe(false);
    expect(ok(WalletId, `wal_${"0".repeat(25)}`)).toBe(false);
    expect(ok(WalletId, `wal_${"0".repeat(27)}`)).toBe(false);
    // Crockford base32 has no i, l, o or u.
    expect(ok(WalletId, `wal_${"0".repeat(25)}u`)).toBe(false);
    expect(ok(WalletId, ` ${id}`)).toBe(false);
    expect(ok(WalletId, 42)).toBe(false);
  });

  it("are unique when minted", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId("int")));
    expect(ids.size).toBe(200);
  });
});

describe("addresses and hex", () => {
  it("accept only lowercase 20-byte addresses", () => {
    expect(ok(Address, ALICE)).toBe(true);
    // EIP-55 checksum form and upper case are display forms and must be normalized first.
    expect(ok(Address, "0x52908400098527886E0F7030069857D2E4169EE7")).toBe(false);
    expect(ok(Address, `0X${"1".repeat(40)}`)).toBe(false);
    expect(ok(Address, `0x${"a".repeat(39)}`)).toBe(false);
    expect(ok(Address, `0x${"a".repeat(41)}`)).toBe(false);
    expect(ok(Address, "a".repeat(40))).toBe(false);
  });

  it("hex needs an even number of lowercase digits", () => {
    expect(ok(Hex, "0x")).toBe(true);
    expect(ok(Hex, "0xab")).toBe(true);
    expect(ok(Hex, "0xabc")).toBe(false);
    expect(ok(Hex, "0xAB")).toBe(false);
  });
});

describe("amounts", () => {
  const max = ((1n << 256n) - 1n).toString();
  it("are canonical decimal uint256", () => {
    expect(ok(Amount, "0")).toBe(true);
    expect(ok(Amount, max)).toBe(true);
    expect(ok(Amount, (1n << 256n).toString())).toBe(false);
    expect(ok(Amount, "01")).toBe(false);
    expect(ok(Amount, "00")).toBe(false);
    expect(ok(Amount, "-1")).toBe(false);
    expect(ok(Amount, "1.0")).toBe(false);
    expect(ok(Amount, "1e18")).toBe(false);
    expect(ok(Amount, " 1")).toBe(false);
    expect(ok(Amount, 1)).toBe(false);
    expect(ok(Amount, "9".repeat(79))).toBe(false);
  });
  it("positive amounts refuse zero", () => {
    expect(ok(PositiveAmount, "0")).toBe(false);
    expect(ok(PositiveAmount, "1")).toBe(true);
  });
});

describe("chain ids", () => {
  it("are CAIP-2 eip155 with a positive integer", () => {
    expect(ok(ChainId, "eip155:1")).toBe(true);
    expect(ok(ChainId, "eip155:8453")).toBe(true);
    expect(ok(ChainId, "eip155:0")).toBe(false);
    expect(ok(ChainId, "eip155:01")).toBe(false);
    expect(ok(ChainId, "eip155:-1")).toBe(false);
    expect(ok(ChainId, "solana:1")).toBe(false);
    expect(ok(ChainId, "8453")).toBe(false);
    expect(ok(ChainId, `eip155:${"9".repeat(17)}`)).toBe(false);
    expect(evmChainNumber("eip155:8453")).toBe(8453);
  });

  it("stop at 15 digits, so no two ids collapse to one chain number", () => {
    const largest = "eip155:999999999999999" as const;
    expect(ok(ChainId, largest)).toBe(true);
    expect(evmChainNumber(largest)).toBe(999_999_999_999_999);
    // 2^53 + 1 rounds to 2^53 as a JavaScript number.
    expect(ok(ChainId, "eip155:9007199254740993")).toBe(false);
    expect(ok(ChainId, `eip155:1${"0".repeat(15)}`)).toBe(false);
  });
});

describe("nonce", () => {
  it("is exactly 16 bytes of unpadded base64url", () => {
    expect(ok(Nonce, Buffer.alloc(16, 7).toString("base64url"))).toBe(true);
    expect(ok(Nonce, `${Buffer.alloc(16).toString("base64url")}==`)).toBe(false);
    expect(ok(Nonce, Buffer.alloc(15).toString("base64url"))).toBe(false);
    expect(ok(Nonce, "A+AAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("memo", () => {
  it("accepts ordinary text in any script", () => {
    expect(ok(Memo, "")).toBe(true);
    expect(ok(Memo, "Pay Alice for March, ≈ €250 ✓ 日本語 مرحبا")).toBe(true);
    expect(ok(Memo, "x".repeat(280))).toBe(true);
    expect(ok(Memo, "x".repeat(281))).toBe(false);
  });

  // Each of these can make an approval card show text that differs from what is hashed.
  it.each([
    ["newline", "pay\nBob"],
    ["tab", "pay\tBob"],
    ["NUL", "pay\u0000"],
    ["DEL", "pay\u007f"],
    ["C1 control", "pay\u0085Bob"],
    ["left-to-right mark", "pay\u200e"],
    ["right-to-left mark", "pay\u200f"],
    ["arabic letter mark", "pay\u061c"],
    ["RLO override", "pay \u202eBob"],
    ["LRE embedding", "pay \u202aBob"],
    ["RLI isolate", "pay \u2067Bob"],
    ["PDI", "pay \u2069Bob"],
    ["line separator", "pay\u2028Bob"],
    ["paragraph separator", "pay\u2029Bob"],
  ])("refuses %s", (_name, value) => {
    expect(ok(Memo, value)).toBe(false);
  });
});

describe("intent", () => {
  it("accepts each operation type", () => {
    expect(ok(Intent, intent())).toBe(true);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.erc20.transfer", token: TOKEN, to: BOB, amount: "1" } }),
      ),
    ).toBe(true);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.call", to: ROUTER, valueWei: "0", data: "0xa9059cbb" } }),
      ),
    ).toBe(true);
  });

  it("refuses unknown keys at every level", () => {
    expect(ok(Intent, { ...intent(), extra: 1 })).toBe(false);
    const operationWithGas = { ...intent().operation, gas: "1" };
    expect(ok(Intent, intent({ operation: operationWithGas }))).toBe(false);
  });

  it("refuses zero transfers, short calldata, zero fee ceilings and other versions", () => {
    expect(
      ok(Intent, intent({ operation: { type: "evm.transfer", to: ALICE, valueWei: "0" } })),
    ).toBe(false);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.call", to: ROUTER, valueWei: "0", data: "0xa9" } }),
      ),
    ).toBe(false);
    expect(ok(Intent, intent({ maxFeeWei: "0" }))).toBe(false);
    expect(ok(Intent, { ...intent(), v: 2 })).toBe(false);
    expect(ok(Intent, intent({ memo: "a\u202eb" }))).toBe(false);
  });

  it("refuses the zero address as recipient, token or call target", () => {
    const zero = "0x0000000000000000000000000000000000000000" as const;
    expect(
      ok(Intent, intent({ operation: { type: "evm.transfer", to: zero, valueWei: "1" } })),
    ).toBe(false);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.erc20.transfer", token: zero, to: BOB, amount: "1" } }),
      ),
    ).toBe(false);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.erc20.transfer", token: TOKEN, to: zero, amount: "1" } }),
      ),
    ).toBe(false);
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.call", to: zero, valueWei: "0", data: "0xa9059cbb" } }),
      ),
    ).toBe(false);
  });

  it("refuses a token transfer to the token's own contract", () => {
    expect(
      ok(
        Intent,
        intent({ operation: { type: "evm.erc20.transfer", token: TOKEN, to: TOKEN, amount: "1" } }),
      ),
    ).toBe(false);
  });
});

describe("canonical decimals", () => {
  it.each(["0.0147", "100", "1670.1", "0.00000001", "0", "0.5", "99999999999999999999.99999999"])(
    "accepts %s",
    (value) => {
      expect(ok(Decimal, value)).toBe(true);
    },
  );
  it.each([
    "1.0",
    "01",
    "1e3",
    ".5",
    "1.",
    "0.000000001",
    "-1",
    "+1",
    " 1",
    "1,000",
    "100000000000000000000",
  ])("refuses %s", (value) => {
    expect(ok(Decimal, value)).toBe(false);
  });
  it("a positive decimal is not zero", () => {
    expect(ok(PositiveDecimal, "0")).toBe(false);
    expect(ok(PositiveDecimal, "0.00000001")).toBe(true);
  });
  it("a cloid is 16 bytes of lowercase hex", () => {
    expect(ok(Cloid, `0x${"ab".repeat(16)}`)).toBe(true);
    expect(ok(Cloid, `0x${"AB".repeat(16)}`)).toBe(false);
    expect(ok(Cloid, `0x${"ab".repeat(15)}`)).toBe(false);
  });
});

describe("venue intent", () => {
  const order = venueIntent().operation;

  if (order.type !== "hyperliquid.order") throw new TypeError("the fixture is an order");

  it("accepts an order and a withdrawal, as an intent and as a venue intent only", () => {
    expect(ok(Intent, venueIntent())).toBe(true);
    expect(ok(VenueIntent, venueIntent())).toBe(true);
    expect(ok(EvmIntent, venueIntent())).toBe(false);
    expect(ok(VenueIntent, intent())).toBe(false);
    const withdraw = venueIntent({ operation: { type: "hyperliquid.withdraw", amount: "12.5" } });
    expect(ok(Intent, withdraw)).toBe(true);
    expect(isVenueIntent(venueIntent())).toBe(true);
    expect(isVenueIntent(intent())).toBe(false);
    expect(isVenueNetwork(HL_TESTNET)).toBe(true);
    expect(isVenueNetwork(BASE)).toBe(false);
  });

  it("refuses an asset index above 9999, an unknown time in force and bad decimals", () => {
    expect(ok(Intent, venueIntent({ operation: { ...order, asset: 9999 } }))).toBe(true);
    expect(ok(Intent, venueIntent({ operation: { ...order, asset: 10_000 } }))).toBe(false);
    expect(ok(Intent, venueIntent({ operation: { ...order, asset: -1 } }))).toBe(false);
    expect(ok(Intent, venueIntent({ operation: { ...order, asset: 1.5 } }))).toBe(false);
    // SAFETY: deliberately not a valid HyperliquidTimeInForce; the test checks the refusal.
    expect(ok(Intent, venueIntent({ operation: { ...order, tif: "Fok" as never } }))).toBe(false);
    expect(ok(Intent, venueIntent({ operation: { ...order, size: "0" } }))).toBe(false);
    expect(ok(Intent, venueIntent({ operation: { ...order, limitPx: "1.0" } }))).toBe(false);
    expect(
      ok(Intent, venueIntent({ operation: { type: "hyperliquid.withdraw", amount: "0" } })),
    ).toBe(false);
  });

  it("refuses an EVM operation on a venue network and a venue operation on an EVM chain", () => {
    expect(ok(Intent, { ...venueIntent(), operation: intent().operation })).toBe(false);
    expect(ok(Intent, { ...intent(), operation: order })).toBe(false);
    expect(ok(Intent, { ...venueIntent(), chainId: BASE })).toBe(false);
    expect(ok(Intent, { ...intent(), chainId: HL_TESTNET })).toBe(false);
  });

  it("refuses a fee ceiling, a destination and any other unknown member", () => {
    expect(ok(Intent, { ...venueIntent(), maxFeeWei: "1" })).toBe(false);
    expect(
      ok(Intent, {
        ...venueIntent(),
        operation: { type: "hyperliquid.withdraw", amount: "1", destination: ALICE },
      }),
    ).toBe(false);
    expect(ok(Intent, { ...venueIntent(), operation: { ...order, cloid: null } })).toBe(false);
    expect(ok(Intent, { ...venueIntent(), chainId: "hyperliquid:devnet" })).toBe(false);
  });
});

describe("wallet policy", () => {
  it("accepts the fixture and its normalized form is identical", () => {
    expect(ok(WalletPolicy, policy())).toBe(true);
    expect(normalizePolicy(policy())).toEqual(policy());
  });

  it("refuses unsorted or duplicated sets", () => {
    expect(ok(WalletPolicy, policy({ chains: [MAINNET, BASE].reverse() }))).toBe(false);
    expect(ok(WalletPolicy, policy({ chains: [BASE, BASE] }))).toBe(false);
    expect(ok(WalletPolicy, policy({ requesters: [OTHER_AGENT, AGENT] }))).toBe(false);
    expect(ok(WalletPolicy, policy({ requesters: [AGENT, AGENT] }))).toBe(false);
    expect(
      ok(WalletPolicy, policy({ recipients: { mode: "allowlist", addresses: [BOB, ALICE] } })),
    ).toBe(false);
    expect(
      ok(WalletPolicy, policy({ contractCalls: { mode: "allowlist", targets: [ROUTER, ROUTER] } })),
    ).toBe(false);
  });

  it("refuses unsorted or duplicated asset limits, and normalizePolicy fixes order", () => {
    const native = policy().assets[0];

    if (!native) throw new Error("fixture");
    const token = { ...native, asset: TOKEN };
    // Sorted by "chainId|asset": "0x33…" sorts before "native".
    expect(ok(WalletPolicy, policy({ assets: [token, native] }))).toBe(true);
    const reversed = policy({ assets: [native, token] });
    expect(ok(WalletPolicy, reversed)).toBe(false);
    expect(ok(WalletPolicy, policy({ assets: [native, native] }))).toBe(false);
    // normalizePolicy only reorders; it still refuses the duplicate.
    expect(() => normalizePolicy(policy({ assets: [native, native] }))).toThrow();
    expect(
      normalizePolicy({
        ...reversed,
        chains: [BASE, BASE],
        recipients: { mode: "allowlist", addresses: [BOB, ALICE, BOB] },
      }),
    ).toEqual(
      policy({
        assets: [token, native],
        recipients: { mode: "allowlist", addresses: [ALICE, BOB] },
      }),
    );
  });

  it("ties revision 1 to a null previous hash and later revisions to a hash", () => {
    expect(ok(WalletPolicy, policy({ revision: 1, previousHash: DIGEST_A }))).toBe(false);
    expect(ok(WalletPolicy, policy({ revision: 2, previousHash: null }))).toBe(false);
    expect(ok(WalletPolicy, policy({ revision: 2, previousHash: DIGEST_A }))).toBe(true);
    expect(ok(WalletPolicy, policy({ revision: 0 }))).toBe(false);
  });

  it("refuses a capped token that is also a contract-call target", () => {
    const native = policy().assets[0];

    if (!native) throw new Error("fixture");
    const token = { ...native, asset: TOKEN };
    const withToken = { assets: [token, native] };
    // Calling the token directly would move it with no cap, so the two may not coexist.
    expect(
      ok(
        WalletPolicy,
        policy({ ...withToken, contractCalls: { mode: "allowlist", targets: [TOKEN, ROUTER] } }),
      ),
    ).toBe(false);
    expect(
      ok(
        WalletPolicy,
        policy({ ...withToken, contractCalls: { mode: "allowlist", targets: [ROUTER] } }),
      ),
    ).toBe(true);
  });

  it("refuses an asset limit on a chain the wallet may not use", () => {
    const native = policy().assets[0];

    if (!native) throw new Error("fixture");
    expect(ok(WalletPolicy, policy({ assets: [{ ...native, chainId: MAINNET }] }))).toBe(false);
  });

  it("refuses a per-transaction cap above the daily cap, and allows them equal", () => {
    const limit = { chainId: BASE, asset: "native" as const };
    expect(
      ok(WalletPolicy, policy({ assets: [{ ...limit, maxPerTx: "2", maxPerDay: "1" }] })),
    ).toBe(false);
    expect(
      ok(WalletPolicy, policy({ assets: [{ ...limit, maxPerTx: "1", maxPerDay: "1" }] })),
    ).toBe(true);
  });

  it("refuses, rather than throws on, malformed cap amounts", () => {
    const limit = { chainId: BASE, asset: "native" as const };

    for (const bad of ["1.0", "1e3", "-5", "0x10"]) {
      expect(() =>
        WalletPolicy.safeParse(policy({ assets: [{ ...limit, maxPerTx: bad, maxPerDay: "10" }] })),
      ).not.toThrow();
      expect(
        ok(WalletPolicy, policy({ assets: [{ ...limit, maxPerTx: "1", maxPerDay: bad }] })),
      ).toBe(false);
    }
  });

  it("accepts venue rules, and normalizePolicy sorts their markets and times in force", () => {
    const withVenues = policy({ venues: { hyperliquid: hyperliquidRules() } });
    expect(ok(WalletPolicy, withVenues)).toBe(true);
    expect(normalizePolicy(withVenues)).toEqual(withVenues);
    const rules = hyperliquidRules();

    const shuffled = policy({
      venues: {
        hyperliquid: {
          ...rules,
          markets: [...rules.markets].reverse(),
          timeInForce: ["Ioc", "Gtc"],
        },
      },
    });

    expect(ok(WalletPolicy, shuffled)).toBe(false);
    expect(normalizePolicy(shuffled)).toEqual(withVenues);
  });

  it("refuses venue rules whose markets are unsorted, repeated or capped above the daily cap", () => {
    const rules = hyperliquidRules();
    const [btc, eth] = rules.markets;

    if (btc === undefined || eth === undefined) throw new TypeError("fixture");

    const bad = (changes: Partial<HyperliquidRules>) =>
      ok(WalletPolicy, policy({ venues: { hyperliquid: { ...rules, ...changes } } }));

    expect(bad({ markets: [eth, btc] })).toBe(false);
    expect(bad({ markets: [btc, { ...btc }] })).toBe(false);
    expect(bad({ markets: [btc, { ...eth, coin: "BTC" }] })).toBe(false);
    expect(bad({ markets: [] })).toBe(false);
    expect(bad({ markets: [{ ...btc, maxNotionalPerOrderUsd6: "2000000001" }] })).toBe(false);
    expect(bad({ markets: [{ ...btc, maxNotionalPerOrderUsd6: "2000000000" }] })).toBe(true);
    expect(bad({ markets: [{ ...btc, coin: "btc" }] })).toBe(false);
    expect(bad({ markets: [{ ...btc, asset: 10_000 }] })).toBe(false);
    expect(bad({ timeInForce: [] })).toBe(false);
    expect(bad({ timeInForce: ["Gtc", "Gtc"] })).toBe(false);
    expect(bad({ submitWindowSeconds: 4 })).toBe(false);
    expect(bad({ submitWindowSeconds: 301 })).toBe(false);
    expect(bad({ maxNotionalPerDayUsd6: "1.5" })).toBe(false);
    expect(ok(HyperliquidRules, { ...rules, extra: true })).toBe(false);
  });

  it("has one form without venue rules: an empty venues member is refused", () => {
    expect(ok(WalletPolicy, policy({ venues: {} }))).toBe(false);
    expect(ok(WalletPolicy, { ...policy(), venues: { other: {} } })).toBe(false);
  });

  it("refuses unknown keys and out-of-range approval settings", () => {
    expect(ok(WalletPolicy, { ...policy(), extra: true })).toBe(false);
    expect(ok(WalletPolicy, policy({ approvals: { threshold: 0, ttlSeconds: 3600 } }))).toBe(false);
    expect(ok(WalletPolicy, policy({ approvals: { threshold: 17, ttlSeconds: 3600 } }))).toBe(
      false,
    );
    expect(ok(WalletPolicy, policy({ approvals: { threshold: 1, ttlSeconds: 59 } }))).toBe(false);
    expect(ok(WalletPolicy, policy({ approvals: { threshold: 1, ttlSeconds: 86_401 } }))).toBe(
      false,
    );
  });
});

describe("envelopes", () => {
  it("must expire strictly after they are issued", () => {
    expect(ok(Envelope, approveIntent())).toBe(true);
    expect(ok(Envelope, approveIntent({ expiresAt: T0 }))).toBe(false);
    expect(ok(Envelope, approveIntent({ expiresAt: T0 - 1 }))).toBe(false);
  });
  it("refuses unknown keys and fields belonging to another type", () => {
    expect(ok(ApproveIntentEnvelope, { ...approveIntent(), memo: "x" })).toBe(false);
    expect(ok(Envelope, { ...approveIntent(), type: "set-policy" })).toBe(false);
  });
});

describe("sweeps", () => {
  const zero = "0x0000000000000000000000000000000000000000" as const;

  it("accept the native coin or a token, and their envelope is an envelope", () => {
    expect(ok(Sweep, sweep())).toBe(true);
    expect(ok(Sweep, sweep({ asset: TOKEN }))).toBe(true);
    expect(ok(Envelope, sweepWallet())).toBe(true);
    expect(ok(SweepWalletEnvelope, sweepWallet({ expiresAt: T0 }))).toBe(true);
    expect(ok(Envelope, sweepWallet({ expiresAt: T0 }))).toBe(false);
  });

  it("refuse the zero address as destination or token, and a token sent to its own contract", () => {
    expect(ok(Sweep, sweep({ to: zero }))).toBe(false);
    expect(ok(Sweep, sweep({ asset: zero }))).toBe(false);
    expect(ok(Sweep, sweep({ asset: TOKEN, to: TOKEN }))).toBe(false);
  });

  it("refuse a zero amount or fee ceiling, unknown keys and other versions", () => {
    expect(ok(Sweep, sweep({ amount: "0" }))).toBe(false);
    expect(ok(Sweep, sweep({ maxFeeWei: "0" }))).toBe(false);
    expect(ok(Sweep, { ...sweep(), memo: "x" })).toBe(false);
    expect(ok(Sweep, { ...sweep(), v: 2 })).toBe(false);
    expect(ok(Envelope, { ...sweepWallet(), amount: "1" })).toBe(false);
    expect(ok(Envelope, { ...sweepWallet(), type: "approve-intent" })).toBe(false);
  });
});

describe("mandates in the envelope and the signer contract", () => {
  const state = {
    mandate: mandate(),
    mandateHash: mandateHash(mandate()),
    status: "active",
    grantApprovalId: APPROVAL,
    grantedAt: T0,
    grantedBy: ["usr_01jd0000000000000000000006"],
    revokedAt: null,
    revokedReason: null,
    usage: {
      uses: 2,
      assets: [{ chainId: BASE, asset: TOKEN, total: "200000000", inWindow: "200000000" }],
    },
  };

  it("a grant-mandate envelope is an envelope, with its own fields only", () => {
    expect(ok(Envelope, grantMandate())).toBe(true);
    expect(ok(GrantMandateEnvelope, grantMandate({ expiresAt: T0 }))).toBe(true);
    expect(ok(Envelope, grantMandate({ expiresAt: T0 }))).toBe(false);
    expect(ok(Envelope, { ...grantMandate(), chainId: BASE })).toBe(false);
    expect(ok(Envelope, { ...grantMandate(), mandateId: newId("int") })).toBe(false);
    expect(ok(Envelope, { ...grantMandate(), type: "sweep-wallet" })).toBe(false);
    expect(ok(MandateId, newId("mnd"))).toBe(true);
  });

  it("requests are strict", () => {
    const assertion = {
      userId: "usr_01jd0000000000000000000006",
      credentialId: "Y3JlZC1h",
      response: {
        id: "Y3JlZC1h",
        rawId: "Y3JlZC1h",
        type: "public-key",
        response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
        clientExtensionResults: {},
      },
    };

    const authorization = { envelope: grantMandate(), assertions: [assertion] };
    expect(ok(GrantMandateRequest, { mandate: mandate(), authorization })).toBe(true);
    expect(ok(GrantMandateRequest, { mandate: mandate(), authorization, policy: policy() })).toBe(
      false,
    );
    expect(
      ok(GrantMandateRequest, { mandate: { ...mandate(), recipients: [] }, authorization }),
    ).toBe(false);

    const use = {
      approvalId: APPROVAL,
      intent: intent(),
      transaction: { nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    };

    expect(ok(SignUnderMandateRequest, use)).toBe(true);
    expect(ok(SignUnderMandateRequest, { ...use, authorization })).toBe(false);
    expect(ok(SignUnderMandateRequest, { ...use, approvalId: newId("mnd") })).toBe(false);
  });

  it("a mandate's state names its own hash and is revoked exactly when it says so", () => {
    expect(ok(MandateState, state)).toBe(true);
    expect(ok(MandateState, { ...state, mandateHash: DIGEST_A })).toBe(false);
    expect(ok(MandateState, { ...state, grantedBy: [] })).toBe(false);
    const revoked = { ...state, status: "revoked", revokedAt: T0 + 1, revokedReason: "requested" };
    expect(ok(MandateState, revoked)).toBe(true);
    expect(ok(MandateState, { ...revoked, status: "active" })).toBe(false);
    expect(ok(MandateState, { ...revoked, revokedReason: null })).toBe(false);
    expect(ok(MandateState, { ...revoked, revokedAt: null })).toBe(false);
    expect(ok(MandateState, { ...revoked, revokedReason: "expired" })).toBe(false);
    expect(ok(MandateState, { ...state, status: "paused" })).toBe(false);
  });
});

describe("reprices and cancels in the envelope and the signer contract", () => {
  const fees = { attempt: 1, maxFeePerGas: "3000000000", maxPriorityFeePerGas: "2000000000" };

  const assertion = {
    userId: "usr_01jd0000000000000000000006",
    credentialId: "Y3JlZC1h",
    response: {
      id: "Y3JlZC1h",
      rawId: "Y3JlZC1h",
      type: "public-key",
      response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
      clientExtensionResults: {},
    },
  };

  const attempt = {
    attempt: 1,
    kind: "reprice",
    transactionHash: `0x${"ab".repeat(32)}`,
    gas: "21000",
    maxFeePerGas: "3000000000",
    maxPriorityFeePerGas: "2000000000",
    signedAt: T0,
  };

  it("a cancel-transaction envelope is an envelope, with its own fields only", () => {
    expect(ok(Envelope, cancelTransaction())).toBe(true);
    expect(ok(Envelope, cancelTransaction({ txNonce: 0 }))).toBe(true);
    expect(ok(Envelope, cancelTransaction({ txNonce: -1 }))).toBe(false);
    expect(ok(Envelope, cancelTransaction({ txNonce: 1.5 }))).toBe(false);
    expect(ok(Envelope, cancelTransaction({ maxFeeWei: "0" }))).toBe(false);
    expect(ok(Envelope, cancelTransaction({ expiresAt: T0 }))).toBe(false);
    expect(ok(Envelope, { ...cancelTransaction(), intentHash: DIGEST_A })).toBe(false);
    expect(ok(Envelope, { ...cancelTransaction(), type: "approve-intent" })).toBe(false);
  });

  it("a cancel-transaction envelope with targetApprovalId equal to approvalId is invalid", () => {
    expect(ok(CancelTransactionEnvelope, cancelTransaction({ targetApprovalId: APPROVAL }))).toBe(
      false,
    );
    expect(ok(Envelope, cancelTransaction({ targetApprovalId: APPROVAL }))).toBe(false);
  });

  it("RepriceRequest refuses unknown members", () => {
    const byEnvelope = { intent: intent(), envelope: approveIntent(), ...fees };
    const byMandate = { intent: intent(), mandateId: MANDATE, ...fees };
    expect(ok(RepriceRequest, byEnvelope)).toBe(true);
    expect(ok(RepriceRequest, byMandate)).toBe(true);
    expect(ok(RepriceRequest, { ...byEnvelope, gas: "30000" })).toBe(false);
    expect(ok(RepriceRequest, { ...byEnvelope, nonce: 3 })).toBe(false);
    expect(ok(RepriceRequest, { ...byEnvelope, mandateId: MANDATE })).toBe(false);
    expect(ok(RepriceRequest, { ...byEnvelope, envelope: grantMandate() })).toBe(false);
    expect(ok(RepriceRequest, { ...byEnvelope, attempt: 0 })).toBe(false);
    expect(ok(RepriceRequest, { ...byEnvelope, maxFeePerGas: "0" })).toBe(false);
    expect(ok(RepriceRequest, { intent: intent(), ...fees })).toBe(false);
  });

  it("a cancel request carries an authorization and the next attempt's fees, nothing else", () => {
    const request = {
      authorization: { envelope: cancelTransaction(), assertions: [assertion] },
      ...fees,
    };

    expect(ok(CancelTransactionRequest, request)).toBe(true);
    expect(ok(CancelTransactionRequest, { ...request, to: ALICE })).toBe(false);
    expect(ok(CancelTransactionRequest, { ...request, attempt: 0 })).toBe(false);
  });

  it("an attempt is the original exactly when it is attempt 0, and approvals list them", () => {
    expect(ok(TransactionAttempt, attempt)).toBe(true);
    expect(ok(TransactionAttempt, { ...attempt, kind: "cancel" })).toBe(true);
    expect(ok(TransactionAttempt, { ...attempt, attempt: 0, kind: "original" })).toBe(true);
    expect(ok(TransactionAttempt, { ...attempt, kind: "original" })).toBe(false);
    expect(ok(TransactionAttempt, { ...attempt, attempt: 0 })).toBe(false);
    expect(ok(TransactionAttempt, { ...attempt, kind: "replace" })).toBe(false);

    const response = {
      approvalId: APPROVAL,
      walletId: WALLET,
      from: ALICE,
      attempt,
      signedTransaction: "0x02",
    };

    expect(ok(AttemptResponse, response)).toBe(true);
    expect(ok(AttemptResponse, { ...response, transactionHash: attempt.transactionHash })).toBe(
      false,
    );

    const state = {
      approvalId: APPROVAL,
      state: "signed",
      transactionHash: attempt.transactionHash,
      attempts: [{ ...attempt, attempt: 0, kind: "original" }, attempt],
      cloid: null,
    };

    expect(ok(ApprovalState, state)).toBe(true);
    const { attempts: _attempts, ...withoutAttempts } = state;
    expect(ok(ApprovalState, withoutAttempts)).toBe(false);
  });
});

describe("confirmation messages", () => {
  const LINK_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

  // The control plane appends the path to the confirmation page's origin, so a path that can
  // change the host or carry something else would send people elsewhere.
  it("a confirmation link is exactly /a/<approval id>#<token>", () => {
    const path = (value: string) => ok(OpenConfirmationResponse, { path: value });
    expect(path(`/a/${APPROVAL}#${LINK_TOKEN}`)).toBe(true);
    expect(path(`//evil.example/a/${APPROVAL}#${LINK_TOKEN}`)).toBe(false);
    expect(path(`@evil.example/a/${APPROVAL}#${LINK_TOKEN}`)).toBe(false);
    expect(path(`/a/${APPROVAL}/../x#${LINK_TOKEN}`)).toBe(false);
    expect(path(`/a/${APPROVAL}?x=1#${LINK_TOKEN}`)).toBe(false);
    expect(path(`/a/${APPROVAL}#${LINK_TOKEN}#${LINK_TOKEN}`)).toBe(false);
    expect(path(`/a/${APPROVAL}#${LINK_TOKEN.slice(1)}`)).toBe(false);
    expect(path(`/a/${APPROVAL}`)).toBe(false);
    expect(path(`/a/${WS}#${LINK_TOKEN}`)).toBe(false);
  });

  // The confirmation page navigates to it after an approval.
  it("the page is sent back only to an http or https address", () => {
    const back = (returnUrl: string) =>
      ok(SubmitConfirmationResponse, { collected: 1, required: 1, returnUrl });

    expect(back(`https://os.example/w/${WS}/approvals/${APPROVAL}`)).toBe(true);
    expect(back("javascript:alert(1)")).toBe(false);
    expect(back("data:text/html,x")).toBe(false);
    expect(back("/relative")).toBe(false);
  });
});

describe("sorted sets", () => {
  it("isSortedUnique and sortedUnique agree", () => {
    expect(isSortedUnique([])).toBe(true);
    expect(isSortedUnique(["a", "b"])).toBe(true);
    expect(isSortedUnique(["b", "a"])).toBe(false);
    expect(isSortedUnique(["a", "a"])).toBe(false);
    expect(sortedUnique(["c", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});
