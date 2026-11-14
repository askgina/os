import { describe, expect, it } from "vitest";
import {
  Address,
  Amount,
  ApproveIntentEnvelope,
  ChainId,
  Envelope,
  evmChainNumber,
  Hex,
  Intent,
  isSortedUnique,
  Memo,
  Nonce,
  newId,
  normalizePolicy,
  PositiveAmount,
  sortedUnique,
  WalletId,
  WalletPolicy,
  WorkspaceId,
} from "../src/index.ts";
import {
  AGENT,
  ALICE,
  approveIntent,
  BASE,
  BOB,
  DIGEST_A,
  intent,
  MAINNET,
  OTHER_AGENT,
  policy,
  ROUTER,
  T0,
  TOKEN,
} from "./fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
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
    expect(ok(Intent, intent({ operation: { ...intent().operation, gas: "1" } as never }))).toBe(
      false,
    );
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

describe("sorted sets", () => {
  it("isSortedUnique and sortedUnique agree", () => {
    expect(isSortedUnique([])).toBe(true);
    expect(isSortedUnique(["a", "b"])).toBe(true);
    expect(isSortedUnique(["b", "a"])).toBe(false);
    expect(isSortedUnique(["a", "a"])).toBe(false);
    expect(sortedUnique(["c", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});
