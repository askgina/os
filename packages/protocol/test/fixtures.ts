import type {
  AddApproverEnvelope,
  ApproveIntentEnvelope,
  CancelTransactionEnvelope,
  DeleteWorkspaceEnvelope,
  Envelope,
  EvmIntent,
  GrantMandateEnvelope,
  HyperliquidRules,
  JsonValue,
  Mandate,
  MandateAssetLimit,
  RemoveApproverEnvelope,
  ResumeWorkspaceEnvelope,
  RetireWalletEnvelope,
  SetAdminThresholdEnvelope,
  SetPolicyEnvelope,
  Sweep,
  SweepWalletEnvelope,
  VenueIntent,
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

export const MANDATE = `mnd_${ULID}6` as const;

/** The approval whose transaction the fixture cancel targets. */
export const TARGET_APPROVAL = `apr_${ULID}e` as const;

/** A second wallet of the workspace, listed by the fixture deletion after `WALLET`. */
export const OTHER_WALLET = `wal_${ULID}g` as const;

export const ALICE = "0x1111111111111111111111111111111111111111" as const;

export const BOB = "0x2222222222222222222222222222222222222222" as const;

export const TOKEN = "0x3333333333333333333333333333333333333333" as const;

export const ROUTER = "0x4444444444444444444444444444444444444444" as const;

/** The addresses of `WALLET` and `OTHER_WALLET`, as a retire or delete envelope names them. */
export const WALLET_ADDRESS = "0x5555555555555555555555555555555555555555" as const;

export const OTHER_WALLET_ADDRESS = "0x7777777777777777777777777777777777777777" as const;

/** USDC on Base, the asset of the fixture mandate. */
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

export const BASE = "eip155:8453" as const;

export const MAINNET = "eip155:1" as const;

export const HL_TESTNET = "hyperliquid:testnet" as const;

/** The asset index the fixture venue rules bind to `BTC`. */
export const BTC_ASSET = 3;

export const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

export const DIGEST_A = "a".repeat(64);

export const DIGEST_B = "b".repeat(64);

export const T0 = 1_700_000_000;

export function intent(overrides: Partial<EvmIntent> = {}): EvmIntent {
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

/** Buy 0.01 BTC perpetual at a limit of 65,000 USD, immediate or cancel: 650 USD notional. */
export function venueIntent(overrides: Partial<VenueIntent> = {}): VenueIntent {
  return {
    v: 1,
    id: INTENT,
    workspaceId: WS,
    agentId: AGENT,
    walletId: WALLET,
    chainId: HL_TESTNET,
    operation: {
      type: "hyperliquid.order",
      asset: BTC_ASSET,
      isBuy: true,
      size: "0.01",
      limitPx: "65000",
      tif: "Ioc",
      reduceOnly: false,
    },
    memo: "the funding rate turned",
    createdAt: T0,
    ...overrides,
  };
}

export function hyperliquidRules(overrides: Partial<HyperliquidRules> = {}): HyperliquidRules {
  return {
    network: HL_TESTNET,
    markets: [
      { asset: BTC_ASSET, coin: "BTC", maxNotionalPerOrderUsd6: "1000000000" },
      { asset: 4, coin: "ETH", maxNotionalPerOrderUsd6: "500000000" },
    ],
    maxNotionalPerDayUsd6: "2000000000",
    timeInForce: ["Gtc", "Ioc"],
    submitWindowSeconds: 60,
    withdrawals: true,
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

export const sweep = (o: Partial<Sweep> = {}): Sweep => ({
  v: 1,
  workspaceId: WS,
  walletId: WALLET,
  chainId: BASE,
  asset: "native",
  amount: "250000000000000000",
  to: ALICE,
  maxFeeWei: "1000000000000000",
  ...o,
});

export const sweepWallet = (o: Partial<SweepWalletEnvelope> = {}): SweepWalletEnvelope => ({
  ...header,
  type: "sweep-wallet",
  walletId: WALLET,
  chainId: BASE,
  sweepHash: DIGEST_A,
  ...o,
});

/**
 * The fixture mandate of `specs/approval-mandates.md` (Artifacts and Notes): USDC in base units,
 * 100 per payment, 500 in any 24 hours, 1,000 in total, 20 payments, three recipients, for
 * 604000 seconds.
 */
export const mandate = (o: Partial<Mandate> = {}): Mandate => ({
  v: 1,
  id: MANDATE,
  workspaceId: WS,
  walletId: WALLET,
  agentId: AGENT,
  assets: [mandateAsset()],
  windowSeconds: 86_400,
  recipients: [ALICE, BOB, TOKEN],
  maxUses: 20,
  maxFeePerActionWei: "2000000000000000",
  notBefore: T0,
  notAfter: T0 + 604_000,
  purpose: "pay supplier invoices this week",
  ...o,
});

/** The fixture mandate's one asset limit. */
export const mandateAsset = (o: Partial<MandateAssetLimit> = {}): MandateAssetLimit => ({
  chainId: BASE,
  asset: USDC_BASE,
  maxPerAction: "100000000",
  maxPerWindow: "500000000",
  maxTotal: "1000000000",
  ...o,
});

export const grantMandate = (o: Partial<GrantMandateEnvelope> = {}): GrantMandateEnvelope => ({
  ...header,
  type: "grant-mandate",
  mandateId: MANDATE,
  walletId: WALLET,
  agentId: AGENT,
  mandateHash: DIGEST_A,
  ...o,
});

export const cancelTransaction = (
  o: Partial<CancelTransactionEnvelope> = {},
): CancelTransactionEnvelope => ({
  ...header,
  type: "cancel-transaction",
  targetApprovalId: TARGET_APPROVAL,
  walletId: WALLET,
  chainId: BASE,
  txNonce: 7,
  maxFeeWei: "2000000000000000",
  ...o,
});

/** Seven days, the default shortest destroy delay. */
export const DESTROY_DELAY = 604_800;

export const retireWallet = (o: Partial<RetireWalletEnvelope> = {}): RetireWalletEnvelope => ({
  ...header,
  type: "retire-wallet",
  wallet: { walletId: WALLET, address: WALLET_ADDRESS },
  destroyAfter: T0 + DESTROY_DELAY,
  ...o,
});

export const deleteWorkspace = (
  o: Partial<DeleteWorkspaceEnvelope> = {},
): DeleteWorkspaceEnvelope => ({
  ...header,
  type: "delete-workspace",
  wallets: [
    { walletId: WALLET, address: WALLET_ADDRESS },
    { walletId: OTHER_WALLET, address: OTHER_WALLET_ADDRESS },
  ],
  destroyAfter: T0 + DESTROY_DELAY,
  ...o,
});

/**
 * For every field of every envelope type, a replacement value that is still valid. Each entry is
 * one way a compromised control plane could try to reuse an approval for something else.
 */
const headerChanges = {
  v: undefined,
  approvalId: `apr_${ULID}a`,
  workspaceId: `ws_${ULID}b`,
  nonce: "BAAAAAAAAAAAAAAAAAAAAA",
  issuedAt: T0 + 1,
  expiresAt: T0 + 601,
} satisfies Record<string, JsonValue | undefined>;

export const envelopeVariants: {
  name: string;
  base: Envelope;
  /** A replacement per field; `undefined` lists a field that gets no variant. */
  changes: Record<string, JsonValue | undefined>;
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
  {
    name: "sweep-wallet",
    base: sweepWallet(),
    changes: {
      ...headerChanges,
      walletId: `wal_${ULID}c`,
      chainId: MAINNET,
      sweepHash: DIGEST_B,
    },
  },
  {
    name: "grant-mandate",
    base: grantMandate(),
    changes: {
      ...headerChanges,
      mandateId: `mnd_${ULID}d`,
      walletId: `wal_${ULID}c`,
      agentId: OTHER_AGENT,
      mandateHash: DIGEST_B,
    },
  },
  {
    name: "cancel-transaction",
    base: cancelTransaction(),
    changes: {
      ...headerChanges,
      targetApprovalId: `apr_${ULID}f`,
      walletId: `wal_${ULID}c`,
      chainId: MAINNET,
      txNonce: 8,
      maxFeeWei: "2000000000000001",
    },
  },
  {
    name: "retire-wallet",
    base: retireWallet(),
    changes: {
      ...headerChanges,
      wallet: { walletId: OTHER_WALLET, address: WALLET_ADDRESS },
      destroyAfter: T0 + DESTROY_DELAY + 1,
    },
  },
  {
    name: "delete-workspace",
    base: deleteWorkspace(),
    changes: {
      ...headerChanges,
      wallets: [{ walletId: WALLET, address: WALLET_ADDRESS }],
      destroyAfter: T0 + DESTROY_DELAY + 1,
    },
  },
];

/** Every envelope field except `v` (only one protocol version exists) gets a variant. */
export function changedEnvelopes(
  variant: (typeof envelopeVariants)[number],
): { field: string; envelope: Envelope }[] {
  return Object.entries(variant.changes)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({
      field,
      // SAFETY: `field` is one of `base`'s own fields (the coverage tests compare the list with
      // `Object.keys(base)`), and each replacement is a valid value for that field, so the result
      // is still an envelope of `base`'s type.
      envelope: { ...variant.base, [field]: value } as Envelope,
    }));
}
