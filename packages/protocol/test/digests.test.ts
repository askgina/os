import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  DomainTag,
  digestHex,
  type EvmIntent,
  envelopeChallenge,
  intentHash,
  type Mandate,
  mandateHash,
  mandateUseDigest,
  normalizeMandate,
  policyHash,
  possessionChallenge,
  type Sweep,
  sweepHash,
} from "../src/index.ts";
import {
  AGENT,
  ALICE,
  APPROVAL,
  approveIntent,
  BOB,
  cancelTransaction,
  changedEnvelopes,
  envelopeVariants,
  grantMandate,
  HL_TESTNET,
  hyperliquidRules,
  INTENT,
  intent,
  MAINNET,
  MANDATE,
  mandate,
  mandateAsset,
  OTHER_AGENT,
  policy,
  sweep,
  sweepWallet,
  T0,
  TARGET_APPROVAL,
  TOKEN,
  venueIntent,
  WALLET,
  WS,
} from "./fixtures.ts";

// The canonical JSON below was written out by hand from RFC 8785 (keys in code-unit order, no
// whitespace) and the expected digests were computed outside this code with
//   printf '%s\n%s' "<tag>" "<json>" | openssl dgst -sha256
// If any of these fail, every existing approval and policy hash in the field changes meaning.
const INTENT_JSON = `{"agentId":"${AGENT}","chainId":"eip155:8453","createdAt":1700000000,"id":"${INTENT}","maxFeeWei":"1000000000000000","memo":"pay invoice 42","operation":{"to":"${ALICE}","type":"evm.transfer","valueWei":"250000000000000000"},"v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const INTENT_HASH = "52d1822482a0fe3dc28883d06413ec38fe1efe50aba28c51167af733e24f9da3";

const POLICY_JSON = `{"approvals":{"threshold":1,"ttlSeconds":3600},"assets":[{"asset":"native","chainId":"eip155:8453","maxPerDay":"5000000000000000000","maxPerTx":"1000000000000000000"}],"chains":["eip155:8453"],"contractCalls":{"mode":"deny"},"fees":{"maxPerTxWei":"10000000000000000"},"previousHash":null,"recipients":{"mode":"any"},"requesters":["${AGENT}"],"revision":1,"v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const POLICY_HASH = "968a11eb9c37f06f745249bfc4a94d48b8aa8b4ed6a3ebbc7673b888970668b5";

const ENVELOPE_JSON = `{"agentId":"${AGENT}","approvalId":"${APPROVAL}","chainId":"eip155:8453","expiresAt":1700000600,"intentHash":"${INTENT_HASH}","issuedAt":1700000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","policyHash":"${POLICY_HASH}","type":"approve-intent","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const ENVELOPE_CHALLENGE = "SoAiEpNpEeP2ex9Y_3B7aWINGGXHZFbp3OvzZU6dC80";

// The policy JSON hashed under the intent tag, to show tags separate otherwise equal inputs.
const POLICY_UNDER_INTENT_TAG = "e690d76b4c9e3a0bb2a01f86834fb4923cbb7b8645ae192d4611455bb756b3c4";

// Added with the `sweep-wallet` envelope. The vectors above did not change.
const SWEEP_JSON = `{"amount":"250000000000000000","asset":"native","chainId":"eip155:8453","maxFeeWei":"1000000000000000","to":"${ALICE}","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const SWEEP_HASH = "aa3f2f4c50ee481b88aaf98c610125b769c5508ab8d6bac13f731c50bccad674";

const SWEEP_ENVELOPE_JSON = `{"approvalId":"${APPROVAL}","chainId":"eip155:8453","expiresAt":1700000600,"issuedAt":1700000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","sweepHash":"${SWEEP_HASH}","type":"sweep-wallet","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const SWEEP_ENVELOPE_CHALLENGE = "lgZRKMxucwdO2AFLyWBfmAc4oANInAkJObl_azLac0Q";

// Added with the possession step of an approver change. The vectors above did not change.
const POSSESSION = {
  approvalId: APPROVAL,
  credentialId: "Y3JlZC1h",
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
} as const;

const POSSESSION_JSON = `{"approvalId":"${APPROVAL}","credentialId":"Y3JlZC1h","nonce":"AAAAAAAAAAAAAAAAAAAAAA","v":1}`;

const POSSESSION_CHALLENGE = "7voVoMiWeZwDat_WCB8R-xOqaIfjygPAYO7xmCsm8ec";

// Added with mandates. The vectors above did not change.
const MANDATE_JSON = `{"agentId":"${AGENT}","assets":[{"asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","chainId":"eip155:8453","maxPerAction":"100000000","maxPerWindow":"500000000","maxTotal":"1000000000"}],"id":"${MANDATE}","maxFeePerActionWei":"2000000000000000","maxUses":20,"notAfter":1700604000,"notBefore":1700000000,"purpose":"pay supplier invoices this week","recipients":["${ALICE}","${BOB}","${TOKEN}"],"v":1,"walletId":"${WALLET}","windowSeconds":86400,"workspaceId":"${WS}"}`;

const MANDATE_HASH = "368a65426f5e33c8fa92c281a9a2d600328b39635fea2d60e67400c5cb65d7d4";

const GRANT_MANDATE_JSON = `{"agentId":"${AGENT}","approvalId":"${APPROVAL}","expiresAt":1700000600,"issuedAt":1700000000,"mandateHash":"${MANDATE_HASH}","mandateId":"${MANDATE}","nonce":"AAAAAAAAAAAAAAAAAAAAAA","type":"grant-mandate","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const GRANT_MANDATE_CHALLENGE = "TjkhTXhNOAPy5fq2YK8479_qPLBCg1DFmvX1g0zX55c";

const MANDATE_USE_JSON = `{"approvalId":"${APPROVAL}","intentHash":"${INTENT_HASH}","mandateId":"${MANDATE}","v":1}`;

const MANDATE_USE_DIGEST = "96fe14af43d24b9388d45b9f7a478c48a1d37c944056f9b5319ddad6bd990cd7";

// Added with the `cancel-transaction` envelope. The vectors above did not change.
const CANCEL_ENVELOPE_JSON = `{"approvalId":"${APPROVAL}","chainId":"eip155:8453","expiresAt":1700000600,"issuedAt":1700000000,"maxFeeWei":"2000000000000000","nonce":"AAAAAAAAAAAAAAAAAAAAAA","targetApprovalId":"${TARGET_APPROVAL}","txNonce":7,"type":"cancel-transaction","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const CANCEL_ENVELOPE_CHALLENGE = "FYp0khasgxD2rQxW3vUf47xd5PbsXrKOGUXaK1L_2ro";

// Added with venue intents, by widening `Intent` and `WalletPolicy` within version 1. The vectors
// above did not change.
const VENUE_INTENT_JSON = `{"agentId":"${AGENT}","chainId":"hyperliquid:testnet","createdAt":1700000000,"id":"${INTENT}","memo":"the funding rate turned","operation":{"asset":3,"isBuy":true,"limitPx":"65000","reduceOnly":false,"size":"0.01","tif":"Ioc","type":"hyperliquid.order"},"v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const VENUE_INTENT_HASH = "63bde93a4524d11d4c53e02ecec81f9e791b3aaf54fb079369255f476edc8afd";

const VENUE_POLICY_JSON = `{"approvals":{"threshold":1,"ttlSeconds":3600},"assets":[{"asset":"native","chainId":"eip155:8453","maxPerDay":"5000000000000000000","maxPerTx":"1000000000000000000"}],"chains":["eip155:8453"],"contractCalls":{"mode":"deny"},"fees":{"maxPerTxWei":"10000000000000000"},"previousHash":null,"recipients":{"mode":"any"},"requesters":["${AGENT}"],"revision":1,"v":1,"venues":{"hyperliquid":{"markets":[{"asset":3,"coin":"BTC","maxNotionalPerOrderUsd6":"1000000000"},{"asset":4,"coin":"ETH","maxNotionalPerOrderUsd6":"500000000"}],"maxNotionalPerDayUsd6":"2000000000","network":"hyperliquid:testnet","submitWindowSeconds":60,"timeInForce":["Gtc","Ioc"],"withdrawals":true}},"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const VENUE_POLICY_HASH = "874aa65f8d6cd314029f14ad0f3c232a2ed00ef7428b901fc35f20266d6a2241";

const VENUE_ENVELOPE_JSON = `{"agentId":"${AGENT}","approvalId":"${APPROVAL}","chainId":"hyperliquid:testnet","expiresAt":1700000600,"intentHash":"${VENUE_INTENT_HASH}","issuedAt":1700000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","policyHash":"${VENUE_POLICY_HASH}","type":"approve-intent","v":1,"walletId":"${WALLET}","workspaceId":"${WS}"}`;

const VENUE_ENVELOPE_CHALLENGE = "4lbDbs7a1SSdmNuM3linOaNBTSVRK1HCVDYIPl0NhjY";

describe("pinned digest vectors", () => {
  it("intentHash", () => {
    expect(canonicalJson(intent())).toBe(INTENT_JSON);
    expect(intentHash(intent())).toBe(INTENT_HASH);
  });

  it("policyHash", () => {
    expect(canonicalJson(policy())).toBe(POLICY_JSON);
    expect(policyHash(policy())).toBe(POLICY_HASH);
  });

  it("envelopeChallenge", () => {
    const envelope = approveIntent({ intentHash: INTENT_HASH, policyHash: POLICY_HASH });
    expect(canonicalJson(envelope)).toBe(ENVELOPE_JSON);
    expect(Buffer.from(envelopeChallenge(envelope)).toString("base64url")).toBe(ENVELOPE_CHALLENGE);
  });

  it("a venue order intent, a policy with venue rules, and their approve-intent envelope", () => {
    expect(canonicalJson(venueIntent())).toBe(VENUE_INTENT_JSON);
    expect(intentHash(venueIntent())).toBe(VENUE_INTENT_HASH);
    const withVenues = policy({ venues: { hyperliquid: hyperliquidRules() } });
    expect(canonicalJson(withVenues)).toBe(VENUE_POLICY_JSON);
    expect(policyHash(withVenues)).toBe(VENUE_POLICY_HASH);

    const envelope = approveIntent({
      chainId: HL_TESTNET,
      intentHash: VENUE_INTENT_HASH,
      policyHash: VENUE_POLICY_HASH,
    });

    expect(canonicalJson(envelope)).toBe(VENUE_ENVELOPE_JSON);
    expect(Buffer.from(envelopeChallenge(envelope)).toString("base64url")).toBe(
      VENUE_ENVELOPE_CHALLENGE,
    );
  });

  it("a policy without venue rules hashes as it did before they existed", () => {
    const { venues: _none, ...withoutVenues } = policy({
      venues: { hyperliquid: hyperliquidRules() },
    });

    expect(policyHash(withoutVenues)).toBe(POLICY_HASH);
    expect(canonicalJson(policy())).not.toContain("venues");
  });

  it("sweepHash and the sweep-wallet envelope's challenge", () => {
    expect(canonicalJson(sweep())).toBe(SWEEP_JSON);
    expect(sweepHash(sweep())).toBe(SWEEP_HASH);
    const envelope = sweepWallet({ sweepHash: SWEEP_HASH });
    expect(canonicalJson(envelope)).toBe(SWEEP_ENVELOPE_JSON);
    expect(Buffer.from(envelopeChallenge(envelope)).toString("base64url")).toBe(
      SWEEP_ENVELOPE_CHALLENGE,
    );
  });

  it("possessionChallenge", () => {
    expect(canonicalJson({ v: 1, ...POSSESSION })).toBe(POSSESSION_JSON);
    expect(Buffer.from(possessionChallenge(POSSESSION)).toString("base64url")).toBe(
      POSSESSION_CHALLENGE,
    );

    // Every field is bound, and a malformed one is refused rather than hashed.
    for (const change of [
      { approvalId: "apr_01jd000000000000000000000z" as const },
      { credentialId: "Y3JlZC1i" },
      { nonce: "AAAAAAAAAAAAAAAAAAAAAQ" },
    ]) {
      expect(
        Buffer.from(possessionChallenge({ ...POSSESSION, ...change })).toString("base64url"),
      ).not.toBe(POSSESSION_CHALLENGE);
    }

    expect(() => possessionChallenge({ ...POSSESSION, nonce: "short" })).toThrow();
  });

  it("mandateHash and the grant-mandate envelope's challenge", () => {
    expect(canonicalJson(mandate())).toBe(MANDATE_JSON);
    expect(mandateHash(mandate())).toBe(MANDATE_HASH);
    const envelope = grantMandate({ mandateHash: MANDATE_HASH });
    expect(canonicalJson(envelope)).toBe(GRANT_MANDATE_JSON);
    expect(Buffer.from(envelopeChallenge(envelope)).toString("base64url")).toBe(
      GRANT_MANDATE_CHALLENGE,
    );
  });

  it("mandateUseDigest", () => {
    const use = { approvalId: APPROVAL, mandateId: MANDATE, intentHash: INTENT_HASH };
    expect(canonicalJson({ v: 1, ...use })).toBe(MANDATE_USE_JSON);
    expect(mandateUseDigest(use)).toBe(MANDATE_USE_DIGEST);

    for (const change of [
      { approvalId: "apr_01jd000000000000000000000z" as const },
      { mandateId: "mnd_01jd000000000000000000000z" as const },
      { intentHash: POLICY_HASH },
    ]) {
      expect(mandateUseDigest({ ...use, ...change })).not.toBe(MANDATE_USE_DIGEST);
    }

    expect(() => mandateUseDigest({ ...use, intentHash: "short" })).toThrow();
    // The same three identifiers under the envelope tag are not a use, and the reverse.
    expect(digestHex(DomainTag.authorize, { v: 1, ...use })).not.toBe(MANDATE_USE_DIGEST);
  });

  it("the cancel-transaction challenge matches its vector", () => {
    expect(canonicalJson(cancelTransaction())).toBe(CANCEL_ENVELOPE_JSON);
    expect(Buffer.from(envelopeChallenge(cancelTransaction())).toString("base64url")).toBe(
      CANCEL_ENVELOPE_CHALLENGE,
    );
  });

  it("domain tags", () => {
    expect(DomainTag).toEqual({
      intent: "askgina.os/v1/intent",
      policy: "askgina.os/v1/policy",
      authorize: "askgina.os/v1/authorize",
      audit: "askgina.os/v1/audit",
      sweep: "askgina.os/v1/sweep",
      possession: "askgina.os/v1/possession",
      mandate: "askgina.os/v1/mandate",
      mandateUse: "askgina.os/v1/mandate-use",
    });
    expect(digestHex(DomainTag.intent, policy())).toBe(POLICY_UNDER_INTENT_TAG);
  });
});

describe("every sweep field is bound", () => {
  const changes: Partial<Sweep> = {
    workspaceId: `ws_01jd000000000000000000000b`,
    walletId: `wal_01jd000000000000000000000c`,
    chainId: MAINNET,
    asset: TOKEN,
    amount: "250000000000000001",
    to: BOB,
    maxFeeWei: "1000000000000001",
  };

  it.each(Object.entries(changes))("%s", (field, value) => {
    expect(sweepHash({ ...sweep(), [field]: value })).not.toBe(sweepHash(sweep()));
  });
  it("covers every field except the version", () => {
    expect(Object.keys(changes).sort()).toEqual(
      Object.keys(sweep())
        .filter((key) => key !== "v")
        .sort(),
    );
  });
});

describe("every mandate field is bound", () => {
  const changes: Partial<Mandate> = {
    id: `mnd_01jd000000000000000000000z`,
    workspaceId: `ws_01jd000000000000000000000b`,
    walletId: `wal_01jd000000000000000000000c`,
    agentId: OTHER_AGENT,
    assets: [mandateAsset({ maxTotal: "1000000001" })],
    windowSeconds: 86_401,
    recipients: [ALICE, BOB],
    maxUses: 21,
    maxFeePerActionWei: "2000000000000001",
    notBefore: T0 + 1,
    notAfter: T0 + 604_001,
    purpose: "pay supplier invoices next week",
  };

  it.each(Object.entries(changes))("%s", (field, value) => {
    expect(mandateHash({ ...mandate(), [field]: value })).not.toBe(MANDATE_HASH);
  });
  it("covers every field except the version", () => {
    expect(Object.keys(changes).sort()).toEqual(
      Object.keys(mandate())
        .filter((key) => key !== "v")
        .sort(),
    );
  });
  it.each([
    ["chainId", { chainId: MAINNET }],
    ["asset", { asset: TOKEN }],
    ["maxPerAction", { maxPerAction: "100000001" }],
    ["maxPerWindow", { maxPerWindow: "500000001" }],
    ["maxTotal", { maxTotal: "1000000001" }],
  ] as const)("asset %s", (_field, change) => {
    expect(mandateHash(mandate({ assets: [mandateAsset(change)] }))).not.toBe(MANDATE_HASH);
  });
  it("is stable under normalizeMandate", () => {
    const shuffled = mandate({ recipients: [TOKEN, ALICE, BOB, ALICE] });
    expect(mandateHash(normalizeMandate(shuffled))).toBe(MANDATE_HASH);
    expect(normalizeMandate(mandate())).toEqual(mandate());
  });
});

describe("canonical form", () => {
  it("does not depend on key insertion order", () => {
    // SAFETY: the entries are exactly intent()'s own, only in reverse order, so the rebuilt object
    // has an EvmIntent's keys and values.
    const reordered = Object.fromEntries(Object.entries(intent()).reverse()) as EvmIntent;
    expect(intentHash(reordered)).toBe(INTENT_HASH);
  });

  it("refuses to hash values that are not valid intents or policies", () => {
    const withExtraKey = { ...intent(), extra: 1 };
    const venueWithFee = { ...venueIntent(), maxFeeWei: "1" };
    expect(() => intentHash(withExtraKey)).toThrow();
    expect(() => intentHash(venueWithFee)).toThrow();
    expect(() => policyHash({ ...policy(), chains: [MAINNET, MAINNET] })).toThrow();
    expect(() => envelopeChallenge(approveIntent({ expiresAt: T0 }))).toThrow();
  });

  it("refuses values with no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("every intent field is bound", () => {
  const changes: Partial<EvmIntent>[] = [
    { id: `int_01jd000000000000000000000z` },
    { workspaceId: `ws_01jd000000000000000000000z` },
    { agentId: OTHER_AGENT },
    { walletId: `wal_01jd000000000000000000000z` },
    { chainId: MAINNET },
    { operation: { type: "evm.transfer", to: BOB, valueWei: "250000000000000000" } },
    { operation: { type: "evm.transfer", to: ALICE, valueWei: "250000000000000001" } },
    {
      operation: {
        type: "evm.erc20.transfer",
        token: TOKEN,
        to: ALICE,
        amount: "250000000000000000",
      },
    },
    {
      operation: {
        type: "evm.call",
        to: ALICE,
        valueWei: "250000000000000000",
        data: "0xa9059cbb",
      },
    },
    { maxFeeWei: "1000000000000001" },
    { memo: "pay invoice 43" },
    { createdAt: T0 + 1 },
  ];

  it.each(changes.map((change) => [Object.keys(change)[0], change] as const))(
    "%s",
    (_field, change) => {
      expect(intentHash(intent(change))).not.toBe(INTENT_HASH);
    },
  );

  it("covers every top-level field except the version", () => {
    const covered = new Set(changes.flatMap((change) => Object.keys(change)));
    expect([...covered].sort()).toEqual(
      Object.keys(intent())
        .filter((key) => key !== "v")
        .sort(),
    );
  });
});

describe("every venue order field is bound", () => {
  const order = venueIntent().operation;

  if (order.type !== "hyperliquid.order") throw new TypeError("the fixture is an order");
  it.each([
    ["chainId", { chainId: "hyperliquid:mainnet" }],
    ["memo", { memo: "the funding rate turned again" }],
    ["asset", { operation: { ...order, asset: 4 } }],
    ["isBuy", { operation: { ...order, isBuy: false } }],
    ["size", { operation: { ...order, size: "0.011" } }],
    ["limitPx", { operation: { ...order, limitPx: "65001" } }],
    ["tif", { operation: { ...order, tif: "Gtc" } }],
    ["reduceOnly", { operation: { ...order, reduceOnly: true } }],
    ["withdraw", { operation: { type: "hyperliquid.withdraw", amount: "0.01" } }],
  ] as const)("%s", (_field, change) => {
    expect(intentHash(venueIntent(change))).not.toBe(VENUE_INTENT_HASH);
  });
});

describe("every envelope field is bound", () => {
  for (const variant of envelopeVariants) {
    describe(variant.name, () => {
      const base = Buffer.from(envelopeChallenge(variant.base)).toString("hex");
      it.each(changedEnvelopes(variant).map((c) => [c.field, c.envelope] as const))(
        "%s",
        (_field, envelope) => {
          expect(Buffer.from(envelopeChallenge(envelope)).toString("hex")).not.toBe(base);
        },
      );
      it("covers every field except the version and type", () => {
        expect(
          changedEnvelopes(variant)
            .map((c) => c.field)
            .sort(),
        ).toEqual(
          Object.keys(variant.base)
            .filter((key) => key !== "v" && key !== "type")
            .sort(),
        );
      });
    });
  }

  it("no two envelope types share a challenge", () => {
    const challenges = envelopeVariants.map((v) =>
      Buffer.from(envelopeChallenge(v.base)).toString("hex"),
    );

    expect(new Set(challenges).size).toBe(envelopeVariants.length);
  });
});

describe("domain separation", () => {
  it("the same structure under each tag gives a different digest", () => {
    const value = { a: 1 };
    const digests = Object.values(DomainTag).map((tag) => digestHex(tag, value));
    expect(new Set(digests).size).toBe(digests.length);
  });
});
