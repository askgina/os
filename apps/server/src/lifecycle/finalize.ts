import type { WalletId, WorkspaceId } from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { and, desc, eq, inArray, lte, not, sql } from "drizzle-orm";
import { type AuditDetail, appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  agents,
  approvalAssertions,
  approvalRejections,
  approvals,
  approverCredentials,
  auditEvents,
  invites,
  memberships,
  nonceReservations,
  notificationDeliveries,
  notificationPreferences,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { takeToken } from "../rate-limit.ts";
import {
  cancelRequests,
  hasUnfinishedRuns,
  hasUnminedTransactions,
  mirrorWallet,
  mirrorWorkspace,
  type Subject,
  waitingRequests,
} from "./state.ts";

/** The sweeper runs the finalize step at most this often. */
const FINALIZE_INTERVAL_SECONDS = 60;

const DELETED_NAME = "Deleted workspace";

const REMOVED_AGENT_NAME = "Removed agent";

/**
 * Why a due retirement or deletion was not finished this round. The next round tries again.
 * - `unmined_transactions`, `unfinished_runs`: see `DeletionBlocker`.
 * - `destroy_not_due`: the signer's clock says it is not time yet.
 * - `not_scheduled`: the signer no longer holds it as scheduled (cancelled); the mirror is
 *   brought up to date.
 */
type SkipCode = "unmined_transactions" | "unfinished_runs" | "destroy_not_due" | "not_scheduled";

const systemActor = { type: "system", id: null } as const;

/**
 * {@link finalizeDue}, at most once per {@link FINALIZE_INTERVAL_SECONDS} across every replica
 * on the database: for the sweeper, which runs in each. A round that outlasts the interval may
 * meet the next one; every step is safe to repeat.
 */
export async function finalizeIfDue(
  ctx: AppContext,
): Promise<{ finalized: number; skipped: number } | null> {
  const due = await takeToken(
    ctx.db,
    "sweep:lifecycle-finalize",
    60 / FINALIZE_INTERVAL_SECONDS,
    1,
  );

  return due ? finalizeDue(ctx) : null;
}

/**
 * Finish every retirement and deletion whose destroy time passed: wait while a transaction could
 * still be mined, end what still waits for people, wait for runs to finish, record the
 * event, have the signer destroy the keys, then, for a workspace, shred its data keys and leave
 * a tombstone. Every step is safe to repeat, so a crash anywhere is finished by a later round.
 * One subject that fails does not stop the others.
 */
export async function finalizeDue(
  ctx: AppContext,
): Promise<{ finalized: number; skipped: number }> {
  const now = new Date(ctx.now() * 1000);

  const dueWorkspaces = await ctx.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.lifecycle, "deleting"), lte(workspaces.destroyAfter, now)));

  // A wallet of a workspace being deleted is finished with the workspace.
  const dueWallets = await ctx.db
    .select({ id: wallets.id, workspaceId: wallets.workspaceId })
    .from(wallets)
    .innerJoin(workspaces, eq(workspaces.id, wallets.workspaceId))
    .where(
      and(
        eq(wallets.lifecycle, "retiring"),
        lte(wallets.destroyAfter, now),
        eq(workspaces.lifecycle, "active"),
      ),
    );

  let finalized = 0;
  let skipped = 0;

  const run = async (subject: Subject, finish: () => Promise<SkipCode | null>) => {
    try {
      const skip = await finish();

      if (skip === null) {
        finalized += 1;

        return;
      }

      skipped += 1;
      ctx.log.info("lifecycle finalize skipped", {
        event: "lifecycle.finalize_skipped",
        workspaceId: subject.workspaceId,
        walletId: subject.walletId,
        code: skip,
      });
    } catch (error) {
      skipped += 1;
      ctx.log.warn("lifecycle finalize failed", {
        event: "lifecycle.finalize_failed",
        workspaceId: subject.workspaceId,
        walletId: subject.walletId,
        code: error instanceof SignerError ? error.code : "internal",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  for (const { id } of dueWorkspaces) {
    await run({ workspaceId: id, walletId: null }, () => finalizeWorkspace(ctx, id));
  }

  for (const { id, workspaceId } of dueWallets) {
    await run({ workspaceId, walletId: id }, () => finalizeWallet(ctx, workspaceId, id));
  }

  return { finalized, skipped };
}

/**
 * What still holds the subject back: a transaction that could be mined (checked first, so a
 * cancel request that clears it is never cancelled here), then, after ending every request
 * still waiting for people, a run not finished yet.
 */
async function blockerOf(ctx: AppContext, subject: Subject): Promise<SkipCode | null> {
  if (await hasUnminedTransactions(ctx, subject)) return "unmined_transactions";
  await cancelRequests(ctx, await waitingRequests(ctx, subject));

  if (await hasUnfinishedRuns(ctx, subject, true)) return "unfinished_runs";

  return null;
}

/**
 * Append `action` about `subject` unless the newest event about it already is that one, under
 * the workspace's audit lock, so a round that repeats after a crash records it once.
 */
async function recordOnce(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  subject: { type: "wallet" | "workspace"; id: string },
  action: string,
  detail: AuditDetail,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("no key update");

    const [newest] = await tx
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          eq(auditEvents.subjectType, subject.type),
          eq(auditEvents.subjectId, subject.id),
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(1);

    if (newest?.action === action) return;
    await appendAudit(ctx, { workspaceId, actor: systemActor, action, subject, detail }, tx);
  });
}

async function finalizeWallet(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  walletId: WalletId,
): Promise<SkipCode | null> {
  const before = await ctx.signer.getWallet(walletId);

  if (before.state !== "retiring" && before.state !== "destroyed") {
    await mirrorWallet(ctx.db, before);

    return "not_scheduled";
  }

  if (before.state === "retiring") {
    if ((before.destroyAfter ?? 0) > ctx.now()) return "destroy_not_due";
    const blocker = await blockerOf(ctx, { workspaceId, walletId });

    if (blocker !== null) return blocker;
    await recordOnce(ctx, workspaceId, { type: "wallet", id: walletId }, "wallet.destroyed", {
      destroyAfter: before.destroyAfter,
    });
  }

  let state = before;

  try {
    state = await ctx.signer.finalizeRetireWallet(walletId, workspaceId);
  } catch (error) {
    if (error instanceof SignerError && error.code === "destroy_not_due") return "destroy_not_due";
    throw error;
  }

  await mirrorWallet(ctx.db, state);
  ctx.log.info("lifecycle finalized", {
    event: "lifecycle.finalized",
    workspaceId,
    walletId,
    wallets: 1,
  });

  return null;
}

async function finalizeWorkspace(
  ctx: AppContext,
  workspaceId: WorkspaceId,
): Promise<SkipCode | null> {
  const before = await ctx.signer.getWorkspace(workspaceId);

  if (before.state === "active") {
    await mirrorWorkspace(ctx.db, before);

    return "not_scheduled";
  }

  // Once the signer destroyed the keys nothing can sign or wait any more: what is left is
  // shredding and the tombstone, which a crash may have interrupted.
  if (before.state === "deleting") {
    if ((before.destroyAfter ?? 0) > ctx.now()) return "destroy_not_due";
    const blocker = await blockerOf(ctx, { workspaceId, walletId: null });

    if (blocker !== null) return blocker;
    // Recorded before the keys go: after shredding, nothing of this workspace can be sealed.
    await recordOnce(
      ctx,
      workspaceId,
      { type: "workspace", id: workspaceId },
      "workspace.deleted",
      { destroyAfter: before.destroyAfter },
    );

    try {
      await ctx.signer.finalizeDeleteWorkspace(workspaceId);
    } catch (error) {
      if (error instanceof SignerError && error.code === "destroy_not_due") {
        return "destroy_not_due";
      }

      throw error;
    }
  }

  const runs = await ctx.keys.shredTenant("run", workspaceId);
  const workspaceKey = await ctx.keys.shred("workspace", workspaceId);
  const counts = await tombstone(ctx, workspaceId);
  ctx.log.info("lifecycle finalized", {
    event: "lifecycle.finalized",
    workspaceId,
    runKeysShredded: runs.shredded,
    workspaceKeyShredded: workspaceKey,
    ...counts,
  });

  if (counts !== null) {
    // The shredded keys stay readable in every keyring backup taken before a rotation.
    ctx.log.warn("rotate the keyring now: see deploy/README.md, Backups and restoring", {
      event: "lifecycle.rotate_keyring",
      workspaceId,
    });
  }

  return null;
}

/**
 * Leave what a deleted workspace keeps: ids, statuses, times, hashes, addresses, the audit chain
 * and the nonces used; names and labels cleared; memberships, invites, approver mirrors,
 * assertions, rejections, nonce reservations and notification preferences removed; undelivered
 * notifications dropped. Null when another round already did it.
 */
async function tombstone(
  ctx: AppContext,
  workspaceId: WorkspaceId,
): Promise<Record<string, number> | null> {
  // The agents first, in a transaction of their own. Replacing a token hash changes a unique
  // key, which takes the strongest row lock; a proposal that inserted rows referring to the
  // agent holds a lock that conflicts with it, and then waits for the workspace row to append
  // its audit event. Taken while holding the workspace row, the two would wait for each other.
  await ctx.db
    .update(agents)
    .set({
      status: "disabled",
      name: REMOVED_AGENT_NAME,
      tokenHash: sql`'removed:' || ${agents.id}`,
    })
    .where(
      and(eq(agents.workspaceId, workspaceId), not(sql`${agents.tokenHash} LIKE 'removed:%'`)),
    );

  return ctx.db.transaction(async (tx) => {
    // The workspace row first, with the lock an audit append takes (`FOR NO KEY UPDATE`): a
    // concurrent proposal that inserted rows referring to it still gets through, and nothing
    // here takes a stronger lock on it.
    const [row] = await tx
      .update(workspaces)
      .set({
        name: DELETED_NAME,
        lifecycle: "deleted",
        deletedAt: new Date(ctx.now() * 1000),
        paused: true,
      })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.lifecycle, "deleting")))
      .returning({ destroyAfter: workspaces.destroyAfter });

    if (!row) return null;

    const walletRows = await tx
      .update(wallets)
      .set({
        label: "",
        lifecycle: "destroyed",
        destroyAfter: sql`coalesce(${wallets.destroyAfter}, ${row.destroyAfter})`,
      })
      .where(eq(wallets.workspaceId, workspaceId))
      .returning({ id: wallets.id });

    const ofWorkspace = sql`(SELECT ${approvals.id} FROM ${approvals} WHERE ${approvals.workspaceId} = ${workspaceId})`;

    const removed = {
      wallets: walletRows.length,
      memberships: (
        await tx
          .delete(memberships)
          .where(eq(memberships.workspaceId, workspaceId))
          .returning({ id: memberships.userId })
      ).length,
      invites: (
        await tx
          .delete(invites)
          .where(eq(invites.workspaceId, workspaceId))
          .returning({ id: invites.id })
      ).length,
      approverCredentials: (
        await tx
          .delete(approverCredentials)
          .where(eq(approverCredentials.workspaceId, workspaceId))
          .returning({ id: approverCredentials.credentialId })
      ).length,
      assertions: (
        await tx
          .delete(approvalAssertions)
          .where(inArray(approvalAssertions.approvalId, ofWorkspace))
          .returning({ id: approvalAssertions.approvalId })
      ).length,
      rejections: (
        await tx
          .delete(approvalRejections)
          .where(inArray(approvalRejections.approvalId, ofWorkspace))
          .returning({ id: approvalRejections.approvalId })
      ).length,
      nonceReservations: (
        await tx
          .delete(nonceReservations)
          .where(
            inArray(
              nonceReservations.walletId,
              sql`(SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.workspaceId} = ${workspaceId})`,
            ),
          )
          .returning({ id: nonceReservations.approvalId })
      ).length,
      preferences: (
        await tx
          .delete(notificationPreferences)
          .where(eq(notificationPreferences.workspaceId, workspaceId))
          .returning({ id: notificationPreferences.userId })
      ).length,
      notificationsDropped: (
        await tx
          .update(notificationDeliveries)
          .set({ state: "dropped", lastCode: "workspace_deleted" })
          .where(
            and(
              eq(notificationDeliveries.workspaceId, workspaceId),
              eq(notificationDeliveries.state, "pending"),
            ),
          )
          .returning({ id: notificationDeliveries.id })
      ).length,
    };

    return removed;
  });
}
