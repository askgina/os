import type { UserId, WorkspaceId } from "@askgina/os-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../context.ts";
import { invites, memberships } from "../db/schema.ts";

/**
 * Whether the workspace still has an owner other than `userId`. It locks the owner rows, so two
 * transactions demoting or removing the last two owners at once cannot both see one left: the
 * second waits, then re-reads the rows the first changed.
 *
 * Call it inside the transaction that changes the membership.
 */
export async function anotherOwnerRemains(
  tx: Executor,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<boolean> {
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")))
    .for("update");

  return owners.some((owner) => owner.userId !== userId);
}

/**
 * Delete the unused invites a member created. An invite carries its creator's authority; once
 * they stop being an owner it must not let anyone (them included) in.
 */
export async function dropInvitesOf(
  tx: Executor,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<void> {
  await tx
    .delete(invites)
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.createdBy, userId),
        isNull(invites.acceptedAt),
      ),
    );
}

/** Whether `userId` is an owner of the workspace, read inside `tx`. */
export async function isOwner(
  tx: Executor,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<boolean> {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        eq(memberships.role, "owner"),
      ),
    );

  return row !== undefined;
}
