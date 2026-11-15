import type { ApprovalId, PushSubscriptionId, UserId, WorkspaceId } from "@askgina/os-protocol";
import { and, asc, count, eq, exists, gt, inArray, ne, notExists, sql } from "drizzle-orm";
import type { Executor } from "../context.ts";
import {
  approvalAssertions,
  approvals,
  approverCredentials,
  memberships,
  notificationPreferences,
  pushSubscriptions,
} from "../db/schema.ts";

/** One device that hears about a workspace's requests, and whether its person wants reminders. */
export interface PushRecipient {
  userId: UserId;
  subscriptionId: PushSubscriptionId;
  reminders: boolean;
}

/**
 * The membership row is someone who can approve: an owner or approver with a passkey the signer
 * accepts in that workspace (`active`, or `removing` until that request ends). Viewers and
 * members whose passkey still waits to be added cannot, and are never notified.
 */
const approves = and(
  inArray(memberships.role, ["owner", "approver"]),
  exists(
    sql`(SELECT 1 FROM ${approverCredentials}
          WHERE ${approverCredentials.workspaceId} = ${memberships.workspaceId}
            AND ${approverCredentials.userId} = ${memberships.userId}
            AND ${approverCredentials.state} IN ('active', 'removing'))`,
  ),
);

const preferencesOfMember = and(
  eq(notificationPreferences.userId, memberships.userId),
  eq(notificationPreferences.workspaceId, memberships.workspaceId),
);
const webPushOn = sql<boolean>`coalesce(${notificationPreferences.webPush}, true)`;
const remindersOn = sql<boolean>`coalesce(${notificationPreferences.reminders}, true)`;

/**
 * Every device that hears about a request in `workspaceId`: each push subscription of each
 * person who can approve there and has not turned Web Push off for it. Ordered by subscription.
 */
export async function approvalRecipients(
  db: Executor,
  workspaceId: WorkspaceId,
): Promise<PushRecipient[]> {
  return db
    .select({
      userId: pushSubscriptions.userId,
      subscriptionId: pushSubscriptions.id,
      reminders: remindersOn,
    })
    .from(memberships)
    .innerJoin(pushSubscriptions, eq(pushSubscriptions.userId, memberships.userId))
    .leftJoin(notificationPreferences, preferencesOfMember)
    .where(and(eq(memberships.workspaceId, workspaceId), approves, webPushOn))
    .orderBy(asc(pushSubscriptions.id));
}

/**
 * Whether `userId` still hears about requests in `workspaceId`, as {@link approvalRecipients}
 * decides it, and whether they want reminders; null when they do not. Checked again when a
 * notification goes out, which may be hours after it was written.
 */
export async function recipientNow(
  db: Executor,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<{ reminders: boolean } | null> {
  const [found] = await db
    .select({ reminders: remindersOn })
    .from(memberships)
    .leftJoin(notificationPreferences, preferencesOfMember)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        approves,
        webPushOn,
      ),
    );
  return found ?? null;
}

/**
 * How many requests wait for `userId`'s passkey across their workspaces at `now`: those they
 * can approve and have not approved yet. A mandate's use is never one.
 */
export async function pendingFor(db: Executor, userId: UserId, now: number): Promise<number> {
  const [row] = await db
    .select({ pending: count() })
    .from(approvals)
    .innerJoin(
      memberships,
      and(eq(memberships.workspaceId, approvals.workspaceId), eq(memberships.userId, userId)),
    )
    .where(
      and(
        approves,
        eq(approvals.status, "pending"),
        ne(approvals.kind, "mandate-use"),
        gt(approvals.expiresAt, new Date(now * 1000)),
        notExists(
          sql`(SELECT 1 FROM ${approvalAssertions}
                WHERE ${approvalAssertions.approvalId} = ${approvals.id}
                  AND ${approvalAssertions.userId} = ${userId})`,
        ),
      ),
    );
  return row?.pending ?? 0;
}

/** Whether `userId` already approved the request: they need no notification about it. */
export async function approvedBy(
  db: Executor,
  approvalId: ApprovalId,
  userId: UserId,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: approvalAssertions.userId })
    .from(approvalAssertions)
    .where(
      and(eq(approvalAssertions.approvalId, approvalId), eq(approvalAssertions.userId, userId)),
    );
  return row !== undefined;
}
