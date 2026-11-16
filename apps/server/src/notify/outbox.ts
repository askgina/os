import { ApprovalKind } from "@askgina/os-api";
import {
  AgentId,
  type ApprovalId,
  Intent,
  isVenueNetwork,
  newId,
  PushSubscriptionId,
  UserId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext, Transaction } from "../context.ts";
import {
  agents,
  approvals,
  intents,
  type NotificationEvent,
  notificationDeliveries,
  pushSubscriptions,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { approvalLink, type DeclarativePush, lifecycleMessage, pushMessage } from "./content.ts";
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

/** How long before keys are destroyed the second lifecycle notice goes out (D10). */
export const DUE_SOON_SECONDS = 86_400;

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

/** A retirement or deletion people approved, as the signer applied it. */
export interface ScheduledDestruction {
  /** The `retire-wallet` or `delete-workspace` request. */
  approvalId: ApprovalId;
  workspaceId: WorkspaceId;
  /** Unix seconds: when the signer applied it. */
  appliedAt: number;
  /** Unix seconds: when the signer destroys the keys. */
  destroyAfter: number;
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
 * Write the notices of a scheduled retirement or deletion (D10), in the transaction that mirrors
 * it: `lifecycle.scheduled` now, and `lifecycle.due_soon` 24 hours before the keys are
 * destroyed when that is still ahead, each to the webhook and to every device of each person
 * who can approve (the reminder only where reminders are on). A cancelled or finished
 * destruction drops what has not gone out yet. Writing them again adds nothing.
 */
export async function enqueueLifecycleNotifications(
  ctx: Pick<AppContext, "config">,
  tx: Transaction,
  scheduled: ScheduledDestruction,
): Promise<void> {
  const webhook: Target[] =
    ctx.config.notify.webhook === null ? [] : [{ target: "webhook", userId: null }];

  const recipients =
    ctx.config.notify.webPush === null ? [] : await approvalRecipients(tx, scheduled.workspaceId);

  const device = ({ subscriptionId, userId }: { subscriptionId: string; userId: UserId }) => ({
    target: `${PUSH_TARGET}${subscriptionId}`,
    userId,
  });

  const approval = { id: scheduled.approvalId, workspaceId: scheduled.workspaceId };
  await enqueue(tx, approval, "lifecycle.scheduled", scheduled.appliedAt, [
    ...webhook,
    ...recipients.map(device),
  ]);
  const dueAt = scheduled.destroyAfter - DUE_SOON_SECONDS;

  if (dueAt <= scheduled.appliedAt) return;
  await enqueue(tx, approval, "lifecycle.due_soon", dueAt, [
    ...webhook,
    ...recipients.filter((recipient) => recipient.reminders).map(device),
  ]);
}

/**
 * When the keys of a lifecycle notice's request are destroyed, while that destruction is still
 * scheduled as people approved it: the wallet is `retiring`, or the workspace `deleting`, with
 * the envelope's destroy time. Null once it was cancelled or carried out.
 */
async function stillScheduled(ctx: AppContext, approval: ApprovalRow): Promise<number | null> {
  const envelope = approval.envelope;

  if (envelope?.type === "retire-wallet") {
    const [wallet] = await ctx.db
      .select({ lifecycle: wallets.lifecycle, destroyAfter: wallets.destroyAfter })
      .from(wallets)
      .where(eq(wallets.id, envelope.wallet.walletId));

    const due = wallet?.destroyAfter ? Math.floor(wallet.destroyAfter.getTime() / 1000) : null;

    return wallet?.lifecycle === "retiring" && due === envelope.destroyAfter ? due : null;
  }

  if (envelope?.type === "delete-workspace") {
    const [workspace] = await ctx.db
      .select({ lifecycle: workspaces.lifecycle, destroyAfter: workspaces.destroyAfter })
      .from(workspaces)
      .where(eq(workspaces.id, approval.workspaceId));

    const due = workspace?.destroyAfter
      ? Math.floor(workspace.destroyAfter.getTime() / 1000)
      : null;

    return workspace?.lifecycle === "deleting" && due === envelope.destroyAfter ? due : null;
  }

  return null;
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
  // A lifecycle notice means something only while its destruction is still scheduled; any
  // other approval's notification only while the request still waits for people.
  let until: number | null = null;

  if (row.event === "lifecycle.scheduled" || row.event === "lifecycle.due_soon") {
    until = await stillScheduled(ctx, approval);

    if (until === null || until <= ctx.now()) {
      return finish(ctx, row, lease, "dropped", { lastCode: "lifecycle_ended" });
    }
  } else if (row.event !== "mandate.used") {
    until = Math.floor(approval.expiresAt.getTime() / 1000);

    if (approval.status !== "pending" || until <= ctx.now()) {
      return finish(ctx, row, lease, "dropped", { lastCode: "approval_ended" });
    }
  }

  if (row.target.startsWith(PUSH_TARGET)) {
    if (until === null) return finish(ctx, row, lease, "failed", { lastCode: "unknown_target" });

    return deliverPush(ctx, row, lease, approval, until);
  }

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

  return retry(ctx, row, lease, until, result.code, result.retryAfter);
}

/**
 * Send one push notification to one device, after checking that it should still go out: Web
 * Push is still on, the device is still its person's, the person can still approve, wants it
 * (reminders apart), has not approved yet (a request's notifications only), and is outside
 * their quiet hours. A notification that falls in quiet hours waits until they end, unless
 * `until` (the request's expiry, or the destroy time of a lifecycle notice) comes first.
 */
async function deliverPush(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  approval: ApprovalRow,
  until: number,
): Promise<Outcome> {
  if (ctx.config.notify.webPush === null) {
    return finish(ctx, row, lease, "dropped", { lastCode: "channel_off" });
  }

  // A target that names no subscription id names no device.
  const subscriptionId = PushSubscriptionId.safeParse(row.target.slice(PUSH_TARGET.length));

  const [subscription] = subscriptionId.success
    ? await ctx.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, subscriptionId.data))
    : [];

  // Removed by its person, gone at its push service, or moved to someone else's account.
  if (!subscription || row.userId === null || subscription.userId !== row.userId) {
    return finish(ctx, row, lease, "dropped", { lastCode: "unsubscribed" });
  }

  const userId = row.userId;
  const recipient = await recipientNow(ctx.db, approval.workspaceId, userId);

  if (recipient === null) return finish(ctx, row, lease, "dropped", { lastCode: "not_recipient" });
  const lifecycle = row.event === "lifecycle.scheduled" || row.event === "lifecycle.due_soon";
  const reminder = row.event === "approval.reminder" || row.event === "lifecycle.due_soon";

  if (reminder && !recipient.reminders) {
    return finish(ctx, row, lease, "dropped", { lastCode: "reminders_off" });
  }

  if (!lifecycle && (await approvedBy(ctx.db, approval.id, userId))) {
    return finish(ctx, row, lease, "dropped", { lastCode: "already_approved" });
  }

  const now = ctx.now();

  const [person] = await ctx.db
    .select({ quietHours: users.quietHours })
    .from(users)
    .where(eq(users.id, userId));

  const allowed = nextAllowedTime(now, person?.quietHours ?? null);

  if (allowed >= until) return finish(ctx, row, lease, "dropped", { lastCode: "quiet_hours" });

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
  const link = approvalLink(ctx.config.publicOrigin, approval.workspaceId, approval.id);
  const pendingCount = await pendingFor(ctx.db, userId, now);

  const payload: DeclarativePush = lifecycle
    ? lifecycleMessage({
        level: workspace.detail,
        approvalId: approval.id,
        kind: approval.kind === "retire-wallet" ? "retire-wallet" : "delete-workspace",
        workspaceName: workspace.name,
        destroyAfter: until,
        pendingCount,
        link,
        dueSoon: reminder,
      })
    : pushMessage({
        level: workspace.detail,
        facts: {
          approvalId: approval.id,
          pendingCount,
          // Only kinds people decide on have push rows: a mandate's use never does.
          kind: ApprovalKind.parse(approval.kind),
          operation: await operationOf(ctx, approval),
          workspaceName: workspace.name,
          requesterName: await requesterName(ctx, approval),
        },
        link,
        reminder,
      });

  const result = await sendPush(
    ctx,
    { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
    {
      payload,
      topic: pushTopic(approval.id),
      ttlSeconds: Math.max(MIN_PUSH_TTL_SECONDS, until - now),
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

  return retry(ctx, row, lease, until, result.reason, result.retryAfter);
}

/**
 * For an `approve-intent` request: a venue order, or a payment (D8). Only a venue intent can be
 * an order, so only its sealed payload (`intents.payload:<intentId>`) is opened, for its
 * operation's type and nothing else.
 */
async function operationOf(
  ctx: AppContext,
  approval: ApprovalRow,
): Promise<"payment" | "order" | null> {
  if (approval.kind !== "approve-intent") return null;

  const [intent] = await ctx.db
    .select({
      id: intents.id,
      workspaceId: intents.workspaceId,
      chainId: intents.chainId,
      payload: intents.payload,
    })
    .from(intents)
    .where(eq(intents.approvalId, approval.id));

  if (!intent || !isVenueNetwork(intent.chainId)) return "payment";

  const opened = Intent.parse(
    await ctx.sealer.open(intent.workspaceId, `intents.payload:${intent.id}`, intent.payload),
  );

  return opened.operation.type === "hyperliquid.order" ? "order" : "payment";
}

/** The name of whoever asked: the agent's or the person's, as stored. */
async function requesterName(ctx: AppContext, approval: ApprovalRow): Promise<string> {
  // An id of the wrong form names nobody, so it has no name.
  if (approval.requestedByType === "agent") {
    const agentId = AgentId.safeParse(approval.requestedById);

    if (!agentId.success) return "";

    const [agent] = await ctx.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId.data));

    return agent?.name ?? "";
  }

  const userId = UserId.safeParse(approval.requestedById);

  if (!userId.success) return "";

  const [person] = await ctx.db
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, userId.data));

  return person?.name ?? "";
}

/**
 * Try a failed attempt again after a backoff of 10 seconds doubling to 600, or give it up after
 * {@link MAX_ATTEMPTS}. A receiver's own `Retry-After` wins when it is sane and still before
 * `until` (a request's expiry, or a lifecycle notice's destroy time; null for a mandate's
 * use): the row would be dropped then anyway.
 */
async function retry(
  ctx: AppContext,
  row: DeliveryRow,
  lease: Date,
  until: number | null,
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
    (until === null || now + retryAfter < until);

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
