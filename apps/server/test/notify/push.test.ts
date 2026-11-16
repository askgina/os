import { randomBytes } from "node:crypto";
import { ApiError, type MandateDraft } from "@askgina/os-api";
import type {
  ApprovalId,
  IntentId,
  MandateId,
  PushSubscriptionId,
  WorkspaceId,
} from "@askgina/os-protocol";
import type { Client } from "@modelcontextprotocol/client";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { intents, notificationDeliveries, pushSubscriptions } from "../../src/db/schema.ts";
import { PUSH_PAYLOAD_MAX_BYTES } from "../../src/notify/content.ts";
import { deliverDueNotifications } from "../../src/notify/outbox.ts";
import { reminderDueAt } from "../../src/notify/schedule.ts";
import { pushTopic } from "../../src/notify/webpush/send.ts";
import { createFixture, draftFor, type Fixture, fund, toolJson } from "../execution/fixture.ts";
import {
  TEST_CHAIN_ID,
  TEST_ORIGIN,
  type TestBrowser,
  type TestPerson,
} from "../support/context.ts";
import {
  type BrowserKeys,
  browserSubscription,
  decryptPush,
  markerForms,
  type Pushed,
  type PushService,
  pushConfig,
  type Receiver,
  startPushService,
  startReceiver,
  webhookSecret,
} from "./support.ts";

let f: Fixture;

let service: PushService;

let receiver: Receiver;

/** Approvers of the main workspace; Carol turned Web Push off for it. */
let bob: TestPerson;

let carol: TestPerson;

/** A viewer, and a member whose approver passkey still waits to be added. */
let viewer: TestBrowser;

let waiting: TestBrowser;

const ETH = 10n ** 18n;

/** Each device's own keys, by its endpoint's path, to read what was pushed to it. */
const devices = new Map<string, BrowserKeys>();

/** Subscription ids by device name. */
const ids = new Map<string, PushSubscriptionId>();

/** Join `workspaceId` through an invite with a new passkey; an approver's passkey is not added. */
async function join(workspaceId: WorkspaceId, displayName: string, role: "viewer" | "approver") {
  const invite = await f.t.owner.browser.api.call("createInvite", {
    params: { workspaceId },
    body: { role },
  });

  const token = invite.url.split("/").at(-1) ?? "";
  const browser = f.t.browser();

  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName },
  });

  const passkey = f.t.register(start.options);

  const session = await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
  });

  if (session.user === null) throw new Error("invite registration did not sign in");

  return browser;
}

beforeAll(async () => {
  service = await startPushService();
  receiver = await startReceiver();
  f = await createFixture("notify_push");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
  carol = await f.addApprover(f.workspaceId, "Carol Approver");
  viewer = await join(f.workspaceId, "Vera Viewer", "viewer");
  waiting = await join(f.workspaceId, "Walt Waiting", "approver");
  f.t.ctx.config.notify = {
    webhook: { url: receiver.url, secret: webhookSecret() },
    webPush: pushConfig().notify.webPush,
  };
});

afterAll(async () => {
  await f?.close();
  await receiver?.close();
  await service?.close();
});

// Each test sends only what it opened: what an earlier one left pending is not sent here.
beforeEach(async () => {
  await f.t.ctx.db
    .update(notificationDeliveries)
    .set({ state: "dropped", lastCode: "test_reset" })
    .where(eq(notificationDeliveries.state, "pending"));
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );

  if (!(error instanceof ApiError)) throw new Error("expected the API to refuse");

  return { code: error.code, status: error.status, detail: error.detail };
}

/** Turn notifications on for this browser as device `name`, keeping its keys to read pushes. */
async function subscribe(browser: TestBrowser, name: string, label?: string) {
  const { ua, keys } = await browserSubscription(`${service.origin}/push/${name}`);
  devices.set(`/push/${name}`, ua);

  const added = await browser.api.call("addPushSubscription", {
    body: {
      endpoint: keys.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      ...(label === undefined ? {} : { label }),
    },
  });

  ids.set(name, added.id as PushSubscriptionId);

  return added;
}

/** A request people decide on in `workspaceId`: an admin threshold change, open for an hour. */
async function openAdmin(workspaceId: WorkspaceId, adminThreshold = 1): Promise<ApprovalId> {
  const opened = await f.t.owner.browser.api.call("requestAdminThreshold", {
    params: { workspaceId },
    body: { adminThreshold },
  });

  return opened.id as ApprovalId;
}

const rowsOf = (approvalId: ApprovalId) =>
  f.t.ctx.db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.approvalId, approvalId))
    .orderBy(asc(notificationDeliveries.event), asc(notificationDeliveries.target));

const targetsOf = async (approvalId: ApprovalId) =>
  (await rowsOf(approvalId)).map((row) => `${row.event} ${row.target}`);

const pushTarget = (name: string) => `push:${ids.get(name)}`;

/** What the push service got for `approvalId`, read as each device reads it. */
async function pushesFor(approvalId: ApprovalId) {
  const topic = pushTopic(approvalId);
  const found = service.pushed.filter((pushed) => pushed.headers.topic === topic);

  return Promise.all(
    found.map(async (pushed: Pushed) => {
      const ua = devices.get(pushed.path);

      if (!ua) throw new Error(`no device at ${pushed.path}`);
      const text = await decryptPush(pushed.body, ua);

      return { pushed, text, payload: JSON.parse(text) };
    }),
  );
}

async function agentWith(name: string, ttlSeconds = 3_600) {
  const agent = await f.newAgent(name);
  await f.setPolicy(
    f.workspaceId,
    agent.walletId,
    draftFor(agent.id, { approvals: { threshold: 1, ttlSeconds } }),
  );
  await fund(agent.address, 50n * ETH);

  return { agent, client: await f.mcp(agent.token) };
}

async function propose(client: Client, args: Record<string, unknown>) {
  const answer = toolJson(await client.callTool({ name: "propose_transfer", arguments: args }));

  if (typeof answer.intentId !== "string") throw new Error(JSON.stringify(answer));

  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, answer.intentId as IntentId));

  if (!row?.approvalId) throw new Error("an intent without its approval or use");

  return { answer, approvalId: row.approvalId };
}

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

/** A payment proposal whose amount, recipient and memo are markers no notification may carry. */
async function markedPayment(client: Client) {
  const recipient = randomAddress();
  const memo = `memo-marker-${randomBytes(6).toString("hex")}`;

  const { approvalId } = await propose(client, {
    chainId: TEST_CHAIN_ID,
    to: recipient,
    amount: "0.031415926",
    memo,
  });

  return {
    approvalId,
    markers: [memo, recipient, recipient.slice(2), "0.031415926", "31415926000000000"],
  };
}

function expectNoMarkers(text: string, markers: string[]) {
  const lower = text.toLowerCase();

  for (const marker of markers) {
    for (const form of markerForms(marker)) expect(lower).not.toContain(form.toLowerCase());
  }
}

describe("devices that get notifications", () => {
  it("are added only while Web Push is on, at an allowed https push service, with a real key", async () => {
    const api = f.t.owner.browser.api;
    const webPush = f.t.ctx.config.notify.webPush;

    if (webPush === null) throw new Error("Web Push is off");
    const config = await api.call("getPushConfig");
    expect(config).toEqual({
      enabled: true,
      applicationServerKey: Buffer.from(webPush.vapidPublicKey).toString("base64url"),
    });
    expect(config.applicationServerKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);

    const { keys } = await browserSubscription(`${service.origin}/push/refused`);
    const input = { endpoint: keys.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    const add = (body: typeof input) => api.call("addPushSubscription", { body });
    expect(
      await refusal(add({ ...input, endpoint: keys.endpoint.replace("https:", "http:") })),
    ).toMatchObject({ code: "invalid_request", status: 400 });

    for (const endpoint of [
      "https://push.evil.example/x",
      "https://127.0.0.1/x",
      `https://user:secret@${new URL(service.origin).host}/push/x`,
    ]) {
      expect(await refusal(add({ ...input, endpoint }))).toEqual({
        code: "invalid_request",
        status: 400,
        detail: "endpoint_refused",
      });
    }

    // 0x04 and zeros: the right length, but not a point on the curve.
    const offCurve = { ...input.keys, p256dh: `B${"A".repeat(86)}` };
    expect(await refusal(add({ ...input, keys: offCurve }))).toEqual({
      code: "invalid_request",
      status: 400,
      detail: "bad_subscription",
    });

    const configured = f.t.ctx.config.notify;
    f.t.ctx.config.notify = { ...configured, webPush: null };

    try {
      expect(await api.call("getPushConfig")).toEqual({
        enabled: false,
        applicationServerKey: null,
      });
      expect(await refusal(add(input))).toEqual({
        code: "conflict",
        status: 409,
        detail: "push_off",
      });
    } finally {
      f.t.ctx.config.notify = configured;
    }

    expect((await refusal(f.t.browser().api.call("getPushConfig"))).code).toBe("unauthenticated");
    expect(
      (await refusal(f.t.browser().api.call("addPushSubscription", { body: input }))).code,
    ).toBe("unauthenticated");
    expect(await f.t.ctx.db.select().from(pushSubscriptions)).toEqual([]);
    expect(service.pushed).toHaveLength(0);
  });

  it("belong to their person, who alone lists and removes them; the same browser again keeps its id", async () => {
    const owner = f.t.owner.browser.api;
    const phone = await subscribe(f.t.owner.browser, "owner-phone", "Phone");
    expect(phone).toEqual({
      id: phone.id,
      label: "Phone",
      createdAt: f.t.clock.now(),
      lastSuccessAt: null,
    });
    expect(phone.id).toMatch(/^psb_[0-9a-hjkmnp-tv-z]{26}$/);
    // The browser renewed its keys and sent the subscription again, with no label.
    expect(await subscribe(f.t.owner.browser, "owner-phone")).toEqual(phone);

    expect(await bob.browser.api.call("listPushSubscriptions")).toEqual({ items: [] });
    expect(
      await refusal(
        bob.browser.api.call("removePushSubscription", { params: { subscriptionId: phone.id } }),
      ),
    ).toMatchObject({ code: "not_found", status: 404 });
    expect(await owner.call("listPushSubscriptions")).toEqual({ items: [phone] });

    // A browser someone else turns on afterwards is theirs from then on, under a new id.
    const tablet = await subscribe(f.t.owner.browser, "shared-tablet", "Tablet");
    const taken = await subscribe(bob.browser, "shared-tablet");
    expect(taken.id).not.toBe(tablet.id);
    expect(taken.label).toBeNull();
    expect(await owner.call("listPushSubscriptions")).toEqual({ items: [phone] });
    expect(await bob.browser.api.call("listPushSubscriptions")).toEqual({ items: [taken] });
    await bob.browser.api.call("removePushSubscription", { params: { subscriptionId: taken.id } });
    expect(await bob.browser.api.call("listPushSubscriptions")).toEqual({ items: [] });
    expect(
      await refusal(
        bob.browser.api.call("removePushSubscription", { params: { subscriptionId: taken.id } }),
      ),
    ).toMatchObject({ code: "not_found" });
    // Nothing about where a device is reached is ever shown back.
    expect(JSON.stringify(await owner.call("listPushSubscriptions"))).not.toContain("/push/");
  });

  it("start with every switch on and no quiet hours; only the person's own workspaces can be set", async () => {
    const api = bob.browser.api;
    expect(await api.call("getNotificationPreferences")).toEqual({
      workspaces: [{ workspaceId: f.workspaceId, webPush: true, reminders: true }],
      quietHours: null,
    });
    const elsewhere = await f.newWorkspace("Not Bob's");
    expect(
      await refusal(
        api.call("setNotificationPreferences", {
          body: {
            workspaces: [{ workspaceId: elsewhere, webPush: false, reminders: false }],
            quietHours: null,
          },
        }),
      ),
    ).toMatchObject({ code: "not_found" });
    const quietHours = { start: "21:30", end: "06:45", timeZone: "Europe/Berlin" };
    expect(
      await api.call("setNotificationPreferences", {
        body: {
          workspaces: [{ workspaceId: f.workspaceId, webPush: true, reminders: false }],
          quietHours,
        },
      }),
    ).toEqual({
      workspaces: [{ workspaceId: f.workspaceId, webPush: true, reminders: false }],
      quietHours,
    });
    // Leaving a workspace out keeps it; null turns quiet hours off.
    expect(
      await api.call("setNotificationPreferences", { body: { workspaces: [], quietHours: null } }),
    ).toEqual({
      workspaces: [{ workspaceId: f.workspaceId, webPush: true, reminders: false }],
      quietHours: null,
    });
  });

  it("hear about a request when their person can approve it: two devices, two rows; none for viewers, a passkey still waiting, or Web Push turned off there", async () => {
    await subscribe(bob.browser, "bob-phone");
    await subscribe(bob.browser, "bob-laptop");
    await subscribe(carol.browser, "carol-phone");
    await subscribe(viewer, "viewer-phone");
    await subscribe(waiting, "waiting-phone");
    await carol.browser.api.call("setNotificationPreferences", {
      body: {
        workspaces: [{ workspaceId: f.workspaceId, webPush: false, reminders: true }],
        quietHours: null,
      },
    });

    const approvalId = await openAdmin(f.workspaceId);
    const rows = await rowsOf(approvalId);
    // Bob turned reminders off in the test before: only the owner's phone gets one.
    expect(rows.map((row) => `${row.event} ${row.target}`).sort()).toEqual(
      [
        "approval.opened webhook",
        `approval.opened ${pushTarget("owner-phone")}`,
        `approval.opened ${pushTarget("bob-phone")}`,
        `approval.opened ${pushTarget("bob-laptop")}`,
        `approval.reminder ${pushTarget("owner-phone")}`,
      ].sort(),
    );
    const byTarget = new Map(rows.map((row) => [`${row.event} ${row.target}`, row]));
    expect(byTarget.get(`approval.opened ${pushTarget("bob-phone")}`)?.userId).toBe(bob.userId);
    expect(byTarget.get(`approval.opened ${pushTarget("owner-phone")}`)?.userId).toBe(
      f.t.owner.userId,
    );
    const reminder = byTarget.get(`approval.reminder ${pushTarget("owner-phone")}`);
    const created = f.t.clock.now();
    expect(reminder?.dueAt).toEqual(
      new Date((reminderDueAt(created, created + 3_600) ?? 0) * 1000),
    );
    expect(reminder?.dueAt).toEqual(new Date((created + 2_700) * 1000));

    // Reminders on again for Bob: the same request written again adds nothing.
    await bob.browser.api.call("setNotificationPreferences", {
      body: {
        workspaces: [{ workspaceId: f.workspaceId, webPush: true, reminders: true }],
        quietHours: null,
      },
    });
    expect(await rowsOf(approvalId)).toHaveLength(5);
  });

  it("never hear about a mandate's use, which nobody decides on", async () => {
    const { agent, client } = await agentWith("Supplier payer");
    const recipient = randomAddress();

    const draft: MandateDraft = {
      agentId: agent.id,
      assets: [
        {
          chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
          asset: "native",
          maxPerAction: ETH.toString(),
          maxPerWindow: (2n * ETH).toString(),
          maxTotal: (3n * ETH).toString(),
        },
      ],
      windowSeconds: 86_400,
      recipients: [recipient],
      maxUses: 5,
      maxFeePerActionWei: "100000000000000000",
      notAfter: f.t.clock.now() + 3 * 86_400,
      purpose: "supplier invoices",
    };

    const grant = await f.t.owner.browser.api.call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: agent.walletId },
      body: draft,
    });

    // A grant is decided by people, so their devices hear about it.
    expect(await targetsOf(grant.id as ApprovalId)).toContain(
      `approval.opened ${pushTarget("bob-phone")}`,
    );
    const granted = await f.t.approve(grant.id as ApprovalId, [bob]);
    expect(granted.status).toBe("executed");

    const { answer, approvalId: useId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.5",
      memo: "covered",
    });

    expect(answer).toMatchObject({ mandateId: granted.subjectId as MandateId, approvalUrl: null });
    expect(await targetsOf(useId)).toEqual(["mandate.used webhook"]);
    await deliverDueNotifications(f.t.ctx);
    expect(await pushesFor(useId)).toEqual([]);
  });
});

describe("a push notification", () => {
  it("at `count` carries no names and none of a payment's amount, recipient or memo, in 511 bytes", async () => {
    const { client } = await agentWith("Marker payer");
    const { approvalId, markers } = await markedPayment(client);
    expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 4, failed: 0 });
    const received = await pushesFor(approvalId);
    expect(received.map(({ pushed }) => pushed.path).sort()).toEqual(
      ["/push/bob-laptop", "/push/bob-phone", "/push/owner-phone"].sort(),
    );
    const approval = await f.t.owner.browser.api.call("getApproval", { params: { approvalId } });
    const link = `${TEST_ORIGIN}/w/${f.workspaceId}/approvals/${approvalId}`;

    for (const { pushed, text, payload } of received) {
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
      expect(payload).toEqual({
        web_push: 8030,
        notification: {
          title: "Approval waiting",
          body: expect.stringMatching(/^(1 request needs|\d+ requests need) your passkey$/),
          navigate: link,
          tag: `approval-${approvalId}`,
          lang: "en",
          silent: false,
          app_badge: expect.stringMatching(/^\d+$/),
        },
      });
      expect(payload.notification.body.startsWith(`${payload.notification.app_badge} `)).toBe(true);
      expect(pushed.headers).toMatchObject({
        ttl: String(approval.expiresAt - f.t.clock.now()),
        urgency: "high",
        topic: pushTopic(approvalId),
      });
      expectNoMarkers(text, [...markers, "Marker payer", "Execution tests", "Payment"]);
      expectNoMarkers(JSON.stringify(pushed.headers), markers);
    }

    const sent = (await rowsOf(approvalId)).filter((row) => row.event === "approval.opened");
    expect(sent.map((row) => row.state)).toEqual(["sent", "sent", "sent", "sent"]);

    const [phone] = await f.t.ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, ids.get("owner-phone") as PushSubscriptionId));

    expect(phone?.lastSuccessAt).toEqual(new Date(f.t.clock.now() * 1000));
    expect(phone?.failureCount).toBe(0);
  });

  it("at `summary`, which only an owner sets and the audit log records, shows the kind, who asked and the workspace", async () => {
    const workspaceId = f.workspaceId;

    const set = (browser: TestBrowser, detail: "count" | "summary") =>
      browser.api.call("setNotificationDetail", { params: { workspaceId }, body: { detail } });

    expect(await refusal(set(bob.browser, "summary"))).toMatchObject({
      code: "forbidden",
      status: 403,
    });
    expect(await refusal(set(viewer, "summary"))).toMatchObject({ code: "forbidden" });
    expect(await refusal(set(f.t.browser(), "summary"))).toMatchObject({
      code: "unauthenticated",
    });

    const recorded = async () =>
      (
        await f.t.owner.browser.api.call("listAudit", { params: { workspaceId }, query: {} })
      ).items.filter((event) => event.action === "workspace.notification_detail_set");

    expect(await recorded()).toEqual([]);
    expect((await set(f.t.owner.browser, "summary")).notificationDetail).toBe("summary");
    // Setting what is already set records nothing.
    await set(f.t.owner.browser, "summary");
    const events = await recorded();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: "user", id: f.t.owner.userId },
      subject: { type: "workspace", id: workspaceId },
      detail: { detail: "summary" },
    });
    expect(
      await f.t.owner.browser.api.call("verifyAudit", { params: { workspaceId } }),
    ).toMatchObject({ ok: true });
    expect(
      (await bob.browser.api.call("getWorkspace", { params: { workspaceId } })).notificationDetail,
    ).toBe("summary");

    try {
      const { client } = await agentWith("Summary payer");
      const { approvalId, markers } = await markedPayment(client);
      await deliverDueNotifications(f.t.ctx);
      const received = await pushesFor(approvalId);
      expect(received).toHaveLength(3);

      for (const { text, payload } of received) {
        expect(payload.notification).toMatchObject({
          title: "Payment waiting",
          body: "Summary payer in Execution tests",
          tag: `approval-${approvalId}`,
        });
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
        expectNoMarkers(text, markers);
      }
    } finally {
      await set(f.t.owner.browser, "count");
    }
  });

  it("logs identifiers and codes only: never where a device is reached or its keys", async () => {
    const stored = await f.t.ctx.db.select().from(pushSubscriptions);
    const lines = f.t.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const pushLines = lines.filter(
      (line) => String(line.message).startsWith("notification ") && line.target === "push",
    );

    expect(pushLines.length).toBeGreaterThan(0);

    for (const line of pushLines) {
      expect(Object.keys(line).sort()).toEqual(
        ["approvalId", "code", "deliveryId", "level", "message", "target"].sort(),
      );
    }

    const all = f.t.log.lines.join("\n");
    expect(all).not.toContain("/push/");

    for (const subscription of stored) {
      expect(all).not.toContain(subscription.p256dh);
      expect(all).not.toContain(subscription.auth);
    }
  });
});

describe("one device's notifications", () => {
  /** A workspace where only Dana hears about requests: the owner turned it off there. */
  let counting: WorkspaceId;
  let dana: TestPerson;

  beforeAll(async () => {
    counting = await f.newWorkspace("Counting");
    dana = await f.addApprover(counting, "Dana Approver");
    await f.t.owner.browser.api.call("setNotificationPreferences", {
      body: {
        workspaces: [{ workspaceId: counting, webPush: false, reminders: true }],
        quietHours: null,
      },
    });
    await subscribe(dana.browser, "dana-phone");
  });

  const danaRow = async (approvalId: ApprovalId, event = "approval.opened") => {
    const row = (await rowsOf(approvalId)).find(
      (item) => item.event === event && item.target === pushTarget("dana-phone"),
    );

    if (!row) throw new Error(`no ${event} row for Dana's phone`);

    return row;
  };

  const seconds = (date: Date) => date.getTime() / 1000;

  /** What waits for Dana now, as her own list of requests shows it. */
  const openForDana = async () =>
    (
      await dana.browser.api.call("listApprovals", {
        params: { workspaceId: counting },
        query: { status: "pending" },
      })
    ).items.filter((item) => item.expiresAt > f.t.clock.now());

  it("goes to that device alone, with the number of requests waiting for its person", async () => {
    const approvalId = await openAdmin(counting);
    expect(await targetsOf(approvalId)).toEqual([
      `approval.opened ${pushTarget("dana-phone")}`,
      "approval.opened webhook",
      `approval.reminder ${pushTarget("dana-phone")}`,
    ]);
    const waitingNow = (await openForDana()).length;
    await deliverDueNotifications(f.t.ctx);
    const [first] = await pushesFor(approvalId);
    expect(first?.payload.notification).toMatchObject({
      body:
        waitingNow === 1
          ? "1 request needs your passkey"
          : `${waitingNow} requests need your passkey`,
      app_badge: String(waitingNow),
    });

    const second = await openAdmin(counting);
    await deliverDueNotifications(f.t.ctx);
    const [next] = await pushesFor(second);
    expect(next?.payload.notification).toMatchObject({
      body: `${waitingNow + 1} requests need your passkey`,
      app_badge: String(waitingNow + 1),
    });
  });

  it("deletes a device its push service says is gone, tries a busy one again, and fails on a refusal", async () => {
    service.answer({ status: 410 });
    const gone = await openAdmin(counting);
    expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1, dropped: 1 });
    expect(await danaRow(gone)).toMatchObject({ state: "dropped", lastCode: "gone", attempts: 0 });
    expect(await dana.browser.api.call("listPushSubscriptions")).toEqual({ items: [] });
    // Written for the device that is now gone; Dana turns notifications on again, a new device.
    const goneReminder = await danaRow(gone, "approval.reminder");
    await subscribe(dana.browser, "dana-phone");

    service.answer({ status: 503 });
    const busy = await openAdmin(counting);
    expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1, retried: 1 });
    const retrying = await danaRow(busy);
    expect(retrying).toMatchObject({ state: "pending", attempts: 1, lastCode: "http_503" });
    expect(seconds(retrying.nextAttemptAt)).toBe(f.t.clock.now() + 10);

    const [failing] = await f.t.ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, ids.get("dana-phone") as PushSubscriptionId));

    expect(failing?.failureCount).toBe(1);
    f.t.clock.advance(10);
    expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1 });
    expect(await danaRow(busy)).toMatchObject({ state: "sent", attempts: 1, lastCode: null });

    const [recovered] = await f.t.ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, ids.get("dana-phone") as PushSubscriptionId));

    expect(recovered?.failureCount).toBe(0);
    expect(recovered?.lastSuccessAt).toEqual(new Date(f.t.clock.now() * 1000));

    service.answer({ status: 400 });
    const refused = await openAdmin(counting);
    expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1, failed: 1 });
    expect(await danaRow(refused)).toMatchObject({
      state: "failed",
      attempts: 1,
      lastCode: "http_400",
    });

    f.t.clock.advance(seconds(goneReminder.dueAt) - f.t.clock.now());
    await deliverDueNotifications(f.t.ctx);

    const [reminded] = await f.t.ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, goneReminder.id));

    expect(reminded).toMatchObject({ state: "dropped", lastCode: "unsubscribed" });
    // Only the attempt the push service answered 410 to.
    expect(
      service.pushed.filter((pushed) => pushed.headers.topic === pushTopic(gone)),
    ).toHaveLength(1);
  });

  it("reminds once before the expiry, replacing the first notification, and not for a request that ended", async () => {
    const approvalId = await openAdmin(counting);
    const ended = await openAdmin(counting);
    const created = f.t.clock.now();
    await deliverDueNotifications(f.t.ctx);
    const [opened] = await pushesFor(approvalId);
    await f.t.owner.browser.api.call("reject", { params: { approvalId: ended }, body: {} });

    const due = seconds((await danaRow(approvalId, "approval.reminder")).dueAt);
    expect(due).toBe(created + 2_700);
    // Not before its time.
    f.t.clock.advance(due - 1 - f.t.clock.now());
    await deliverDueNotifications(f.t.ctx);
    expect(await pushesFor(approvalId)).toHaveLength(1);

    f.t.clock.advance(1);
    await deliverDueNotifications(f.t.ctx);
    const received = await pushesFor(approvalId);
    expect(received).toHaveLength(2);
    const reminder = received[1];
    expect(reminder?.payload.notification.title).toBe("Expiring soon: Approval waiting");
    expect(reminder?.payload.notification.tag).toBe(opened?.payload.notification.tag);
    expect(reminder?.pushed.headers.topic).toBe(opened?.pushed.headers.topic);
    expect(reminder?.pushed.headers.ttl).toBe("900");
    expect(await danaRow(approvalId, "approval.reminder")).toMatchObject({ state: "sent" });
    expect(await danaRow(ended, "approval.reminder")).toMatchObject({
      state: "dropped",
      lastCode: "approval_ended",
    });
    expect(await pushesFor(ended)).toHaveLength(1);
  });

  it("is not reminded of a request that lives under thirty minutes", async () => {
    const { client } = await agentWith("Quick payer", 600);

    const { approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: randomAddress(),
      amount: "0.01",
      memo: "quick",
    });

    const rows = await targetsOf(approvalId);
    expect(rows).toContain(`approval.opened ${pushTarget("owner-phone")}`);
    expect(rows.filter((row) => row.startsWith("approval.reminder"))).toEqual([]);
  });

  it("is not reminded of a request its person already approved, which no longer counts as waiting", async () => {
    // Two approvals needed from here on.
    const raise = await openAdmin(counting, 2);
    expect((await f.t.approve(raise, [dana])).status).toBe("executed");
    const approvalId = await openAdmin(counting, 2);
    expect((await f.t.approve(approvalId, [dana])).status).toBe("pending");

    const due = seconds((await danaRow(approvalId, "approval.reminder")).dueAt);
    f.t.clock.advance(due - f.t.clock.now());
    await deliverDueNotifications(f.t.ctx);
    expect(await danaRow(approvalId, "approval.reminder")).toMatchObject({
      state: "dropped",
      lastCode: "already_approved",
    });

    const next = await openAdmin(counting, 2);
    await deliverDueNotifications(f.t.ctx);
    const [told] = await pushesFor(next);
    // Everything still open but the one Dana approved.
    const open = await openForDana();
    expect(open.map((item) => item.id)).toContain(approvalId);
    expect(open.map((item) => item.id)).toContain(next);
    expect(told?.payload.notification.app_badge).toBe(String(open.length - 1));
  });

  it("waits out its person's quiet hours, while the webhook does not, and is dropped when the request expires first", async () => {
    const hhmm = (instant: number) => new Date(instant * 1000).toISOString().slice(11, 16);
    const now = f.t.clock.now();
    const endAt = Math.ceil((now + 600) / 60) * 60;

    const quiet = (end: number) =>
      dana.browser.api.call("setNotificationPreferences", {
        body: {
          workspaces: [],
          quietHours: { start: hhmm(now - 3_600), end: hhmm(end), timeZone: "UTC" },
        },
      });

    await quiet(endAt);

    try {
      const approvalId = await openAdmin(counting, 2);

      const hooks = () =>
        receiver.requests.filter((request) => JSON.parse(request.body).approvalId === approvalId);

      expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1, held: 1 });
      expect(hooks()).toHaveLength(1);
      const held = await danaRow(approvalId);
      expect(held).toMatchObject({ state: "pending", attempts: 0, lastCode: "quiet_hours" });
      expect(seconds(held.nextAttemptAt)).toBe(endAt);
      expect(await pushesFor(approvalId)).toEqual([]);
      f.t.clock.advance(endAt - 1 - f.t.clock.now());
      expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 0, held: 0 });
      f.t.clock.advance(1);
      expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1 });
      expect(await danaRow(approvalId)).toMatchObject({ state: "sent", lastCode: null });
      expect(await pushesFor(approvalId)).toHaveLength(1);

      // Quiet until two hours from now; the request expires in one.
      const later = f.t.clock.now();
      await dana.browser.api.call("setNotificationPreferences", {
        body: {
          workspaces: [],
          quietHours: {
            start: hhmm(later - 600),
            end: hhmm(Math.ceil((later + 7_200) / 60) * 60),
            timeZone: "UTC",
          },
        },
      });
      const expiring = await openAdmin(counting, 2);
      expect(await deliverDueNotifications(f.t.ctx)).toMatchObject({ sent: 1, dropped: 1 });
      expect(await danaRow(expiring)).toMatchObject({ state: "dropped", lastCode: "quiet_hours" });
      expect(
        receiver.requests.filter((request) => JSON.parse(request.body).approvalId === expiring),
      ).toHaveLength(1);
    } finally {
      await dana.browser.api.call("setNotificationPreferences", {
        body: { workspaces: [], quietHours: null },
      });
    }
  });
});
