import { ApiError, type CloneResult, type WorkspaceTemplate } from "@askgina/os-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyName,
  needsFreshSignIn,
  readTemplateFile,
  recordFileName,
  templateFileName,
  templateFileText,
  thresholdReminder,
} from "../src/lib/export.ts";
import { revealCloneResult, takeCloneResult } from "../src/lib/reveal.ts";

const TEMPLATE: WorkspaceTemplate = {
  format: "askgina.os/workspace-template/v1",
  name: "Research team",
  adminThreshold: 2,
  notificationDetail: "count",
  wallets: [
    {
      ref: "w1",
      kind: "agent",
      label: "Invoice payer's wallet",
      agent: { name: "Invoice payer" },
      policy: {
        chains: ["eip155:31337"],
        requesters: ["w1"],
        assets: [],
        recipients: { mode: "any" },
        contractCalls: { mode: "deny" },
        fees: { maxPerTxWei: "1000000000000000" },
        approvals: { threshold: 1, ttlSeconds: 600 },
      },
    },
    { ref: "w2", kind: "treasury", label: "Reserve", agent: null, policy: null },
  ],
  members: [{ userId: "usr_01jd0000000000000000000001", role: "owner" }],
};

describe("the files a workspace is exported to", () => {
  it("are named after the workspace, in letters, digits and dashes", () => {
    expect(templateFileName("Research team")).toBe("research-team-template.json");
    expect(templateFileName("  Équipe / R&D  ")).toBe("equipe-r-d-template.json");
    expect(templateFileName("🙂")).toBe("workspace-template.json");
    expect(templateFileName("a".repeat(64))).toBe(`${"a".repeat(48)}-template.json`);
  });

  it("dates the record in UTC", () => {
    expect(recordFileName("Research team", new Date("2026-11-15T23:30:00Z"))).toBe(
      "research-team-record-2026-11-15.jsonl",
    );
  });

  it("writes a template that reads back the same", () => {
    const text = templateFileText(TEMPLATE);
    expect(text.endsWith("}\n")).toBe(true);
    expect(readTemplateFile(text)).toEqual({ ok: true, template: TEMPLATE });
  });
});

describe("reading a template file", () => {
  it("says when the file is not JSON", () => {
    expect(readTemplateFile("not json")).toEqual({
      ok: false,
      problem: "This file is not a workspace template: it is not JSON.",
    });
  });

  it("checks the template as the server does, and says where it is wrong", () => {
    const strayRequester = {
      ...TEMPLATE,
      wallets: [
        { ...TEMPLATE.wallets[1], policy: { ...TEMPLATE.wallets[0]?.policy, requesters: ["w2"] } },
      ],
    };

    const result = readTemplateFile(JSON.stringify(strayRequester));
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.problem).toMatch(/^This file is not a workspace template this server can read/);
      expect(result.problem).toContain("(at wallets.0.policy.requesters)");
    }

    const otherFormat = readTemplateFile(JSON.stringify({ ...TEMPLATE, format: "something/v2" }));
    expect(otherFormat.ok).toBe(false);
    const extraField = readTemplateFile(JSON.stringify({ ...TEMPLATE, keys: ["0xabc"] }));
    expect(extraField.ok).toBe(false);
  });
});

describe("downloading the record", () => {
  it("asks for a fresh sign-in only when the server says so", () => {
    expect(
      needsFreshSignIn(new ApiError("forbidden", "Sign in again.", 403, "sign_in_again")),
    ).toBe(true);
    expect(needsFreshSignIn(new ApiError("forbidden", "Owners only.", 403))).toBe(false);
    expect(needsFreshSignIn(new ApiError("conflict", "No.", 409, "sign_in_again"))).toBe(false);
    expect(needsFreshSignIn(new Error("sign_in_again"))).toBe(false);
    expect(needsFreshSignIn(null)).toBe(false);
  });
});

describe("copying a workspace", () => {
  it("names the copy after its source, within 64 characters", () => {
    expect(copyName("Research team")).toBe("Research team (copy)");
    const long = copyName(`${"a".repeat(56)} bcdefgh`);
    expect(long).toHaveLength(63);
    expect(long.endsWith("a (copy)")).toBe(true);
  });

  it("reminds that the copy starts at one approval, and what the template had", () => {
    expect(thresholdReminder(1)).toBe(
      "Admin changes in this workspace need 1 approval until you change it: you are its only approver.",
    );
    expect(thresholdReminder(3)).toMatch(
      /need 1 approval until you change it.*needed 3; raise it to that once 3 approvers have joined\.$/,
    );
  });
});

describe("the result of a copy, shown once", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is handed to the next page through memory and gone after it read it", () => {
    vi.useFakeTimers();

    const result: CloneResult = {
      workspace: {
        id: "ws_new",
        name: "Research team (copy)",
        role: "owner",
        paused: false,
        pendingApprovals: 0,
        lifecycle: { state: "active", destroyAfter: null, deletedAt: null },
        adminThreshold: 1,
        notificationDetail: "count",
        members: [],
        agents: [],
        wallets: [],
        chains: [],
        venueNetworks: [],
      },
      approvals: [],
      agents: [],
      invites: [],
      templateAdminThreshold: 2,
    };

    revealCloneResult(result);
    expect(takeCloneResult("ws_new")).toBe(result);
    // A second render in the same task sees the same value.
    expect(takeCloneResult("ws_new")).toBe(result);
    vi.runAllTimers();
    expect(takeCloneResult("ws_new")).toBeNull();
    expect(takeCloneResult("ws_other")).toBeNull();
  });
});
