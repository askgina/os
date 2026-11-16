import { describe, expect, it } from "vitest";
import {
  checkMandateAgainstPolicy,
  type EvmIntent,
  evaluateIntent,
  evaluateMandate,
  MANDATE_DENY_CODES,
  MANDATE_GRANT_REFUSALS,
  type Mandate,
  type MandateDecision,
  type MandateDenyCode,
  type MandateGrantRefusal,
  MandateId,
  Mandate as MandateSchema,
  type MandateUsage,
  mandateHash,
  mandateTimeState,
  mandateWorstCase,
  newId,
  normalizeMandate,
  type WalletPolicy,
} from "../src/index.ts";
import {
  ALICE,
  BASE,
  BOB,
  intent,
  MAINNET,
  mandate,
  mandateAsset,
  OTHER_AGENT,
  policy,
  ROUTER,
  T0,
  TOKEN,
  USDC_BASE,
  venueIntent,
} from "./fixtures.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const ok = <Value>(value: Value) => MandateSchema.safeParse(value).success;

/** A USDC payment from the fixture wallet by the fixture agent, inside every fixture cap. */
const pay = (amount = "100000000", overrides: Partial<EvmIntent> = {}): EvmIntent =>
  intent({
    operation: { type: "evm.erc20.transfer", token: USDC_BASE, to: ALICE, amount },
    maxFeeWei: "2000000000000000",
    ...overrides,
  });

const usage = (
  counts: { uses?: number; total?: bigint; inWindow?: bigint } = {},
): MandateUsage => ({
  uses: counts.uses ?? 0,
  total: () => counts.total ?? 0n,
  inWindow: () => counts.inWindow ?? 0n,
});

/** The fixture policy, with USDC capped exactly as the fixture mandate. */
const usdcPolicy = (overrides: Partial<WalletPolicy> = {}): WalletPolicy =>
  policy({
    assets: [
      { chainId: BASE, asset: USDC_BASE, maxPerTx: "100000000", maxPerDay: "500000000" },
      ...policy().assets,
    ],
    ...overrides,
  });

const GRANT = { now: T0, maxSeconds: 604_800 };

function denied(decision: MandateDecision): MandateDenyCode | null {
  return decision.allowed ? null : decision.code;
}

describe("mandate schema", () => {
  it("accepts the fixture, and mandate ids carry their own prefix", () => {
    expect(ok(mandate())).toBe(true);
    expect(MandateId.safeParse(newId("mnd")).success).toBe(true);
    expect(ok({ ...mandate(), id: newId("int") })).toBe(false);
  });

  it("refuses assets out of order, duplicated, missing or too many", () => {
    const eth = mandateAsset({
      asset: "native",
      maxPerAction: "1",
      maxPerWindow: "1",
      maxTotal: "1",
    });

    expect(ok(mandate({ assets: [mandateAsset(), eth] }))).toBe(true);
    expect(ok(mandate({ assets: [eth, mandateAsset()] }))).toBe(false);
    expect(ok(mandate({ assets: [mandateAsset(), mandateAsset()] }))).toBe(false);
    expect(ok(mandate({ assets: [] }))).toBe(false);

    const many = Array.from({ length: 17 }, (_, index) =>
      mandateAsset({ chainId: `eip155:${index + 1}` }),
    ).sort((a, b) => (`${a.chainId}|${a.asset}` < `${b.chainId}|${b.asset}` ? -1 : 1));

    expect(ok(mandate({ assets: many.slice(0, 16) }))).toBe(true);
    expect(ok(mandate({ assets: many }))).toBe(false);
  });

  it("orders the caps: per payment ≤ per window ≤ total, equal allowed", () => {
    const caps = (maxPerAction: string, maxPerWindow: string, maxTotal: string) =>
      ok(mandate({ assets: [mandateAsset({ maxPerAction, maxPerWindow, maxTotal })] }));

    expect(caps("5", "5", "5")).toBe(true);
    expect(caps("6", "5", "5")).toBe(false);
    expect(caps("5", "6", "5")).toBe(false);
    expect(caps("0", "5", "5")).toBe(false);
    // A malformed amount is refused, not thrown on.
    expect(caps("1.5", "5", "5")).toBe(false);
    expect(caps("5", "5", "x")).toBe(false);
  });

  it("refuses the zero address as a token or a recipient", () => {
    expect(ok(mandate({ assets: [mandateAsset({ asset: ZERO })] }))).toBe(false);
    expect(ok(mandate({ recipients: [ZERO, ALICE] }))).toBe(false);
  });

  it("needs 1 to 64 recipients as a sorted set", () => {
    expect(ok(mandate({ recipients: [] }))).toBe(false);
    expect(ok(mandate({ recipients: [BOB, ALICE] }))).toBe(false);
    expect(ok(mandate({ recipients: [ALICE, ALICE] }))).toBe(false);

    const addresses = Array.from(
      { length: 65 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as const,
    );

    expect(ok(mandate({ recipients: addresses.slice(0, 64) }))).toBe(true);
    expect(ok(mandate({ recipients: addresses }))).toBe(false);
  });

  it("ends after it starts, and lasts at most 30 days", () => {
    expect(ok(mandate({ notAfter: T0 }))).toBe(false);
    expect(ok(mandate({ notAfter: T0 - 1 }))).toBe(false);
    expect(ok(mandate({ notAfter: T0 + 1 }))).toBe(true);
    expect(ok(mandate({ notAfter: T0 + 2_592_000 }))).toBe(true);
    expect(ok(mandate({ notAfter: T0 + 2_592_001 }))).toBe(false);
  });

  it("bounds the window, the uses and the fee ceiling", () => {
    expect(ok(mandate({ windowSeconds: 3600 }))).toBe(true);
    expect(ok(mandate({ windowSeconds: 3599 }))).toBe(false);
    expect(ok(mandate({ windowSeconds: 604_800 }))).toBe(true);
    expect(ok(mandate({ windowSeconds: 604_801 }))).toBe(false);
    expect(ok(mandate({ windowSeconds: 3600.5 }))).toBe(false);
    expect(ok(mandate({ maxUses: 1 }))).toBe(true);
    expect(ok(mandate({ maxUses: 0 }))).toBe(false);
    expect(ok(mandate({ maxUses: 10_000 }))).toBe(true);
    expect(ok(mandate({ maxUses: 10_001 }))).toBe(false);
    expect(ok(mandate({ maxFeePerActionWei: "0" }))).toBe(false);
  });

  it("refuses unknown keys, another version and a purpose with control characters", () => {
    expect(ok({ ...mandate(), operation: "evm.call" })).toBe(false);
    expect(ok({ ...mandate(), assets: [{ ...mandateAsset(), maxPerDay: "1" }] })).toBe(false);
    expect(ok({ ...mandate(), v: 2 })).toBe(false);
    expect(ok(mandate({ purpose: "pay\u202eevil" }))).toBe(false);
    expect(ok(mandate({ purpose: "x".repeat(281) }))).toBe(false);
  });

  it("normalizeMandate sorts its sets, and mandateHash refuses what it cannot", () => {
    const eth = mandateAsset({
      asset: "native",
      maxPerAction: "1",
      maxPerWindow: "1",
      maxTotal: "1",
    });

    const messy = mandate({ assets: [eth, mandateAsset()], recipients: [TOKEN, BOB, ALICE, BOB] });
    const normal = normalizeMandate(messy);
    expect(normal.assets).toEqual([mandateAsset(), eth]);
    expect(normal.recipients).toEqual([ALICE, BOB, TOKEN]);
    expect(() => mandateHash(messy)).toThrow();
    expect(() => normalizeMandate(mandate({ assets: [eth, eth] }))).toThrow();
  });
});

describe("worst case and time", () => {
  it("is bound by the total, or by the uses when they allow less", () => {
    expect(mandateWorstCase(mandate())).toEqual([
      { chainId: BASE, asset: USDC_BASE, amount: 1_000_000_000n },
    ]);
    expect(mandateWorstCase(mandate({ maxUses: 5 }))).toEqual([
      { chainId: BASE, asset: USDC_BASE, amount: 500_000_000n },
    ]);
    expect(mandateWorstCase(mandate({ maxUses: 10 }))[0]?.amount).toBe(1_000_000_000n);
  });

  it("is live from notBefore up to, not including, notAfter", () => {
    const { notBefore, notAfter } = mandate();
    expect(mandateTimeState(mandate(), notBefore - 1)).toBe("not_yet_valid");
    expect(mandateTimeState(mandate(), notBefore)).toBe("live");
    expect(mandateTimeState(mandate(), notAfter - 1)).toBe("live");
    expect(mandateTimeState(mandate(), notAfter)).toBe("expired");
  });
});

describe("checkMandateAgainstPolicy", () => {
  const check = (subject: Mandate, against: WalletPolicy, options = GRANT) =>
    checkMandateAgainstPolicy(subject, against, options);

  it("accepts a mandate inside the policy, at every boundary", () => {
    expect(check(mandate(), usdcPolicy())).toBe(null);

    // The policy's allowlist holds every recipient.
    const listed = usdcPolicy({
      recipients: { mode: "allowlist", addresses: [ALICE, BOB, TOKEN] },
    });

    expect(check(mandate(), listed)).toBe(null);
    expect(check(mandate({ maxFeePerActionWei: "10000000000000000" }), usdcPolicy())).toBe(null);
  });

  it("refuses with each reason, in order", () => {
    const cases: [MandateGrantRefusal, Mandate, WalletPolicy][] = [
      ["wallet_mismatch", mandate(), usdcPolicy({ walletId: `wal_${"0".repeat(25)}9` })],
      ["wallet_mismatch", mandate(), usdcPolicy({ workspaceId: `ws_${"0".repeat(25)}9` })],
      ["requester_not_allowed", mandate(), usdcPolicy({ requesters: [OTHER_AGENT] })],
      [
        "chain_not_allowed",
        mandate({ assets: [mandateAsset({ chainId: MAINNET })] }),
        usdcPolicy(),
      ],
      ["asset_not_allowed", mandate(), policy()],
      ["asset_not_allowed", mandate({ assets: [mandateAsset({ asset: TOKEN })] }), usdcPolicy()],
      [
        "over_per_tx_cap",
        mandate(),
        usdcPolicy({
          assets: [
            { chainId: BASE, asset: USDC_BASE, maxPerTx: "99999999", maxPerDay: "500000000" },
          ],
        }),
      ],
      [
        "over_daily_cap",
        mandate(),
        usdcPolicy({
          assets: [
            { chainId: BASE, asset: USDC_BASE, maxPerTx: "100000000", maxPerDay: "499999999" },
          ],
        }),
      ],
      [
        "recipient_not_allowed",
        mandate(),
        usdcPolicy({ recipients: { mode: "allowlist", addresses: [ALICE, BOB] } }),
      ],
      ["over_fee_cap", mandate({ maxFeePerActionWei: "10000000000000001" }), usdcPolicy()],
    ];

    for (const [reason, subject, against] of cases) {
      expect(check(subject, against), reason).toBe(reason);
    }

    // The first failing rule decides: this one fails the agent and the fee ceiling.
    const both = mandate({ agentId: OTHER_AGENT, maxFeePerActionWei: "10000000000000001" });
    expect(check(both, usdcPolicy())).toBe("requester_not_allowed");
  });

  it("checks a window longer than a day against the per-payment cap only", () => {
    const week = mandate({
      windowSeconds: 604_800,
      assets: [mandateAsset({ maxPerWindow: "1000000000" })],
    });

    expect(check(week, usdcPolicy())).toBe(null);
    expect(check({ ...week, windowSeconds: 86_400 }, usdcPolicy())).toBe("over_daily_cap");
  });

  it("refuses a mandate that has ended or would last longer than the signer allows", () => {
    const { notBefore, notAfter } = mandate();
    expect(check(mandate(), usdcPolicy(), { now: notAfter, maxSeconds: 604_800 })).toBe(
      "already_expired",
    );
    expect(check(mandate(), usdcPolicy(), { now: notAfter - 1, maxSeconds: 604_800 })).toBe(null);
    // 604000 seconds from now to the end.
    expect(check(mandate(), usdcPolicy(), { now: notBefore, maxSeconds: 604_000 })).toBe(null);
    expect(check(mandate(), usdcPolicy(), { now: notBefore, maxSeconds: 603_999 })).toBe(
      "lifetime_too_long",
    );
    // Counted from the start when it is still ahead, and from now when it has passed.
    const later = mandate({ notBefore: T0 + 1000, notAfter: T0 + 1000 + 604_000 });
    expect(check(later, usdcPolicy(), { now: T0, maxSeconds: 604_000 })).toBe(null);
    expect(check(mandate(), usdcPolicy(), { now: T0 + 1, maxSeconds: 603_999 })).toBe(null);
  });

  it("lists every reason, the signer-only one last", () => {
    expect(MANDATE_GRANT_REFUSALS.at(-1)).toBe("too_many_live_mandates");
    expect(new Set(MANDATE_GRANT_REFUSALS).size).toBe(MANDATE_GRANT_REFUSALS.length);
  });
});

describe("evaluateMandate", () => {
  it("allows a payment inside every cap, with its spend", () => {
    expect(evaluateMandate(mandate(), pay(), usage())).toEqual({
      allowed: true,
      spend: { chainId: BASE, asset: USDC_BASE, amount: 100_000_000n },
    });
  });

  it("refuses another wallet or workspace, and another agent", () => {
    expect(
      denied(evaluateMandate(mandate(), pay("1", { walletId: `wal_${"0".repeat(25)}9` }), usage())),
    ).toBe("mandate_wallet_mismatch");
    expect(
      denied(
        evaluateMandate(mandate(), pay("1", { workspaceId: `ws_${"0".repeat(25)}9` }), usage()),
      ),
    ).toBe("mandate_wallet_mismatch");
    expect(denied(evaluateMandate(mandate(), pay("1", { agentId: OTHER_AGENT }), usage()))).toBe(
      "mandate_agent_mismatch",
    );
  });

  it("never covers a contract call, not even one that sends nothing", () => {
    for (const operation of [
      { type: "evm.call" as const, to: ALICE, valueWei: "0", data: "0xa9059cbb" as const },
      {
        type: "evm.call" as const,
        to: USDC_BASE,
        valueWei: "0",
        data: `0xa9059cbb${"0".repeat(24)}${ALICE.slice(2)}${"0".repeat(56)}05f5e100` as const,
      },
    ]) {
      expect(denied(evaluateMandate(mandate(), intent({ operation }), usage()))).toBe(
        "mandate_operation_not_allowed",
      );
    }
  });

  it("never covers an order or a withdrawal at a venue", () => {
    expect(denied(evaluateMandate(mandate(), venueIntent(), usage()))).toBe(
      "mandate_operation_not_allowed",
    );
    const withdraw = venueIntent({ operation: { type: "hyperliquid.withdraw", amount: "1" } });
    expect(denied(evaluateMandate(mandate(), withdraw, usage()))).toBe(
      "mandate_operation_not_allowed",
    );
    // The wallet and the agent are still checked first, as for any intent.
    expect(denied(evaluateMandate(mandate(), venueIntent({ agentId: OTHER_AGENT }), usage()))).toBe(
      "mandate_agent_mismatch",
    );
  });

  it("covers only its assets on their chains", () => {
    const native = intent({ maxFeeWei: "2000000000000000" });
    expect(denied(evaluateMandate(mandate(), native, usage()))).toBe("mandate_asset_not_allowed");

    const otherToken = pay("1", {
      operation: { type: "evm.erc20.transfer", token: TOKEN, to: ALICE, amount: "1" },
    });

    expect(denied(evaluateMandate(mandate(), otherToken, usage()))).toBe(
      "mandate_asset_not_allowed",
    );
    expect(denied(evaluateMandate(mandate(), pay("1", { chainId: MAINNET }), usage()))).toBe(
      "mandate_asset_not_allowed",
    );

    // A native limit covers a native transfer.
    const eth = mandate({
      assets: [
        mandateAsset({
          asset: "native",
          maxPerAction: "250000000000000000",
          maxPerWindow: "250000000000000000",
          maxTotal: "250000000000000000",
        }),
      ],
    });

    expect(evaluateMandate(eth, native, usage()).allowed).toBe(true);
  });

  it("pays only listed recipients", () => {
    for (const to of [ALICE, BOB, TOKEN]) {
      const listed = pay("1", {
        operation: { type: "evm.erc20.transfer", token: USDC_BASE, to, amount: "1" },
      });

      expect(evaluateMandate(mandate(), listed, usage()).allowed).toBe(true);
    }

    const unlisted = pay("1", {
      operation: { type: "evm.erc20.transfer", token: USDC_BASE, to: ROUTER, amount: "1" },
    });

    expect(denied(evaluateMandate(mandate(), unlisted, usage()))).toBe(
      "mandate_recipient_not_allowed",
    );
  });

  it("refuses a fee ceiling above the mandate's, and allows it equal", () => {
    expect(evaluateMandate(mandate(), pay(), usage()).allowed).toBe(true);
    expect(
      denied(
        evaluateMandate(mandate(), pay(undefined, { maxFeeWei: "2000000000000001" }), usage()),
      ),
    ).toBe("mandate_over_fee_cap");
  });

  it("counts uses: the last one fits, the next does not", () => {
    expect(evaluateMandate(mandate(), pay(), usage({ uses: 19 })).allowed).toBe(true);
    expect(denied(evaluateMandate(mandate(), pay(), usage({ uses: 20 })))).toBe(
      "mandate_uses_exhausted",
    );
  });

  it("caps each payment", () => {
    expect(evaluateMandate(mandate(), pay("100000000"), usage()).allowed).toBe(true);
    expect(denied(evaluateMandate(mandate(), pay("100000001"), usage()))).toBe(
      "mandate_over_per_action_cap",
    );
  });

  it("caps the rolling window with what the signer counted in it", () => {
    expect(evaluateMandate(mandate(), pay(), usage({ inWindow: 400_000_000n })).allowed).toBe(true);
    expect(denied(evaluateMandate(mandate(), pay(), usage({ inWindow: 400_000_001n })))).toBe(
      "mandate_over_window_cap",
    );
  });

  it("caps the total over the mandate's life", () => {
    expect(evaluateMandate(mandate(), pay(), usage({ total: 900_000_000n })).allowed).toBe(true);
    expect(denied(evaluateMandate(mandate(), pay(), usage({ total: 900_000_001n })))).toBe(
      "mandate_over_total_cap",
    );
  });

  it("asks the usage about the intent's own asset and chain", () => {
    const asked: string[] = [];

    const spy: MandateUsage = {
      uses: 0,
      total: (chainId, asset) => {
        asked.push(`total ${chainId}|${asset}`);

        return 0n;
      },
      inWindow: (chainId, asset) => {
        asked.push(`window ${chainId}|${asset}`);

        return 0n;
      },
    };

    evaluateMandate(mandate(), pay(), spy);
    expect(asked).toEqual([`window ${BASE}|${USDC_BASE}`, `total ${BASE}|${USDC_BASE}`]);
  });

  it("the first failing rule decides", () => {
    // Unlisted recipient and over every cap: the recipient is checked first.
    const unlisted = pay("100000001", {
      operation: { type: "evm.erc20.transfer", token: USDC_BASE, to: ROUTER, amount: "100000001" },
    });

    expect(denied(evaluateMandate(mandate(), unlisted, usage({ uses: 20 })))).toBe(
      "mandate_recipient_not_allowed",
    );
    // Over the per-payment cap and the window: the per-payment cap is checked first.
    expect(
      denied(evaluateMandate(mandate(), pay("100000001"), usage({ inWindow: 500_000_000n }))),
    ).toBe("mandate_over_per_action_cap");
  });

  it("does not look at time, and every code is listed once", () => {
    // Time is the signer's to judge with mandateTimeState; the evaluation is the same.
    expect(evaluateMandate(mandate({ notBefore: 0, notAfter: 1 }), pay(), usage()).allowed).toBe(
      true,
    );
    expect(new Set(MANDATE_DENY_CODES).size).toBe(MANDATE_DENY_CODES.length);
    expect(MANDATE_DENY_CODES.every((code) => code.startsWith("mandate_"))).toBe(true);
  });
});

describe("the wallet's policy stays the outer limit", () => {
  // The signer evaluates both and signs only when both allow; neither widens the other.
  const both = (
    subject: Mandate,
    against: WalletPolicy,
    payment: EvmIntent,
    spent24h: bigint,
    used: MandateUsage,
  ) => {
    const byPolicy = evaluateIntent(against, payment, () => spent24h);
    const byMandate = evaluateMandate(subject, payment, used);

    return {
      policy: byPolicy.allowed ? null : byPolicy.code,
      mandate: byMandate.allowed ? null : byMandate.code,
    };
  };

  it("its 24-hour cap refuses a payment a week-long window would allow", () => {
    const week = mandate({
      windowSeconds: 604_800,
      assets: [mandateAsset({ maxPerWindow: "1000000000" })],
    });

    expect(checkMandateAgainstPolicy(week, usdcPolicy(), GRANT)).toBe(null);
    expect(
      both(week, usdcPolicy(), pay(), 450_000_000n, usage({ inWindow: 450_000_000n })),
    ).toEqual({
      policy: "over_daily_cap",
      mandate: null,
    });
  });

  it("lowering the policy narrows a granted mandate at once", () => {
    const lowered = usdcPolicy({
      assets: [{ chainId: BASE, asset: USDC_BASE, maxPerTx: "50000000", maxPerDay: "500000000" }],
    });

    expect(both(mandate(), lowered, pay(), 0n, usage())).toEqual({
      policy: "over_per_tx_cap",
      mandate: null,
    });
    const fewerRecipients = usdcPolicy({ recipients: { mode: "allowlist", addresses: [BOB] } });
    expect(both(mandate(), fewerRecipients, pay(), 0n, usage())).toEqual({
      policy: "recipient_not_allowed",
      mandate: null,
    });
    const agentRemoved = usdcPolicy({ requesters: [OTHER_AGENT] });
    expect(both(mandate(), agentRemoved, pay(), 0n, usage())).toEqual({
      policy: "requester_not_allowed",
      mandate: null,
    });
  });

  it("raising the policy widens nothing the mandate caps", () => {
    const raised = usdcPolicy({
      assets: [
        { chainId: BASE, asset: USDC_BASE, maxPerTx: "10000000000", maxPerDay: "10000000000" },
      ],
    });

    expect(both(mandate(), raised, pay("100000001"), 0n, usage())).toEqual({
      policy: null,
      mandate: "mandate_over_per_action_cap",
    });
    expect(both(mandate(), raised, pay(), 0n, usage({ inWindow: 450_000_000n }))).toEqual({
      policy: null,
      mandate: "mandate_over_window_cap",
    });
  });
});
