import type {
  AddApproverEnvelope,
  ApproveIntentEnvelope,
  Envelope,
  Intent,
  RemoveApproverEnvelope,
  ResumeWorkspaceEnvelope,
  SetAdminThresholdEnvelope,
  SetPolicyEnvelope,
  WalletPolicy,
} from "../src/index.ts";

// Fixed identifiers, so digests of the fixtures below are stable test vectors.
const ULID = "01jd000000000000000000000";
export const WS = `ws_${ULID}1` as const;
export const AGENT = `agt_${ULID}2` as const;
export const WALLET = `wal_${ULID}3` as const;
export const INTENT = `int_${ULID}4` as const;
export const APPROVAL = `apr_${ULID}5` as const;
export const USER_A = `usr_${ULID}6` as const;
export const USER_B = `usr_${ULID}7` as const;
export const USER_C = `usr_${ULID}8` as const;
export const OTHER_AGENT = `agt_${ULID}9` as const;

export const ALICE = "0x1111111111111111111111111111111111111111" as const;
export const BOB = "0x2222222222222222222222222222222222222222" as const;
export const TOKEN = "0x3333333333333333333333333333333333333333" as const;
export const ROUTER = "0x4444444444444444444444444444444444444444" as const;
export const BASE = "eip155:8453" as const;
export const MAINNET = "eip155:1" as const;
export const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);

export const T0 = 1_700_000_000;

export function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    v: 1,
    id: INTENT,
    workspaceId: WS,
    agentId: AGENT,
    walletId: WALLET,
    chainId: BASE,
    operation: { type: "evm.transfer", to: ALICE, valueWei: "250000000000000000" },
    maxFeeWei: "1000000000000000",
    memo: "pay invoice 42",
    createdAt: T0,
    ...overrides,
  };
}

export function policy(overrides: Partial<WalletPolicy> = {}): WalletPolicy {
  return {
    v: 1,
    workspaceId: WS,
    walletId: WALLET,
    revision: 1,
    previousHash: null,
    chains: [BASE],
    requesters: [AGENT],
    assets: [
      {
        chainId: BASE,
        asset: "native",
        maxPerTx: "1000000000000000000",
        maxPerDay: "5000000000000000000",
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: "10000000000000000" },
    approvals: { threshold: 1, ttlSeconds: 3600 },
    ...overrides,
  };
}

const header = {
  v: 1,
  approvalId: APPROVAL,
  workspaceId: WS,
  nonce: NONCE,
  issuedAt: T0,
  expiresAt: T0 + 600,
} as const;

export const approveIntent = (o: Partial<ApproveIntentEnvelope> = {}): ApproveIntentEnvelope => ({
  ...header,
  type: "approve-intent",
  intentHash: DIGEST_A,
  walletId: WALLET,
  agentId: AGENT,
  chainId: BASE,
  policyHash: DIGEST_B,
  ...o,
});

export const setPolicy = (o: Partial<SetPolicyEnvelope> = {}): SetPolicyEnvelope => ({
  ...header,
  type: "set-policy",
  walletId: WALLET,
  policyHash: DIGEST_A,
  previousPolicyHash: null,
  ...o,
});

export const addApprover = (o: Partial<AddApproverEnvelope> = {}): AddApproverEnvelope => ({
  ...header,
  type: "add-approver",
  userId: USER_B,
  credentialId: "Y3JlZC1i",
  publicKey: "cHVibGljLWtleQ",
  ...o,
});

export const removeApprover = (
  o: Partial<RemoveApproverEnvelope> = {},
): RemoveApproverEnvelope => ({
  ...header,
  type: "remove-approver",
  userId: USER_B,
  credentialId: "Y3JlZC1i",
  ...o,
});

export const setAdminThreshold = (
  o: Partial<SetAdminThresholdEnvelope> = {},
): SetAdminThresholdEnvelope => ({
  ...header,
  type: "set-admin-threshold",
  adminThreshold: 2,
  ...o,
});

export const resumeWorkspace = (
  o: Partial<ResumeWorkspaceEnvelope> = {},
): ResumeWorkspaceEnvelope => ({ ...header, type: "resume-workspace", ...o });

/**
 * For every field of every envelope type, a replacement value that is still valid. Each entry is
 * one way a compromised control plane could try to reuse an approval for something else.
 */
const headerChanges: Record<string, unknown> = {
  v: undefined,
  approvalId: `apr_${ULID}a`,
  workspaceId: `ws_${ULID}b`,
  nonce: "BAAAAAAAAAAAAAAAAAAAAA",
  issuedAt: T0 + 1,
  expiresAt: T0 + 601,
};

export const envelopeVariants: {
  name: string;
  base: Envelope;
  changes: Record<string, unknown>;
}[] = [
  {
    name: "approve-intent",
    base: approveIntent(),
    changes: {
      ...headerChanges,
      intentHash: DIGEST_B,
      walletId: `wal_${ULID}c`,
      agentId: OTHER_AGENT,
      chainId: MAINNET,
      policyHash: DIGEST_A,
    },
  },
  {
    name: "set-policy",
    base: setPolicy(),
    changes: {
      ...headerChanges,
      walletId: `wal_${ULID}c`,
      policyHash: DIGEST_B,
      previousPolicyHash: DIGEST_B,
    },
  },
  {
    name: "add-approver",
    base: addApprover(),
    changes: {
      ...headerChanges,
      userId: USER_C,
      credentialId: "Y3JlZC1j",
      publicKey: "b3RoZXIta2V5",
    },
  },
  {
    name: "remove-approver",
    base: removeApprover(),
    changes: { ...headerChanges, userId: USER_C, credentialId: "Y3JlZC1j" },
  },
  {
    name: "set-admin-threshold",
    base: setAdminThreshold(),
    changes: { ...headerChanges, adminThreshold: 3 },
  },
  { name: "resume-workspace", base: resumeWorkspace(), changes: { ...headerChanges } },
];

/** Every envelope field except `v` (only one protocol version exists) gets a variant. */
export function changedEnvelopes(
  variant: (typeof envelopeVariants)[number],
): { field: string; envelope: Envelope }[] {
  return Object.entries(variant.changes)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({
      field,
      envelope: { ...variant.base, [field]: value } as Envelope,
    }));
}
