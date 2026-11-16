import type {
  AgentSummary,
  ApproverState,
  Member,
  Role,
  WalletLifecycle,
  WalletSummary,
  WorkspaceDetail,
  WorkspaceLifecycle,
} from "@askgina/os-api";
import { VenueNetwork, type WorkspaceId } from "@askgina/os-protocol";
import { and, asc, count, eq, ne } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import {
  agents,
  approvals,
  approverCredentials,
  credentials,
  memberships,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function agentSummary(row: typeof agents.$inferSelect): AgentSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    walletId: row.walletId,
    tokenPrefix: row.tokenPrefix,
    createdAt: seconds(row.createdAt),
    lastSeenAt: row.lastSeenAt === null ? null : seconds(row.lastSeenAt),
  };
}

/** A wallet's lifecycle as its mirror row holds it. */
export function walletLifecycle(
  row: Pick<typeof wallets.$inferSelect, "lifecycle" | "destroyAfter">,
): WalletLifecycle {
  return {
    state: row.lifecycle,
    destroyAfter: row.destroyAfter === null ? null : seconds(row.destroyAfter),
  };
}

/** A workspace's lifecycle as its row holds it. */
export function workspaceLifecycle(
  row: Pick<typeof workspaces.$inferSelect, "lifecycle" | "destroyAfter" | "deletedAt">,
): WorkspaceLifecycle {
  return {
    state: row.lifecycle,
    destroyAfter: row.destroyAfter === null ? null : seconds(row.destroyAfter),
    deletedAt: row.deletedAt === null ? null : seconds(row.deletedAt),
  };
}

export function walletSummary(
  row: typeof wallets.$inferSelect,
  agentId: AgentSummary["id"] | null,
): WalletSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    address: row.address,
    agentId,
    policy: row.policy,
    policyHash: row.policyHash,
    lifecycle: walletLifecycle(row),
  };
}

/** A wallet of the workspace with the agent it belongs to, or `not_found`. */
export async function loadWallet(ctx: AppContext, workspaceId: WorkspaceId, walletId: string) {
  const [row] = await ctx.db
    .select({ wallet: wallets, agentId: agents.id })
    .from(wallets)
    .leftJoin(agents, eq(agents.walletId, wallets.id))
    .where(and(eq(wallets.id, walletId as never), eq(wallets.workspaceId, workspaceId)));
  if (!row) throw new HttpError("not_found", "no such wallet");
  return row;
}

export async function pendingApprovalCount(
  ctx: AppContext,
  workspaceId: WorkspaceId,
): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, "pending"),
        ne(approvals.kind, "mandate-use"),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The workspace's members. `viewerRole` is the asking person's role: only owners see the public
 * keys of passkeys waiting to approve, which an operator needs to enroll one at the signer.
 */
export async function listMembers(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  viewerRole: Role,
): Promise<Member[]> {
  const rows = await ctx.db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.createdAt));
  const approverRows = await ctx.db
    .select({
      userId: approverCredentials.userId,
      state: approverCredentials.state,
      credentialId: credentials.id,
      publicKey: credentials.publicKey,
      label: credentials.label,
    })
    .from(approverCredentials)
    .innerJoin(credentials, eq(credentials.id, approverCredentials.credentialId))
    .where(eq(approverCredentials.workspaceId, workspaceId));
  return rows.map(({ membership, user }) => {
    const states = approverRows.filter((row) => row.userId === user.id).map((row) => row.state);
    // A passkey being removed is still accepted by the signer until the removal is applied.
    const approver: ApproverState =
      states.includes("active") || states.includes("removing")
        ? "active"
        : states.includes("pending")
          ? "pending"
          : "none";
    return {
      user: { id: user.id, displayName: user.displayName },
      role: membership.role,
      approver,
      joinedAt: seconds(membership.createdAt),
      pendingPasskeys:
        viewerRole === "owner"
          ? approverRows
              .filter((row) => row.userId === user.id && row.state === "pending")
              .map((row) => ({
                credentialId: row.credentialId,
                publicKey: row.publicKey.toString("base64url"),
                label: row.label,
              }))
          : [],
    };
  });
}

export async function workspaceDetail(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  role: Role,
): Promise<WorkspaceDetail> {
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new HttpError("not_found", "no such workspace");
  const agentRows = await ctx.db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.createdAt));
  const walletRows = await ctx.db
    .select()
    .from(wallets)
    .where(eq(wallets.workspaceId, workspaceId))
    .orderBy(asc(wallets.createdAt));
  return {
    id: workspace.id,
    name: workspace.name,
    role,
    paused: workspace.paused,
    pendingApprovals: await pendingApprovalCount(ctx, workspaceId),
    lifecycle: workspaceLifecycle(workspace),
    adminThreshold: workspace.adminThreshold,
    notificationDetail: workspace.notificationDetail,
    members: await listMembers(ctx, workspaceId, role),
    // Only owners see the passkeys that wait to approve, and the command that enrolls them.
    ...(role === "owner" ? { signerAdminCommand: ctx.config.signerAdminCommand } : {}),
    agents: agentRows.map(agentSummary),
    wallets: walletRows.map((wallet) =>
      walletSummary(wallet, agentRows.find((agent) => agent.walletId === wallet.id)?.id ?? null),
    ),
    chains: ctx.chains.list(),
    venueNetworks: VenueNetwork.options.filter((network) =>
      ctx.config.venues.some((venue) => venue.network === network),
    ),
  };
}
