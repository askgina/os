import { IntentDetail, IntentStatus, StuckReason } from "@askgina/os-api";
import { describe, expect, it } from "vitest";
import { intentSentence, stuckReasonSentence, transactionSentence } from "../src/lib/statuses.ts";

const transactionStatuses = IntentDetail.shape.transaction.unwrap().shape.status.options;

describe("status sentences", () => {
  it.each(IntentStatus.options)("intent status %s reads as a sentence, not a code", (status) => {
    const sentence = intentSentence[status];
    expect(sentence).toMatch(/^[A-Z].+\.$/);
    expect(sentence.split(" ").length).toBeGreaterThan(5);
  });

  it.each(transactionStatuses)("transaction status %s reads as a sentence", (status) => {
    expect(transactionSentence[status]).toMatch(/^[A-Z].+\.$/);
    expect(transactionSentence[status].split(" ").length).toBeGreaterThan(3);
  });

  it("warns that a stuck payment may still land and holds back later ones", () => {
    expect(transactionSentence.stuck).toMatch(/may still be included/);
    expect(transactionSentence.stuck).toMatch(
      /Later payments from this wallet on this network wait/,
    );
  });

  it("says a rejected transaction will not be sent again", () => {
    expect(transactionSentence.rejected).toMatch(/never accepted/);
    expect(transactionSentence.rejected).toMatch(/will not be sent again/);
  });

  it("says a cancelled payment moved nothing but paid a fee", () => {
    expect(intentSentence.voided).toMatch(/Nothing moved; a network fee was paid\./);
    expect(transactionSentence.cancelled).toMatch(/Nothing moved/);
    expect(transactionSentence.superseded).toMatch(/can never be included/);
  });
});

describe("why a transaction is not mined yet", () => {
  it.each(StuckReason.options)("%s reads as sentences, not a code", (reason) => {
    const sentence = stuckReasonSentence[reason];
    expect(sentence).toMatch(/^[A-Z].+\.$/);
    expect(sentence).not.toContain(reason);
    expect(sentence.split(" ").length).toBeGreaterThan(10);
  });

  it("offers a higher fee only when the fee is the reason", () => {
    expect(stuckReasonSentence.fee_too_low).toMatch(/Speeding it up offers a higher one/);
    expect(stuckReasonSentence.waiting_behind_nonce).toMatch(/A higher fee here would not help\./);
  });

  it.each([
    "workspace_paused",
    "fee_ceiling_reached",
    "reprice_window_closed",
    "reprice_refused",
  ] as const)("%s still leaves the cancel", (reason) => {
    expect(stuckReasonSentence[reason]).toMatch(/It can still be cancelled\.$/);
  });

  it("says when neither a speed-up nor a cancel is left", () => {
    expect(stuckReasonSentence.attempts_exhausted).toMatch(/neither sped up nor cancelled/);
  });
});
