import type { ApprovalSummary } from "@askgina/os-api";
import type { UserId, WorkspaceId } from "@askgina/os-protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { approvals, approverCredentials, credentials, workspaces } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";

/** What happens to a membership once the last of its passkeys stops approving. */
export type AfterRemoval = "keep" | "viewer" | "remove";

export interface AddApproverDetail {
  userId: UserId;
  credentialId: string;
}

export interface RemoveApproverDetail {
  userId: UserId;
  credentialId: string;
  afterwards: AfterRemoval;
  /**
   * The person removed the passkey itself. Its sign-in ends once no workspace's signer accepts
   * it any more: ending it earlier would leave someone unable to approve their own removal.
   */
  revokeSignIn?: boolean;
}

type Requester = { type: "user"; id: string };

async function adminThreshold(ctx: AppContext, workspaceId: WorkspaceId): Promise<number> {
  const [row] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!row) throw new HttpError("not_found", "no such workspace");

  return row.adminThreshold;
}

/**
 * Ask the workspace's approvers to let one more passkey approve. Until they do, the passkey is
 * `pending`: its owner can look but the signer does not accept it.
 */
export async function openAddApprover(
  ctx: AppContext,
  input: { workspaceId: WorkspaceId; userId: UserId; credentialId: string; requestedBy: Requester },
): Promise<ApprovalSummary> {
  const [credential] = await ctx.db
    .select({ publicKey: credentials.publicKey })
    .from(credentials)
    .where(and(eq(credentials.id, input.credentialId), isNull(credentials.revokedAt)));

  if (!credential) throw new HttpError("not_found", "no such passkey");
  const detail: AddApproverDetail = { userId: input.userId, credentialId: input.credentialId };

  return ctx.approvals.open({
    workspaceId: input.workspaceId,
    kind: "add-approver",
    subjectId: input.credentialId,
    envelope: {
      userId: input.userId,
      credentialId: input.credentialId,
      publicKey: credential.publicKey.toString("base64url"),
    },
    threshold: await adminThreshold(ctx, input.workspaceId),
    ttlSeconds: ctx.config.adminApprovalTtlSeconds,
    detail,
    requestedBy: input.requestedBy,
    alongside: async (tx) => {
      await tx
        .insert(approverCredentials)
        .values({
          workspaceId: input.workspaceId,
          credentialId: input.credentialId,
          userId: input.userId,
          state: "pending",
        })
        .onConflictDoNothing();
    },
  });
}

/**
 * Ask the workspace's approvers to stop accepting one passkey. The signer keeps accepting it
 * until the request is applied, so the passkey is `removing` meanwhile.
 */
export async function openRemoveApprover(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    userId: UserId;
    credentialId: string;
    afterwards: AfterRemoval;
    revokeSignIn: boolean;
    requestedBy: Requester;
  },
): Promise<ApprovalSummary> {
  const detail: RemoveApproverDetail = {
    userId: input.userId,
    credentialId: input.credentialId,
    afterwards: input.afterwards,
    revokeSignIn: input.revokeSignIn,
  };

  return ctx.approvals.open({
    workspaceId: input.workspaceId,
    kind: "remove-approver",
    subjectId: input.credentialId,
    envelope: { userId: input.userId, credentialId: input.credentialId },
    threshold: await adminThreshold(ctx, input.workspaceId),
    ttlSeconds: ctx.config.adminApprovalTtlSeconds,
    detail,
    requestedBy: input.requestedBy,
    alongside: async (tx) => {
      await tx
        .update(approverCredentials)
        .set({ state: "removing" })
        .where(
          and(
            eq(approverCredentials.workspaceId, input.workspaceId),
            eq(approverCredentials.credentialId, input.credentialId),
          ),
        );
    },
  });
}

/**
 * Take a member's passkeys out of a workspace: active ones through `remove-approver` requests,
 * pending ones by cancelling their `add-approver` requests. Returns the requests opened; when
 * there are none, nothing at the signer needs to change.
 */
export async function withdrawApprover(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    userId: UserId;
    credentialIds?: string[];
    afterwards: AfterRemoval;
    /** See {@link RemoveApproverDetail.revokeSignIn}. */
    revokeSignIn?: boolean;
    requestedBy: Requester;
  },
): Promise<ApprovalSummary[]> {
  const rows = await ctx.db
    .select()
    .from(approverCredentials)
    .where(
      and(
        eq(approverCredentials.workspaceId, input.workspaceId),
        eq(approverCredentials.userId, input.userId),
        ...(input.credentialIds === undefined
          ? []
          : [inArray(approverCredentials.credentialId, input.credentialIds)]),
      ),
    );

  // A removal already waiting decides what happens to the membership; a second one would race it.
  if (rows.some((row) => row.state === "removing")) {
    throw new HttpError("conflict", "a change to this member's passkeys is already waiting");
  }

  const pendingIds = rows.filter((row) => row.state === "pending").map((r) => r.credentialId);

  if (pendingIds.length > 0) {
    const open = await ctx.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, input.workspaceId),
          eq(approvals.kind, "add-approver"),
          eq(approvals.status, "pending"),
          inArray(approvals.subjectId, pendingIds),
        ),
      );

    for (const approval of open) await ctx.approvals.cancel(approval.id);
    // Cancelling runs the kind's `abandon`, which deletes the row; this also covers a request
    // that ended some other way and left its row behind.
    await ctx.db
      .delete(approverCredentials)
      .where(
        and(
          eq(approverCredentials.workspaceId, input.workspaceId),
          eq(approverCredentials.state, "pending"),
          inArray(approverCredentials.credentialId, pendingIds),
        ),
      );
  }

  const opened: ApprovalSummary[] = [];

  for (const row of rows) {
    if (row.state !== "active") continue;
    opened.push(
      await openRemoveApprover(ctx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        credentialId: row.credentialId,
        afterwards: input.afterwards,
        revokeSignIn: input.revokeSignIn ?? false,
        requestedBy: input.requestedBy,
      }),
    );
  }

  return opened;
}

/**
 * Notice approvers an operator enrolled directly at the signer (its admin CLI, the way back in
 * when no approver is left). Each of our `pending` passkeys the signer already accepts becomes
 * `active`, and the request that waited for it is cancelled.
 */
export async function reconcileApprovers(ctx: AppContext, workspaceId: WorkspaceId): Promise<void> {
  const pending = await ctx.db
    .select()
    .from(approverCredentials)
    .where(
      and(
        eq(approverCredentials.workspaceId, workspaceId),
        eq(approverCredentials.state, "pending"),
      ),
    );

  if (pending.length === 0) return;
  const state = await ctx.signer.getWorkspace(workspaceId);
  const enrolled = new Set(state.approvers.map((approver) => approver.credentialId));

  for (const row of pending) {
    if (!enrolled.has(row.credentialId)) continue;

    const changed = await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(approverCredentials)
        .set({ state: "active" })
        .where(
          and(
            eq(approverCredentials.workspaceId, workspaceId),
            eq(approverCredentials.credentialId, row.credentialId),
            eq(approverCredentials.state, "pending"),
          ),
        )
        .returning();

      if (updated.length === 0) return false;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: { type: "signer", id: null },
          action: "approver.enrolled_by_operator",
          subject: { type: "user", id: row.userId },
          detail: { credentialId: row.credentialId },
        },
        tx,
      );

      return true;
    });

    if (!changed) continue;

    // The row is `active` now, so the kind's `abandon` (which deletes `pending` rows) leaves it.
    const open = await ctx.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.kind, "add-approver"),
          eq(approvals.status, "pending"),
          eq(approvals.subjectId, row.credentialId),
        ),
      );

    for (const approval of open) await ctx.approvals.cancel(approval.id);
  }
}
