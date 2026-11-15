import type { Intent, Mandate, WalletPolicy } from "@askgina/os-protocol";
import type {
  AgentSummary,
  ApprovalDetail,
  ApprovalSummary,
  AuditEvent,
  IntentDetail,
  IntentSummary,
  MandateDetail,
  MandateDraft,
  MandateSummary,
  Member,
  NotificationPreferences,
  PasskeySummary,
  PushSubscriptionInput,
  PushSubscriptionSummary,
  SessionInfo,
  WalletDetail,
  WalletSummary,
  WorkspaceDetail,
} from "../src/index.ts";

// Realistic values as the server would send them; one per DTO.
const ULID = "01jd000000000000000000000";
export const WS = `ws_${ULID}1` as const;
export const AGENT = `agt_${ULID}2` as const;
export const WALLET = `wal_${ULID}3` as const;
export const INTENT = `int_${ULID}4` as const;
export const APPROVAL = `apr_${ULID}5` as const;
export const USER = `usr_${ULID}6` as const;
export const MANDATE = `mnd_${ULID}7` as const;
export const SUBSCRIPTION = `psb_${ULID}8` as const;
const T0 = 1_700_000_000;
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const HASH = "c".repeat(64);
const TX = `0x${"d".repeat(64)}` as const;

export const user = { id: USER, displayName: "Ada" };

export const session: SessionInfo = {
  setupRequired: false,
  user,
  relyingParty: { id: "localhost", name: "askgina os" },
};

export const ceremony = { ceremonyId: "cer_0123456789abcdef", options: { challenge: "AAAA" } };

export const registrationResponse = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key" as const,
  response: { clientDataJSON: "e30", attestationObject: "o2NmbXQ", transports: ["internal"] },
  clientExtensionResults: {},
  authenticatorAttachment: "platform",
};

export const assertionResponse = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key" as const,
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AAAA",
    signature: "MEUC",
    userHandle: "dXNy",
  },
  clientExtensionResults: {},
};

export const passkey: PasskeySummary = {
  credentialId: "Y3JlZA",
  label: "Laptop",
  createdAt: T0,
  lastUsedAt: null,
  deviceType: "multiDevice",
  backedUp: true,
};

export const member: Member = {
  user,
  role: "owner",
  approver: "active",
  joinedAt: T0,
  pendingPasskeys: [{ credentialId: "Y3JlZDI", publicKey: "pQECAyYgASFYIA", label: "Phone" }],
};

export const policy: WalletPolicy = {
  v: 1,
  workspaceId: WS,
  walletId: WALLET,
  revision: 1,
  previousHash: null,
  chains: ["eip155:8453"],
  requesters: [AGENT],
  assets: [{ chainId: "eip155:8453", asset: "native", maxPerTx: "10", maxPerDay: "20" }],
  recipients: { mode: "any" },
  contractCalls: { mode: "deny" },
  fees: { maxPerTxWei: "1000" },
  approvals: { threshold: 1, ttlSeconds: 3600 },
};

export const agent: AgentSummary = {
  id: AGENT,
  name: "billing bot",
  status: "active",
  walletId: WALLET,
  tokenPrefix: "osa_1a2b",
  createdAt: T0,
  lastSeenAt: T0 + 5,
};

export const wallet: WalletSummary = {
  id: WALLET,
  kind: "agent",
  label: "billing bot",
  address: ADDRESS,
  agentId: AGENT,
  policy,
  policyHash: HASH,
};

export const walletDetail: WalletDetail = {
  ...wallet,
  balances: [{ chainId: "eip155:8453", asset: "native", symbol: "ETH", decimals: 18, amount: "5" }],
  spent: [{ chainId: "eip155:8453", asset: "native", amount: "1" }],
  pendingPolicyApprovalId: null,
};

export const workspaceSummary = {
  id: WS,
  name: "Acme",
  role: "owner" as const,
  paused: false,
  pendingApprovals: 1,
};

export const workspace: WorkspaceDetail = {
  ...workspaceSummary,
  adminThreshold: 1,
  notificationDetail: "count",
  members: [member],
  agents: [agent],
  wallets: [wallet],
  chains: [
    {
      chainId: "eip155:8453",
      name: "Base",
      nativeSymbol: "ETH",
      explorerUrl: "https://basescan.org",
    },
  ],
};

/** As a browser reports it: a 65-byte P-256 point and a 16-byte secret, unpadded base64url. */
export const pushSubscriptionInput: PushSubscriptionInput = {
  endpoint: "https://fcm.googleapis.com/fcm/send/dXNlcg:APA91b",
  keys: {
    p256dh: `B${"A".repeat(86)}`,
    auth: "AAAAAAAAAAAAAAAAAAAAAA",
  },
  label: "Phone",
};

export const pushSubscription: PushSubscriptionSummary = {
  id: SUBSCRIPTION,
  label: "Phone",
  createdAt: T0,
  lastSuccessAt: null,
};

export const notificationPreferences: NotificationPreferences = {
  workspaces: [{ workspaceId: WS, webPush: true, reminders: false }],
  quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/London" },
};

export const intent: Intent = {
  v: 1,
  id: INTENT,
  workspaceId: WS,
  agentId: AGENT,
  walletId: WALLET,
  chainId: "eip155:8453",
  operation: { type: "evm.transfer", to: ADDRESS, valueWei: "5" },
  maxFeeWei: "100",
  memo: "refund order 7",
  createdAt: T0,
};

export const intentSummary: IntentSummary = {
  id: INTENT,
  agent: { id: AGENT, name: "billing bot" },
  walletId: WALLET,
  chainId: "eip155:8453",
  status: "pending_approval",
  display: {
    title: "Send 0.000000000000000005 ETH",
    assetSymbol: "ETH",
    assetDecimals: 18,
    amount: "5",
    amountFormatted: "0.000000000000000005",
    to: ADDRESS,
    token: null,
    rawCall: false,
  },
  memo: "refund order 7",
  createdAt: T0,
  approvalId: APPROVAL,
  mandateId: null,
  transactionHash: null,
  failureCode: null,
};

export const intentDetail: IntentDetail = {
  ...intentSummary,
  intent,
  intentHash: HASH,
  simulation: { ok: true, blockNumber: 100, gasEstimate: "21000", error: null },
  transaction: { hash: TX, status: "broadcast", blockNumber: null, explorerUrl: null },
};

export const approvalSummary: ApprovalSummary = {
  id: APPROVAL,
  workspaceId: WS,
  kind: "approve-intent",
  status: "pending",
  title: "Send 5 wei to 0x1111…1111",
  requestedBy: { type: "agent", id: AGENT, name: "billing bot" },
  createdAt: T0,
  expiresAt: T0 + 600,
  threshold: 1,
  approvals: 0,
  failureCode: null,
};

export const approvalDetail: ApprovalDetail = {
  ...approvalSummary,
  envelope: {
    v: 1,
    type: "approve-intent",
    approvalId: APPROVAL,
    workspaceId: WS,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: T0,
    expiresAt: T0 + 600,
    intentHash: HASH,
    walletId: WALLET,
    agentId: AGENT,
    chainId: "eip155:8453",
    policyHash: HASH,
  },
  approvedBy: [],
  rejectedBy: null,
  canDecide: true,
  subject: {
    kind: "approve-intent",
    intent: intentDetail,
    wallet,
    limits: { maxPerTx: "10", maxPerDay: "20", spentToday: "1" },
  },
  confirmUrl: `https://approve.os.example.com/a/${APPROVAL}#AAAAAAAAAAAAAAAAAAAAAA`,
};

export const sweep = {
  v: 1 as const,
  workspaceId: WS,
  walletId: WALLET,
  chainId: "eip155:8453" as const,
  asset: "native" as const,
  amount: "990000000000000000",
  to: "0x1111111111111111111111111111111111111111" as const,
  maxFeeWei: "10000000000000000",
};

export const sweepApprovalDetail: ApprovalDetail = {
  ...approvalSummary,
  kind: "sweep-wallet",
  title: "Empty 0.99 ETH from the wallet to 0x1111…1111",
  requestedBy: { type: "user", id: USER, name: "Ada" },
  envelope: {
    v: 1,
    type: "sweep-wallet",
    approvalId: APPROVAL,
    workspaceId: WS,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: T0,
    expiresAt: T0 + 600,
    walletId: WALLET,
    chainId: "eip155:8453",
    sweepHash: HASH,
  },
  approvedBy: [],
  rejectedBy: null,
  canDecide: true,
  subject: {
    kind: "sweep-wallet",
    wallet,
    sweep,
    sweepHash: HASH,
    assetSymbol: "ETH",
    assetDecimals: 18,
    destination: "treasury",
    transaction: null,
  },
  confirmUrl: null,
};

export const auditEvent: AuditEvent = {
  seq: 1,
  at: T0,
  actor: { type: "agent", id: AGENT, name: "billing bot" },
  action: "intent.proposed",
  subject: { type: "intent", id: INTENT },
  detail: { amount: "5" },
  previousHash: null,
  hash: HASH,
};

export const signerDecision = {
  seq: 1,
  at: T0,
  workspaceId: WS,
  approvalId: APPROVAL,
  action: "sign",
  outcome: "allowed" as const,
  code: null,
  previousHash: null,
  hash: HASH,
};

export const mandate: Mandate = {
  v: 1,
  id: MANDATE,
  workspaceId: WS,
  walletId: WALLET,
  agentId: AGENT,
  assets: [
    {
      chainId: "eip155:8453",
      asset: "native",
      maxPerAction: "5",
      maxPerWindow: "10",
      maxTotal: "15",
    },
  ],
  windowSeconds: 86_400,
  recipients: [ADDRESS, "0x2222222222222222222222222222222222222222"],
  maxUses: 3,
  maxFeePerActionWei: "1000",
  notBefore: T0,
  notAfter: T0 + 7 * 86_400,
  purpose: "refunds this week",
};

export const mandateDraft: MandateDraft = {
  agentId: AGENT,
  assets: mandate.assets,
  windowSeconds: mandate.windowSeconds,
  recipients: mandate.recipients,
  maxUses: mandate.maxUses,
  maxFeePerActionWei: mandate.maxFeePerActionWei,
  notAfter: mandate.notAfter,
  purpose: mandate.purpose,
};

const mandateAssets = [
  {
    chainId: "eip155:8453" as const,
    asset: "native" as const,
    symbol: "ETH",
    decimals: 18,
    worstCase: "15",
    policy: { maxPerTx: "10", maxPerDay: "20" },
  },
];

export const mandateSummary: MandateSummary = {
  id: MANDATE,
  workspaceId: WS,
  walletId: WALLET,
  agent: { id: AGENT, name: "billing bot" },
  mandate,
  mandateHash: HASH,
  status: "active",
  endedReason: null,
  grantApprovalId: APPROVAL,
  grantedAt: T0 + 60,
  grantedBy: [user],
  revokedAt: null,
  assets: mandateAssets,
  usage: {
    uses: 1,
    usesLeft: 2,
    assets: [{ chainId: "eip155:8453", asset: "native", usedTotal: "5", usedInWindow: "5" }],
  },
};

export const mandateDetail: MandateDetail = {
  ...mandateSummary,
  intents: [{ ...intentSummary, status: "confirmed", approvalId: null, mandateId: MANDATE }],
  intentsCursor: null,
};

export const grantApprovalDetail: ApprovalDetail = {
  ...approvalSummary,
  kind: "grant-mandate",
  title: "Let billing bot make up to 3 payments from billing bot without asking",
  requestedBy: { type: "user", id: USER, name: "Ada" },
  envelope: {
    v: 1,
    type: "grant-mandate",
    approvalId: APPROVAL,
    workspaceId: WS,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: T0,
    expiresAt: T0 + 600,
    mandateId: MANDATE,
    walletId: WALLET,
    agentId: AGENT,
    mandateHash: HASH,
  },
  approvedBy: [],
  rejectedBy: null,
  canDecide: true,
  subject: {
    kind: "grant-mandate",
    wallet,
    agent: { id: AGENT, name: "billing bot" },
    mandate,
    mandateHash: HASH,
    assets: mandateAssets,
    usage: null,
  },
  confirmUrl: `https://approve.os.example.com/a/${APPROVAL}#AAAAAAAAAAAAAAAAAAAAAA`,
};

export const policyDraft = {
  chains: policy.chains,
  requesters: policy.requesters,
  assets: policy.assets,
  recipients: policy.recipients,
  contractCalls: policy.contractCalls,
  fees: policy.fees,
  approvals: policy.approvals,
};
