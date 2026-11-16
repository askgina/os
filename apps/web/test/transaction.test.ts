import { ApiError, TransactionAttemptView, TransactionInfo } from "@askgina/os-api";
import { describe, expect, it } from "vitest";
import { explainCancelError, explainCode, explainSpeedUpError } from "../src/lib/codes.ts";
import {
  attemptFeeCeiling,
  attemptKindLabel,
  attemptStatusLabel,
  formatGwei,
  paymentTitle,
  transactionActions,
  transactionOpen,
} from "../src/lib/transaction.ts";

const RECIPIENT = "0x52908400098527886e0f7030069857d2e4169ee7";

describe("attempts in words", () => {
  it.each(TransactionAttemptView.shape.kind.options)("kind %s has a label", (kind) => {
    expect(attemptKindLabel[kind]).toMatch(/^[A-Z]/);
  });

  it.each(TransactionAttemptView.shape.status.options)("status %s has a label", (status) => {
    expect(attemptStatusLabel[status]).toMatch(/^[A-Z]/);
  });

  it("shows fees per gas in gwei, exactly", () => {
    expect(formatGwei("2240000000")).toBe("2.24 gwei");
    expect(formatGwei("1000000000")).toBe("1 gwei");
    expect(formatGwei("1")).toBe("0.000000001 gwei");
    expect(formatGwei("150000000000")).toBe("150 gwei");
  });

  it("takes the most an attempt can cost as its gas limit at its highest fee", () => {
    expect(attemptFeeCeiling({ gas: "21000", maxFeePerGas: "2240000000" })).toBe(
      47_040_000_000_000n,
    );
  });

  it("heads a payment and a contract call as their request's page does", () => {
    const transfer = {
      rawCall: false,
      amount: "15000000000000000",
      amountFormatted: "0.015",
      assetSymbol: "ETH",
      to: RECIPIENT,
    } as const;

    expect(paymentTitle(transfer)).toMatch(/^Send 0\.015 ETH to 0x5290…/);
    expect(paymentTitle({ ...transfer, rawCall: true, amount: "0" })).toMatch(
      /^Call contract 0x5290…[0-9a-fA-F]{4}$/,
    );
  });
});

describe("who may act on a sent transaction", () => {
  const both = { canSpeedUp: true, canCancel: true };

  it("lets owners and approvers do what the transaction allows", () => {
    expect(transactionActions(both, "owner")).toEqual({ speedUp: true, cancel: true });
    expect(transactionActions({ canSpeedUp: false, canCancel: true }, "approver")).toEqual({
      speedUp: false,
      cancel: true,
    });
  });

  it("gives a viewer no action, whatever the transaction allows", () => {
    expect(transactionActions(both, "viewer")).toEqual({ speedUp: false, cancel: false });
  });

  it.each(TransactionInfo.shape.status.options)("status %s is open only until final", (status) => {
    expect(transactionOpen(status)).toBe(
      status === "signed" || status === "broadcast" || status === "stuck",
    );
  });
});

describe("refusals in words", () => {
  it.each([
    "not_repriceable",
    "waiting_behind_nonce",
    "workspace_paused",
    "fee_ceiling_reached",
    "reprice_window_closed",
    "attempts_exhausted",
    "reprice_refused",
  ])("a speed-up refused with %s says why", (detail) => {
    const words = explainSpeedUpError(new ApiError("conflict", "conflict", 409, detail));
    expect(words).toMatch(/^[A-Z].+\.$/);
  });

  it("asks to try a speed-up again when the chain or the signer was out of reach", () => {
    expect(explainSpeedUpError(new ApiError("internal", "internal", 500, "retry_later"))).toMatch(
      /Try again in a moment\.$/,
    );
  });

  it("a paused workspace still lets a cancel through", () => {
    expect(
      explainSpeedUpError(new ApiError("conflict", "conflict", 409, "workspace_paused")),
    ).toMatch(/Cancelling still works\./);
  });

  it.each(["not_sent", "transaction_final", "attempts_exhausted", "fee_ceiling_reached"])(
    "a cancel refused with %s says why",
    (detail) => {
      const words = explainCancelError(new ApiError("conflict", "conflict", 409, detail));
      expect(words).toMatch(/^[A-Z].+\.$/);
    },
  );

  it("a cancel for a wallet without limits says so", () => {
    expect(
      explainCancelError(new ApiError("policy_denied", "denied", 403, "policy_missing")),
    ).toMatch(/no limits set/);
  });

  it("leaves other refusals to the API's own message", () => {
    expect(explainSpeedUpError(new ApiError("forbidden", "Only an owner…", 403))).toBeNull();
    expect(explainCancelError(new ApiError("conflict", "conflict", 409, "other"))).toBeNull();
    expect(explainCancelError(new Error("offline"))).toBeNull();
  });

  it.each(["transaction_cancelled", "cancel_too_late", "nonce_used_elsewhere"])(
    "the outcome %s has its own meaning",
    (code) => {
      expect(explainCode(code)).not.toBe(explainCode("an unknown code"));
    },
  );

  it("says a cancel that came too late let the payment through", () => {
    expect(explainCode("cancel_too_late")).toMatch(/included the payment first/);
  });
});
