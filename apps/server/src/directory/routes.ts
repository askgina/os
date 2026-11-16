import type { ApprovalSummary, AuditEvent, PolicyDraft, Role } from "@askgina/os-api";
import {
  Address,
  AgentId,
  type AssetRef,
  type ChainId,
  newId,
  normalizePolicy,
  PROTOCOL_VERSION,
  policyHash,
  UserId,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { requireMember, workspaceIdFromPath } from "../access.ts";
import { appendAudit, openAuditDetail, verifyAudit } from "../audit.ts";
import type { AppContext, Executor, Session } from "../context.ts";
import {
  agents,
  approvals,
  approverCredentials,
  auditEvents,
  credentials,
  invites,
  memberships,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { revokeAgentMandates } from "../execution/mandates.ts";
import { walletVenueAccount } from "../execution/orders.ts";
import { fromSignerError, HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import { finishRegistration, insertPasskey, startRegistration } from "../identity/ceremonies.ts";
import { sessionInfo } from "../identity/routes.ts";
import { randomToken, sha256Hex } from "../identity/secrets.ts";
import { issueSession } from "../identity/sessions.ts";
import { cancelRequests } from "../lifecycle/state.ts";
import { openAddApprover, reconcileApprovers, withdrawApprover } from "./approvers.ts";
import type { SetPolicyDetail } from "./kinds.ts";
import { anotherOwnerRemains, dropInvitesOf, isOwner } from "./members.ts";
import {
  agentSummary,
  listMembers,
  loadWallet,
  pendingApprovalCount,
  walletSummary,
  workspaceDetail,
  workspaceLifecycle,
} from "./views.ts";

const INVITE_TTL_SECONDS = 7 * 24 * 3600;

const AUDIT_PAGE = 50;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const actorOf = (session: Session) => ({ type: "user" as const, id: session.user.id });

/** Ask the signer something; its refusals become the API's error codes. */
async function signerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw fromSignerError(error);
  }
}

/** `osa_<agent ulid>_<32 random bytes>`: recognizable in a leaked-secret scan, unguessable. */
export function mintAgentToken(agentId: AgentId) {
  const token = `osa_${agentId.slice("agt_".length)}_${randomToken(32)}`;

  // The prefix names the agent and four characters of the secret: enough to tell tokens apart.
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 35) };
}

/** A pending invite the token names, or `not_found` for any token that cannot be used. */
async function liveInvite(ctx: AppContext, token: string) {
  const [invite] = await ctx.db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, sha256Hex(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date(ctx.now() * 1000)),
      ),
    );

  // An invite is only as good as its creator's authority: once they are no longer an owner,
  // it does not let anyone in.
  if (!invite || !(await isOwner(ctx.db, invite.workspaceId, invite.createdBy))) {
    throw new HttpError("not_found", "this invite is not valid any more");
  }

  return invite;
}

/**
 * Use an invite and add the member, in one transaction. The conditional update makes the
 * invite single use even when two people race with the same link.
 */
async function joinByInvite(
  ctx: AppContext,
  tx: Executor,
  tokenHash: string,
  userId: UserId,
): Promise<{ workspaceId: WorkspaceId; role: Role }> {
  const now = new Date(ctx.now() * 1000);

  const [invite] = await tx
    .update(invites)
    .set({ acceptedBy: userId, acceptedAt: now })
    .where(
      and(eq(invites.tokenHash, tokenHash), isNull(invites.acceptedAt), gt(invites.expiresAt, now)),
    )
    .returning();

  if (!invite || !(await isOwner(tx, invite.workspaceId, invite.createdBy))) {
    throw new HttpError("not_found", "this invite is not valid any more");
  }

  const [already] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, invite.workspaceId), eq(memberships.userId, userId)));

  if (already) throw new HttpError("conflict", "you are already a member of this workspace");
  // Every member starts without approving: the signer accepts their passkeys only once the
  // workspace's approvers authorize each one.
  await tx
    .insert(memberships)
    .values({ workspaceId: invite.workspaceId, userId, role: invite.role });
  await appendAudit(
    ctx,
    {
      workspaceId: invite.workspaceId,
      actor: { type: "user", id: userId },
      action: "member.joined",
      subject: { type: "user", id: userId },
      detail: { role: invite.role, invitedBy: invite.createdBy },
    },
    tx,
  );

  return { workspaceId: invite.workspaceId, role: invite.role };
}

/** Open an `add-approver` request for each of a person's passkeys. */
async function enrollPasskeys(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<ApprovalSummary[]> {
  const rows = await ctx.db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.userId, userId), isNull(credentials.revokedAt)));

  const opened: ApprovalSummary[] = [];

  for (const row of rows) {
    opened.push(
      await openAddApprover(ctx, {
        workspaceId,
        userId,
        credentialId: row.id,
        requestedBy: { type: "user", id: userId },
      }),
    );
  }

  return opened;
}

const LAST_OWNER = "a workspace needs at least one owner";

/**
 * The member a request path names, with their role. A segment that is no user id names no member.
 */
async function pathMember(ctx: AppContext, workspaceId: WorkspaceId, segment: string) {
  const userId = UserId.safeParse(segment);

  if (!userId.success) throw new HttpError("not_found", "no such member");

  const [row] = await ctx.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId.data)));

  if (!row) throw new HttpError("not_found", "no such member");

  return { userId: userId.data, role: row.role };
}

async function loadAgent(ctx: AppContext, workspaceId: WorkspaceId, segment: string) {
  const agentId = AgentId.safeParse(segment);

  // A segment that is no agent id names no agent.
  if (!agentId.success) throw new HttpError("not_found", "no such agent");

  const [row] = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId.data), eq(agents.workspaceId, workspaceId)));

  if (!row) throw new HttpError("not_found", "no such agent");

  return row;
}

/** Create a wallet at the signer and mirror it. The signer is idempotent by wallet id. */
async function createWallet(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    walletId: WalletId;
    kind: "agent" | "treasury";
    label: string;
  },
) {
  const state = await signerCall(() => ctx.signer.createWallet(input));
  await ctx.db
    .insert(wallets)
    .values({
      id: input.walletId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      label: input.label,
      address: Address.parse(state.address.toLowerCase()),
    })
    .onConflictDoNothing();
  const [row] = await ctx.db.select().from(wallets).where(eq(wallets.id, input.walletId));

  // The only conflict other than a retry of this same wallet is a second treasury that lost a
  // race with the first (the unique index allows one per workspace).
  if (!row) throw new HttpError("conflict", "this workspace already has a treasury");

  return row;
}

/** Create a workspace whose only member, owner and approver is the signed-in person. */
export async function createWorkspaceFor(
  ctx: AppContext,
  session: Session,
  name: string,
): Promise<WorkspaceId> {
  const workspaceId = newId("ws");

  const passkeys = await ctx.db
    .select({ id: credentials.id, publicKey: credentials.publicKey })
    .from(credentials)
    .where(and(eq(credentials.userId, session.user.id), isNull(credentials.revokedAt)));

  // Trust on first use: the signer learns the creator's passkeys here and from then on only
  // changes the set with their assertions.
  await signerCall(() =>
    ctx.signer.createWorkspace({
      workspaceId,
      adminThreshold: 1,
      approvers: passkeys.map((passkey) => ({
        userId: session.user.id,
        credentialId: passkey.id,
        publicKey: passkey.publicKey.toString("base64url"),
      })),
    }),
  );
  await ctx.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      name,
      createdBy: session.user.id,
      adminThreshold: 1,
    });
    await tx.insert(memberships).values({ workspaceId, userId: session.user.id, role: "owner" });

    if (passkeys.length > 0) {
      await tx.insert(approverCredentials).values(
        passkeys.map((passkey) => ({
          workspaceId,
          credentialId: passkey.id,
          userId: session.user.id,
          state: "active" as const,
        })),
      );
    }

    await appendAudit(
      ctx,
      {
        workspaceId,
        actor: actorOf(session),
        action: "workspace.created",
        subject: { type: "workspace", id: workspaceId },
        detail: { name, approvers: passkeys.length },
      },
      tx,
    );
  });

  return workspaceId;
}

/** Create an agent with its own new wallet and token. The token exists only in the result. */
export async function createAgentIn(
  ctx: AppContext,
  session: Session,
  workspaceId: WorkspaceId,
  name: string,
) {
  // A wallet left behind by an earlier attempt whose agent insert failed is reused, so a retry
  // does not leave an orphan key at the signer.
  const [orphan] = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .leftJoin(agents, eq(agents.walletId, wallets.id))
    .where(
      and(
        eq(wallets.workspaceId, workspaceId),
        eq(wallets.kind, "agent"),
        eq(wallets.label, name),
        isNull(agents.id),
      ),
    );

  const wallet = await createWallet(ctx, {
    workspaceId,
    walletId: orphan?.id ?? newId("wal"),
    kind: "agent",
    label: name,
  });

  const agentId = newId("agt");
  const minted = mintAgentToken(agentId);

  const agent = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        id: agentId,
        workspaceId,
        name,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
        walletId: wallet.id,
      })
      .returning();

    await appendAudit(
      ctx,
      {
        workspaceId,
        actor: actorOf(session),
        action: "agent.created",
        subject: { type: "agent", id: agentId },
        detail: { name, walletId: wallet.id, address: wallet.address },
      },
      tx,
    );

    return row;
  });

  if (!agent) throw new HttpError("internal", "the agent was not stored");
  ctx.log.info("agent created", { event: "agent.created", workspaceId, agentId });

  return { agent, wallet, token: minted.token, mcpUrl: `${ctx.config.publicOrigin}/mcp` };
}

/** Create the workspace's treasury wallet; `conflict` when it has one. */
export async function createTreasuryIn(
  ctx: AppContext,
  session: Session,
  workspaceId: WorkspaceId,
  label: string,
) {
  const [existing] = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.workspaceId, workspaceId), eq(wallets.kind, "treasury")));

  if (existing) throw new HttpError("conflict", "this workspace already has a treasury");

  const wallet = await createWallet(ctx, {
    workspaceId,
    walletId: newId("wal"),
    kind: "treasury",
    label,
  });

  await appendAudit(ctx, {
    workspaceId,
    actor: actorOf(session),
    action: "treasury.created",
    subject: { type: "wallet", id: wallet.id },
    detail: { label, address: wallet.address },
  });

  return wallet;
}

/** A single-use link that lets one person join the workspace with `role`. */
export async function createInviteIn(
  ctx: AppContext,
  session: Session,
  workspaceId: WorkspaceId,
  role: Role,
): Promise<{ id: string; url: string; expiresAt: number }> {
  const token = randomToken(32);
  const expiresAt = ctx.now() + INVITE_TTL_SECONDS;
  const inviteId = `inv_${randomToken(16)}`;
  await ctx.db.transaction(async (tx) => {
    await tx.insert(invites).values({
      tokenHash: sha256Hex(token),
      id: inviteId,
      workspaceId,
      role,
      createdBy: session.user.id,
      expiresAt: new Date(expiresAt * 1000),
    });
    await appendAudit(
      ctx,
      {
        workspaceId,
        actor: actorOf(session),
        action: "invite.created",
        detail: { inviteId, role, expiresAt },
      },
      tx,
    );
  });

  // `/join/<token>` is the web app's route for accepting an invite.
  return { id: inviteId, url: `${ctx.config.publicOrigin}/join/${token}`, expiresAt };
}

/**
 * Open a `set-policy` request for a wallet, replacing one still waiting. Refused with
 * `invalid_request` for an approval threshold above the workspace's admin threshold, a chain or
 * venue network not configured here, or a requester that is not an agent of the workspace.
 */
export async function openPolicyRequest(
  ctx: AppContext,
  session: Session,
  workspaceId: WorkspaceId,
  walletId: string,
  draft: PolicyDraft,
): Promise<ApprovalSummary> {
  const { wallet } = await loadWallet(ctx, workspaceId, walletId);
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) throw new HttpError("not_found", "no such workspace");

  if (draft.approvals.threshold > workspace.adminThreshold) {
    throw new HttpError(
      "invalid_request",
      `draft.approvals.threshold: may not exceed the workspace's admin threshold (${workspace.adminThreshold}); raise that first`,
    );
  }

  const configured = new Set<string>(ctx.chains.list().map((chain) => chain.chainId));
  const unknownChain = draft.chains.find((chainId) => !configured.has(chainId));

  if (unknownChain !== undefined) {
    throw new HttpError("invalid_request", "draft.chains: a chain is not configured here");
  }

  const venueNetwork = draft.venues?.hyperliquid?.network;

  if (
    venueNetwork !== undefined &&
    !ctx.config.venues.some((venue) => venue.network === venueNetwork)
  ) {
    throw new HttpError(
      "invalid_request",
      "draft.venues: this venue network is not configured here",
      "venue_not_configured",
    );
  }

  if (draft.requesters.length > 0) {
    const found = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, draft.requesters)));

    if (found.length !== new Set(draft.requesters).size) {
      throw new HttpError("invalid_request", "draft.requesters: not an agent of this workspace");
    }
  }

  const current = await signerCall(() => ctx.signer.getWallet(wallet.id));

  const policy: WalletPolicy = normalizePolicy({
    ...draft,
    v: PROTOCOL_VERSION,
    workspaceId,
    walletId: wallet.id,
    revision: (current.policy?.revision ?? 0) + 1,
    previousHash: current.policyHash,
  });

  // One draft at a time per wallet: a newer draft replaces the one still waiting.
  const waiting = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.kind, "set-policy"),
        eq(approvals.subjectId, wallet.id),
        eq(approvals.status, "pending"),
      ),
    );

  for (const approval of waiting) await ctx.approvals.cancel(approval.id);
  const detail: SetPolicyDetail = { policy };

  return ctx.approvals.open({
    workspaceId,
    kind: "set-policy",
    subjectId: wallet.id,
    envelope: {
      walletId: wallet.id,
      policyHash: policyHash(policy),
      previousPolicyHash: current.policyHash,
    },
    threshold: workspace.adminThreshold,
    ttlSeconds: ctx.config.adminApprovalTtlSeconds,
    detail,
    requestedBy: actorOf(session),
  });
}

export function registerDirectoryRoutes(app: Hono, ctx: AppContext): void {
  // --- workspaces -----------------------------------------------------------------------------

  handle(app, ctx, "listWorkspaces", async ({ session }) => {
    const rows = await ctx.db
      .select({ workspace: workspaces, role: memberships.role })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, session.user.id))
      .orderBy(asc(workspaces.createdAt));

    const items = [];

    for (const { workspace, role } of rows) {
      items.push({
        id: workspace.id,
        name: workspace.name,
        role,
        paused: workspace.paused,
        pendingApprovals: await pendingApprovalCount(ctx, workspace.id),
        lifecycle: workspaceLifecycle(workspace),
      });
    }

    return { items };
  });

  handle(app, ctx, "createWorkspace", async ({ session, body }) => {
    const workspaceId = await createWorkspaceFor(ctx, session, body.name);

    return workspaceDetail(ctx, workspaceId, "owner");
  });

  handle(app, ctx, "getWorkspace", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    const role = await requireMember(ctx, session, workspaceId);

    try {
      await reconcileApprovers(ctx, workspaceId);
    } catch (error) {
      // The page still shows the mirror; the next visit tries again.
      ctx.log.warn("approver reconcile failed", {
        event: "approvers.reconcile_failed",
        workspaceId,
        code: error instanceof SignerError ? error.code : "unavailable",
      });
    }

    return workspaceDetail(ctx, workspaceId, role);
  });

  handle(app, ctx, "pauseWorkspace", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    // Any approver may pull the brake; it only removes authority, so it needs no passkey.
    const role = await requireMember(ctx, session, workspaceId, "approver");
    await signerCall(() => ctx.signer.pauseWorkspace(workspaceId));
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ paused: true })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.paused, false)))
        .returning({ id: workspaces.id });

      if (changed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: actorOf(session),
          action: "workspace.paused",
          subject: { type: "workspace", id: workspaceId },
        },
        tx,
      );
    });

    return workspaceDetail(ctx, workspaceId, role);
  });

  handle(app, ctx, "requestResume", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "approver");

    const [workspace] = await ctx.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace?.paused) throw new HttpError("conflict", "this workspace is not paused");

    return ctx.approvals.open({
      workspaceId,
      kind: "resume-workspace",
      subjectId: workspaceId,
      envelope: {},
      threshold: workspace.adminThreshold,
      ttlSeconds: ctx.config.adminApprovalTtlSeconds,
      detail: {},
      requestedBy: actorOf(session),
    });
  });

  handle(app, ctx, "requestAdminThreshold", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");

    const [workspace] = await ctx.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace) throw new HttpError("not_found", "no such workspace");

    const policies = await ctx.db
      .select({ policy: wallets.policy })
      .from(wallets)
      .where(eq(wallets.workspaceId, workspaceId));

    const highest = Math.max(0, ...policies.map((row) => row.policy?.approvals.threshold ?? 0));

    if (body.adminThreshold < highest) {
      throw new HttpError(
        "invalid_request",
        `adminThreshold: a wallet policy needs ${highest} approvals, and policies may not need more than the admin threshold; lower those policies first`,
      );
    }

    return ctx.approvals.open({
      workspaceId,
      kind: "set-admin-threshold",
      subjectId: workspaceId,
      envelope: { adminThreshold: body.adminThreshold },
      // The threshold in force decides whether it may change.
      threshold: workspace.adminThreshold,
      ttlSeconds: ctx.config.adminApprovalTtlSeconds,
      detail: {},
      requestedBy: actorOf(session),
    });
  });

  // --- members --------------------------------------------------------------------------------

  handle(app, ctx, "createInvite", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");

    return createInviteIn(ctx, session, workspaceId, body.role);
  });

  handle(app, ctx, "listInvites", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");

    const rows = await ctx.db
      .select({ invite: invites, creator: users })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.createdBy))
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date(ctx.now() * 1000)),
        ),
      )
      .orderBy(asc(invites.createdAt));

    return {
      items: rows.map(({ invite, creator }) => ({
        id: invite.id,
        role: invite.role,
        createdBy: { id: creator.id, displayName: creator.displayName },
        createdAt: seconds(invite.createdAt),
        expiresAt: seconds(invite.expiresAt),
      })),
    };
  });

  handle(app, ctx, "revokeInvite", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    await ctx.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(invites)
        .where(
          and(
            eq(invites.workspaceId, workspaceId),
            eq(invites.id, params.inviteId),
            isNull(invites.acceptedAt),
          ),
        )
        .returning({ id: invites.id });

      if (deleted.length === 0) throw new HttpError("not_found", "no such invite");
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: actorOf(session),
          action: "invite.revoked",
          detail: { inviteId: params.inviteId },
        },
        tx,
      );
    });

    return {};
  });

  handle(app, ctx, "getInvite", async ({ params }) => {
    const invite = await liveInvite(ctx, params.token);

    const [row] = await ctx.db
      .select({ workspaceName: workspaces.name, invitedBy: users.displayName })
      .from(workspaces)
      .innerJoin(users, eq(users.id, invite.createdBy))
      .where(eq(workspaces.id, invite.workspaceId));

    if (!row) throw new HttpError("not_found", "this invite is not valid any more");

    return { workspaceName: row.workspaceName, role: invite.role, invitedBy: row.invitedBy };
  });

  handle(app, ctx, "startInviteRegistration", async ({ params, body }) => {
    const invite = await liveInvite(ctx, params.token);

    return startRegistration(ctx, {
      kind: "invite",
      userId: newId("usr"),
      displayName: body.displayName,
      context: { displayName: body.displayName, tokenHash: invite.tokenHash },
    });
  });

  handle(app, ctx, "finishInviteRegistration", async ({ params, body, c }) => {
    const { ceremony, passkey } = await finishRegistration(ctx, {
      ceremonyId: body.ceremonyId,
      kind: "invite",
      response: body.response,
    });

    // The ceremony was started for one invite; it cannot finish another.
    if (ceremony.context.tokenHash !== sha256Hex(params.token)) {
      throw new HttpError("not_found", "this invite is not valid any more");
    }

    const { userId } = ceremony;

    // startInviteRegistration stores the new person's id with every invite ceremony.
    if (userId === null) throw new Error("an invite ceremony without its user id");
    const displayName = ceremony.context.displayName ?? "Member";

    const joined = await ctx.db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, displayName });
      await insertPasskey(tx, userId, passkey, "First passkey");
      const result = await joinByInvite(ctx, tx, sha256Hex(params.token), userId);
      await issueSession(ctx, c, { userId, credentialId: passkey.id }, tx);

      return result;
    });

    if (joined.role !== "viewer") await enrollPasskeys(ctx, joined.workspaceId, userId);

    return sessionInfo(ctx, { id: userId, displayName });
  });

  handle(app, ctx, "acceptInvite", async ({ session, params }) => {
    const joined = await ctx.db.transaction((tx) =>
      joinByInvite(ctx, tx, sha256Hex(params.token), session.user.id),
    );

    if (joined.role !== "viewer") await enrollPasskeys(ctx, joined.workspaceId, session.user.id);

    return { workspaceId: joined.workspaceId };
  });

  handle(app, ctx, "setMemberRole", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    const { userId, role: current } = await pathMember(ctx, workspaceId, params.userId);
    const demotingOwner = current === "owner" && body.role !== "owner";

    // Checked early for a clear answer, and again inside the transaction that changes the role.
    if (demotingOwner && !(await anotherOwnerRemains(ctx.db, workspaceId, userId))) {
      throw new HttpError("conflict", LAST_OWNER);
    }

    const setRole = async (role: Role) => {
      await ctx.db.transaction(async (tx) => {
        if (demotingOwner) {
          if (!(await anotherOwnerRemains(tx, workspaceId, userId))) {
            throw new HttpError("conflict", LAST_OWNER);
          }

          await dropInvitesOf(tx, workspaceId, userId);
        }

        await tx
          .update(memberships)
          .set({ role })
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
        await appendAudit(
          ctx,
          {
            workspaceId,
            actor: actorOf(session),
            action: "member.role_changed",
            subject: { type: "user", id: userId },
            detail: { role },
          },
          tx,
        );
      });
    };

    let opened: ApprovalSummary[] = [];

    if (body.role === current) {
      // Nothing to change.
    } else if (body.role === "viewer") {
      // The role drops only once the signer stops accepting the member's passkeys.
      opened = await withdrawApprover(ctx, {
        workspaceId,
        userId,
        afterwards: "viewer",
        requestedBy: actorOf(session),
      });

      if (opened.length === 0) await setRole("viewer");
    } else {
      await setRole(body.role);

      if (current === "viewer") opened = await enrollPasskeys(ctx, workspaceId, userId);
    }

    const member = (await listMembers(ctx, workspaceId, "owner")).find((m) => m.user.id === userId);

    if (!member) throw new HttpError("not_found", "no such member");

    return { member, approvals: opened };
  });

  handle(app, ctx, "removeMember", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    const { userId, role: current } = await pathMember(ctx, workspaceId, params.userId);

    if (current === "owner" && !(await anotherOwnerRemains(ctx.db, workspaceId, userId))) {
      throw new HttpError("conflict", LAST_OWNER);
    }

    const opened = await withdrawApprover(ctx, {
      workspaceId,
      userId,
      afterwards: "remove",
      requestedBy: actorOf(session),
    });

    if (opened.length === 0) {
      await ctx.db.transaction(async (tx) => {
        if (current === "owner") {
          if (!(await anotherOwnerRemains(tx, workspaceId, userId))) {
            throw new HttpError("conflict", LAST_OWNER);
          }
        }

        await dropInvitesOf(tx, workspaceId, userId);
        await tx
          .delete(memberships)
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
        await appendAudit(
          ctx,
          {
            workspaceId,
            actor: actorOf(session),
            action: "member.removed",
            subject: { type: "user", id: userId },
          },
          tx,
        );
      });
    }

    return { approvals: opened };
  });

  // --- agents and wallets ---------------------------------------------------------------------

  handle(app, ctx, "createAgent", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    const created = await createAgentIn(ctx, session, workspaceId, body.name);

    return {
      agent: agentSummary(created.agent),
      wallet: walletSummary(created.wallet, created.agent.id),
      token: created.token,
      mcpUrl: created.mcpUrl,
    };
  });

  handle(app, ctx, "rotateAgentToken", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    const agent = await loadAgent(ctx, workspaceId, params.agentId);

    if (agent.status !== "active") throw new HttpError("conflict", "this agent is disabled");
    const minted = mintAgentToken(agent.id);
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ tokenHash: minted.hash, tokenPrefix: minted.prefix })
        .where(eq(agents.id, agent.id));
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: actorOf(session),
          action: "agent.token_rotated",
          subject: { type: "agent", id: agent.id },
        },
        tx,
      );
    });

    return { token: minted.token };
  });

  handle(app, ctx, "disableAgent", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");
    const agent = await loadAgent(ctx, workspaceId, params.agentId);

    const updated = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ status: "disabled" })
        .where(eq(agents.id, agent.id))
        .returning();

      if (agent.status === "active") {
        await appendAudit(
          ctx,
          {
            workspaceId,
            actor: actorOf(session),
            action: "agent.disabled",
            subject: { type: "agent", id: agent.id },
          },
          tx,
        );
      }

      return row;
    });

    if (!updated) throw new HttpError("not_found", "no such agent");
    // The gateway already refuses the agent; its mandates end at the signer too, so nothing is
    // signed under them even by a control plane that ignored the status. Done after the status
    // change, so a grant applied meanwhile sees the agent disabled and revokes itself.
    await revokeAgentMandates(ctx, updated, actorOf(session)).then(
      (revoked) =>
        ctx.log.info("agent mandates revoked", {
          event: "agent.mandates_revoked",
          workspaceId,
          agentId: agent.id,
          count: revoked,
        }),
      (cause: unknown) =>
        ctx.log.warn("revoking an agent's mandates failed", {
          workspaceId,
          agentId: agent.id,
          code: cause instanceof SignerError ? cause.code : "unreachable",
        }),
    );

    // Disabling is removal: the agent's payments still waiting for people end too, and
    // the signer is told at once, so none of them can be approved and signed later.
    const payments = await ctx.db
      .select({ id: approvals.id, workspaceId: approvals.workspaceId })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.kind, "approve-intent"),
          eq(approvals.status, "pending"),
          sql`${approvals.envelope}->>'agentId' = ${agent.id}`,
        ),
      );

    await cancelRequests(ctx, payments).then(
      (cancelled) =>
        ctx.log.info("agent payments cancelled", {
          event: "agent.payments_cancelled",
          workspaceId,
          agentId: agent.id,
          count: cancelled,
        }),
      (cause: unknown) =>
        ctx.log.warn("cancelling an agent's payments failed", {
          workspaceId,
          agentId: agent.id,
          error: cause instanceof Error ? cause.name : "unknown",
        }),
    );

    return agentSummary(updated);
  });

  handle(app, ctx, "createTreasury", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");

    return walletSummary(await createTreasuryIn(ctx, session, workspaceId, body.label), null);
  });

  handle(app, ctx, "getWallet", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId);
    const { wallet, agentId } = await loadWallet(ctx, workspaceId, params.walletId);
    const state = await signerCall(() => ctx.signer.getWallet(wallet.id));
    const policy = state.policy;
    const chains = policy?.chains ?? ctx.chains.list().map((chain) => chain.chainId);

    const assets: { chainId: ChainId; asset: AssetRef }[] = chains.map((chainId) => ({
      chainId,
      asset: "native",
    }));

    for (const limit of policy?.assets ?? []) {
      if (limit.asset !== "native") assets.push({ chainId: limit.chainId, asset: limit.asset });
    }

    const [balances, venue] = await Promise.all([
      ctx.chains.balances(wallet.address, assets),
      walletVenueAccount(ctx, wallet, policy, state.venueSpent),
    ]);

    const [pending] = await ctx.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.kind, "set-policy"),
          eq(approvals.subjectId, wallet.id),
          eq(approvals.status, "pending"),
        ),
      );

    const detail = {
      // The signer's copy of the policy is the one that is enforced.
      ...walletSummary({ ...wallet, policy, policyHash: state.policyHash }, agentId),
      balances,
      spent: state.spent,
      pendingPolicyApprovalId: pending?.id ?? null,
    };

    // A wallet without venue rules has no venue account to show.
    if (venue === null) return detail;

    return { ...detail, venue };
  });

  handle(app, ctx, "requestPolicy", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId, "owner");

    return openPolicyRequest(ctx, session, workspaceId, params.walletId, body.draft);
  });

  // --- audit ----------------------------------------------------------------------------------

  handle(app, ctx, "listAudit", async ({ session, params, query }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId);
    const before = query.cursor === undefined ? null : Number.parseInt(query.cursor, 10);

    if (before !== null && !Number.isSafeInteger(before)) {
      throw new HttpError("invalid_request", "cursor: not a cursor from this list");
    }

    const rows = await ctx.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          // `and` leaves out an undefined condition.
          before === null ? undefined : lt(auditEvents.seq, before),
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(AUDIT_PAGE + 1);

    const pageRows = rows.slice(0, AUDIT_PAGE);
    const names = await actorNames(ctx, pageRows);
    const items: AuditEvent[] = [];

    for (const row of pageRows) {
      const detail = await openAuditDetail(ctx, row);
      items.push({
        seq: row.seq,
        at: seconds(row.at),
        actor: {
          type: row.actorType,
          id: row.actorId,
          name: row.actorId === null ? null : (names.get(row.actorId) ?? null),
        },
        action: row.action,
        subject:
          row.subjectType === null || row.subjectId === null
            ? null
            : { type: row.subjectType, id: row.subjectId },
        detail,
        previousHash: row.previousHash,
        hash: row.hash,
      });
    }

    const last = pageRows.at(-1);

    return {
      items,
      nextCursor: rows.length > AUDIT_PAGE && last ? String(last.seq) : null,
    };
  });

  handle(app, ctx, "verifyAudit", async ({ session, params }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId);

    return verifyAudit(ctx, workspaceId);
  });

  handle(app, ctx, "listSignerDecisions", async ({ session, params, query }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    await requireMember(ctx, session, workspaceId);

    const response = await signerCall(() =>
      ctx.signer.listDecisions(
        workspaceId,
        query.after === undefined ? {} : { after: Number(query.after) },
      ),
    );

    return { items: response.decisions };
  });
}

async function actorNames(
  ctx: AppContext,
  rows: { actorType: string; actorId: string | null }[],
): Promise<Map<string, string>> {
  // An actor id that is no user or agent id names nobody, so it gets no name.
  const userIds = rows.flatMap((row) => {
    const id = UserId.safeParse(row.actorType === "user" ? row.actorId : null);

    return id.success ? [id.data] : [];
  });

  const agentIds = rows.flatMap((row) => {
    const id = AgentId.safeParse(row.actorType === "agent" ? row.actorId : null);

    return id.success ? [id.data] : [];
  });

  const names = new Map<string, string>();

  if (userIds.length > 0) {
    const found = await ctx.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds));

    for (const row of found) names.set(row.id, row.name);
  }

  if (agentIds.length > 0) {
    const found = await ctx.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds));

    for (const row of found) names.set(row.id, row.name);
  }

  return names;
}
