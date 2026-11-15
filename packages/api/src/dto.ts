import {
  Address,
  AgentId,
  Amount,
  ApprovalId,
  AssetRef,
  Base64Url,
  ChainId,
  Digest,
  Envelope,
  EpochSeconds,
  Hex32,
  Intent,
  IntentId,
  Mandate,
  MandateAssetLimit,
  MandateId,
  Memo,
  PositiveAmount,
  PushSubscriptionId,
  Sweep,
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
  /**
   * A wallet policy, or the mandate an agent named, would refuse this proposal. `detail` carries
   * the reason code: a policy's (for example `over_daily_cap`) or a mandate's (for example
   * `mandate_over_window_cap`, `mandate_expired`).
   */
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

/** An opaque position in a list. Pass it back to get the next page. */
export const Cursor = z.string().min(1).max(256);

export const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: Cursor.nullable() });

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

/**
 * A name a person typed that is later shown next to approval cards: workspace, agent, wallet,
 * person and passkey names. It follows the memo rule (no control or bidirectional characters),
 * so a name cannot make a card read differently from what is stored.
 */
export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Memo.safeParse(value).success, "contains control or bidi characters");

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
 * What a workspace's notifications may say. `count`: only how many requests wait. `summary`:
 * also the kind of request, the workspace's name and who asked, never an amount, a recipient or
 * a memo. Only an owner may change it; the change is in the workspace's audit log.
 */
export const NotificationDetail = z.enum(["count", "summary"]);
export type NotificationDetail = z.infer<typeof NotificationDetail>;

/**
 * Whether the signer accepts this member's passkeys. `pending` means a passkey is waiting for an
 * existing approver to authorize it; until then the member can look but not approve.
 */
export const ApproverState = z.enum(["none", "pending", "active"]);
export type ApproverState = z.infer<typeof ApproverState>;

/**
 * A passkey of a member that waits to approve. Shown to owners with its COSE public key
 * (base64url), so an operator can enroll it directly at the signer when no approver is left.
 */
export const PendingPasskey = z.strictObject({
  credentialId: Base64Url,
  publicKey: Base64Url,
  label: z.string(),
});
export type PendingPasskey = z.infer<typeof PendingPasskey>;

export const Member = z.strictObject({
  user: UserSummary,
  role: Role,
  approver: ApproverState,
  joinedAt: EpochSeconds,
  /** Filled for owners only; empty for everyone else. */
  pendingPasskeys: z.array(PendingPasskey),
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
  /** What notifications about this workspace's requests may say. */
  notificationDetail: NotificationDetail,
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
  /** The request people approve it with; null when a mandate covered it. */
  approvalId: ApprovalId.nullable(),
  /**
   * The mandate it was signed under, with no person asked; null when people approve it. Exactly
   * one of `approvalId` and `mandateId` is set.
   */
  mandateId: MandateId.nullable(),
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

/** The one transaction an approval signed, as the chain last showed it. */
export const TransactionInfo = z.strictObject({
  hash: Hex32,
  /** `rejected`: signed, never accepted by the chain, and no longer retried. */
  status: z.enum(["signed", "broadcast", "confirmed", "reverted", "stuck", "rejected"]),
  blockNumber: z.number().int().nullable(),
  explorerUrl: z.string().nullable(),
});
export type TransactionInfo = z.infer<typeof TransactionInfo>;

export const IntentDetail = IntentSummary.extend({
  /** The exact structure whose hash people approve. */
  intent: Intent,
  intentHash: Digest,
  simulation: Simulation.nullable(),
  transaction: TransactionInfo.nullable(),
});
export type IntentDetail = z.infer<typeof IntentDetail>;

// --- mandates ---------------------------------------------------------------------------------

/**
 * What an owner fills in to approve one agent's transfers in advance: from the wallet in the
 * path, to the listed recipients, within these caps (base units), until `notAfter`. The server
 * sets the id, the workspace, the wallet and `notBefore` (now) and puts the lists in order. The
 * signer checks it against the wallet's policy and its own longest lifetime when people grant it.
 */
export const MandateDraft = z.strictObject({
  agentId: AgentId,
  assets: z.array(MandateAssetLimit).min(1).max(16),
  /** The rolling span `maxPerWindow` is counted over: 3600 to 604800 seconds. */
  windowSeconds: z.number().int().min(3600).max(604_800),
  recipients: z.array(Address).min(1).max(64),
  maxUses: z.number().int().min(1).max(10_000),
  maxFeePerActionWei: PositiveAmount,
  notAfter: EpochSeconds,
  /** The person's own reason, shown with the mandate. */
  purpose: Memo,
});
export type MandateDraft = z.infer<typeof MandateDraft>;

/**
 * Where a mandate stands, as the signer computes it when asked.
 * - `active`: payments that fit are signed with no person asked.
 * - `not_yet_valid`, `expired`: the signer's clock is before `notBefore`, or at or after `notAfter`.
 * - `exhausted`: its uses, or every asset's total, are spent.
 * - `revoked`: ended for good.
 */
export const MandateStatus = z.enum(["active", "not_yet_valid", "expired", "exhausted", "revoked"]);
export type MandateStatus = z.infer<typeof MandateStatus>;

/**
 * Why a mandate can never sign again, as the control plane first saw it: a person revoked it
 * (`revoked`), a passkey that granted it stopped approving (`grantor_removed`), the operator
 * ended it on the signer host or the signer no longer holds it after a restore (`operator`),
 * `expired`, `exhausted`, or its agent was disabled (`agent_disabled`).
 */
export const MandateEndedReason = z.enum([
  "revoked",
  "grantor_removed",
  "operator",
  "expired",
  "exhausted",
  "agent_disabled",
]);
export type MandateEndedReason = z.infer<typeof MandateEndedReason>;

/** One asset of a mandate as a person reads it. */
export const MandateAssetView = z.strictObject({
  chainId: ChainId,
  asset: AssetRef,
  /** How the asset is shown; null when its chain is not configured here or the token could not be read. */
  symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(36).nullable(),
  /** `min(maxTotal, maxUses × maxPerAction)` in base units: the most that can leave the wallet under it. */
  worstCase: Amount,
  /** The wallet policy's caps for this asset, which still apply to every payment; null when the policy lists none. */
  policy: z.strictObject({ maxPerTx: Amount, maxPerDay: Amount }).nullable(),
});
export type MandateAssetView = z.infer<typeof MandateAssetView>;

/** What the signer counted under a mandate. Counted payments are never given back. */
export const MandateUsageSummary = z.strictObject({
  uses: z.number().int().min(0),
  usesLeft: z.number().int().min(0),
  /** Per asset of the mandate, in base units: all signed under it, and in the last `windowSeconds`. */
  assets: z
    .array(
      z.strictObject({
        chainId: ChainId,
        asset: AssetRef,
        usedTotal: Amount,
        usedInWindow: Amount,
      }),
    )
    .max(16),
});
export type MandateUsageSummary = z.infer<typeof MandateUsageSummary>;

export const MandateSummary = z.strictObject({
  id: MandateId,
  workspaceId: WorkspaceId,
  walletId: WalletId,
  agent: z.strictObject({ id: AgentId, name: z.string() }),
  /** Exactly what people approved, and what the signer enforces. */
  mandate: Mandate,
  mandateHash: Digest,
  status: MandateStatus,
  /** Set once the mandate can never sign again; null while it still can. */
  endedReason: MandateEndedReason.nullable(),
  /** The `grant-mandate` request people approved it with. */
  grantApprovalId: ApprovalId,
  grantedAt: EpochSeconds,
  grantedBy: z.array(UserSummary),
  revokedAt: EpochSeconds.nullable(),
  assets: z.array(MandateAssetView),
  /**
   * What the signer counted under it. Null when the signer no longer holds it: its volume was
   * restored from a backup older than the grant.
   */
  usage: MandateUsageSummary.nullable(),
});
export type MandateSummary = z.infer<typeof MandateSummary>;

export const MandateDetail = MandateSummary.extend({
  /** The intents signed under it, newest first: the first page of `listIntents` with its `mandateId`. */
  intents: z.array(IntentSummary),
  /** Pass to `listIntents` with this `mandateId` for the next page. */
  intentsCursor: Cursor.nullable(),
});
export type MandateDetail = z.infer<typeof MandateDetail>;

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
  "sweep-wallet",
  "grant-mandate",
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
  z.strictObject({
    kind: z.literal("sweep-wallet"),
    wallet: WalletSummary,
    /** The exact structure whose hash people approve. */
    sweep: Sweep,
    sweepHash: Digest,
    /** How the asset is shown, read from the chain by the server. */
    assetSymbol: z.string(),
    assetDecimals: z.number().int().min(0).max(36),
    /**
     * Why the server expects the signer to accept the destination: it is on the wallet's
     * allowlist, or it is the workspace's treasury. Null when neither holds: the signer will
     * refuse the sweep. The signer decides from its own records either way.
     */
    destination: z.enum(["allowlist", "treasury"]).nullable(),
    transaction: TransactionInfo.nullable(),
  }),
  z.strictObject({
    kind: z.literal("grant-mandate"),
    wallet: WalletSummary,
    agent: z.strictObject({ id: AgentId, name: z.string() }),
    /** The exact structure whose hash people approve. */
    mandate: Mandate,
    mandateHash: Digest,
    assets: z.array(MandateAssetView),
    /** What the signer counted under it once granted; null while the grant waits. */
    usage: MandateUsageSummary.nullable(),
  }),
]);
export type ApprovalSubject = z.infer<typeof ApprovalSubject>;

export const ApprovalDetail = ApprovalSummary.extend({
  /** Exactly what a passkey approves on the signer's confirmation page. */
  envelope: Envelope,
  approvedBy: z.array(UserSummary),
  rejectedBy: UserSummary.nullable(),
  /** Whether the signed-in person may approve or reject right now. */
  canDecide: z.boolean(),
  subject: ApprovalSubject,
  /**
   * The signer's confirmation page for this request, on its own origin: where a person reads
   * the request as the signer holds it and approves it with a passkey. The link carries its
   * token after `#`. Null once the request no longer waits for approval, and while the signer
   * refuses to open one (for example, the wallet's policy changed since it was proposed).
   */
  confirmUrl: z.url({ protocol: /^https?$/ }).nullable(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;

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

/** An invite still waiting to be used. Its token is never shown again. */
export const InviteSummary = z.strictObject({
  id: z.string().min(1).max(64),
  role: Role,
  createdBy: UserSummary,
  createdAt: EpochSeconds,
  expiresAt: EpochSeconds,
});
export type InviteSummary = z.infer<typeof InviteSummary>;

export const AuditVerification = z.strictObject({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  /**
   * The first `seq` whose hash does not follow from the entry before it, or the first missing
   * one when the newest entries are gone.
   */
  brokenAt: z.number().int().nullable(),
});
export type AuditVerification = z.infer<typeof AuditVerification>;

// --- notifications ----------------------------------------------------------------------------

/**
 * Whether this server sends Web Push, and the key a browser subscribes with
 * (`applicationServerKey` of `pushManager.subscribe`): the VAPID public key, an uncompressed
 * P-256 point, in unpadded base64url. Null while Web Push is off.
 */
export const PushConfig = z.strictObject({
  enabled: z.boolean(),
  applicationServerKey: Base64Url.nullable(),
});
export type PushConfig = z.infer<typeof PushConfig>;

/** A name a person gives one of their devices, for example "Phone". */
export const DeviceLabel = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => Memo.safeParse(value).success, "contains control or bidirectional characters");

/**
 * A browser's push subscription, from `PushSubscription.toJSON()` without `expirationTime`.
 * `p256dh` is the browser's P-256 key (65 bytes) and `auth` its 16-byte secret, both base64url.
 * The endpoint must be `https:` and under one of the push services the operator allows.
 */
export const PushSubscriptionInput = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.strictObject({
    p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}=?$/, "expected a 65-byte P-256 key in base64url"),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/, "expected 16 bytes in base64url"),
  }),
  label: DeviceLabel.optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** One of the signed-in person's devices that gets notifications. No endpoint, no keys. */
export const PushSubscriptionSummary = z.strictObject({
  id: PushSubscriptionId,
  label: z.string().nullable(),
  createdAt: EpochSeconds,
  /** The last time a notification reached its push service. */
  lastSuccessAt: EpochSeconds.nullable(),
});
export type PushSubscriptionSummary = z.infer<typeof PushSubscriptionSummary>;

/** A time of day, `HH:MM` on a 24-hour clock. */
export const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name, for example `Europe/London`. */
export const TimeZone = z.string().min(1).max(64).refine(isTimeZone, "unknown time zone");

/**
 * When a person's devices stay silent: from `start` until `end`, in `timeZone`, every day. A
 * window may cross midnight (`22:00` to `07:00`). Notifications that fall inside wait until it
 * ends, and are dropped when their request expires first. The operator's webhook ignores it.
 */
export const QuietHours = z
  .strictObject({ start: ClockTime, end: ClockTime, timeZone: TimeZone })
  .refine((value) => value.start !== value.end, "start and end must differ");
export type QuietHours = z.infer<typeof QuietHours>;

/** One workspace's notification switches for the signed-in person. Both are on by default. */
export const WorkspaceNotifications = z.strictObject({
  workspaceId: WorkspaceId,
  /** Push notifications to this person's devices about this workspace's requests. */
  webPush: z.boolean(),
  /** One more notification shortly before a request expires. */
  reminders: z.boolean(),
});
export type WorkspaceNotifications = z.infer<typeof WorkspaceNotifications>;

/**
 * The signed-in person's notification settings. Reading lists every workspace they are a member
 * of. Writing changes the workspaces listed, each at most once, and leaves the others as they
 * are; `quietHours: null` turns quiet hours off.
 */
export const NotificationPreferences = z.strictObject({
  workspaces: z
    .array(WorkspaceNotifications)
    .max(256)
    .refine(
      (items) => new Set(items.map((item) => item.workspaceId)).size === items.length,
      "each workspace at most once",
    ),
  quietHours: QuietHours.nullable(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
