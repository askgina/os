import type { ApprovalSummary } from "@askgina/os-api";
import type { UserId, WorkspaceId } from "@askgina/os-protocol";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { isRequest } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  approvals,
  approverCredentials,
  ceremonies,
  credentials,
  memberships,
  notificationDeliveries,
  notificationPreferences,
  pushSubscriptions,
  sessions,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { openRemoveApprover, withdrawApprover } from "../directory/approvers.ts";
import { anotherOwnerRemains, dropInvitesOf } from "../directory/members.ts";
import { engineOf } from "../execution/approvals.ts";
import { HttpError } from "../http/errors.ts";

/** The name an erased person's id is shown with wherever history still keeps the id. */
export const ERASED_NAME = "Erased person";

/** Who asked: the person in the app, or the operator with `erase-cli.ts`. */
export type Eraser = "self" | "operator";

/** What erasing needs besides the database: sealing the audit events it appends. */
export type ErasureDeps = Pick<AppContext, "db" | "sealer" | "now" | "log">;

export type ApproverRow = typeof approverCredentials.$inferSelect;

export interface ErasureOutcome {
  status: "erased" | "waiting";
  approvals: ApprovalSummary[];
}

function lastOwner(name: string, lifecycle: string): HttpError {
  const next =
    lifecycle === "deleting"
      ? "wait until its deletion is finished"
      : "make another member an owner, or delete the workspace";
  return new HttpError(
    "conflict",
    `the only owner of the workspace "${name}": ${next}, first`,
    "last_owner",
  );
}

/**
 * The most approvers any current threshold of the workspace needs: its admin threshold and each
 * wallet policy's, as the signer counts them before it lets an approver go (a wallet whose key
 * is destroyed keeps its policy there too).
 */
async function requiredApprovers(
  ctx: Pick<AppContext, "db">,
  workspaceId: WorkspaceId,
  adminThreshold: number,
): Promise<number> {
  const rows = await ctx.db
    .select({ policy: wallets.policy })
    .from(wallets)
    .where(eq(wallets.workspaceId, workspaceId));
  return Math.max(adminThreshold, ...rows.map((row) => row.policy?.approvals.threshold ?? 0));
}

/**
 * Refuse while erasing the person would leave a workspace without what it needs from them:
 * - `last_owner`: they are its only owner.
 * - `workspace_deleting`: their passkeys approve in a workspace being deleted, where the signer
 *   takes no approver change; the deletion removes every approver when it finishes.
 * - `last_approver`: without their passkeys, fewer people could approve than its admin threshold
 *   or a wallet policy's threshold needs, which is when the signer refuses their removal
 *   (`threshold_unreachable`). Someone else must become an approver first.
 * Returns their rows in `approver_credentials`, ordered by workspace and passkey.
 */
export async function checkErasable(
  ctx: Pick<AppContext, "db">,
  userId: UserId,
): Promise<ApproverRow[]> {
  const member = await ctx.db
    .select({
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      name: workspaces.name,
      lifecycle: workspaces.lifecycle,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.workspaceId));
  for (const row of member) {
    if (row.role !== "owner") continue;
    const [other] = await ctx.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, row.workspaceId),
          eq(memberships.role, "owner"),
          ne(memberships.userId, userId),
        ),
      )
      .limit(1);
    if (!other) throw lastOwner(row.name, row.lifecycle);
  }

  const approving = await ctx.db
    .select()
    .from(approverCredentials)
    .where(eq(approverCredentials.userId, userId))
    .orderBy(asc(approverCredentials.workspaceId), asc(approverCredentials.credentialId));
  // Where the signer accepts one of their passkeys: `active`, or `removing` until that is applied.
  const accepted = [
    ...new Set(approving.filter((row) => row.state !== "pending").map((row) => row.workspaceId)),
  ];
  for (const workspaceId of accepted) {
    const [workspace] = await ctx.db
      .select({
        name: workspaces.name,
        lifecycle: workspaces.lifecycle,
        adminThreshold: workspaces.adminThreshold,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace) continue;
    if (workspace.lifecycle !== "active") {
      throw new HttpError(
        "conflict",
        `the workspace "${workspace.name}" is being deleted: wait until its deletion is finished, or cancel it, first`,
        "workspace_deleting",
      );
    }
    const needed = await requiredApprovers(ctx, workspaceId, workspace.adminThreshold);
    const [others] = await ctx.db
      .select({ n: sql<number>`count(DISTINCT ${approverCredentials.userId})::int` })
      .from(approverCredentials)
      .where(
        and(
          eq(approverCredentials.workspaceId, workspaceId),
          ne(approverCredentials.userId, userId),
          inArray(approverCredentials.state, ["active", "removing"]),
        ),
      );
    if ((others?.n ?? 0) < needed) {
      throw new HttpError(
        "conflict",
        `the workspace "${workspace.name}" needs ${needed} people to approve, and fewer would be left: add another approver there first`,
        "last_approver",
      );
    }
  }
  return approving;
}

/** The `remove-approver` request still deciding about one `removing` passkey, if any. */
async function waitingRemoval(ctx: AppContext, row: ApproverRow): Promise<ApprovalSummary[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, row.workspaceId),
        eq(approvals.kind, "remove-approver"),
        eq(approvals.subjectId, row.credentialId),
        inArray(approvals.status, ["pending", "approved"]),
      ),
    );
  const engine = engineOf(ctx);
  return Promise.all(rows.filter(isRequest).map((request) => engine.summary(request)));
}

/**
 * Erase the signed-in person, as `POST /api/v1/me/erase` does (D6). The signer stops accepting a
 * passkey only through a `remove-approver` request people approve, which also ends every mandate
 * that passkey granted. So while their passkeys approve anywhere, this opens one such request
 * per passkey and workspace (requested by them, the membership kept until erasure) and answers
 * `waiting` with those requests and any already waiting; a passkey still waiting to be added is
 * withdrawn at once. Once none approves anywhere, it erases (see {@link eraseUser}).
 */
export async function eraseOnRequest(ctx: AppContext, userId: UserId): Promise<ErasureOutcome> {
  const approving = await checkErasable(ctx, userId);
  const requestedBy = { type: "user" as const, id: userId };
  const pendingIn = new Map<WorkspaceId, string[]>();
  for (const row of approving) {
    if (row.state !== "pending") continue;
    pendingIn.set(row.workspaceId, [...(pendingIn.get(row.workspaceId) ?? []), row.credentialId]);
  }
  for (const [workspaceId, credentialIds] of pendingIn) {
    await withdrawApprover(ctx, {
      workspaceId,
      userId,
      credentialIds,
      afterwards: "keep",
      requestedBy,
    });
  }
  const waiting: ApprovalSummary[] = [];
  for (const row of approving) {
    if (row.state === "active") {
      waiting.push(
        await openRemoveApprover(ctx, {
          workspaceId: row.workspaceId,
          userId,
          credentialId: row.credentialId,
          // Erasing ends the membership; until then the person keeps their role, and keeps
          // signing in so they can approve their own removal and ask again.
          afterwards: "keep",
          revokeSignIn: false,
          requestedBy,
        }),
      );
    } else if (row.state === "removing") {
      waiting.push(...(await waitingRemoval(ctx, row)));
    }
  }
  if (waiting.length > 0) return { status: "waiting", approvals: waiting };
  await eraseUser(ctx, userId, "self");
  return { status: "erased", approvals: [] };
}

/**
 * Erase a person no passkey of whom approves anywhere any more, in one transaction: end each
 * membership (refused with `last_owner` if they became a workspace's only owner meanwhile),
 * dropping the invites they created and appending `member.erased` to that workspace's audit log;
 * delete their sessions, push subscriptions, notification preferences, registration and sign-in
 * steps and passkeys; drop their notifications still pending; and keep their `users` row with the
 * name {@link ERASED_NAME}, no quiet hours and `erased_at`. Their id stays where history keeps it
 * (audit chains, approvals and their assertions, deliveries, and the signer's records), so every
 * chain still verifies. Refused with `conflict` and `try_again` if one of their passkeys was
 * enrolled meanwhile. Erasing someone already erased does nothing.
 */
export async function eraseUser(
  ctx: ErasureDeps,
  userId: UserId,
  by: Eraser,
): Promise<{ alreadyErased: boolean }> {
  const done = await ctx.db.transaction(async (tx) => {
    // Two erasures of one person run one after the other. `FOR NO KEY UPDATE` still lets rows
    // that refer to the person be inserted meanwhile, so it waits for no workspace's audit lock.
    const [user] = await tx
      .select({ erasedAt: users.erasedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (!user) throw new HttpError("not_found", "no such person");
    if (user.erasedAt !== null) return null;
    const [approving] = await tx
      .select({ workspaceId: approverCredentials.workspaceId })
      .from(approverCredentials)
      .where(eq(approverCredentials.userId, userId))
      .limit(1);
    if (approving) {
      throw new HttpError(
        "conflict",
        "this person's passkeys changed while erasing; ask again",
        "try_again",
      );
    }

    const member = await tx
      .select({
        workspaceId: memberships.workspaceId,
        role: memberships.role,
        name: workspaces.name,
        lifecycle: workspaces.lifecycle,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.workspaceId));
    const actor =
      by === "self" ? { type: "user" as const, id: userId } : { type: "system" as const, id: null };
    // As `removeMember` does it, one workspace after another in id order.
    for (const row of member) {
      if (row.role === "owner" && !(await anotherOwnerRemains(tx, row.workspaceId, userId))) {
        throw lastOwner(row.name, row.lifecycle);
      }
      await dropInvitesOf(tx, row.workspaceId, userId);
      await tx
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, userId)));
      await appendAudit(
        ctx,
        {
          workspaceId: row.workspaceId,
          actor,
          action: "member.erased",
          subject: { type: "user", id: userId },
        },
        tx,
      );
    }

    const count = async (query: PromiseLike<unknown[]>) => (await query).length;
    const removed = {
      sessions: await count(
        tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.idHash }),
      ),
      pushSubscriptions: await count(
        tx
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.userId, userId))
          .returning({ id: pushSubscriptions.id }),
      ),
      notificationsDropped: await count(
        tx
          .update(notificationDeliveries)
          .set({ state: "dropped", lastCode: "person_erased" })
          .where(
            and(
              eq(notificationDeliveries.userId, userId),
              eq(notificationDeliveries.state, "pending"),
            ),
          )
          .returning({ id: notificationDeliveries.id }),
      ),
      preferences: await count(
        tx
          .delete(notificationPreferences)
          .where(eq(notificationPreferences.userId, userId))
          .returning({ id: notificationPreferences.workspaceId }),
      ),
      ceremonies: await count(
        tx.delete(ceremonies).where(eq(ceremonies.userId, userId)).returning({ id: ceremonies.id }),
      ),
      passkeys: await count(
        tx
          .delete(credentials)
          .where(eq(credentials.userId, userId))
          .returning({ id: credentials.id }),
      ),
    };
    await tx
      .update(users)
      .set({ displayName: ERASED_NAME, quietHours: null, erasedAt: new Date(ctx.now() * 1000) })
      .where(eq(users.id, userId));
    return { workspaces: member.length, ...removed };
  });
  if (done === null) return { alreadyErased: true };
  ctx.log.info("person erased", { event: "person.erased", userId, by, ...done });
  return { alreadyErased: false };
}
