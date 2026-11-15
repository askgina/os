import type { ApprovalKind } from "@askgina/os-api";
import {
  type AgentId,
  type ApprovalId,
  newId,
  type PushSubscriptionId,
  type UserId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext, Transaction } from "../context.ts";
import {
  agents,
  approvals,
  type NotificationEvent,
  notificationDeliveries,
  pushSubscriptions,
  users,
  workspaces,
} from "../db/schema.ts";
import { approvalLink, pushMessage } from "./content.ts";
import { approvalRecipients, approvedBy, pendingFor, recipientNow } from "./recipients.ts";
import { nextAllowedTime, reminderDueAt } from "./schedule.ts";
import { sendWebhook } from "./webhook.ts";
import { pushTopic, sendPush } from "./webpush/send.ts";

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
/** The shortest time a push service keeps a message for a device that is offline. */
const MIN_PUSH_TTL_SECONDS = 60;
const PUSH_TARGET = "push:";

type DeliveryRow = typeof notificationDeliveries.$inferSelect;

/**
 * What one pass did, per outcome. `held`: a push notification that falls in its person's quiet
 * hours waits until they end.
 */
export interface DeliveryCounts {
  sent: number;
  retried: number;
  held: number;
  dropped: number;
  failed: number;
}

type Outcome = keyof DeliveryCounts;

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
 * operator's webhook when one is configured and, while Web Push is on, one per device of each
 * person who can approve it, plus one reminder per device whose person wants reminders when the
 * request lives long enough for one. Writing them again for the same request adds nothing.
 */
export async function enqueueApprovalNotifications(
  ctx: Pick<AppContext, "config">,
  tx: Transaction,
  approval: OpenedApproval,
): Promise<void> {
  const targets: Target[] = [];
  if (ctx.config.notify.webhook !== null) targets.push({ target: "webhook", userId: null });
  const recipients =
    ctx.config.notify.webPush === null ? [] : await approvalRecipients(tx, approval.workspaceId);
  for (const { subscriptionId, userId } of recipients) {
    targets.push({ target: `${PUSH_TARGET}${subscriptionId}`, userId });
  }
  await enqueue(tx, approval, "approval.opened", approval.createdAt, targets);

  const remindAt = reminderDueAt(approval.createdAt, approval.expiresAt);
  if (remindAt === null) return;
  await enqueue(
    tx,
    approval,
    "approval.reminder",
    remindAt,
    recipients
      .filter((recipient) => recipient.reminders)
      .map(({ subscriptionId, userId }) => ({
        target: `${PUSH_TARGET}${subscriptionId}`,
        userId,
      })),
  );
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

  const counts: DeliveryCounts = { sent: 0, retried: 0, held: 0, dropped: 0, failed: 0 };
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

async function deliver(ctx: AppContext, row: DeliveryRow, lease: Date): Promise<Outcome> {
  const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, row.approvalId));
  if (!approval) throw new Error("a notification without its approval");
  // An approval's notification means something only while the request still waits for people.
  const ended =
    row.event !== "mandate.used" &&
    (approval.status !== "pending" || approval.expiresAt.getTime() <= ctx.now() * 1000);
  if (ended) return finish(ctx, row, lease, "dropped", { lastCode: "approval_ended" });
  if (row.target.startsWith(PUSH_TARGET)) return deliverPush(ctx, row, lease, approval);
  if (row.target !== "webhook") {
    return finish(ctx, row, lease, "failed", { lastCode: "unknown_target" });
  }
  // The operator removed the webhook after this row was written.
  if (ctx.config.notify.webhook === null) {
    return finish(ctx, row, lease, "dropped", { lastCode: "channel_off" });
  }
  const result = await sendWebhook(ctx, row, approval);
  if (result.ok) {
    return finish(ctx, row, lease, "sent", {
      lastCode: null,
      sentAt: new Date(ctx.now() * 1000),
    });
  }
  if (!result.retry) {
    return finish(ctx, row, lease, "failed", { lastCode: result.code, attempts: row.attempts + 1 });
  }
  return retry(ctx, row, lease, approval, result.code, result.retryAfter);
}

/**
 * Send one push notification to one device, after checking that it should still go out: Web
 * Push is still on, the device is still its person's, the person can still approve, wants it
 * (reminders apart), has not approved yet, and is outside their quiet hours. A notification that
 * falls in quiet hours waits until they end, unless the request expires first.
 */
async function deliverPush(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  approval: ApprovalRow,
): Promise<Outcome> {
  if (ctx.config.notify.webPush === null) {
    return finish(ctx, row, lease, "dropped", { lastCode: "channel_off" });
  }
  const subscriptionId = row.target.slice(PUSH_TARGET.length);
  const [subscription] = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.id, subscriptionId as PushSubscriptionId));
  // Removed by its person, gone at its push service, or moved to someone else's account.
  if (!subscription || row.userId === null || subscription.userId !== row.userId) {
    return finish(ctx, row, lease, "dropped", { lastCode: "unsubscribed" });
  }
  const userId = row.userId;
  const recipient = await recipientNow(ctx.db, approval.workspaceId, userId);
  if (recipient === null) return finish(ctx, row, lease, "dropped", { lastCode: "not_recipient" });
  const reminder = row.event === "approval.reminder";
  if (reminder && !recipient.reminders) {
    return finish(ctx, row, lease, "dropped", { lastCode: "reminders_off" });
  }
  if (await approvedBy(ctx.db, approval.id, userId)) {
    return finish(ctx, row, lease, "dropped", { lastCode: "already_approved" });
  }

  const now = ctx.now();
  const expiresAt = Math.floor(approval.expiresAt.getTime() / 1000);
  const [person] = await ctx.db
    .select({ quietHours: users.quietHours })
    .from(users)
    .where(eq(users.id, userId));
  const allowed = nextAllowedTime(now, person?.quietHours ?? null);
  if (allowed >= expiresAt) return finish(ctx, row, lease, "dropped", { lastCode: "quiet_hours" });
  if (allowed > now) {
    return finish(ctx, row, lease, "held", {
      lastCode: "quiet_hours",
      nextAttemptAt: new Date(allowed * 1000),
    });
  }

  const [workspace] = await ctx.db
    .select({ name: workspaces.name, detail: workspaces.notificationDetail })
    .from(workspaces)
    .where(eq(workspaces.id, approval.workspaceId));
  if (!workspace) throw new Error("a notification without its workspace");
  const payload = pushMessage({
    level: workspace.detail,
    facts: {
      approvalId: approval.id,
      pendingCount: await pendingFor(ctx.db, userId, now),
      // Only kinds people decide on have push rows: a mandate's use never does.
      kind: approval.kind as ApprovalKind,
      workspaceName: workspace.name,
      requesterName: await requesterName(ctx, approval),
    },
    link: approvalLink(ctx.config.publicOrigin, approval.workspaceId, approval.id),
    reminder,
  });
  const result = await sendPush(
    ctx,
    { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
    {
      payload,
      topic: pushTopic(approval.id),
      ttlSeconds: Math.max(MIN_PUSH_TTL_SECONDS, expiresAt - now),
      urgency: "high",
    },
  );
  if (result.ok) {
    await ctx.db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: new Date(now * 1000), failureCount: 0 })
      .where(eq(pushSubscriptions.id, subscription.id));
    return finish(ctx, row, lease, "sent", { lastCode: null, sentAt: new Date(now * 1000) });
  }
  if (result.code === "gone") {
    // The browser unsubscribed, or the push service forgot it: it never comes back.
    await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    return finish(ctx, row, lease, "dropped", { lastCode: "gone" });
  }
  await ctx.db
    .update(pushSubscriptions)
    .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
    .where(eq(pushSubscriptions.id, subscription.id));
  if (result.code === "rejected") {
    return finish(ctx, row, lease, "failed", {
      lastCode: result.reason,
      attempts: row.attempts + 1,
    });
  }
  return retry(ctx, row, lease, approval, result.reason, result.retryAfter);
}

/** The name of whoever asked: the agent's or the person's, as stored. */
async function requesterName(ctx: AppContext, approval: ApprovalRow): Promise<string> {
  if (approval.requestedByType === "agent") {
    const [agent] = await ctx.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, approval.requestedById as AgentId));
    return agent?.name ?? "";
  }
  const [person] = await ctx.db
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, approval.requestedById as UserId));
  return person?.name ?? "";
}

/**
 * Try a failed attempt again after a backoff of 10 seconds doubling to 600, or give it up after
 * {@link MAX_ATTEMPTS}. A receiver's own `Retry-After` wins when it is sane and, for a request,
 * still before its expiry; the row would be dropped then anyway.
 */
async function retry(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  approval: ApprovalRow,
  code: string,
  retryAfter: number | undefined,
): Promise<Outcome> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS)
    return finish(ctx, row, lease, "failed", { lastCode: code, attempts });
  const now = ctx.now();
  const backoff = Math.min(MAX_BACKOFF_SECONDS, FIRST_BACKOFF_SECONDS * 2 ** row.attempts);
  const honoured =
    retryAfter !== undefined &&
    retryAfter <= MAX_RETRY_AFTER_SECONDS &&
    (row.event === "mandate.used" || (now + retryAfter) * 1000 < approval.expiresAt.getTime());
  const delay = honoured ? retryAfter : backoff;
  return finish(ctx, row, lease, "retried", {
    lastCode: code,
    attempts,
    nextAttemptAt: new Date((now + delay) * 1000),
  });
}

const OUTCOME: Record<
  Outcome,
  { state: DeliveryRow["state"]; message: string; level: "info" | "warn" }
> = {
  sent: { state: "sent", message: "notification delivered", level: "info" },
  retried: { state: "pending", message: "notification retry", level: "warn" },
  held: { state: "pending", message: "notification held", level: "info" },
  dropped: { state: "dropped", message: "notification dropped", level: "info" },
  failed: { state: "failed", message: "notification failed", level: "warn" },
};

/**
 * Record an attempt's outcome, only while this pass still holds the row's lease, and log it with
 * identifiers and the code only.
 */
async function finish(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  outcome: Outcome,
  change: Pick<DeliveryRow, "lastCode"> &
    Partial<Pick<DeliveryRow, "attempts" | "nextAttemptAt" | "sentAt">>,
): Promise<Outcome> {
  const { state, message, level } = OUTCOME[outcome];
  await ctx.db
    .update(notificationDeliveries)
    .set({ ...change, state })
    .where(
      and(
        eq(notificationDeliveries.id, row.id),
        eq(notificationDeliveries.state, "pending"),
        eq(notificationDeliveries.nextAttemptAt, lease),
      ),
    );
  ctx.log[level](message, {
    deliveryId: row.id,
    approvalId: row.approvalId,
    target: row.target === "webhook" ? "webhook" : "push",
    code: change.lastCode,
  });
  return outcome;
}
