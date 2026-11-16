import type { ApprovalId, WorkspaceId } from "@askgina/os-protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, notificationDeliveries } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { registerExecution, sweep } from "../../src/execution/index.ts";
import { deliverDueNotifications, enqueueApprovalNotifications } from "../../src/notify/outbox.ts";
import { createTestContext, type TestContext } from "../support/context.ts";
import {
  expectedSignature,
  type Received,
  type Receiver,
  startReceiver,
  webhookSecret,
} from "./support.ts";

let t: TestContext;

let receiver: Receiver;

let workspaceId: WorkspaceId;

const secret = webhookSecret();

const NOTHING = { sent: 0, retried: 0, held: 0, dropped: 0, failed: 0 };

beforeAll(async () => {
  receiver = await startReceiver();
  t = await createTestContext({
    label: "notify_outbox",
    config: { notify: { webhook: { url: receiver.url, secret }, webPush: null } },
    routes: (app, ctx) => registerExecution(app, ctx),
  });
  const created = await t.owner.browser.api.call("createWorkspace", { body: { name: "Notified" } });
  workspaceId = created.id as WorkspaceId;
});

afterAll(async () => {
  await t?.close();
  await receiver?.close();
});

// Each test starts with nothing due: what an earlier test left pending is not sent here.
beforeEach(async () => {
  await t.ctx.db
    .update(notificationDeliveries)
    .set({ state: "dropped", lastCode: "test_reset" })
    .where(eq(notificationDeliveries.state, "pending"));
});

/** A request people decide on: changing the workspace's admin threshold. */
async function openApproval(): Promise<ApprovalId> {
  const opened = await t.owner.browser.api.call("requestAdminThreshold", {
    params: { workspaceId },
    body: { adminThreshold: 1 },
  });

  return opened.id as ApprovalId;
}

const deliveriesOf = (approvalId: ApprovalId) =>
  t.ctx.db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.approvalId, approvalId));

async function deliveryOf(approvalId: ApprovalId) {
  const rows = await deliveriesOf(approvalId);
  expect(rows).toHaveLength(1);
  const [row] = rows;

  if (!row) throw new Error("no delivery row");

  return row;
}

const requestsFor = (approvalId: ApprovalId): Received[] =>
  receiver.requests.filter((request) => JSON.parse(request.body).approvalId === approvalId);

const seconds = (date: Date) => date.getTime() / 1000;

describe("the notification outbox", () => {
  it("writes one webhook row in the transaction that opens the approval, and none when opening fails", async () => {
    const approvalId = await openApproval();
    const row = await deliveryOf(approvalId);
    const [approval] = await t.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      workspaceId,
      event: "approval.opened",
      target: "webhook",
      userId: null,
      state: "pending",
      attempts: 0,
      lastCode: null,
      sentAt: null,
    });
    expect(row.id).toMatch(/^ndl_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(row.dueAt).toEqual(approval?.createdAt);
    expect(row.nextAttemptAt).toEqual(approval?.createdAt);

    // One transaction wrote the row and the approval's audit entry, which is never updated.
    const { rows } = await t.ctx.pool.query<{ delivery: string; audit: string }>(
      `SELECT (SELECT xmin::text FROM os.notification_deliveries WHERE approval_id = $1) AS delivery,
              (SELECT xmin::text FROM os.audit_events
                WHERE subject_id = $1 AND action = 'approval.opened') AS audit`,
      [approvalId],
    );

    expect(rows[0]?.delivery).toBe(rows[0]?.audit);

    const counts = async () => ({
      approvals: (await t.ctx.db.select({ id: approvals.id }).from(approvals)).length,
      deliveries: (
        await t.ctx.db.select({ id: notificationDeliveries.id }).from(notificationDeliveries)
      ).length,
    });

    const before = await counts();
    await expect(
      engineOf(t.ctx).open({
        workspaceId,
        kind: "set-admin-threshold",
        subjectId: workspaceId,
        envelope: { adminThreshold: 1 },
        threshold: 1,
        ttlSeconds: 3_600,
        detail: {},
        requestedBy: { type: "user", id: t.owner.userId },
        alongside: async () => {
          throw new Error("alongside failed");
        },
      }),
    ).rejects.toThrow("alongside failed");
    expect(await counts()).toEqual(before);
  });

  it("writes no row and sends nothing when no webhook is configured", async () => {
    const configured = t.ctx.config.notify;
    t.ctx.config.notify = { webhook: null, webPush: null };
    let approvalId: ApprovalId;

    try {
      approvalId = await openApproval();
    } finally {
      t.ctx.config.notify = configured;
    }

    expect(await deliveriesOf(approvalId)).toEqual([]);
    const before = receiver.requests.length;
    expect(await deliverDueNotifications(t.ctx)).toEqual(NOTHING);
    expect(receiver.requests).toHaveLength(before);
  });

  it("adds nothing when the same approval's notifications are written again", async () => {
    const approvalId = await openApproval();
    const now = t.clock.now();
    await t.ctx.db.transaction((tx) =>
      enqueueApprovalNotifications(t.ctx, tx, {
        id: approvalId,
        workspaceId,
        kind: "set-admin-threshold",
        createdAt: now,
        expiresAt: now + 3_600,
      }),
    );
    expect(await deliveriesOf(approvalId)).toHaveLength(1);
  });

  it("sends a row left pending by a process that died after opening the approval on the next sweep, signed", async () => {
    // Opened and committed, never sent: exactly what a crash right after the commit leaves.
    const approvalId = await openApproval();
    const result = await sweep(t.ctx);
    expect(result.notifications).toEqual({ ...NOTHING, sent: 1 });
    const row = await deliveryOf(approvalId);
    expect(row).toMatchObject({ state: "sent", attempts: 0, lastCode: null });
    expect(row.sentAt).toEqual(new Date(t.clock.now() * 1000));
    const [request] = requestsFor(approvalId);

    if (!request) throw new Error("the receiver saw nothing");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-os-delivery"]).toBe(row.id);
    expect(request.headers["x-os-timestamp"]).toBe(String(t.clock.now()));
    expect(request.headers["x-os-signature"]).toBe(
      expectedSignature(secret, String(request.headers["x-os-timestamp"]), request.body),
    );
  });

  it("sends a row again once the lease of a sender that died ends", async () => {
    const approvalId = await openApproval();
    // Claimed by a pass that died before it sent: its lease still runs.
    await t.ctx.db
      .update(notificationDeliveries)
      .set({ nextAttemptAt: new Date((t.clock.now() + 60) * 1000) })
      .where(eq(notificationDeliveries.approvalId, approvalId));
    expect(await deliverDueNotifications(t.ctx)).toEqual(NOTHING);
    expect(requestsFor(approvalId)).toHaveLength(0);
    t.clock.advance(60);
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, sent: 1 });
    expect(requestsFor(approvalId)).toHaveLength(1);
  });

  it("retries a 503 after its backoff, with the same delivery id, and ends sent after one failed attempt", async () => {
    receiver.answer({ status: 503 });
    const approvalId = await openApproval();
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, retried: 1 });
    const retrying = await deliveryOf(approvalId);
    expect(retrying).toMatchObject({ state: "pending", attempts: 1, lastCode: "http_503" });
    expect(seconds(retrying.nextAttemptAt)).toBe(t.clock.now() + 10);
    // Not before its time.
    expect(await deliverDueNotifications(t.ctx)).toEqual(NOTHING);

    t.clock.advance(10);
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, sent: 1 });
    expect(await deliveryOf(approvalId)).toMatchObject({
      state: "sent",
      attempts: 1,
      lastCode: null,
    });
    const seen = requestsFor(approvalId);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers["x-os-delivery"]).toBe(retrying.id);
    expect(seen[1]?.headers["x-os-delivery"]).toBe(retrying.id);
    expect(seen[0]?.body).toBe(seen[1]?.body);

    for (const request of seen) {
      expect(request.headers["x-os-signature"]).toBe(
        expectedSignature(secret, String(request.headers["x-os-timestamp"]), request.body),
      );
    }
  });

  it("honours Retry-After while it ends before the approval does, and backs off otherwise", async () => {
    receiver.answer({ status: 429, headers: { "retry-after": "30" } });
    const soon = await openApproval();
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, retried: 1 });
    const waiting = await deliveryOf(soon);
    expect(waiting.lastCode).toBe("http_429");
    expect(seconds(waiting.nextAttemptAt)).toBe(t.clock.now() + 30);

    // `soon` is delivered on its own pass first: two rows due in one pass are sent side by side,
    // and the receiver's one queued answer would go to whichever request arrived first.
    t.clock.advance(30);
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, sent: 1 });

    const late = await openApproval();
    t.clock.advance(3_000);
    receiver.answer({ status: 503, headers: { "retry-after": "900" } });
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, retried: 1 });
    // 900 seconds would pass the expiry, 600 seconds from now: the backoff applies.
    expect(seconds((await deliveryOf(late)).nextAttemptAt)).toBe(t.clock.now() + 10);
  });

  it("gives up after eight failed attempts, backing off 10 s doubling to 600 s, and at once on another refusal", async () => {
    receiver.answer(...Array.from({ length: 8 }, () => ({ status: 500 })));
    const approvalId = await openApproval();
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const counts = await deliverDueNotifications(t.ctx);
      const row = await deliveryOf(approvalId);
      expect(row.attempts).toBe(attempt);

      if (attempt === 8) {
        expect(counts).toEqual({ ...NOTHING, failed: 1 });
        expect(row).toMatchObject({ state: "failed", lastCode: "http_500" });
        break;
      }

      expect(counts).toEqual({ ...NOTHING, retried: 1 });
      const delay = seconds(row.nextAttemptAt) - t.clock.now();
      delays.push(delay);
      t.clock.advance(delay);
    }

    expect(delays).toEqual([10, 20, 40, 80, 160, 320, 600]);
    expect(requestsFor(approvalId)).toHaveLength(8);
    t.clock.advance(600);
    expect(await deliverDueNotifications(t.ctx)).toEqual(NOTHING);

    for (const answer of [
      { status: 400 },
      { status: 410 },
      { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } },
    ]) {
      receiver.answer(answer);
      const refused = await openApproval();
      expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, failed: 1 });
      expect(await deliveryOf(refused)).toMatchObject({
        state: "failed",
        attempts: 1,
        lastCode: `http_${answer.status}`,
      });
      expect(requestsFor(refused)).toHaveLength(1);
    }
  });

  it("drops, without a request, the notification of an approval rejected or expired before it went out", async () => {
    const rejected = await openApproval();
    await t.owner.browser.api.call("reject", { params: { approvalId: rejected }, body: {} });
    const expired = await openApproval();
    t.clock.advance(3_600);
    const before = receiver.requests.length;
    expect(await deliverDueNotifications(t.ctx)).toEqual({ ...NOTHING, dropped: 2 });

    for (const approvalId of [rejected, expired]) {
      expect(await deliveryOf(approvalId)).toMatchObject({
        state: "dropped",
        attempts: 0,
        lastCode: "approval_ended",
      });
    }

    expect(receiver.requests).toHaveLength(before);
  });

  it("sends each row once when two passes run at the same time", async () => {
    receiver.answer(...Array.from({ length: 3 }, () => ({ status: 200, delayMs: 200 })));
    const ids = [await openApproval(), await openApproval(), await openApproval()];

    const [first, second] = await Promise.all([
      deliverDueNotifications(t.ctx),
      deliverDueNotifications(t.ctx),
    ]);

    expect((first?.sent ?? 0) + (second?.sent ?? 0)).toBe(3);

    for (const approvalId of ids) {
      expect(requestsFor(approvalId)).toHaveLength(1);
      expect((await deliveryOf(approvalId)).state).toBe("sent");
    }
  });

  it("logs identifiers and codes only, and keeps nothing a receiver answered", async () => {
    const lines = t.log.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => String(line.message).startsWith("notification "));

    expect(new Set(lines.map((line) => line.message))).toEqual(
      new Set([
        "notification delivered",
        "notification retry",
        "notification dropped",
        "notification failed",
      ]),
    );

    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ["approvalId", "code", "deliveryId", "level", "message", "target"].sort(),
      );
      expect(line.target).toBe("webhook");
    }

    expect(t.log.lines.join("\n")).not.toContain("receiver body");

    const codes = await t.ctx.db
      .select({ code: notificationDeliveries.lastCode })
      .from(notificationDeliveries);

    for (const { code } of codes) expect(code ?? "").toMatch(/^[a-z0-9_]*$/);
  });
});
