import type {
  NotificationPreferences,
  PushSubscriptionSummary,
  WorkspaceNotifications,
} from "@askgina/os-api";
import { newId, PushSubscriptionId, type UserId } from "@askgina/os-protocol";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { requireMember, workspaceIdFromPath } from "../access.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  memberships,
  notificationPreferences,
  pushSubscriptions,
  users,
  workspaces,
} from "../db/schema.ts";
import { workspaceDetail } from "../directory/views.ts";
import { HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import { pushEndpointAllowed } from "./webpush/send.ts";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function subscriptionSummary(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionSummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: seconds(row.createdAt),
    lastSuccessAt: row.lastSuccessAt === null ? null : seconds(row.lastSuccessAt),
  };
}

/** Whether `raw` is an uncompressed point on P-256, as a browser's `p256dh` must be. */
async function isP256Point(raw: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);

    return true;
  } catch {
    return false;
  }
}

/** The person's switches for every workspace they are a member of, and their quiet hours. */
async function preferencesOf(ctx: AppContext, userId: UserId): Promise<NotificationPreferences> {
  const rows: WorkspaceNotifications[] = await ctx.db
    .select({
      workspaceId: memberships.workspaceId,
      webPush: sql<boolean>`coalesce(${notificationPreferences.webPush}, true)`,
      reminders: sql<boolean>`coalesce(${notificationPreferences.reminders}, true)`,
    })
    .from(memberships)
    .leftJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.userId, memberships.userId),
        eq(notificationPreferences.workspaceId, memberships.workspaceId),
      ),
    )
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId));

  const [person] = await ctx.db
    .select({ quietHours: users.quietHours })
    .from(users)
    .where(eq(users.id, userId));

  return { workspaces: rows, quietHours: person?.quietHours ?? null };
}

/**
 * Who hears about waiting requests, on which devices, and what they are told: push
 * subscriptions, each person's switches and quiet hours, and each workspace's content level.
 */
export function registerNotify(app: Hono, ctx: AppContext): void {
  handle(app, ctx, "getPushConfig", async () => {
    const webPush = ctx.config.notify.webPush;

    return {
      enabled: webPush !== null,
      applicationServerKey:
        webPush === null ? null : Buffer.from(webPush.vapidPublicKey).toString("base64url"),
    };
  });

  handle(app, ctx, "listPushSubscriptions", async ({ session }) => {
    const rows = await ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, session.user.id))
      .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));

    return { items: rows.map(subscriptionSummary) };
  });

  handle(app, ctx, "addPushSubscription", async ({ session, body }) => {
    const webPush = ctx.config.notify.webPush;

    if (webPush === null) {
      throw new HttpError(
        "conflict",
        "notifications on devices are off on this server",
        "push_off",
      );
    }

    if (!pushEndpointAllowed(body.endpoint, webPush.endpointHosts)) {
      throw new HttpError(
        "invalid_request",
        "this push service is not one this server sends to",
        "endpoint_refused",
      );
    }

    const p256dh = body.keys.p256dh.replace(/=+$/, "");
    const auth = body.keys.auth.replace(/=+$/, "");

    if (!(await isP256Point(new Uint8Array(Buffer.from(p256dh, "base64url"))))) {
      throw new HttpError(
        "invalid_request",
        "the subscription's key is not a P-256 public key",
        "bad_subscription",
      );
    }

    const userId = session.user.id;

    const saved = await ctx.db.transaction(async (tx) => {
      // A browser has one subscription per site, so whoever turns it on there last owns it; the
      // other person's notifications already waiting for it are dropped when they come due.
      await tx
        .delete(pushSubscriptions)
        .where(
          and(eq(pushSubscriptions.endpoint, body.endpoint), ne(pushSubscriptions.userId, userId)),
        );

      const [row] = await tx
        .insert(pushSubscriptions)
        .values({
          id: newId("psb"),
          userId,
          endpoint: body.endpoint,
          p256dh,
          auth,
          label: body.label ?? null,
          createdAt: new Date(ctx.now() * 1000),
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          // The same browser again: new keys, the same id, and its label unless a new one came.
          set: {
            p256dh,
            auth,
            label: sql`coalesce(excluded.label, ${pushSubscriptions.label})`,
            failureCount: 0,
          },
          setWhere: eq(pushSubscriptions.userId, userId),
        })
        .returning();

      return row;
    });

    if (!saved) {
      throw new HttpError("conflict", "this device was just turned on for someone else; try again");
    }

    return subscriptionSummary(saved);
  });

  handle(app, ctx, "removePushSubscription", async ({ session, params }) => {
    const subscriptionId = PushSubscriptionId.safeParse(params.subscriptionId);

    // A segment that is no subscription id names no device.
    if (!subscriptionId.success) throw new HttpError("not_found", "no such device");

    const removed = await ctx.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, subscriptionId.data),
          eq(pushSubscriptions.userId, session.user.id),
        ),
      )
      .returning({ id: pushSubscriptions.id });

    if (removed.length === 0) throw new HttpError("not_found", "no such device");

    return {};
  });

  handle(app, ctx, "getNotificationPreferences", async ({ session }) =>
    preferencesOf(ctx, session.user.id),
  );

  handle(app, ctx, "setNotificationPreferences", async ({ session, body }) => {
    const userId = session.user.id;
    const ids = body.workspaces.map((item) => item.workspaceId);

    if (ids.length > 0) {
      const member = await ctx.db
        .select({ workspaceId: memberships.workspaceId })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), inArray(memberships.workspaceId, ids)));

      if (member.length !== ids.length) throw new HttpError("not_found", "no such workspace");
    }

    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ quietHours: body.quietHours }).where(eq(users.id, userId));

      for (const item of body.workspaces) {
        const values = { webPush: item.webPush, reminders: item.reminders };
        await tx
          .insert(notificationPreferences)
          .values({ userId, workspaceId: item.workspaceId, ...values })
          .onConflictDoUpdate({
            target: [notificationPreferences.userId, notificationPreferences.workspaceId],
            set: values,
          });
      }
    });

    return preferencesOf(ctx, userId);
  });

  handle(app, ctx, "setNotificationDetail", async ({ session, params, body }) => {
    const workspaceId = workspaceIdFromPath(params.workspaceId);
    // Only an owner: `summary` puts names on lock screens and in push services' hands.
    const role = await requireMember(ctx, session, workspaceId, "owner");
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ notificationDetail: body.detail })
        .where(and(eq(workspaces.id, workspaceId), ne(workspaces.notificationDetail, body.detail)))
        .returning({ id: workspaces.id });

      if (changed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: { type: "user", id: session.user.id },
          action: "workspace.notification_detail_set",
          subject: { type: "workspace", id: workspaceId },
          detail: { detail: body.detail },
        },
        tx,
      );
    });

    return workspaceDetail(ctx, workspaceId, role);
  });
}
