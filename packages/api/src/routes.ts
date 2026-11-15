import {
  Address,
  AgentId,
  AssertionResponse,
  AssetRef,
  ChainId,
  EpochSeconds,
  MandateId,
  SignerDecision,
  WalletId,
} from "@askgina/os-protocol";
import { z } from "zod";
import {
  AgentSummary,
  ApprovalDetail,
  ApprovalSummary,
  AuditEvent,
  AuditVerification,
  CeremonyId,
  CeremonyStart,
  CloneOptions,
  CloneResult,
  Cursor,
  DeletionPreflight,
  DisplayName,
  ErasureResult,
  IntentDetail,
  IntentSummary,
  InviteSummary,
  MandateDetail,
  MandateDraft,
  MandateSummary,
  Member,
  NotificationDetail,
  NotificationPreferences,
  PasskeySummary,
  PolicyDraft,
  PushConfig,
  PushSubscriptionInput,
  PushSubscriptionSummary,
  page,
  RegistrationResponse,
  Role,
  SessionInfo,
  WalletDetail,
  WalletSummary,
  WorkspaceDetail,
  WorkspaceRecordExport,
  WorkspaceSummary,
  WorkspaceTemplate,
} from "./dto.ts";

export type HttpMethod = "GET" | "POST" | "DELETE";

/** `public` endpoints work without a session; `session` endpoints need a signed-in person. */
export type RouteAuth = "public" | "session";

/**
 * One endpoint of the control plane. The server registers a handler per definition and the
 * client derives its types from the same object, so the two cannot drift apart.
 */
export interface RouteDefinition<
  Path extends string = string,
  Body extends z.ZodType | null = z.ZodType | null,
  Query extends z.ZodType | null = z.ZodType | null,
  Response extends z.ZodType = z.ZodType,
  Auth extends RouteAuth = RouteAuth,
> {
  method: HttpMethod;
  path: Path;
  auth: Auth;
  body: Body;
  query: Query;
  response: Response;
}

const Empty = z.strictObject({});
const NoBody = z.strictObject({});
const items = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item) });
const approvals = z.strictObject({ approvals: z.array(ApprovalSummary) });
const cursorQuery = z.strictObject({ cursor: Cursor.optional() });

// One helper per method and kind of access, each with a fixed `auth` literal in its return type.
// A single helper with an optional `auth` argument would lose the literal: the `satisfies` below
// gives every call a contextual type whose `auth` is the whole union, and inference picks that up.
function get<Path extends string, Response extends z.ZodType>(
  path: Path,
  response: Response,
): RouteDefinition<Path, null, null, Response, "session"> {
  return { method: "GET", path, auth: "session", body: null, query: null, response };
}

function publicGet<Path extends string, Response extends z.ZodType>(
  path: Path,
  response: Response,
): RouteDefinition<Path, null, null, Response, "public"> {
  return { method: "GET", path, auth: "public", body: null, query: null, response };
}

function list<Path extends string, Query extends z.ZodType, Response extends z.ZodType>(
  path: Path,
  query: Query,
  response: Response,
): RouteDefinition<Path, null, Query, Response, "session"> {
  return { method: "GET", path, auth: "session", body: null, query, response };
}

function post<Path extends string, Body extends z.ZodType, Response extends z.ZodType>(
  path: Path,
  body: Body,
  response: Response,
): RouteDefinition<Path, Body, null, Response, "session"> {
  return { method: "POST", path, auth: "session", body, query: null, response };
}

function publicPost<Path extends string, Body extends z.ZodType, Response extends z.ZodType>(
  path: Path,
  body: Body,
  response: Response,
): RouteDefinition<Path, Body, null, Response, "public"> {
  return { method: "POST", path, auth: "public", body, query: null, response };
}

function del<Path extends string, Response extends z.ZodType>(
  path: Path,
  response: Response,
): RouteDefinition<Path, null, null, Response, "session"> {
  return { method: "DELETE", path, auth: "session", body: null, query: null, response };
}

export const routes = {
  // --- session and passkeys -------------------------------------------------------------------
  getSession: publicGet("/api/v1/session", SessionInfo),
  /** First run only: the setup token printed by the server creates the first owner. */
  startSetup: publicPost(
    "/api/v1/setup/options",
    z.strictObject({ setupToken: z.string().min(16).max(128), displayName: DisplayName }),
    CeremonyStart,
  ),
  finishSetup: publicPost(
    "/api/v1/setup/verify",
    z.strictObject({ ceremonyId: CeremonyId, response: RegistrationResponse }),
    SessionInfo,
  ),
  startLogin: publicPost("/api/v1/auth/login/options", NoBody, CeremonyStart),
  finishLogin: publicPost(
    "/api/v1/auth/login/verify",
    z.strictObject({ ceremonyId: CeremonyId, response: AssertionResponse }),
    SessionInfo,
  ),
  logout: post("/api/v1/auth/logout", NoBody, Empty),

  listPasskeys: get("/api/v1/me/passkeys", items(PasskeySummary)),
  startAddPasskey: post("/api/v1/me/passkeys/options", NoBody, CeremonyStart),
  /**
   * Registers one more passkey. Where the person already approves for a workspace, this also
   * opens an `add-approver` request per workspace, which one of their existing passkeys can approve.
   */
  finishAddPasskey: post(
    "/api/v1/me/passkeys/verify",
    z.strictObject({
      ceremonyId: CeremonyId,
      response: RegistrationResponse,
      label: DisplayName,
    }),
    z.strictObject({ passkey: PasskeySummary, approvals: z.array(ApprovalSummary) }),
  ),
  /** Stops the passkey signing in at once, and opens `remove-approver` requests where it approves. */
  removePasskey: del("/api/v1/me/passkeys/:credentialId", approvals),
  /**
   * Erase the signed-in person (see `ErasureResult`). Where their passkeys still approve, this
   * first opens a `remove-approver` request per passkey and workspace and answers `waiting`;
   * once none approves anywhere, it erases and answers `erased`, clearing the session cookie.
   * Refused with `forbidden` and the detail `sign_in_again` unless the session's passkey sign-in
   * is at most 300 seconds old; with `conflict` and `last_owner` while they are the only owner of
   * a workspace not deleted, and `last_approver` while a workspace would be left with fewer
   * approvers than its admin threshold or a wallet policy's threshold (the message names the
   * workspace); with `conflict` and `try_again` when their passkeys changed meanwhile.
   */
  eraseMe: post("/api/v1/me/erase", NoBody, ErasureResult),

  // --- workspaces -----------------------------------------------------------------------------
  listWorkspaces: get("/api/v1/workspaces", items(WorkspaceSummary)),
  createWorkspace: post(
    "/api/v1/workspaces",
    z.strictObject({ name: DisplayName }),
    WorkspaceDetail,
  ),
  getWorkspace: get("/api/v1/workspaces/:workspaceId", WorkspaceDetail),
  /** Stops all signing for the workspace at once. Needs no passkey: it only removes authority. */
  pauseWorkspace: post("/api/v1/workspaces/:workspaceId/pause", NoBody, WorkspaceDetail),
  requestResume: post("/api/v1/workspaces/:workspaceId/resume", NoBody, ApprovalSummary),
  requestAdminThreshold: post(
    "/api/v1/workspaces/:workspaceId/admin-threshold",
    z.strictObject({ adminThreshold: z.number().int().min(1).max(16) }),
    ApprovalSummary,
  ),
  /**
   * Owners only. Advisory: each wallet's balances as the server reads them, and what would
   * make the deletion lose something or wait (see `DeletionBlocker`). The signer cannot check
   * balances.
   */
  getDeletionPreflight: get("/api/v1/workspaces/:workspaceId/delete/preflight", DeletionPreflight),
  /**
   * Owners only. Opens a `delete-workspace` request at the admin threshold naming every wallet
   * whose key the signer holds, as the signer reports them, and `destroyAfter`. Once people
   * approve it on the signer's confirmation page, the workspace stays paused, its wallets and
   * mandates sign nothing more, and at `destroyAfter` the keys are destroyed and its data made
   * unreadable, unless a member cancels first. Refused with `conflict` unless the workspace is
   * paused, or while another deletion waits; with `invalid_request` and the detail
   * `destroy_delay_out_of_range` for a `destroyAfter` sooner than the signer's minimum delay.
   */
  requestDeleteWorkspace: post(
    "/api/v1/workspaces/:workspaceId/delete",
    z.strictObject({ destroyAfter: EpochSeconds }),
    ApprovalSummary,
  ),
  /**
   * Any member. Cancels a deletion: the waiting `delete-workspace` request, or once applied, the
   * scheduled destruction (the workspace stays paused; its keys are kept; its mandates stay
   * ended). Refused with `conflict` when there is nothing to cancel or the keys are already gone.
   */
  cancelDeleteWorkspace: post(
    "/api/v1/workspaces/:workspaceId/delete/cancel",
    NoBody,
    WorkspaceDetail,
  ),

  // --- export and clone -----------------------------------------------------------------------
  /** Owners only. The workspace's configuration, without secrets, history or mandates. */
  exportTemplate: get("/api/v1/workspaces/:workspaceId/export/template", WorkspaceTemplate),
  /**
   * Owners only, signed in with a passkey in the last 300 seconds, else `forbidden` with the
   * detail `sign_in_again`. The workspace's history, opened, as JSON Lines that verify offline.
   * Recorded in the audit log as `workspace.exported`, which the record itself includes.
   */
  exportRecord: get("/api/v1/workspaces/:workspaceId/export/record", WorkspaceRecordExport),
  /**
   * Owners only. A new workspace from this one's template, with the signed-in person as its only
   * member and approver: new wallets with new keys, new agent tokens, and one `set-policy`
   * request per wallet that had a policy. Nothing of the source's history, keys or mandates.
   */
  cloneWorkspace: post("/api/v1/workspaces/:workspaceId/clone", CloneOptions, CloneResult),
  /**
   * Any signed-in person. A new workspace from a template file, as `cloneWorkspace` makes one.
   * Members this installation does not know are dropped. Refused with `invalid_request` for a
   * template naming a chain that is not configured here.
   */
  importTemplate: post(
    "/api/v1/workspaces/import",
    CloneOptions.extend({ template: WorkspaceTemplate }),
    CloneResult,
  ),

  // --- members --------------------------------------------------------------------------------
  createInvite: post(
    "/api/v1/workspaces/:workspaceId/invites",
    z.strictObject({ role: Role }),
    z.strictObject({
      /** The same id `listInvites` reports, so a client can tell when this link was revoked. */
      id: z.string().min(1).max(64),
      url: z.string(),
      expiresAt: z.number().int(),
    }),
  ),
  /** Owners only: invites still waiting to be used, without their tokens. */
  listInvites: get("/api/v1/workspaces/:workspaceId/invites", items(InviteSummary)),
  /** Owners only: the invite's link stops working at once. */
  revokeInvite: del("/api/v1/workspaces/:workspaceId/invites/:inviteId", NoBody),
  getInvite: publicGet(
    "/api/v1/invites/:token",
    z.strictObject({ workspaceName: z.string(), role: Role, invitedBy: z.string() }),
  ),
  /** For someone with no account yet: register a passkey and join in one step. */
  startInviteRegistration: publicPost(
    "/api/v1/invites/:token/options",
    z.strictObject({ displayName: DisplayName }),
    CeremonyStart,
  ),
  finishInviteRegistration: publicPost(
    "/api/v1/invites/:token/verify",
    z.strictObject({ ceremonyId: CeremonyId, response: RegistrationResponse }),
    SessionInfo,
  ),
  /** For someone already signed in. */
  acceptInvite: post(
    "/api/v1/invites/:token/accept",
    NoBody,
    z.strictObject({ workspaceId: z.string() }),
  ),
  setMemberRole: post(
    "/api/v1/workspaces/:workspaceId/members/:userId/role",
    z.strictObject({ role: Role }),
    z.strictObject({ member: Member, approvals: z.array(ApprovalSummary) }),
  ),
  removeMember: del("/api/v1/workspaces/:workspaceId/members/:userId", approvals),

  // --- agents and wallets ---------------------------------------------------------------------
  /** Creates the agent, its dedicated wallet and its token. The token is shown only here. */
  createAgent: post(
    "/api/v1/workspaces/:workspaceId/agents",
    z.strictObject({ name: DisplayName }),
    z.strictObject({
      agent: AgentSummary,
      wallet: WalletSummary,
      token: z.string(),
      mcpUrl: z.string(),
    }),
  ),
  rotateAgentToken: post(
    "/api/v1/workspaces/:workspaceId/agents/:agentId/rotate-token",
    NoBody,
    z.strictObject({ token: z.string() }),
  ),
  disableAgent: post(
    "/api/v1/workspaces/:workspaceId/agents/:agentId/disable",
    NoBody,
    AgentSummary,
  ),
  createTreasury: post(
    "/api/v1/workspaces/:workspaceId/treasury",
    z.strictObject({ label: DisplayName }),
    WalletSummary,
  ),
  getWallet: get("/api/v1/workspaces/:workspaceId/wallets/:walletId", WalletDetail),
  /** Opens a `set-policy` request. The policy takes effect when enough people approve it. */
  requestPolicy: post(
    "/api/v1/workspaces/:workspaceId/wallets/:walletId/policy",
    z.strictObject({ draft: PolicyDraft }),
    ApprovalSummary,
  ),
  /**
   * Owners only. Opens a `sweep-wallet` request that empties one asset of the wallet to `to`, at
   * the workspace's admin threshold, with no agent and no cap. The server reads the balance and
   * fixes the amount in the request: all of a token, or the native coin less the fee ceiling.
   * Also while the workspace is paused. The signer sends only to an address on the wallet's
   * allowlist or to the workspace's treasury, and refuses anything else after approval.
   */
  requestSweep: post(
    "/api/v1/workspaces/:workspaceId/wallets/:walletId/sweep",
    z.strictObject({ chainId: ChainId, asset: AssetRef, to: Address }),
    ApprovalSummary,
  ),
  /**
   * Owners only. Opens a `retire-wallet` request at the admin threshold: once people approve it
   * on the signer's confirmation page, the wallet signs nothing more, its mandates end, and its
   * key is destroyed at `destroyAfter` unless someone cancels first. Refused with `conflict`
   * for a wallet that is already retiring or destroyed, or while another retirement of it
   * waits; with `invalid_request` and the detail `destroy_delay_out_of_range` for a
   * `destroyAfter` sooner than the signer's minimum delay.
   */
  requestRetireWallet: post(
    "/api/v1/workspaces/:workspaceId/wallets/:walletId/retire",
    z.strictObject({ destroyAfter: EpochSeconds }),
    ApprovalSummary,
  ),
  /**
   * Owners and approvers. Cancels a retirement: the waiting `retire-wallet` request, or once
   * applied, the scheduled destruction. A cancelled retirement leaves the wallet `held`: it
   * signs nothing until a new policy is approved. Refused with `conflict` when there is nothing
   * to cancel, the key is already gone, or the workspace is being deleted.
   */
  cancelRetireWallet: post(
    "/api/v1/workspaces/:workspaceId/wallets/:walletId/retire/cancel",
    NoBody,
    WalletSummary,
  ),

  // --- mandates -------------------------------------------------------------------------------
  /**
   * Owners only. Opens a `grant-mandate` request at the workspace's admin threshold: once enough
   * people approve it on the signer's confirmation page, the agent's transfers from this wallet
   * that fit are signed with no person asked. The server checks the draft against the signer's
   * copy of the wallet's policy first (`invalid_request` with the reason as `detail`, for example
   * `over_daily_cap` or `lifetime_too_long`); the signer checks it again when it grants it.
   */
  proposeMandate: post(
    "/api/v1/workspaces/:workspaceId/wallets/:walletId/mandates",
    MandateDraft,
    ApprovalSummary,
  ),
  /** Newest first. `status`: `active` while one can still sign, `ended` once it never will. */
  listMandates: list(
    "/api/v1/workspaces/:workspaceId/mandates",
    z.strictObject({
      walletId: WalletId.optional(),
      agentId: AgentId.optional(),
      status: z.enum(["active", "ended"]).optional(),
      cursor: Cursor.optional(),
    }),
    page(MandateSummary),
  ),
  getMandate: get("/api/v1/workspaces/:workspaceId/mandates/:mandateId", MandateDetail),
  /**
   * Owners and approvers. Ends the mandate for good at the signer. Needs no passkey, because it
   * only removes authority; revoking an ended mandate changes nothing.
   */
  revokeMandate: post(
    "/api/v1/workspaces/:workspaceId/mandates/:mandateId/revoke",
    NoBody,
    MandateSummary,
  ),

  // --- approvals ------------------------------------------------------------------------------
  listApprovals: list(
    "/api/v1/workspaces/:workspaceId/approvals",
    z.strictObject({ status: z.enum(["pending", "all"]).optional(), cursor: Cursor.optional() }),
    page(ApprovalSummary),
  ),
  getApproval: get("/api/v1/approvals/:approvalId", ApprovalDetail),
  /**
   * Fetch the approvals people made on the signer's confirmation page and count them, as
   * reading the request does while it waits. Each is checked here before it counts. Approving
   * happens only on that page: the control plane has no route that takes a passkey approval.
   */
  collectApproval: post("/api/v1/approvals/:approvalId/collect", NoBody, ApprovalDetail),
  reject: post("/api/v1/approvals/:approvalId/reject", NoBody, ApprovalDetail),
  /**
   * Owners and approvers. Opens a `cancel-transaction` request for the transaction of a
   * `sweep-wallet` request (a payment is cancelled through its intent, `requestCancel`), as
   * `requestCancel` does, with the same answers and refusals. Any other kind is `not_found`.
   */
  requestSweepCancel: post(
    "/api/v1/approvals/:approvalId/cancel-transaction",
    NoBody,
    ApprovalSummary,
  ),

  // --- intents --------------------------------------------------------------------------------
  /** Newest first; with `mandateId`, only the intents signed under that mandate. */
  listIntents: list(
    "/api/v1/workspaces/:workspaceId/intents",
    z.strictObject({ cursor: Cursor.optional(), mandateId: MandateId.optional() }),
    page(IntentSummary),
  ),
  getIntent: get("/api/v1/intents/:intentId", IntentDetail),
  /**
   * Owners and approvers, with no passkey. Asks the signer now for one more attempt of the
   * payment's sent, unmined transaction with both fees raised by at least `REPRICE_BUMP_PERCENT`
   * (12 by default), at the same account nonce and under the fee ceiling people approved, and
   * offers it to the chain. Answers the intent with every attempt. Within 15 seconds of the
   * newest attempt (a second click, or the automatic reprice) no attempt is added and the
   * answer is the same. Refused with `conflict` and the reason as `detail`: `not_repriceable`
   * (not sent yet, already final, or its nonce was used), `waiting_behind_nonce`,
   * `workspace_paused`, `fee_ceiling_reached`, `reprice_window_closed`, `attempts_exhausted` or
   * `reprice_refused` (see `StuckReason`); with `internal` and `retry_later` when the chain or
   * the signer could not be reached.
   */
  speedUp: post("/api/v1/intents/:intentId/speed-up", NoBody, IntentDetail),
  /**
   * Owners and approvers. Opens a `cancel-transaction` request for the payment's sent, unmined
   * transaction: once enough people approve it on the signer's confirmation page, at the
   * wallet policy's threshold and within its lifetime, the signer signs a transfer of nothing
   * from the wallet to itself at the same account nonce, with fees up to the policy's fee cap
   * per transaction. Whichever the chain mines first wins: the payment (`confirmed`, failure
   * code `cancel_too_late`) or the cancel (`voided`). Allowed while the workspace is paused.
   * While one request waits, asking again answers that one. Refused with `conflict`: `not_sent`
   * (no transaction sent yet), `transaction_final` (already mined or replaced),
   * `attempts_exhausted`, `fee_ceiling_reached` (the policy's fee cap cannot outbid the newest
   * attempt); with `policy_denied` and `policy_missing` for a wallet without a policy.
   */
  requestCancel: post("/api/v1/intents/:intentId/cancel-transaction", NoBody, ApprovalSummary),

  // --- audit ----------------------------------------------------------------------------------
  listAudit: list("/api/v1/workspaces/:workspaceId/audit", cursorQuery, page(AuditEvent)),
  verifyAudit: get("/api/v1/workspaces/:workspaceId/audit/verify", AuditVerification),
  /** The signer's own record of what it allowed and refused, read through the control plane. */
  listSignerDecisions: list(
    "/api/v1/workspaces/:workspaceId/signer-decisions",
    z.strictObject({
      after: z
        .string()
        .regex(/^[0-9]+$/)
        .optional(),
    }),
    items(SignerDecision),
  ),

  // --- notifications --------------------------------------------------------------------------
  /** Whether this server sends Web Push, and the key a browser subscribes with. */
  getPushConfig: get("/api/v1/me/push", PushConfig),
  /** The signed-in person's devices that get notifications. */
  listPushSubscriptions: get("/api/v1/me/push-subscriptions", items(PushSubscriptionSummary)),
  /**
   * Add this browser's push subscription for the signed-in person, or update it when the browser
   * sends the same endpoint again (same id). An endpoint someone else had moves to this person
   * with a new id. Refused with `conflict` (detail `push_off`) while Web Push is off, and with
   * `invalid_request` for an endpoint outside the allowed push services (`endpoint_refused`) or
   * keys that are not a P-256 point and a 16-byte secret (`bad_subscription`).
   */
  addPushSubscription: post(
    "/api/v1/me/push-subscriptions",
    PushSubscriptionInput,
    PushSubscriptionSummary,
  ),
  /** Only the person's own devices: any other id is `not_found`. */
  removePushSubscription: del("/api/v1/me/push-subscriptions/:subscriptionId", NoBody),
  getNotificationPreferences: get("/api/v1/me/notifications", NotificationPreferences),
  /** A workspace the person is not a member of is `not_found`. Answers the settings as stored. */
  setNotificationPreferences: post(
    "/api/v1/me/notifications",
    NotificationPreferences,
    NotificationPreferences,
  ),
  /**
   * Owners only. Sets what this workspace's notifications may say; recorded in the audit log as
   * `workspace.notification_detail_set`. Needs no passkey: it never reaches the signer.
   */
  setNotificationDetail: post(
    "/api/v1/workspaces/:workspaceId/notification-detail",
    z.strictObject({ detail: NotificationDetail }),
    WorkspaceDetail,
  ),
} as const satisfies Record<string, RouteDefinition>;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

/** `{ workspaceId: string; agentId: string }` for `/…/:workspaceId/…/:agentId`. */
export type PathParams<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name | keyof PathParams<`/${Rest}`>]: string }
  : Path extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : Record<never, never>;

type BodyInput<R extends RouteDefinition> = R["body"] extends z.ZodType
  ? { body: z.input<R["body"]> }
  : unknown;
type QueryInput<R extends RouteDefinition> = R["query"] extends z.ZodType
  ? { query?: z.input<R["query"]> }
  : unknown;
type ParamsInput<R extends RouteDefinition> = keyof PathParams<R["path"]> extends never
  ? unknown
  : { params: PathParams<R["path"]> };

export type RouteInput<N extends RouteName> = ParamsInput<Routes[N]> &
  BodyInput<Routes[N]> &
  QueryInput<Routes[N]>;
export type RouteOutput<N extends RouteName> = z.infer<Routes[N]["response"]>;
