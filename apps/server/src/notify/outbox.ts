import type { ApprovalKind } from "@askgina/os-api";
import { type ApprovalId, newId, type UserId, type WorkspaceId } from "@askgina/os-protocol";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { AppContext, Transaction } from "../context.ts";
import { approvals, type NotificationEvent, notificationDeliveries } from "../db/schema.ts";
import { sendWebhook } from "./webhook.ts";

/** Rows one pass claims at most. */
const CLAIM_LIMIT = 50;
/** How long a claimed row is held. A sender that dies leaves it to be sent again after this. */
const LEASE_SECONDS = 60;
/** Failed attempts after which a delivery is given up. */
const MAX_ATTEMPTS = 8;
const FIRST_BACKOFF_SECONDS = 10;
const MAX_BACKOFF_SECONDS = 600;
/** The longest `Retry-After` honoured; a longer one falls back to the backoff. */
const MAX_RETRY_AFTER_SECONDS = 3_600;
/** Deliveries one pass sends at once. */
const SENDERS = 8;

type DeliveryRow = typeof notificationDeliveries.$inferSelect;

/** What one pass did, per outcome. */
export interface DeliveryCounts {
  sent: number;
  retried: number;
  dropped: number;
  failed: number;
}

/** The approval a notification announces, as `Engine.open()` has it in its transaction. */
export interface OpenedApproval {
  id: ApprovalId;
  workspaceId: WorkspaceId;
  /** Only requests people decide on: a `mandate-use` row is never announced to approvers. */
  kind: ApprovalKind;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. */
  expiresAt: number;
}

/** One row to write: where it goes, and whose device that is (null for the webhook). */
interface Target {
  target: string;
  userId: UserId | null;
}

async function enqueue(
  tx: Transaction,
  approval: { id: ApprovalId; workspaceId: WorkspaceId },
  event: NotificationEvent,
  dueAt: number,
  targets: readonly Target[],
): Promise<void> {
  if (targets.length === 0) return;
  const at = new Date(dueAt * 1000);
  await tx
    .insert(notificationDeliveries)
    .values(
      targets.map(({ target, userId }) => ({
        id: newId("ndl"),
        workspaceId: approval.workspaceId,
        approvalId: approval.id,
        event,
        target,
        userId,
        dueAt: at,
        nextAttemptAt: at,
        createdAt: at,
      })),
    )
    .onConflictDoNothing({
      target: [
        notificationDeliveries.approvalId,
        notificationDeliveries.event,
        notificationDeliveries.target,
      ],
    });
}

/**
 * Write the notifications of a request people now decide on, in the transaction that opens it,
 * so a request never exists without them and a crash cannot lose them: one row for the
 * operator's webhook when one is configured. Writing them again for the same request adds
 * nothing.
 */
export async function enqueueApprovalNotifications(
  ctx: Pick<AppContext, "config">,
  tx: Transaction,
  approval: OpenedApproval,
): Promise<void> {
  const targets: Target[] = [];
  if (ctx.config.notify.webhook !== null) targets.push({ target: "webhook", userId: null });
  await enqueue(tx, approval, "approval.opened", approval.createdAt, targets);
}

/**
 * Write the webhook's `mandate.used` notification in the transaction that records the use. A
 * use is never announced to people: nobody decides on it.
 */
export async function enqueueMandateUseNotification(
  ctx: Pick<AppContext, "config">,
  tx: Transaction,
  use: { id: ApprovalId; workspaceId: WorkspaceId; createdAt: number },
): Promise<void> {
  if (ctx.config.notify.webhook === null) return;
  await enqueue(tx, use, "mandate.used", use.createdAt, [{ target: "webhook", userId: null }]);
}

/**
 * Send what is due, at least once each. Due rows are claimed under `FOR UPDATE SKIP LOCKED` and
 * leased for {@link LEASE_SECONDS} in one short transaction, then sent outside it, so passes that
 * overlap never send a row twice, and a row whose sender died is sent again once its lease ends.
 * Never throws for a delivery that fails; a database error propagates to the sweeper.
 */
export async function deliverDueNotifications(ctx: AppContext): Promise<DeliveryCounts> {
  const now = ctx.now();
  const lease = new Date((now + LEASE_SECONDS) * 1000);
  const claimed = await ctx.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.state, "pending"),
          lte(notificationDeliveries.nextAttemptAt, new Date(now * 1000)),
        ),
      )
      .orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.id))
      .limit(CLAIM_LIMIT)
      .for("update", { skipLocked: true });
    if (due.length > 0) {
      await tx
        .update(notificationDeliveries)
        .set({ nextAttemptAt: lease })
        .where(
          inArray(
            notificationDeliveries.id,
            due.map((row) => row.id),
          ),
        );
    }
    return due;
  });

  const counts: DeliveryCounts = { sent: 0, retried: 0, dropped: 0, failed: 0 };
  const queue = [...claimed];
  await Promise.all(
    Array.from({ length: Math.min(SENDERS, queue.length) }, async () => {
      for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
        counts[await deliver(ctx, row, lease)] += 1;
      }
    }),
  );
  return counts;
}

async function deliver(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
): Promise<keyof DeliveryCounts> {
  const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, row.approvalId));
  if (!approval) throw new Error("a notification without its approval");
  // An approval's notification means something only while the request still waits for people.
  const ended =
    row.event !== "mandate.used" &&
    (approval.status !== "pending" || approval.expiresAt.getTime() <= ctx.now() * 1000);
  if (ended) return finish(ctx, row, lease, { state: "dropped", lastCode: "approval_ended" });
  if (row.target !== "webhook") {
    return finish(ctx, row, lease, { state: "failed", lastCode: "unknown_target" });
  }
  // The operator removed the webhook after this row was written.
  if (ctx.config.notify.webhook === null) {
    return finish(ctx, row, lease, { state: "dropped", lastCode: "channel_off" });
  }
  const result = await sendWebhook(ctx, row, approval);
  const now = ctx.now();
  if (result.ok) {
    return finish(ctx, row, lease, {
      state: "sent",
      lastCode: null,
      sentAt: new Date(now * 1000),
    });
  }
  const attempts = row.attempts + 1;
  if (!result.retry || attempts >= MAX_ATTEMPTS) {
    return finish(ctx, row, lease, { state: "failed", lastCode: result.code, attempts });
  }
  const backoff = Math.min(MAX_BACKOFF_SECONDS, FIRST_BACKOFF_SECONDS * 2 ** row.attempts);
  // A receiver's own `Retry-After` wins when it is sane and, for a request, still before its
  // expiry; the row would be dropped then anyway.
  const honoured =
    result.retryAfter !== undefined &&
    result.retryAfter <= MAX_RETRY_AFTER_SECONDS &&
    (row.event === "mandate.used" ||
      (now + result.retryAfter) * 1000 < approval.expiresAt.getTime());
  const delay = honoured && result.retryAfter !== undefined ? result.retryAfter : backoff;
  return finish(ctx, row, lease, {
    state: "pending",
    lastCode: result.code,
    attempts,
    nextAttemptAt: new Date((now + delay) * 1000),
  });
}

const OUTCOME = {
  sent: { count: "sent", message: "notification delivered" },
  pending: { count: "retried", message: "notification retry" },
  dropped: { count: "dropped", message: "notification dropped" },
  failed: { count: "failed", message: "notification failed" },
} as const;

/**
 * Record an attempt's outcome, only while this pass still holds the row's lease, and log it with
 * identifiers and the code only.
 */
async function finish(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  change: Pick<DeliveryRow, "state" | "lastCode"> &
    Partial<Pick<DeliveryRow, "attempts" | "nextAttemptAt" | "sentAt">>,
): Promise<keyof DeliveryCounts> {
  await ctx.db
    .update(notificationDeliveries)
    .set(change)
    .where(
      and(
        eq(notificationDeliveries.id, row.id),
        eq(notificationDeliveries.state, "pending"),
        eq(notificationDeliveries.nextAttemptAt, lease),
      ),
    );
  const outcome = OUTCOME[change.state];
  const fields = {
    deliveryId: row.id,
    approvalId: row.approvalId,
    target: row.target === "webhook" ? "webhook" : "push",
    code: change.lastCode,
  };
  if (change.state === "sent" || change.state === "dropped") ctx.log.info(outcome.message, fields);
  else ctx.log.warn(outcome.message, fields);
  return outcome.count;
}
