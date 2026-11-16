import {
  Address,
  AgentId,
  Amount,
  ApprovalId,
  AssetRef,
  Base64Url,
  ChainId,
  Cloid,
  Digest,
  Envelope,
  EpochSeconds,
  Hex32,
  HyperliquidTimeInForce,
  Intent,
  IntentId,
  Mandate,
  MandateAssetLimit,
  MandateId,
  Memo,
  Network,
  PairingId,
  PositiveAmount,
  PositiveDecimal,
  PushSubscriptionId,
  Sweep,
  UserId,
  VenueNetwork,
  VenueRules,
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

/** A token's own `decimals`. Its contract declares it as a uint8, so any of 0 to 255 is shown. */
export const TokenDecimals = z.number().int().min(0).max(255);

/**
 * How many of a list's rows are left out because their stored details can no longer be read.
 * The list says so in place of failing as a whole; the server's log names each one.
 */
export const UnreadableCount = z.number().int().min(0);

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

/**
 * What an operator types on the signer's host before one of the signer's admin commands, for
 * example `docker compose exec signer node src/admin.ts` (the server's `SIGNER_ADMIN_COMMAND`).
 * It is pasted into a root shell, so it is only words of `[A-Za-z0-9_./:-]` separated by single
 * spaces: no quoting, substitution, redirection or second command.
 */
export const SignerAdminCommand = z.string().regex(/^[A-Za-z0-9_./:-]+( [A-Za-z0-9_./:-]+)*$/, {
  message: "must be words of [A-Za-z0-9_./:-] separated by single spaces",
});

export type SignerAdminCommand = z.infer<typeof SignerAdminCommand>;

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

/**
 * Where a wallet is in its life, as the signer last reported it.
 * - `active`: signs within its policy.
 * - `retiring`: people approved retiring it; it signs nothing, and its key is destroyed at
 *   `destroyAfter` unless someone cancels first.
 * - `held`: its retirement was cancelled; it signs nothing until a new policy is approved.
 * - `destroyed`: its key is gone; `destroyAfter` is when that was due.
 */
export const WalletLifecycle = z
  .strictObject({
    state: z.enum(["active", "retiring", "held", "destroyed"]),
    destroyAfter: EpochSeconds.nullable(),
  })
  .refine(
    (wallet) =>
      (wallet.state === "retiring" || wallet.state === "destroyed") ===
      (wallet.destroyAfter !== null),
    { path: ["destroyAfter"], message: "only a retiring or destroyed wallet has a destroy time" },
  );

export type WalletLifecycle = z.infer<typeof WalletLifecycle>;

/**
 * Where a workspace is in its life.
 * - `active`: as usual.
 * - `deleting`: people approved deleting it; it is paused, its wallets sign nothing, and at
 *   `destroyAfter` their keys are destroyed and its data made unreadable, unless a member
 *   cancels first. Only pausing, cancelling, notification settings and reading still work.
 * - `deleted`: a tombstone; `deletedAt` is when the deletion finished.
 */
export const WorkspaceLifecycle = z
  .strictObject({
    state: z.enum(["active", "deleting", "deleted"]),
    destroyAfter: EpochSeconds.nullable(),
    deletedAt: EpochSeconds.nullable(),
  })
  .refine((workspace) => (workspace.state === "active") === (workspace.destroyAfter === null), {
    path: ["destroyAfter"],
    message: "only a workspace being deleted or deleted has a destroy time",
  })
  .refine((workspace) => (workspace.state === "deleted") === (workspace.deletedAt !== null), {
    path: ["deletedAt"],
    message: "only a deleted workspace has a deletion time",
  });

export type WorkspaceLifecycle = z.infer<typeof WorkspaceLifecycle>;

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
  lifecycle: WalletLifecycle,
});

export type WalletSummary = z.infer<typeof WalletSummary>;

export const AssetBalance = z.strictObject({
  chainId: ChainId,
  asset: AssetRef,
  symbol: z.string(),
  decimals: TokenDecimals,
  amount: Amount,
});

export type AssetBalance = z.infer<typeof AssetBalance>;

/** A decimal as a venue writes it; a signed one may start with "-". Shown, never computed with. */
const VenueDecimal = z.string().regex(/^-?\d{1,30}(\.\d{1,30})?$/);

/**
 * A wallet's account at a venue, for the wallet page. `spentTodayUsd6` is the signer's own count;
 * `reported` is what the venue answered this server: not verified by the signer, which could
 * misreport it, and null when the venue could not be read.
 */
export const VenueAccount = z.strictObject({
  network: VenueNetwork,
  /** The notional the signer counted against the daily cap in the last 24 hours, in micro-USD. */
  spentTodayUsd6: Amount,
  /** The policy's daily cap on new orders' notional; null when the policy has no rules here. */
  maxNotionalPerDayUsd6: Amount.nullable(),
  reported: z
    .strictObject({
      accountValueUsd: VenueDecimal,
      withdrawableUsd: VenueDecimal,
      positions: z
        .array(
          z.strictObject({
            coin: z.string().max(32),
            side: z.enum(["long", "short"]),
            size: VenueDecimal,
            entryPrice: VenueDecimal,
            unrealizedPnlUsd: VenueDecimal,
          }),
        )
        .max(100),
      openOrders: z
        .array(
          z.strictObject({
            coin: z.string().max(32),
            side: z.enum(["buy", "sell"]),
            /** What is left of it. */
            size: VenueDecimal,
            limitPrice: VenueDecimal,
            venueOrderId: z.number().int().min(0),
            cloid: z.string().max(66).nullable(),
          }),
        )
        .max(100),
    })
    .nullable(),
});

export type VenueAccount = z.infer<typeof VenueAccount>;

export const WalletDetail = WalletSummary.extend({
  balances: z.array(AssetBalance),
  /** What the signer has signed for in the last 24 hours, per asset. */
  spent: z.array(z.strictObject({ chainId: ChainId, asset: AssetRef, amount: Amount })),
  /** Set while a policy change is waiting for approval. */
  pendingPolicyApprovalId: ApprovalId.nullable(),
  /**
   * The wallet's account at a venue this server is configured for, when its policy has rules
   * there or it has used one; absent otherwise.
   */
  venue: VenueAccount.optional(),
});

export type WalletDetail = z.infer<typeof WalletDetail>;

export const WorkspaceSummary = z.strictObject({
  id: WorkspaceId,
  name: z.string(),
  role: Role,
  paused: z.boolean(),
  pendingApprovals: z.number().int().min(0),
  lifecycle: WorkspaceLifecycle,
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceDetail = WorkspaceSummary.extend({
  /** How many people must approve changes to approvers and policies. */
  adminThreshold: z.number().int().min(1),
  /** What notifications about this workspace's requests may say. */
  notificationDetail: NotificationDetail,
  members: z.array(Member),
  /**
   * Set for owners only, who see the passkeys that wait to approve: the prefix of the signer's
   * admin commands on its host, to build the command that enrolls such a passkey there.
   */
  signerAdminCommand: SignerAdminCommand.optional(),
  agents: z.array(AgentSummary),
  wallets: z.array(WalletSummary),
  chains: z.array(ChainInfo),
  /** The venue networks this server is configured for, testnet first; empty when none. */
  venueNetworks: z.array(VenueNetwork),
});

export type WorkspaceDetail = z.infer<typeof WorkspaceDetail>;

/**
 * Why deleting a workspace now would lose something or wait, as the control plane sees it.
 * - `pending_approvals`: requests still wait for people; the deletion cancels them.
 * - `unfinished_runs`: an approved request, or a payment under a mandate, is still being
 *   carried out; the deletion finishes after it.
 * - `unmined_transactions`: a signed transaction is not mined yet (or was given up on while its
 *   nonce is still unused, so it can still be mined); the deletion waits for it. Cancel it with
 *   a cancel request if it is stuck.
 * - `nonzero_balance`: a wallet still holds an asset the server read; it is lost when the key
 *   is destroyed. Empty the wallet first.
 */
export const DeletionBlocker = z.enum([
  "pending_approvals",
  "unfinished_runs",
  "unmined_transactions",
  "nonzero_balance",
]);

export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

/**
 * Advisory. What deleting the workspace would lose, read by the control plane: the signer
 * cannot see balances, and the server reads only the native coin of each configured chain and
 * the assets each wallet's policy lists. A wallet's `balances` is null when they could not be
 * read.
 */
export const DeletionPreflight = z.strictObject({
  workspaceId: WorkspaceId,
  source: z.literal("control-plane"),
  wallets: z.array(
    z.strictObject({
      wallet: WalletSummary,
      balances: z.array(AssetBalance).nullable(),
    }),
  ),
  blockers: z.array(DeletionBlocker),
  /** The shortest delay the signer accepts between asking and destroying, in seconds. */
  minDestroyDelaySeconds: z.number().int().min(0),
  /** The earliest `destroyAfter` a request opened now may name. */
  earliestDestroyAfter: EpochSeconds,
});

export type DeletionPreflight = z.infer<typeof DeletionPreflight>;

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
  /** What the wallet may do at venues; absent, nothing. The network must be configured here. */
  venues: VenueRules.optional(),
});

export type PolicyDraft = z.infer<typeof PolicyDraft>;

// --- intents ----------------------------------------------------------------------------------

/**
 * - `proposed`: recorded; checks are running.
 * - `pending_approval`: waiting for people.
 * - `approved`: enough people approved; signing is next.
 * - `signed`, `broadcast`: the transaction exists and is on its way.
 * - `confirmed` / `reverted`: mined, with that outcome. A venue withdrawal is `confirmed` once
 *   the venue accepted it.
 * - `submitted`: a venue order was posted and the venue's answer is not known yet.
 * - `placed`: a venue order rests on the book; it may still fill or be cancelled.
 * - `filled` / `partially_filled`: a venue order ended filled in full, or in part (the rest was
 *   cancelled, as an immediate-or-cancel order's is).
 * - `stuck`: signed and broadcast but not mined in time. It can still be mined later, or
 *   cancelled.
 * - `voided`: a cancel people approved was mined in its place; nothing moved, a fee was paid.
 * - `rejected`, `expired`, `cancelled`: ended without a signature. A venue order also ends
 *   `expired` when the venue never received it within its submit window, and `cancelled` when
 *   it was cancelled at the venue with nothing filled.
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
  "voided",
  "submitted",
  "placed",
  "filled",
  "partially_filled",
]);

export type IntentStatus = z.infer<typeof IntentStatus>;

/**
 * How to show a transfer, a contract call or a venue withdrawal to a person. Derived, never
 * hashed: the `Intent` itself is the truth. A venue withdrawal shows the wallet's own address as
 * `to`, the only destination the signer allows.
 */
export const TransferDisplay = z.strictObject({
  kind: z.literal("transfer"),
  /** For example "Send 250 USDC". */
  title: z.string(),
  assetSymbol: z.string(),
  assetDecimals: TokenDecimals,
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

export type TransferDisplay = z.infer<typeof TransferDisplay>;

/** How to show a venue order to a person. Derived from the intent and the policy's market. */
export const OrderDisplay = z.strictObject({
  kind: z.literal("order"),
  /** For example "Buy 0.01 BTC at 65000". */
  title: z.string(),
  network: VenueNetwork,
  /** The name the wallet's policy binds to `asset`. */
  coin: z.string(),
  /** The perpetual's index at the venue: what is signed. */
  asset: z.number().int().min(0),
  side: z.enum(["buy", "sell"]),
  size: PositiveDecimal,
  limitPrice: PositiveDecimal,
  /** The worst-case notional, size times limit price, in USD rounded up to micro-USD. */
  notionalUsd: z.string(),
  timeInForce: HyperliquidTimeInForce,
  reduceOnly: z.boolean(),
  /** Approving an order includes the right to cancel it, for the agent too. */
  cancellableByAgent: z.literal(true),
});

export type OrderDisplay = z.infer<typeof OrderDisplay>;

export const IntentDisplay = z.discriminatedUnion("kind", [TransferDisplay, OrderDisplay]);

export type IntentDisplay = z.infer<typeof IntentDisplay>;

/**
 * A venue order after its approval, as the venue last reported it through this server. Not
 * verified by the signer: the control plane reads and could misreport the venue's state.
 */
export const VenueOrderView = z.strictObject({
  /** The client order id the signer derived from the approval id. */
  cloid: Cloid,
  /** The venue's order id, once it reported one. */
  venueOrderId: z.number().int().min(0).nullable(),
  /** How much filled so far, as the venue reported it; null before it did. */
  filledSize: z.string().nullable(),
  /** The average fill price, when the venue reported one. */
  averagePrice: z.string().nullable(),
  /** The venue refuses the signed order after this time (its `expiresAfter`). */
  submitBy: EpochSeconds,
  /** The venue's own text for a refusal or a cancel it made, at most 200 characters. */
  venueError: z.string().max(200).nullable(),
  /** Whether a cancel can be asked for now: the order was posted and is not final. */
  canCancel: z.boolean(),
});

export type VenueOrderView = z.infer<typeof VenueOrderView>;

export const IntentSummary = z.strictObject({
  id: IntentId,
  agent: z.strictObject({ id: AgentId, name: z.string() }),
  walletId: WalletId,
  /** An EVM chain, or a venue network for a venue intent. */
  chainId: Network,
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
  /** The venue order once signed; null for anything else, a venue withdrawal included. */
  order: VenueOrderView.nullable(),
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

/**
 * Why a sent transaction is not mined yet, as the control plane last found it.
 * - `fee_too_low`: its account nonce is the next to mine; its newest attempt's fee is not enough.
 * - `waiting_behind_nonce`: an earlier transaction of the wallet is not mined yet. A higher fee
 *   here would not help.
 * - `workspace_paused`: nothing is repriced while the workspace is paused. A cancel still works.
 * The rest stop repricing until a cancel adds an attempt: the next fee would pass the approved
 * ceiling (`fee_ceiling_reached`), the signer's window after the first signature closed
 * (`reprice_window_closed`), the transaction has every attempt the signer allows
 * (`attempts_exhausted`, which also ends cancelling), or the signer refuses to reprice it for
 * good (`reprice_refused`, for example after its mandate was revoked).
 */
export const StuckReason = z.enum([
  "fee_too_low",
  "waiting_behind_nonce",
  "workspace_paused",
  "fee_ceiling_reached",
  "reprice_window_closed",
  "attempts_exhausted",
  "reprice_refused",
]);

export type StuckReason = z.infer<typeof StuckReason>;

/**
 * One signed attempt of a transaction. Every attempt has the account nonce of the first, so at
 * most one of them is ever mined.
 */
export const TransactionAttemptView = z.strictObject({
  /** 0 for the first signature, then 1, 2, … */
  attempt: z.number().int().min(0),
  /**
   * `original`: the first signature. `reprice`: the same transaction with both fees higher.
   * `cancel`: a transfer of nothing from the wallet to itself, approved by a
   * `cancel-transaction` request, or a later reprice of one.
   */
  kind: z.enum(["original", "reprice", "cancel"]),
  hash: Hex32,
  gas: Amount,
  /** In wei per gas. */
  maxFeePerGas: Amount,
  maxPriorityFeePerGas: Amount,
  /** When the signer signed it; for the first attempt, when it was stored. */
  signedAt: EpochSeconds,
  /** For a cancel: the `cancel-transaction` request it is under, when known. */
  cancelApprovalId: ApprovalId.nullable(),
  /**
   * `mined`: the attempt the chain mined. `not_mined`: the transaction is final through another
   * attempt or another transaction at its nonce. `pending`: nothing is final yet.
   */
  status: z.enum(["pending", "mined", "not_mined"]),
  explorerUrl: z.string().nullable(),
});

export type TransactionAttemptView = z.infer<typeof TransactionAttemptView>;

/** The one transaction an approval signed, as the chain last showed it. */
export const TransactionInfo = z.strictObject({
  /** The mined attempt's hash once one is final, otherwise the newest attempt's. */
  hash: Hex32,
  /**
   * `rejected`: signed, never accepted by the chain, and no longer retried. `cancelled`: a
   * cancel was mined in its place. `superseded`: another transaction used its account nonce.
   */
  status: z.enum([
    "signed",
    "broadcast",
    "confirmed",
    "reverted",
    "stuck",
    "rejected",
    "cancelled",
    "superseded",
  ]),
  blockNumber: z.number().int().nullable(),
  explorerUrl: z.string().nullable(),
  /** Every attempt, oldest first, the first signature included. */
  attempts: z.array(TransactionAttemptView).min(1).max(64),
  /** The attempt the chain mined, once final at the chain's confirmation depth. */
  minedAttempt: z.number().int().min(0).nullable(),
  /** Why it is not mined yet, while it is `broadcast` or `stuck`; null when none was found. */
  stuckReason: StuckReason.nullable(),
  /**
   * Whether `speedUp` can add an attempt with higher fees now: a payment (never a sweep) that is
   * `broadcast` or `stuck`, in a workspace that is not paused, with no `stuckReason` that a
   * higher fee cannot cure. Says nothing about the signed-in person's role: owners and approvers
   * may speed up.
   */
  canSpeedUp: z.boolean(),
  /**
   * Whether a cancel can be requested now: the transaction is `broadcast` or `stuck`, the wallet
   * has a policy, the signer still allows attempts, and no cancel request waits already (see
   * `pendingCancelApprovalId`). Says nothing about the signed-in person's role: owners and
   * approvers may request one.
   */
  canCancel: z.boolean(),
  /** A `cancel-transaction` request for this transaction that waits for approval, if any. */
  pendingCancelApprovalId: ApprovalId.nullable(),
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
  decimals: TokenDecimals.nullable(),
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
  /** Payments of that first page left out of `intents`. */
  intentsUnreadable: UnreadableCount,
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
  "cancel-transaction",
  "retire-wallet",
  "delete-workspace",
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
    /** Where this transaction sits against the wallet's caps for its asset; null for a raw call that moves no native coin, and for a venue intent. */
    limits: z.strictObject({ maxPerTx: Amount, maxPerDay: Amount, spentToday: Amount }).nullable(),
    /** A venue intent's rules and where it stands against them; null for an EVM intent. */
    venue: z
      .strictObject({
        network: VenueNetwork,
        /** The market's cap on one order, in micro-USD; null for a withdrawal. */
        maxPerOrderUsd6: Amount.nullable(),
        maxNotionalPerDayUsd6: Amount,
        /** The notional the signer counted against the daily cap in the last 24 hours. */
        spentTodayUsd6: Amount,
        submitWindowSeconds: z.number().int().min(1),
        withdrawals: z.boolean(),
        /**
         * The account's value at the venue in USD, which bounds what can be lost there; as the
         * venue reported it through this server, not verified by the signer. Null when it could
         * not be read.
         */
        accountValueUsd: z.string().nullable(),
      })
      .nullable(),
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
    assetDecimals: TokenDecimals,
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
  z.strictObject({
    kind: z.literal("cancel-transaction"),
    wallet: WalletSummary,
    /** The payment it would stop; null when it stops a sweep. */
    intent: IntentDetail.nullable(),
    /** The `sweep-wallet` request whose transaction it would stop; null for a payment. */
    sweep: z.strictObject({ approvalId: ApprovalId, title: z.string() }).nullable(),
    /** The transaction it would stop, with every attempt so far. */
    transaction: TransactionInfo,
    /** The account nonce the cancel is signed at: the transaction's own. */
    txNonce: z.number().int().min(0),
    /**
     * The most the cancel may cost in network fees, in wei: the wallet policy's fee cap per
     * transaction when it was requested. Nothing else leaves the wallet.
     */
    maxFeeWei: Amount,
  }),
  z.strictObject({
    kind: z.literal("retire-wallet"),
    /** The wallet as this control plane mirrors it; the envelope names it as the signer holds it. */
    wallet: WalletSummary,
    /** When the signer destroys its key, unless someone cancels first. */
    destroyAfter: EpochSeconds,
  }),
  z.strictObject({
    kind: z.literal("delete-workspace"),
    /** Every wallet whose key the deletion destroys, in the envelope's order. */
    wallets: z.array(WalletSummary),
    /** When the signer destroys the keys, unless a member cancels first. */
    destroyAfter: EpochSeconds,
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

/**
 * An agent asking to be connected, as the owner who answers it sees it. `userCode` is the code
 * the agent shows on its own screen; the owner allows only when the two match.
 */
export const PairingDetail = z.strictObject({
  id: PairingId,
  clientName: z.string(),
  userCode: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired", "claimed"]),
  expiresAt: EpochSeconds,
  workspaceId: WorkspaceId.nullable(),
  walletId: WalletId.nullable(),
});

export type PairingDetail = z.infer<typeof PairingDetail>;

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

// --- export and clone -------------------------------------------------------------------------

/** A wallet's name inside a template: `requesters` point at agents through their wallets' refs. */
export const TemplateWalletRef = z.string().regex(/^w[1-9][0-9]{0,3}$/, "a wallet ref: w1, w2, …");

export type TemplateWalletRef = z.infer<typeof TemplateWalletRef>;

/**
 * A wallet policy without its ids, revision and hash chain, as a template carries it. Each of
 * `requesters` is the ref of a template wallet that has an agent.
 */
export const PolicyTemplate = PolicyDraft.extend({
  requesters: z.array(TemplateWalletRef).max(64),
});

export type PolicyTemplate = z.infer<typeof PolicyTemplate>;

/**
 * A workspace's configuration and nothing of its history: no key, address, token, intent,
 * approval, mandate, transaction or audit entry. Mandates are authority and are granted again by
 * the new workspace's people; per-person notification settings stay with each person.
 */
export const WorkspaceTemplate = z
  .strictObject({
    format: z.literal("askgina.os/workspace-template/v1"),
    name: DisplayName,
    /** A reminder only: a new workspace starts with one approver, and so at threshold 1. */
    adminThreshold: z.number().int().min(1).max(16),
    notificationDetail: NotificationDetail,
    wallets: z
      .array(
        z.strictObject({
          ref: TemplateWalletRef,
          kind: z.enum(["agent", "treasury"]),
          label: DisplayName,
          /** The agent this wallet is for; null exactly for the treasury. */
          agent: z.strictObject({ name: DisplayName }).nullable(),
          policy: PolicyTemplate.nullable(),
        }),
      )
      .max(256),
    /** The source's members. Only an installation that knows these people invites them. */
    members: z.array(z.strictObject({ userId: UserId, role: Role })).max(256),
  })
  .superRefine((template, issue) => {
    const refs = new Set(template.wallets.map((wallet) => wallet.ref));

    if (refs.size !== template.wallets.length) {
      issue.addIssue({ code: "custom", path: ["wallets"], message: "each ref at most once" });
    }

    if (template.wallets.filter((wallet) => wallet.kind === "treasury").length > 1) {
      issue.addIssue({ code: "custom", path: ["wallets"], message: "at most one treasury" });
    }

    const agentRefs = new Set(
      template.wallets.filter((wallet) => wallet.agent !== null).map((wallet) => wallet.ref),
    );

    template.wallets.forEach((wallet, index) => {
      if ((wallet.kind === "agent") !== (wallet.agent !== null)) {
        issue.addIssue({
          code: "custom",
          path: ["wallets", index, "agent"],
          message: "an agent wallet names its agent, a treasury none",
        });
      }

      for (const ref of wallet.policy?.requesters ?? []) {
        if (!agentRefs.has(ref)) {
          issue.addIssue({
            code: "custom",
            path: ["wallets", index, "policy", "requesters"],
            message: "a requester is the ref of a template wallet with an agent",
          });
        }
      }
    });

    if (new Set(template.members.map((member) => member.userId)).size !== template.members.length) {
      issue.addIssue({ code: "custom", path: ["members"], message: "each person at most once" });
    }
  });

export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplate>;

/**
 * A workspace's history as JSON Lines (`askgina.os/workspace-record/v1`): a header, then the
 * opened audit log with its hash chain, intents, transactions, policy revisions, mandates and
 * their uses, the signer's decision log, and an `end` line with the count of each. It verifies
 * offline with `node apps/server/src/lifecycle/verify-record.ts <file>`. It carries no token,
 * session, sealed value, confirmation link, push endpoint or signed transaction.
 */
export const WorkspaceRecordExport = z.strictObject({ record: z.string() });

export type WorkspaceRecordExport = z.infer<typeof WorkspaceRecordExport>;

/** What a clone takes from its source besides the wallets' configuration. */
export const CloneOptions = z.strictObject({
  name: DisplayName,
  /** Create the template's agents (new tokens, new wallets) and keep their requester entries. */
  includeAgents: z.boolean(),
  /** Create an invite for each member this installation knows, with the member's role. */
  includeMembers: z.boolean(),
});

export type CloneOptions = z.infer<typeof CloneOptions>;

/**
 * A new workspace made from a template. The person cloning is its only member and approver; each
 * wallet is new, with a new address, and signs nothing until people approve its policy in the
 * `set-policy` request listed in `approvals`.
 */
export const CloneResult = z.strictObject({
  workspace: WorkspaceDetail,
  approvals: z.array(ApprovalSummary),
  /** The new agents' tokens, shown only here. */
  agents: z.array(
    z.strictObject({ agentId: AgentId, walletId: WalletId, token: z.string(), mcpUrl: z.string() }),
  ),
  /** One link per member to invite, for the person cloning to pass on. */
  invites: z.array(
    z.strictObject({
      userId: UserId,
      displayName: z.string(),
      role: Role,
      url: z.string(),
      expiresAt: z.number().int(),
    }),
  ),
  /** The source's admin threshold, to raise to once enough approvers have joined. */
  templateAdminThreshold: z.number().int().min(1).max(16),
});

export type CloneResult = z.infer<typeof CloneResult>;

/**
 * What asking to erase the signed-in person did.
 * - `erased`: their name, passkeys, sessions, push subscriptions and notification settings are
 *   gone and they are no longer a member of any workspace; the session that asked is signed out.
 *   Their user id stays where history keeps it (audit chains, approvals, the signer's records),
 *   shown with the name "Erased person". `approvals` is empty.
 * - `waiting`: nothing is erased yet. Their passkeys still approve in some workspace, and the
 *   signer stops accepting a passkey only through a `remove-approver` request people approve on
 *   its confirmation page (which also ends every mandate that passkey granted). `approvals` lists
 *   those requests, opened now or already waiting; ask again once they are applied.
 */
export const ErasureResult = z.strictObject({
  status: z.enum(["erased", "waiting"]),
  approvals: z.array(ApprovalSummary),
});

export type ErasureResult = z.infer<typeof ErasureResult>;
