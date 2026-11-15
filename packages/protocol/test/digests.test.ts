import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  DomainTag,
  digestHex,
  envelopeChallenge,
  type Intent,
  intentHash,
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
  changedEnvelopes,
  envelopeVariants,
  INTENT,
  intent,
  MAINNET,
  OTHER_AGENT,
  policy,
  sweep,
  sweepWallet,
  T0,
  TOKEN,
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

  it("domain tags", () => {
    expect(DomainTag).toEqual({
      intent: "askgina.os/v1/intent",
      policy: "askgina.os/v1/policy",
      authorize: "askgina.os/v1/authorize",
      audit: "askgina.os/v1/audit",
      sweep: "askgina.os/v1/sweep",
      possession: "askgina.os/v1/possession",
    });
    expect(digestHex(DomainTag.intent, policy())).toBe(POLICY_UNDER_INTENT_TAG);
  });
});

describe("every sweep field is bound", () => {
  const changes: { [K in keyof Sweep]?: Sweep[K] } = {
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

describe("canonical form", () => {
  it("does not depend on key insertion order", () => {
    const reordered = Object.fromEntries(Object.entries(intent()).reverse()) as Intent;
    expect(intentHash(reordered)).toBe(INTENT_HASH);
  });

  it("refuses to hash values that are not valid intents or policies", () => {
    expect(() => intentHash({ ...intent(), extra: 1 } as Intent)).toThrow();
    expect(() => policyHash({ ...policy(), chains: [MAINNET, MAINNET] })).toThrow();
    expect(() => envelopeChallenge(approveIntent({ expiresAt: T0 }))).toThrow();
  });

  it("refuses values with no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("every intent field is bound", () => {
  const changes: Partial<Intent>[] = [
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
