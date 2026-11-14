import { IntentDetail, IntentStatus } from "@askgina/os-api";
import { describe, expect, it } from "vitest";
import { intentSentence, transactionSentence } from "../src/lib/statuses.ts";

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
});
