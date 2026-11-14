import { AssertionResponse, SignerDecision } from "@askgina/os-protocol";
import { z } from "zod";
import {
  AgentSummary,
  ApprovalDetail,
  ApprovalSummary,
  ApproveRequest,
  AuditEvent,
  AuditVerification,
  CeremonyId,
  CeremonyStart,
  Cursor,
  DisplayName,
  IntentDetail,
  IntentSummary,
  InviteSummary,
  Member,
  PasskeySummary,
  PolicyDraft,
  page,
  RegistrationResponse,
  Role,
  SessionInfo,
  WalletDetail,
  WalletSummary,
  WebAuthnOptions,
  WorkspaceDetail,
  WorkspaceSummary,
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

  // --- members --------------------------------------------------------------------------------
  createInvite: post(
    "/api/v1/workspaces/:workspaceId/invites",
    z.strictObject({ role: Role }),
    z.strictObject({ url: z.string(), expiresAt: z.number().int() }),
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

  // --- approvals ------------------------------------------------------------------------------
  listApprovals: list(
    "/api/v1/workspaces/:workspaceId/approvals",
    z.strictObject({ status: z.enum(["pending", "all"]).optional(), cursor: Cursor.optional() }),
    page(ApprovalSummary),
  ),
  getApproval: get("/api/v1/approvals/:approvalId", ApprovalDetail),
  /** WebAuthn request options whose challenge is the envelope's digest. */
  startApproval: post(
    "/api/v1/approvals/:approvalId/options",
    NoBody,
    z.strictObject({ options: WebAuthnOptions }),
  ),
  approve: post("/api/v1/approvals/:approvalId/approve", ApproveRequest, ApprovalDetail),
  reject: post("/api/v1/approvals/:approvalId/reject", NoBody, ApprovalDetail),

  // --- intents --------------------------------------------------------------------------------
  listIntents: list("/api/v1/workspaces/:workspaceId/intents", cursorQuery, page(IntentSummary)),
  getIntent: get("/api/v1/intents/:intentId", IntentDetail),

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
