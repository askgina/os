import type { Intent, WalletPolicy } from "@askgina/os-protocol";
import type {
  AgentSummary,
  ApprovalDetail,
  ApprovalSummary,
  AuditEvent,
  IntentDetail,
  IntentSummary,
  Member,
  PasskeySummary,
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
  challenge: "SoAiEpNpEeP2ex9Y_3B7aWINGGXHZFbp3OvzZU6dC80",
  approvedBy: [],
  rejectedBy: null,
  canDecide: true,
  subject: {
    kind: "approve-intent",
    intent: intentDetail,
    wallet,
    limits: { maxPerTx: "10", maxPerDay: "20", spentToday: "1" },
  },
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

export const policyDraft = {
  chains: policy.chains,
  requesters: policy.requesters,
  assets: policy.assets,
  recipients: policy.recipients,
  contractCalls: policy.contractCalls,
  fees: policy.fees,
  approvals: policy.approvals,
};
