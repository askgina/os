import { MandateEndedReason, MandateStatus } from "@askgina/os-api";
import {
  MANDATE_DENY_CODES,
  MANDATE_GRANT_REFUSALS,
  type Mandate,
  mandateWorstCase,
} from "@askgina/os-protocol";
import { describe, expect, it } from "vitest";
import { explainCode, explainMandateRefusal } from "../src/lib/codes.ts";
import {
  CLOCK_SLACK_SECONDS,
  endChoices,
  endedReasonSentence,
  formatTimeLeft,
  formatWindow,
  localDateTimeValue,
  type MandateForm,
  MandateFormError,
  mandateDraft,
  mandateSentence,
  mandateStatusLabel,
  parseLocalDateTime,
  worstCase,
  worstCaseSentence,
} from "../src/lib/mandate.ts";

const AGENT = "agt_01jd0000000000000000000002";

const PAYEE = "0x1111111111111111111111111111111111111111";

const OTHER = "0x2222222222222222222222222222222222222222";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

describe("the worst case", () => {
  it("is the total cap, or the uses times the per-payment cap when that is smaller", () => {
    expect(worstCase({ maxPerAction: 100n, maxTotal: 1_000n }, 20)).toBe(1_000n);
    expect(worstCase({ maxPerAction: 100n, maxTotal: 1_000n }, 3)).toBe(300n);
  });

  it("matches the protocol's figure for a granted mandate", () => {
    const mandate: Mandate = {
      v: 1,
      id: "mnd_01jd0000000000000000000006",
      workspaceId: "ws_01jd0000000000000000000001",
      walletId: "wal_01jd0000000000000000000003",
      agentId: AGENT,
      assets: [
        {
          chainId: "eip155:8453",
          asset: "native",
          maxPerAction: "100000000",
          maxPerWindow: "500000000",
          maxTotal: "1000000000",
        },
      ],
      windowSeconds: 86_400,
      recipients: [PAYEE],
      maxUses: 7,
      maxFeePerActionWei: "2000000000000000",
      notBefore: 1_700_000_000,
      notAfter: 1_700_604_000,
      purpose: "",
    };

    const [limit] = mandate.assets;

    if (!limit) throw new Error("no asset");
    expect(
      worstCase(
        { maxPerAction: BigInt(limit.maxPerAction), maxTotal: BigInt(limit.maxTotal) },
        mandate.maxUses,
      ),
    ).toBe(mandateWorstCase(mandate)[0]?.amount);
  });
});

describe("the end times the editor offers", () => {
  it("offers the end of today, of Friday and 7 days, in the viewer's own time zone", () => {
    // A Wednesday morning, local time.
    const now = new Date(2026, 10, 18, 9, 30);
    const choices = endChoices(now);
    expect(choices.map((choice) => choice.id)).toEqual(["today", "friday", "week"]);
    expect(choices[0]?.notAfter).toBe(seconds(new Date(2026, 10, 18, 23, 59)));
    expect(choices[1]?.notAfter).toBe(seconds(new Date(2026, 10, 20, 23, 59)));
    const week = choices[2]?.notAfter ?? 0;
    expect(week % 60).toBe(0);
    expect(week).toBeLessThanOrEqual(seconds(now) + 604_800 - CLOCK_SLACK_SECONDS);
    expect(week).toBeGreaterThan(seconds(now) + 604_800 - CLOCK_SLACK_SECONDS - 60);
  });

  it("does not offer Friday on a Friday, nor an end that has passed", () => {
    const friday = new Date(2026, 10, 20, 23, 59, 30);
    expect(endChoices(friday).map((choice) => choice.id)).toEqual(["week"]);
  });

  it("drops a Friday that lies beyond the signer's longest life", () => {
    // Saturday just after midnight: the next Friday's end is almost 7 days away.
    const saturday = new Date(2026, 10, 21, 0, 1);
    expect(endChoices(saturday).map((choice) => choice.id)).toEqual(["today", "week"]);
  });

  it("reads a typed date and time in local time, and refuses one that does not exist", () => {
    expect(parseLocalDateTime("2026-11-21T18:00")).toBe(seconds(new Date(2026, 10, 21, 18, 0)));
    expect(parseLocalDateTime("2026-11-21T18:00:30")).toBe(
      seconds(new Date(2026, 10, 21, 18, 0, 30)),
    );
    expect(parseLocalDateTime("2026-02-30T10:00")).toBeNull();
    expect(parseLocalDateTime("tomorrow")).toBeNull();
    const at = seconds(new Date(2026, 10, 21, 18, 5));
    expect(localDateTimeValue(at)).toBe("2026-11-21T18:05");
    expect(parseLocalDateTime(localDateTimeValue(at))).toBe(at);
  });
});

describe("how times and spans read", () => {
  it("says how long is left in days, hours and minutes", () => {
    expect(formatTimeLeft(0)).toBe("no time");
    expect(formatTimeLeft(30)).toBe("less than a minute");
    expect(formatTimeLeft(12 * 60)).toBe("12 min");
    expect(formatTimeLeft(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
    expect(formatTimeLeft(2 * 3600)).toBe("2 h");
    expect(formatTimeLeft(86_400)).toBe("1 day");
    expect(formatTimeLeft(6 * 86_400 + 23 * 3600 + 59)).toBe("6 days 23 h");
  });

  it("names the window", () => {
    expect(formatWindow(3_600)).toBe("1 hour");
    expect(formatWindow(86_400)).toBe("24 hours");
    expect(formatWindow(7_200)).toBe("2 hours");
    expect(formatWindow(604_800)).toBe("7 days");
    expect(formatWindow(5_400)).toBe("90 minutes");
  });
});

describe("the sentences", () => {
  it("puts one asset's mandate in one sentence", () => {
    expect(
      mandateSentence({
        agent: "Invoice payer",
        assets: [{ perAction: "100 USDC", perWindow: "500 USDC", total: "1,000 USDC" }],
        recipients: 3,
        windowSeconds: 86_400,
        maxUses: 20,
        ends: "Fri, Nov 21, 6:00 PM (your time)",
      }),
    ).toBe(
      "Let Invoice payer pay up to 100 USDC at a time to 3 listed recipients, at most 500 USDC in any 24 hours and 1,000 USDC in total, at most 20 payments, until Fri, Nov 21, 6:00 PM (your time).",
    );
  });

  it("lists each asset's caps when there are several", () => {
    expect(
      mandateSentence({
        agent: "Payer",
        assets: [
          { perAction: "1 ETH", perWindow: "2 ETH", total: "3 ETH" },
          { perAction: "5 USDC", perWindow: "6 USDC", total: "7 USDC" },
        ],
        recipients: 1,
        windowSeconds: 3_600,
        maxUses: 1,
        ends: "Mon",
      }),
    ).toBe(
      "Let Payer pay 1 listed recipient, at most 1 payment, until Mon: up to 1 ETH at a time, 2 ETH in any 1 hour and 3 ETH in total; up to 5 USDC at a time, 6 USDC in any 1 hour and 7 USDC in total.",
    );
  });

  it("states the worst case with the fees", () => {
    expect(
      worstCaseSentence({
        amounts: ["1,000 USDC", "0.5 ETH"],
        feePerPayment: "0.002 ETH",
        feeTotal: "0.04 ETH",
      }),
    ).toBe(
      "At most 1,000 USDC and 0.5 ETH can leave this wallet under this approval, plus network fees of at most 0.002 ETH per payment (0.04 ETH in all).",
    );
  });

  it("has words for every status and every reason a mandate ended", () => {
    expect(Object.keys(mandateStatusLabel).sort()).toEqual([...MandateStatus.options].sort());
    expect(Object.keys(endedReasonSentence).sort()).toEqual([...MandateEndedReason.options].sort());
  });
});

describe("what the codes mean", () => {
  const generic = explainCode("no_such_code");

  it("explains every reason a mandate does not cover a payment", () => {
    for (const code of [
      ...MANDATE_DENY_CODES,
      "mandate_revoked",
      "mandate_expired",
      "mandate_not_yet_valid",
    ]) {
      expect(explainCode(code), code).not.toBe(generic);
    }
  });

  it("explains every refusal of a draft or a grant in a mandate's own terms", () => {
    for (const code of [...MANDATE_GRANT_REFUSALS, "agent_disabled"]) {
      expect(explainMandateRefusal(code), code).not.toBe(generic);
    }

    expect(explainMandateRefusal("over_per_tx_cap")).not.toBe(explainCode("over_per_tx_cap"));
    // A code about something else keeps its usual meaning.
    expect(explainMandateRefusal("workspace_paused")).toBe(explainCode("workspace_paused"));
    expect(explainMandateRefusal("constructor")).toBe(generic);
  });
});

describe("the editor's draft", () => {
  const NOW = 1_800_000_000;

  const form = (patch: Partial<MandateForm> = {}): MandateForm => ({
    agentId: AGENT,
    recipients: `${PAYEE.toUpperCase().replace("0X", "0x")}\n${OTHER}, ${PAYEE}`,
    assets: [
      {
        chainId: "eip155:31337",
        asset: "native",
        decimals: 18,
        label: "ETH on Local",
        maxPerAction: "0.01",
        maxPerWindow: "0.02",
        maxTotal: "0.03",
      },
      {
        chainId: "eip155:31337",
        asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        decimals: 6,
        label: "USDC on Local",
        maxPerAction: "",
        maxPerWindow: "",
        maxTotal: "",
      },
    ],
    windowSeconds: 86_400,
    maxUses: "3",
    feePerPayment: "0.01",
    notAfter: NOW + 3_600,
    purpose: "  Pay invoices this week ",
    ...patch,
  });

  it("turns whole units into base units, keeps each recipient once and leaves empty assets out", () => {
    expect(mandateDraft(form(), NOW)).toEqual({
      agentId: AGENT,
      assets: [
        {
          chainId: "eip155:31337",
          asset: "native",
          maxPerAction: "10000000000000000",
          maxPerWindow: "20000000000000000",
          maxTotal: "30000000000000000",
        },
      ],
      windowSeconds: 86_400,
      recipients: [PAYEE, OTHER],
      maxUses: 3,
      maxFeePerActionWei: "10000000000000000",
      notAfter: NOW + 3_600,
      purpose: "Pay invoices this week",
    });
  });

  const refusal = (patch: Partial<MandateForm>) => {
    try {
      mandateDraft(form(patch), NOW);
    } catch (error) {
      if (error instanceof MandateFormError) return error.message;
      throw error;
    }

    return null;
  };

  it("names the field that is wrong", () => {
    expect(refusal({ agentId: "" })).toBe("Choose the agent that may pay.");
    expect(refusal({ recipients: " " })).toMatch(/^Add at least one recipient/);
    expect(refusal({ recipients: "0x12" })).toBe('Recipients: "0x12" is not an address.');
    expect(refusal({ recipients: "0x0000000000000000000000000000000000000000" })).toMatch(
      /zero address/,
    );
    expect(refusal({ maxUses: "0" })).toBe("Number of payments: a whole number from 1 to 10,000.");
    expect(refusal({ maxUses: "1.5" })).toBe(
      "Number of payments: a whole number from 1 to 10,000.",
    );
    expect(refusal({ feePerPayment: "0" })).toBe("Network fee per payment must be above zero.");
    expect(refusal({ notAfter: null })).toBe("Choose when it ends.");
    expect(refusal({ notAfter: NOW })).toBe("The end time has already passed.");
    expect(refusal({ notAfter: NOW + 31 * 86_400 })).toMatch(/at most 30 days/);
    expect(refusal({ purpose: "x".repeat(281) })).toMatch(/^Purpose: at most 280 characters/);
  });

  it("checks each asset's caps are complete and in order", () => {
    const [eth, usdc] = form().assets;

    if (!eth || !usdc) throw new Error("no assets");
    expect(
      refusal({ assets: [{ ...eth, maxPerAction: "", maxPerWindow: "", maxTotal: "" }] }),
    ).toBe("Fill in the limits of at least one asset.");
    expect(refusal({ assets: [{ ...eth, maxTotal: "" }] })).toBe(
      "ETH on Local: fill in all three limits, or none to leave this asset out.",
    );
    expect(refusal({ assets: [{ ...eth, maxPerAction: "0.05" }] })).toBe(
      "ETH on Local: the most per payment cannot be more than the most in the window.",
    );
    expect(refusal({ assets: [{ ...eth, maxTotal: "0.015" }] })).toBe(
      "ETH on Local: the most in the window cannot be more than the most in total.",
    );
    expect(refusal({ assets: [{ ...eth, maxPerAction: "0" }] })).toBe(
      "ETH on Local: the most per payment must be above zero.",
    );
    expect(
      refusal({
        assets: [{ ...usdc, maxPerAction: "1.0000001", maxPerWindow: "2", maxTotal: "3" }],
      }),
    ).toBe("USDC on Local, the most per payment: This asset has at most 6 decimal places.");
  });

  it("takes base units for a token whose decimals are unknown", () => {
    const [eth] = form().assets;

    if (!eth) throw new Error("no asset");

    const draft = mandateDraft(
      form({
        assets: [{ ...eth, decimals: null, maxPerAction: "5", maxPerWindow: "10", maxTotal: "20" }],
      }),
      NOW,
    );

    expect(draft.assets[0]?.maxPerAction).toBe("5");
  });
});
