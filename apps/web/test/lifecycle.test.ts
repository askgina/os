import {
  type ApprovalDetail,
  type ApprovalSummary,
  DeletionBlocker,
  type WalletSummary,
} from "@askgina/os-api";
import { describe, expect, it } from "vitest";
import {
  blockerText,
  DEFAULT_MIN_DESTROY_DELAY_SECONDS,
  DESTROY_AFTER_MARGIN_SECONDS,
  delayChoices,
  destroyAfterFor,
  destroyCountdown,
  formatDelay,
  heldBalances,
  serverClockOffset,
  waitingRequests,
  waitingRetirementOf,
  walletChangeable,
  walletLifecycleLabel,
} from "../src/lib/lifecycle.ts";

const DAY = 86_400;

describe("the delay before keys are destroyed", () => {
  it("offers the signer's shortest delay first, then 14 and 30 days", () => {
    expect(delayChoices(DEFAULT_MIN_DESTROY_DELAY_SECONDS)).toEqual([7 * DAY, 14 * DAY, 30 * DAY]);
  });

  it("never offers a delay the signer would refuse as too short", () => {
    expect(delayChoices(21 * DAY)).toEqual([21 * DAY, 30 * DAY]);
    expect(delayChoices(14 * DAY)).toEqual([14 * DAY, 30 * DAY]);
    expect(delayChoices(60 * DAY)).toEqual([60 * DAY]);
    // An operator may shorten it; the shortest still comes first.
    expect(delayChoices(3_600)).toEqual([3_600, 14 * DAY, 30 * DAY]);
  });

  it("names delays in days, hours or minutes", () => {
    expect(formatDelay(7 * DAY)).toBe("7 days");
    expect(formatDelay(DAY)).toBe("1 day");
    expect(formatDelay(3_600)).toBe("1 hour");
    expect(formatDelay(36 * 3_600)).toBe("36 hours");
    expect(formatDelay(5_400)).toBe("90 minutes");
  });

  it("asks for the delay on the server's clock, with room for the request to open", () => {
    // The server's clock runs 40 seconds ahead of this browser's.
    const preflight = {
      minDestroyDelaySeconds: 7 * DAY,
      earliestDestroyAfter: 1_000_040 + 7 * DAY,
    };

    const offset = serverClockOffset(preflight, 1_000_000);
    expect(offset).toBe(40);
    // A minute later the shortest delay still lands after the server's earliest.
    const destroyAfter = destroyAfterFor(7 * DAY, 1_000_060, offset);
    expect(destroyAfter).toBe(1_000_100 + 7 * DAY + DESTROY_AFTER_MARGIN_SECONDS);
    expect(destroyAfter).toBeGreaterThan(preflight.earliestDestroyAfter);
  });

  it("counts down to the destroy time, then says it is due", () => {
    expect(destroyCountdown(1_000 + 6 * DAY + 3 * 3_600, 1_000)).toBe("6 days 3 h left to cancel");
    expect(destroyCountdown(1_000 + 90, 1_000)).toBe("1 min left to cancel");
    expect(destroyCountdown(1_000, 1_000)).toBe(
      "Due now: it finishes once nothing is left waiting",
    );
  });
});

describe("what the server reads before keys are destroyed", () => {
  it("keeps only the balances that are not zero", () => {
    const eth = {
      chainId: "eip155:31337" as const,
      asset: "native" as const,
      symbol: "ETH",
      decimals: 18,
      amount: "1250000000000000000",
    };

    expect(heldBalances([eth, { ...eth, symbol: "WETH", amount: "0" }])).toEqual([eth]);
  });

  it("explains every reason deleting would lose something or wait", () => {
    for (const blocker of DeletionBlocker.options) {
      expect(blockerText[blocker]).toMatch(/\.$/);
    }
  });
});

describe("a wallet's lifecycle", () => {
  it("is labelled only once it is no longer active", () => {
    expect(walletLifecycleLabel({ state: "active", destroyAfter: null })).toBeNull();
    expect(walletLifecycleLabel({ state: "retiring", destroyAfter: 1 })).toBe("Retiring");
    expect(walletLifecycleLabel({ state: "held", destroyAfter: null })).toBe("Stopped");
    expect(walletLifecycleLabel({ state: "destroyed", destroyAfter: 1 })).toBe("Key destroyed");
  });

  it("can be changed or retired while active or stopped, never while retiring or destroyed", () => {
    expect(walletChangeable({ state: "active", destroyAfter: null })).toBe(true);
    expect(walletChangeable({ state: "held", destroyAfter: null })).toBe(true);
    expect(walletChangeable({ state: "retiring", destroyAfter: 1 })).toBe(false);
    expect(walletChangeable({ state: "destroyed", destroyAfter: 1 })).toBe(false);
  });
});

describe("a waiting retirement or deletion, linked from its wallet or workspace", () => {
  const request = (
    id: string,
    kind: ApprovalSummary["kind"],
    status: ApprovalSummary["status"],
    createdAt: number,
  ) => ({ id, kind, status, createdAt });

  it("lists the waiting requests of one kind, oldest first", () => {
    const items = [
      request("b", "delete-workspace", "pending", 20),
      request("a", "delete-workspace", "pending", 10),
      request("c", "delete-workspace", "rejected", 5),
      request("d", "retire-wallet", "pending", 1),
      request("e", "set-policy", "pending", 2),
    ];

    expect(waitingRequests(items, "delete-workspace").map((item) => item.id)).toEqual(["a", "b"]);
    expect(waitingRequests(items, "retire-wallet").map((item) => item.id)).toEqual(["d"]);
  });

  it("finds the waiting retirement of this wallet among requests read in full", () => {
    const wallet = (id: string) => ({ id }) as WalletSummary;

    const detail = (
      id: string,
      walletId: string,
      status: ApprovalDetail["status"] = "pending",
    ): Pick<ApprovalDetail, "id" | "status" | "subject"> => ({
      id: id as ApprovalDetail["id"],
      status,
      subject: { kind: "retire-wallet", wallet: wallet(walletId), destroyAfter: 1 },
    });

    const details = [
      undefined,
      detail("apr_other", "wal_2"),
      detail("apr_done", "wal_1", "approved"),
      detail("apr_mine", "wal_1"),
    ];

    expect(waitingRetirementOf(details, "wal_1")?.id).toBe("apr_mine");
    expect(waitingRetirementOf(details, "wal_3")).toBeNull();
    // Not read yet: nothing to link.
    expect(waitingRetirementOf([undefined], "wal_1")).toBeNull();
  });
});
