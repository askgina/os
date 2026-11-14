import type { WalletSummary } from "@askgina/os-api";
import type { WalletPolicy } from "@askgina/os-protocol";
import { describe, expect, it } from "vitest";
import { sweepDestinations } from "../src/lib/sweep.ts";

const ULID = "01jd000000000000000000000";
const AGENT_WALLET = `wal_${ULID}1` as const;
const TREASURY = `wal_${ULID}2` as const;
const AGENT_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TREASURY_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const PAYEE = "0x3333333333333333333333333333333333333333" as const;

function policy(recipients: WalletPolicy["recipients"]): WalletPolicy {
  return {
    v: 1,
    workspaceId: `ws_${ULID}3`,
    walletId: AGENT_WALLET,
    revision: 1,
    previousHash: null,
    chains: ["eip155:31337"],
    requesters: [],
    assets: [],
    recipients,
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: "1000000000000000" },
    approvals: { threshold: 1, ttlSeconds: 600 },
  };
}

const wallet = (
  id: typeof AGENT_WALLET | typeof TREASURY,
  recipients: WalletPolicy["recipients"] | null,
) => ({
  id,
  address: id === TREASURY ? TREASURY_ADDRESS : AGENT_ADDRESS,
  policy: recipients ? policy(recipients) : null,
});

const summary = (id: typeof AGENT_WALLET | typeof TREASURY): WalletSummary => ({
  id,
  kind: id === TREASURY ? "treasury" : "agent",
  label: id === TREASURY ? "Reserve" : "Agent wallet",
  address: id === TREASURY ? TREASURY_ADDRESS : AGENT_ADDRESS,
  agentId: null,
  policy: null,
  policyHash: null,
});

describe("where the wallet page offers to sweep", () => {
  it("offers the treasury, then the wallet's allowed recipients, and nothing else", () => {
    const destinations = sweepDestinations(
      wallet(AGENT_WALLET, { mode: "allowlist", addresses: [TREASURY_ADDRESS, PAYEE] }),
      { wallets: [summary(AGENT_WALLET), summary(TREASURY)] },
    );
    expect(destinations).toEqual([
      { address: TREASURY_ADDRESS, label: "Reserve", reason: "treasury" },
      { address: PAYEE, label: "Allowed recipient", reason: "allowlist" },
    ]);
  });

  it("offers no recipient when the limits let agents pay anyone: the signer would refuse it", () => {
    expect(
      sweepDestinations(wallet(AGENT_WALLET, { mode: "any" }), {
        wallets: [summary(AGENT_WALLET), summary(TREASURY)],
      }).map((destination) => destination.reason),
    ).toEqual(["treasury"]);
    expect(
      sweepDestinations(wallet(AGENT_WALLET, null), { wallets: [summary(AGENT_WALLET)] }),
    ).toEqual([]);
  });

  it("never offers the swept wallet itself, so the treasury cannot be swept to itself", () => {
    const destinations = sweepDestinations(
      wallet(TREASURY, { mode: "allowlist", addresses: [TREASURY_ADDRESS] }),
      { wallets: [summary(AGENT_WALLET), summary(TREASURY)] },
    );
    expect(destinations).toEqual([]);
  });
});
