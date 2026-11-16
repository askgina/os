import { ApiError, type MandateDraft, type WorkspaceTemplate } from "@askgina/os-api";
import type { UserId, WorkspaceId } from "@askgina/os-protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approverCredentials,
  auditEvents,
  credentials,
  notificationDeliveries,
  notificationPreferences,
  pushSubscriptions,
  sessions,
  users,
} from "../../src/db/schema.ts";
import { ERASED_NAME } from "../../src/identity/erase.ts";
import { main as eraseCli } from "../../src/identity/erase-cli.ts";
import { RECENT_SIGN_IN_MAX_AGE_SECONDS } from "../../src/identity/sessions.ts";
import { recordLines, verifyRecord } from "../../src/lifecycle/verify-record.ts";
import { createFixture, type Fixture } from "../execution/fixture.ts";
import { browserSubscription, markerForms, pushConfig } from "../notify/support.ts";
import { TEST_CHAIN_ID, type TestBrowser, type TestPerson } from "../support/context.ts";

const ETH = 10n ** 18n;

const VENDOR = "0x00000000000000000000000000000000000000cc";

const BOB = "Bob Approver";

let f: Fixture;

/** Approvers of the main workspace with the owner. Bob is the one erased. */
let bob: TestPerson;

let carol: TestPerson;

/** A workspace Bob created, so its first owner. */
let bobs: WorkspaceId;

/** The main workspace's template, exported while Bob was still a member. */
let template: WorkspaceTemplate;

let mandateId: string;

const owner = () => f.t.owner.browser.api;

async function refusal(call: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) {
      return error.detail === undefined
        ? { code: error.code }
        : { code: error.code, detail: error.detail };
    }

    throw error;
  }

  throw new Error("the call was not refused");
}

/** Join `workspaceId` as a viewer through an invite, with a new passkey. */
async function joinAsViewer(workspaceId: WorkspaceId, displayName: string): Promise<UserId> {
  const invite = await owner().call("createInvite", {
    params: { workspaceId },
    body: { role: "viewer" },
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
    body: { ceremonyId: start.ceremonyId, response: passkey.response },
  });

  if (session.user === null) throw new Error("invite registration did not sign in");

  return session.user.id;
}

/** Rows anywhere in the `os` schema whose text holds `marker` as itself, hex or base64. */
async function rowsNaming(marker: string): Promise<string[]> {
  const { rows: tables } = await f.t.ctx.pool.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'os' AND table_type = 'BASE TABLE'",
  );

  const found: string[] = [];

  for (const { name } of tables) {
    for (const form of markerForms(marker)) {
      const { rows } = await f.t.ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM os."${name}" AS r WHERE strpos(r::text, $1) > 0`,
        [form],
      );

      if ((rows[0]?.n ?? 0) > 0) found.push(`${name}: ${form}`);
    }
  }

  return found;
}

async function signInAgain(person: TestPerson): Promise<TestBrowser> {
  return f.t.signIn(person.credentialId, person.browser);
}

beforeAll(async () => {
  f = await createFixture("identity_erase");
  const ws = f.workspaceId;
  bob = await f.addApprover(ws, BOB);
  carol = await f.addApprover(ws, "Carol Approver");
  f.t.ctx.config.notify = { webhook: null, webPush: pushConfig().notify.webPush };

  // Bob's device and settings, all personal data erasing removes.
  const { keys } = await browserSubscription("https://localhost/push/bob");
  await bob.browser.api.call("addPushSubscription", {
    body: { endpoint: keys.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label: BOB },
  });
  await bob.browser.api.call("setNotificationPreferences", {
    body: {
      workspaces: [{ workspaceId: ws, webPush: true, reminders: false }],
      quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Berlin" },
    },
  });

  // A mandate only Bob's passkey granted: it must not outlive his authority.
  const draft: MandateDraft = {
    agentId: f.agent.id,
    assets: [
      {
        chainId: TEST_CHAIN_ID,
        asset: "native",
        maxPerAction: ETH.toString(),
        maxPerWindow: (2n * ETH).toString(),
        maxTotal: (3n * ETH).toString(),
      },
    ],
    windowSeconds: 86_400,
    recipients: [VENDOR],
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: f.t.clock.now() + 3 * 86_400,
    purpose: "pay the vendor",
  };

  const grant = await owner().call("proposeMandate", {
    params: { workspaceId: ws, walletId: f.agent.walletId },
    body: draft,
  });

  expect((await f.t.approve(grant.id, [bob])).status).toBe("executed");
  const [state] = (await f.t.ctx.signer.listMandates(f.agent.walletId)).mandates;
  expect(state?.grantedBy).toEqual([bob.userId]);
  mandateId = state?.mandate.id ?? "";

  // Bob's own workspace, where he is the only owner.
  bobs = (await bob.browser.api.call("createWorkspace", { body: { name: "Bob's books" } })).id;

  template = await owner().call("exportTemplate", { params: { workspaceId: ws } });
  expect(template.members.map((member) => member.userId)).toContain(bob.userId);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

describe("erasing a person", () => {
  it("refuses while they are the only owner of a workspace", async () => {
    expect(await refusal(bob.browser.api.call("eraseMe", { body: {} }))).toEqual({
      code: "conflict",
      detail: "last_owner",
    });

    // The owner joins Bob's workspace as a second owner, with her passkey approving there.
    const invite = await bob.browser.api.call("createInvite", {
      params: { workspaceId: bobs },
      body: { role: "owner" },
    });

    await owner().call("acceptInvite", {
      params: { token: invite.url.split("/").at(-1) ?? "" },
      body: {},
    });

    const pending = await bob.browser.api.call("listApprovals", {
      params: { workspaceId: bobs },
      query: { status: "pending" },
    });

    const enroll = pending.items.find((item) => item.kind === "add-approver");

    if (enroll === undefined) throw new Error("no pending add-approver request");
    expect((await f.t.approve(enroll.id, [bob])).status).toBe("executed");
  });

  it("refuses while a workspace's threshold needs their passkey", async () => {
    const raise = await owner().call("requestAdminThreshold", {
      params: { workspaceId: f.workspaceId },
      body: { adminThreshold: 3 },
    });

    expect((await f.t.approve(raise.id, [f.t.owner])).status).toBe("executed");
    expect(await refusal(bob.browser.api.call("eraseMe", { body: {} }))).toEqual({
      code: "conflict",
      detail: "last_approver",
    });
    // Nothing changed: the operator's command refuses the same way.
    const printed: object[] = [];
    expect(await eraseCli(["--user", bob.userId], f.t.ctx, (line) => printed.push(line))).toBe(2);
    expect(printed).toEqual([
      expect.objectContaining({ ok: false, code: "conflict", detail: "last_approver" }),
    ]);

    const lower = await owner().call("requestAdminThreshold", {
      params: { workspaceId: f.workspaceId },
      body: { adminThreshold: 2 },
    });

    expect((await f.t.approve(lower.id, [f.t.owner, bob, carol])).status).toBe("executed");
  });

  it("needs a passkey sign-in from the last five minutes", async () => {
    f.t.clock.advance(RECENT_SIGN_IN_MAX_AGE_SECONDS + 1);
    expect(await refusal(bob.browser.api.call("eraseMe", { body: {} }))).toEqual({
      code: "forbidden",
      detail: "sign_in_again",
    });
    await signInAgain(bob);
  });

  it("first asks each workspace's people to stop accepting their passkey, and asking again shows the same requests", async () => {
    const first = await bob.browser.api.call("eraseMe", { body: {} });
    expect(first.status).toBe("waiting");
    expect(first.approvals.map((a) => [a.workspaceId, a.kind, a.threshold]).sort()).toEqual(
      [
        [bobs, "remove-approver", 1],
        [f.workspaceId, "remove-approver", 2],
      ].sort(),
    );
    const again = await bob.browser.api.call("eraseMe", { body: {} });
    expect(again.status).toBe("waiting");
    expect(again.approvals.map((a) => a.id).sort()).toEqual(
      first.approvals.map((a) => a.id).sort(),
    );
    // Still a member who signs in and approves, until erased.
    expect((await bob.browser.api.call("getSession")).user?.id).toBe(bob.userId);

    for (const approval of first.approvals) {
      const people = approval.workspaceId === bobs ? [f.t.owner] : [bob, carol];
      expect((await f.t.approve(approval.id, people)).status).toBe("executed");
    }

    for (const workspaceId of [f.workspaceId, bobs]) {
      const atSigner = await f.t.ctx.signer.getWorkspace(workspaceId);
      expect(atSigner.approvers.map((a) => a.userId)).not.toContain(bob.userId);
    }

    // Removing the passkey that granted it ended Bob's mandate at the signer.
    const [state] = (await f.t.ctx.signer.listMandates(f.agent.walletId)).mandates.filter(
      (m) => m.mandate.id === mandateId,
    );

    expect(state?.revokedReason).toBe("grantor_removed");
  });

  it("then erases them: no sign-in, session, device, setting or name is left, and every audit chain verifies", async () => {
    const bobPending = and(
      eq(notificationDeliveries.userId, bob.userId),
      eq(notificationDeliveries.state, "pending"),
    );

    const waiting = await f.t.ctx.db.select().from(notificationDeliveries).where(bobPending);
    expect(waiting.length).toBeGreaterThan(0);
    expect(await rowsNaming(BOB)).not.toEqual([]);

    await signInAgain(bob);
    expect(await bob.browser.api.call("eraseMe", { body: {} })).toEqual({
      status: "erased",
      approvals: [],
    });
    expect(bob.browser.cookie()).toBe("");
    expect((await bob.browser.api.call("getSession")).user).toBeNull();
    expect(await refusal(f.t.signIn(bob.credentialId))).toEqual({ code: "unauthenticated" });

    const db = f.t.ctx.db;
    expect(await db.select().from(sessions).where(eq(sessions.userId, bob.userId))).toEqual([]);
    expect(await db.select().from(credentials).where(eq(credentials.userId, bob.userId))).toEqual(
      [],
    );
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, bob.userId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, bob.userId)),
    ).toEqual([]);
    expect(
      await db.select().from(approverCredentials).where(eq(approverCredentials.userId, bob.userId)),
    ).toEqual([]);
    expect(await db.select().from(notificationDeliveries).where(bobPending)).toEqual([]);
    const [row] = await db.select().from(users).where(eq(users.id, bob.userId));
    expect(row).toMatchObject({ displayName: ERASED_NAME, quietHours: null });
    expect(row?.erasedAt).toBeInstanceOf(Date);
    expect(await rowsNaming(BOB)).toEqual([]);

    for (const workspaceId of [f.workspaceId, bobs]) {
      expect(await owner().call("verifyAudit", { params: { workspaceId } })).toMatchObject({
        ok: true,
        brokenAt: null,
      });

      const erased = await db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "member.erased")),
        );

      expect(erased).toMatchObject([
        { actorType: "user", actorId: bob.userId, subjectType: "user", subjectId: bob.userId },
      ]);
      const workspace = await owner().call("getWorkspace", { params: { workspaceId } });
      expect(workspace.members.map((member) => member.user.id)).not.toContain(bob.userId);
    }
  });

  it("keeps their id in history under the erased name, and exports never name them", async () => {
    await signInAgain(f.t.owner);

    const { record } = await owner().call("exportRecord", {
      params: { workspaceId: f.workspaceId },
    });

    expect(verifyRecord(recordLines(record))).toEqual({ ok: true, brokenAt: null });
    expect(record).toContain(bob.userId);
    expect(record).not.toContain(BOB);

    const audit = await owner().call("listAudit", { params: { workspaceId: f.workspaceId } });
    const byBob = audit.items.filter((event) => event.actor.id === bob.userId);
    expect(byBob.length).toBeGreaterThan(0);
    expect(new Set(byBob.map((event) => event.actor.name))).toEqual(new Set([ERASED_NAME]));

    // A template exported while Bob was a member does not invite him back.
    const clone = await owner().call("importTemplate", {
      body: { template, name: "Copy", includeAgents: false, includeMembers: true },
    });

    const invited = clone.invites.map((invite) => invite.userId);
    expect(invited).toContain(carol.userId);
    expect(invited).not.toContain(bob.userId);
  });
});

describe("the operator's command", () => {
  it("erases someone whose passkeys approve nowhere, as the system, once", async () => {
    const vera = await joinAsViewer(f.workspaceId, "Vera Viewer");
    const printed: object[] = [];
    expect(await eraseCli(["--user", vera], f.t.ctx, (line) => printed.push(line))).toBe(0);
    expect(await eraseCli(["--user", vera], f.t.ctx, (line) => printed.push(line))).toBe(0);
    expect(printed).toEqual([
      { ok: true, userId: vera, alreadyErased: false },
      { ok: true, userId: vera, alreadyErased: true },
    ]);

    const erased = await f.t.ctx.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.erased"), eq(auditEvents.subjectId, vera)));

    expect(erased).toMatchObject([{ actorType: "system", actorId: null }]);
    expect(
      await owner().call("verifyAudit", { params: { workspaceId: f.workspaceId } }),
    ).toMatchObject({ ok: true });
  });

  it("changes nothing for someone whose passkeys still approve, and names the workspaces", async () => {
    // Carol and the owner are the main workspace's two approvers, and it needs two.
    const lower = await owner().call("requestAdminThreshold", {
      params: { workspaceId: f.workspaceId },
      body: { adminThreshold: 1 },
    });

    expect((await f.t.approve(lower.id, [f.t.owner, carol])).status).toBe("executed");
    const printed: object[] = [];
    expect(await eraseCli(["--user", carol.userId], f.t.ctx, (line) => printed.push(line))).toBe(3);
    expect(printed).toEqual([{ ok: false, code: "still_approving", workspaces: [f.workspaceId] }]);
    expect((await carol.browser.api.call("getSession")).user?.displayName).toBe("Carol Approver");
  });

  it("needs a user id", async () => {
    expect(await eraseCli([], f.t.ctx, () => {})).toBe(1);
    expect(await eraseCli(["--user", "nobody"], f.t.ctx, () => {})).toBe(1);
  });
});
