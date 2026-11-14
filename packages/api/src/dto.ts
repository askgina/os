import {
  Address,
  AgentId,
  Amount,
  ApprovalId,
  AssertionResponse,
  AssetRef,
  Base64Url,
  ChainId,
  Digest,
  Envelope,
  EpochSeconds,
  Hex32,
  Intent,
  IntentId,
  UserId,
  WalletId,
  WalletPolicy,
  WorkspaceId,
} from "@askgina/os-protocol";
import { z } from "zod";

// --- errors -----------------------------------------------------------------------------------

export const ApiErrorCode = z.enum([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  /** The signer refused. `detail` carries the signer's own error code. */
  "signer_refused",
  /** A wallet policy would refuse this proposal. `detail` carries the policy's reason code. */
  "policy_denied",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorBody = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCode,
    message: z.string(),
    detail: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const apiErrorStatus: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  signer_refused: 422,
  policy_denied: 422,
  internal: 500,
};

// --- people and sessions ----------------------------------------------------------------------

export const DisplayName = z.string().trim().min(1).max(64);

export const UserSummary = z.strictObject({ id: UserId, displayName: z.string() });
export type UserSummary = z.infer<typeof UserSummary>;

export const SessionInfo = z.strictObject({
  /** True until the first owner has been created with the setup token. */
  setupRequired: z.boolean(),
  user: UserSummary.nullable(),
  relyingParty: z.strictObject({ id: z.string(), name: z.string() }),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/**
 * WebAuthn options as `@simplewebauthn/server` generates them. The browser hands them to
 * `@simplewebauthn/browser` unchanged, so this contract treats them as opaque JSON.
 */
export const WebAuthnOptions = z.record(z.string(), z.unknown());
export type WebAuthnOptions = z.infer<typeof WebAuthnOptions>;

/** A WebAuthn registration response as `@simplewebauthn/browser` returns it. */
export const RegistrationResponse = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: Base64Url, attestationObject: Base64Url }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});
export type RegistrationResponse = z.infer<typeof RegistrationResponse>;

/** A sign-in or registration in progress. Opaque; single use; expires after five minutes. */
export const CeremonyId = z.string().min(16).max(128);

export const CeremonyStart = z.strictObject({ ceremonyId: CeremonyId, options: WebAuthnOptions });
export type CeremonyStart = z.infer<typeof CeremonyStart>;

export const PasskeySummary = z.strictObject({
  credentialId: Base64Url,
  label: z.string(),
  createdAt: EpochSeconds,
  lastUsedAt: EpochSeconds.nullable(),
  /** `multiDevice` passkeys may be synced by their provider; `singleDevice` ones cannot. */
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
});
export type PasskeySummary = z.infer<typeof PasskeySummary>;

// --- workspaces -------------------------------------------------------------------------------

export const Role = z.enum(["owner", "approver", "viewer"]);
export type Role = z.infer<typeof Role>;

/**
 * Whether the signer accepts this member's passkeys. `pending` means a passkey is waiting for an
 * existing approver to authorize it; until then the member can look but not approve.
 */
export const ApproverState = z.enum(["none", "pending", "active"]);
export type ApproverState = z.infer<typeof ApproverState>;

export const Member = z.strictObject({
  user: UserSummary,
  role: Role,
  approver: ApproverState,
  joinedAt: EpochSeconds,
});
export type Member = z.infer<typeof Member>;

export const ChainInfo = z.strictObject({
  chainId: ChainId,
  name: z.string(),
  nativeSymbol: z.string(),
  explorerUrl: z.string().nullable(),
});
export type ChainInfo = z.infer<typeof ChainInfo>;

export const AgentSummary = z.strictObject({
  id: AgentId,
  name: z.string(),
  status: z.enum(["active", "disabled"]),
  walletId: WalletId,
  /** The first characters of the agent's token, enough to tell tokens apart. */
  tokenPrefix: z.string(),
  createdAt: EpochSeconds,
  lastSeenAt: EpochSeconds.nullable(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const WalletSummary = z.strictObject({
  id: WalletId,
  kind: z.enum(["agent", "treasury"]),
  label: z.string(),
  address: Address,
  /** The agent this wallet was created for; null for a treasury. */
  agentId: AgentId.nullable(),
  /** Null until the first policy is approved. A wallet without a policy can sign nothing. */
  policy: WalletPolicy.nullable(),
  policyHash: Digest.nullable(),
});
export type WalletSummary = z.infer<typeof WalletSummary>;

export const AssetBalance = z.strictObject({
  chainId: ChainId,
  asset: AssetRef,
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
  amount: Amount,
});
export type AssetBalance = z.infer<typeof AssetBalance>;

export const WalletDetail = WalletSummary.extend({
  balances: z.array(AssetBalance),
  /** What the signer has signed for in the last 24 hours, per asset. */
  spent: z.array(z.strictObject({ chainId: ChainId, asset: AssetRef, amount: Amount })),
  /** Set while a policy change is waiting for approval. */
  pendingPolicyApprovalId: ApprovalId.nullable(),
});
export type WalletDetail = z.infer<typeof WalletDetail>;

export const WorkspaceSummary = z.strictObject({
  id: WorkspaceId,
  name: z.string(),
  role: Role,
  paused: z.boolean(),
  pendingApprovals: z.number().int().min(0),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceDetail = WorkspaceSummary.extend({
  /** How many people must approve changes to approvers and policies. */
  adminThreshold: z.number().int().min(1),
  members: z.array(Member),
  agents: z.array(AgentSummary),
  wallets: z.array(WalletSummary),
  chains: z.array(ChainInfo),
});
export type WorkspaceDetail = z.infer<typeof WorkspaceDetail>;

/** The parts of a wallet policy a person edits. The server fills in ids, revision and hash chain. */
export const PolicyDraft = z.strictObject({
  chains: z.array(ChainId).max(32),
  requesters: z.array(AgentId).max(64),
  assets: z
    .array(
      z.strictObject({ chainId: ChainId, asset: AssetRef, maxPerTx: Amount, maxPerDay: Amount }),
    )
    .max(128),
  recipients: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("any") }),
    z.strictObject({ mode: z.literal("allowlist"), addresses: z.array(Address).max(256) }),
  ]),
  contractCalls: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("deny") }),
    z.strictObject({ mode: z.literal("allowlist"), targets: z.array(Address).max(256) }),
  ]),
  fees: z.strictObject({ maxPerTxWei: Amount }),
  approvals: z.strictObject({
    threshold: z.number().int().min(1).max(16),
    ttlSeconds: z.number().int().min(60).max(86_400),
  }),
});
export type PolicyDraft = z.infer<typeof PolicyDraft>;

// --- intents ----------------------------------------------------------------------------------

/**
 * - `proposed`: recorded; checks are running.
 * - `pending_approval`: waiting for people.
 * - `approved`: enough people approved; signing is next.
 * - `signed`, `broadcast`: the transaction exists and is on its way.
 * - `confirmed` / `reverted`: mined, with that outcome.
 * - `stuck`: signed and broadcast but not mined in time. It can still be mined later.
 * - `rejected`, `expired`, `cancelled`: ended without a signature.
 * - `denied`: a policy or the signer refused it; `failureCode` says why.
 * - `failed`: something broke; `failureCode` says what.
 */
export const IntentStatus = z.enum([
  "proposed",
  "pending_approval",
  "approved",
  "signed",
  "broadcast",
  "confirmed",
  "reverted",
  "stuck",
  "rejected",
  "expired",
  "cancelled",
  "denied",
  "failed",
]);
export type IntentStatus = z.infer<typeof IntentStatus>;

/** How to show an intent to a person. Derived, never hashed: the `Intent` itself is the truth. */
export const IntentDisplay = z.strictObject({
  /** For example "Send 250 USDC". */
  title: z.string(),
  assetSymbol: z.string(),
  assetDecimals: z.number().int().min(0).max(36),
  /** Base units, as in the intent. */
  amount: Amount,
  /** The same amount in whole units, for example "250" or "0.015". */
  amountFormatted: z.string(),
  /** Who receives the transfer, or the contract a raw call goes to. */
  to: Address,
  /** The ERC-20 contract for token transfers, otherwise null. */
  token: Address.nullable(),
  /** True for a raw contract call, whose effect per-asset caps cannot measure. */
  rawCall: z.boolean(),
});
export type IntentDisplay = z.infer<typeof IntentDisplay>;

export const IntentSummary = z.strictObject({
  id: IntentId,
  agent: z.strictObject({ id: AgentId, name: z.string() }),
  walletId: WalletId,
  chainId: ChainId,
  status: IntentStatus,
  display: IntentDisplay,
  memo: z.string(),
  createdAt: EpochSeconds,
  approvalId: ApprovalId.nullable(),
  transactionHash: Hex32.nullable(),
  failureCode: z.string().nullable(),
});
export type IntentSummary = z.infer<typeof IntentSummary>;

export const Simulation = z.strictObject({
  ok: z.boolean(),
  blockNumber: z.number().int(),
  gasEstimate: Amount.nullable(),
  /** The revert reason when `ok` is false. */
  error: z.string().nullable(),
});
export type Simulation = z.infer<typeof Simulation>;

export const IntentDetail = IntentSummary.extend({
  /** The exact structure whose hash people approve. */
  intent: Intent,
  intentHash: Digest,
  simulation: Simulation.nullable(),
  transaction: z
    .strictObject({
      hash: Hex32,
      status: z.enum(["signed", "broadcast", "confirmed", "reverted", "stuck"]),
      blockNumber: z.number().int().nullable(),
      explorerUrl: z.string().nullable(),
    })
    .nullable(),
});
export type IntentDetail = z.infer<typeof IntentDetail>;

// --- approvals --------------------------------------------------------------------------------

/**
 * - `pending`: collecting passkey approvals.
 * - `approved`: enough collected; the effect is being applied.
 * - `executed`: the effect took place (transaction signed, policy set, approver changed, ...).
 * - `rejected`, `expired`, `cancelled`: ended with no effect.
 * - `failed`: approved, but the signer or the chain refused; `failureCode` says why.
 */
export const ApprovalStatus = z.enum([
  "pending",
  "approved",
  "executed",
  "rejected",
  "expired",
  "cancelled",
  "failed",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalKind = z.enum([
  "approve-intent",
  "set-policy",
  "add-approver",
  "remove-approver",
  "set-admin-threshold",
  "resume-workspace",
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const Requester = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent"), id: AgentId, name: z.string() }),
  z.strictObject({ type: z.literal("user"), id: UserId, name: z.string() }),
]);
export type Requester = z.infer<typeof Requester>;

export const ApprovalSummary = z.strictObject({
  id: ApprovalId,
  workspaceId: WorkspaceId,
  kind: ApprovalKind,
  status: ApprovalStatus,
  /** One line a person can act on, for example "Send 250 USDC to 0x12ab…89ef". */
  title: z.string(),
  requestedBy: Requester,
  createdAt: EpochSeconds,
  expiresAt: EpochSeconds,
  /** How many different people must approve. */
  threshold: z.number().int().min(1),
  approvals: z.number().int().min(0),
  failureCode: z.string().nullable(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummary>;

export const ApprovalSubject = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("approve-intent"),
    intent: IntentDetail,
    wallet: WalletSummary,
    /** Where this transaction sits against the wallet's caps for its asset; null for a raw call that moves no native coin. */
    limits: z.strictObject({ maxPerTx: Amount, maxPerDay: Amount, spentToday: Amount }).nullable(),
  }),
  z.strictObject({
    kind: z.literal("set-policy"),
    wallet: WalletSummary,
    current: WalletPolicy.nullable(),
    proposed: WalletPolicy,
  }),
  z.strictObject({
    kind: z.literal("add-approver"),
    user: UserSummary,
    credentialId: Base64Url,
    passkeyLabel: z.string(),
  }),
  z.strictObject({
    kind: z.literal("remove-approver"),
    user: UserSummary,
    credentialId: Base64Url,
    passkeyLabel: z.string(),
  }),
  z.strictObject({
    kind: z.literal("set-admin-threshold"),
    current: z.number().int(),
    proposed: z.number().int(),
  }),
  z.strictObject({ kind: z.literal("resume-workspace") }),
]);
export type ApprovalSubject = z.infer<typeof ApprovalSubject>;

export const ApprovalDetail = ApprovalSummary.extend({
  /** Exactly what a passkey signs. */
  envelope: Envelope,
  /** The envelope's digest, base64url: the WebAuthn challenge. */
  challenge: Base64Url,
  approvedBy: z.array(UserSummary),
  rejectedBy: UserSummary.nullable(),
  /** Whether the signed-in person may approve or reject right now. */
  canDecide: z.boolean(),
  subject: ApprovalSubject,
});
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;

export const ApproveRequest = z.strictObject({ response: AssertionResponse });
export type ApproveRequest = z.infer<typeof ApproveRequest>;

// --- audit ------------------------------------------------------------------------------------

export const AuditActor = z.strictObject({
  type: z.enum(["user", "agent", "system", "signer"]),
  id: z.string().nullable(),
  name: z.string().nullable(),
});
export type AuditActor = z.infer<typeof AuditActor>;

/** One entry of a workspace's append-only log. Entries are hash-chained in `seq` order. */
export const AuditEvent = z.strictObject({
  seq: z.number().int().min(1),
  at: EpochSeconds,
  actor: AuditActor,
  /** For example `intent.proposed`, `approval.approved`, `policy.changed`. */
  action: z.string(),
  subject: z.strictObject({ type: z.string(), id: z.string() }).nullable(),
  detail: z.record(z.string(), z.unknown()),
  previousHash: Digest.nullable(),
  hash: Digest,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditVerification = z.strictObject({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  /** The first `seq` whose hash does not follow from the entry before it. */
  brokenAt: z.number().int().nullable(),
});
export type AuditVerification = z.infer<typeof AuditVerification>;

/** An opaque position in a list. Pass it back to get the next page. */
export const Cursor = z.string().min(1).max(256);

export const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: Cursor.nullable() });
