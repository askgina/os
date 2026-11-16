import { setTimeout as delay } from "node:timers/promises";
import { ApiError, type MandateDraft } from "@askgina/os-api";
import { DataKeyUnavailableError } from "@askgina/os-keys";
import { type ApprovalId, MandateId, type WorkspaceId } from "@askgina/os-protocol";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openAuditDetail, verifyAudit } from "../../src/audit.ts";
import {
  agents,
  approvals,
  auditEvents,
  mandates,
  memberships,
  notificationDeliveries,
  transactions,
  wallets,
  workspaces,
} from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { sweep } from "../../src/execution/index.ts";
import { finalizeDue } from "../../src/lifecycle/finalize.ts";
import {
  createFixture,
  draftFor,
  type Fixture,
  fund,
  type TestAgent,
} from "../execution/fixture.ts";
import {
  expectedSignature,
  type Receiver,
  startReceiver,
  webhookSecret,
} from "../notify/support.ts";
import { JsonObject, loggedLines, TEST_CHAIN_ID } from "../support/context.ts";

const WEEK = 604_800;

const ETH = 10n ** 18n;

let f: Fixture;

let receiver: Receiver;

const secret = webhookSecret();

beforeAll(async () => {
  f = await createFixture("lifecycle_delete");
  receiver = await startReceiver();
  // The operator's webhook, so the deletion notices have somewhere to go.
  f.t.ctx.config.notify.webhook = { url: receiver.url, secret };
});

afterAll(async () => {
  await f?.close();
  await receiver?.close();
});

const api = () => f.t.owner.browser.api;

const now = () => f.t.clock.now();

/** Move the shared clock, and sign the owner in again: a session lasts less than a week. */
async function advance(seconds: number): Promise<void> {
  f.t.clock.advance(seconds);
  await f.t.signIn(f.t.owner.credentialId, f.t.owner.browser);
}

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

/** A workspace with one agent whose funded wallet has the fixture's policy. */
async function workspaceWithAgent(name: string): Promise<{ ws: WorkspaceId; agent: TestAgent }> {
  const ws = await f.newWorkspace(name);
  const agent = await f.newAgent("Bot", ws);
  await f.setPolicy(ws, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 10n * ETH);

  return { ws, agent };
}

async function grantMandate(ws: WorkspaceId, agent: TestAgent): Promise<MandateId> {
  const draft: MandateDraft = {
    agentId: agent.id,
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
    recipients: ["0x00000000000000000000000000000000000000aa"],
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: now() + 3 * 86_400,
    purpose: "pay the suppliers this week",
  };

  const opened = await api().call("proposeMandate", {
    params: { workspaceId: ws, walletId: agent.walletId },
    body: draft,
  });

  const row = await f.t.approve(opened.id, [f.t.owner]);
  expect(row.status).toBe("executed");

  return MandateId.parse(row.subjectId);
}

const requestDelete = (ws: WorkspaceId, destroyAfter: number) =>
  api().call("requestDeleteWorkspace", { params: { workspaceId: ws }, body: { destroyAfter } });

/** The codes of the finalize rounds that skipped `ws`, oldest first. */
function skipsOf(ws: WorkspaceId): string[] {
  return loggedLines(f.t.log).flatMap((line) =>
    line.event === "lifecycle.finalize_skipped" && line.workspaceId === ws
      ? [String(line.code)]
      : [],
  );
}

async function deliveriesOf(approvalId: ApprovalId) {
  return f.t.ctx.db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.approvalId, approvalId))
    .orderBy(asc(notificationDeliveries.dueAt));
}

describe("deleting a workspace", () => {
  it("ends its mandates when approved, announces it, and a cancel keeps the keys and the pause", async () => {
    const { ws, agent } = await workspaceWithAgent("Delete and cancel");
    const mandateId = await grantMandate(ws, agent);

    expect(await refusal(requestDelete(ws, now() + 2 * WEEK))).toEqual({
      code: "conflict",
      detail: "not_paused",
    });
    await api().call("pauseWorkspace", { params: { workspaceId: ws }, body: {} });
    expect(await refusal(requestDelete(ws, now() + 3_600))).toEqual({
      code: "invalid_request",
      detail: "destroy_delay_out_of_range",
    });

    const preflight = await api().call("getDeletionPreflight", { params: { workspaceId: ws } });
    expect(preflight).toMatchObject({
      source: "control-plane",
      minDestroyDelaySeconds: WEEK,
      blockers: ["nonzero_balance"],
    });
    expect(preflight.wallets.map(({ wallet }) => wallet.id)).toEqual([agent.walletId]);
    expect(preflight.wallets[0]?.balances?.[0]?.amount).toBe((10n * ETH).toString());
    expect(preflight.earliestDestroyAfter).toBeGreaterThan(now() + WEEK);

    // A request still waiting when the deletion applies ends with it.
    const policy = await api().call("requestPolicy", {
      params: { workspaceId: ws, walletId: agent.walletId },
      body: { draft: draftFor(agent.id, { approvals: { threshold: 1, ttlSeconds: 7_200 } }) },
    });

    const destroyAfter = now() + WEEK + 60;
    const opened = await requestDelete(ws, destroyAfter);
    expect(opened).toMatchObject({ kind: "delete-workspace", status: "pending", threshold: 1 });
    expect(await refusal(requestDelete(ws, destroyAfter))).toEqual({
      code: "conflict",
      detail: "already_requested",
    });
    const approvalId = opened.id;
    const detail = await api().call("getApproval", { params: { approvalId } });
    expect(detail.envelope).toMatchObject({
      type: "delete-workspace",
      wallets: [{ walletId: agent.walletId, address: agent.address }],
      destroyAfter,
    });
    expect(detail.subject).toMatchObject({ kind: "delete-workspace", destroyAfter });
    expect(detail.confirmUrl).not.toBeNull();

    expect((await f.t.approve(approvalId, [f.t.owner])).status).toBe("executed");
    const deleting = await api().call("getWorkspace", { params: { workspaceId: ws } });
    expect(deleting).toMatchObject({
      paused: true,
      lifecycle: { state: "deleting", destroyAfter, deletedAt: null },
    });
    expect(deleting.wallets[0]?.lifecycle).toEqual({ state: "retiring", destroyAfter });
    // The mandate ended when people approved, at the signer and in the mirror.
    expect((await f.t.ctx.signer.getMandate(mandateId)).status).toBe("revoked");
    const [mirror] = await f.t.ctx.db.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(mirror).toMatchObject({ status: "ended", endedReason: "revoked" });
    expect((await engineOf(f.t.ctx).row(policy.id)).status).toBe("cancelled");

    // Announced now, and again a day before the keys go; the webhook gets the first.
    const notices = (await deliveriesOf(approvalId)).filter((row) =>
      row.event.startsWith("lifecycle."),
    );

    expect(
      notices.map((row) => [row.event, row.target, Math.floor(row.dueAt.getTime() / 1000)]),
    ).toEqual([
      ["lifecycle.scheduled", "webhook", now()],
      ["lifecycle.due_soon", "webhook", destroyAfter - 86_400],
    ]);
    await sweep(f.t.ctx);

    const sent = receiver.requests.map((request) => ({
      request,
      body: JsonObject.parse(JSON.parse(request.body)),
    }));

    const scheduled = sent.find(({ body }) => body.event === "lifecycle.scheduled");
    expect(scheduled?.body).toMatchObject({
      v: 1,
      approvalId,
      workspaceId: ws,
      kind: "delete-workspace",
      walletId: null,
      destroyAfter,
    });
    const headers = scheduled?.request.headers ?? {};
    expect(headers["x-os-signature"]).toBe(
      expectedSignature(secret, String(headers["x-os-timestamp"]), scheduled?.request.body ?? ""),
    );

    // While it waits, nothing but pausing, cancelling and settings changes, and agents are out.
    expect(
      await refusal(
        api().call("requestPolicy", {
          params: { workspaceId: ws, walletId: agent.walletId },
          body: { draft: draftFor(agent.id) },
        }),
      ),
    ).toEqual({ code: "conflict", detail: "workspace_deleting" });
    await expect(f.mcp(agent.token)).rejects.toThrow();

    // Any member may cancel; the workspace stays paused and its keys stay.
    const cancelled = await api().call("cancelDeleteWorkspace", {
      params: { workspaceId: ws },
      body: {},
    });

    expect(cancelled).toMatchObject({
      paused: true,
      lifecycle: { state: "active", destroyAfter: null, deletedAt: null },
    });
    expect(cancelled.wallets[0]?.lifecycle).toEqual({ state: "active", destroyAfter: null });
    expect(await f.t.ctx.signer.getWorkspace(ws)).toMatchObject({ state: "active", paused: true });
    expect((await f.t.ctx.signer.getMandate(mandateId)).status).toBe("revoked");
    expect(
      await refusal(api().call("cancelDeleteWorkspace", { params: { workspaceId: ws }, body: {} })),
    ).toEqual({ code: "conflict", detail: "active" });

    // The second notice of a cancelled deletion never goes out.
    await advance(WEEK - 86_400 + 120);
    await sweep(f.t.ctx);

    const [dueSoon] = (await deliveriesOf(approvalId)).filter(
      (row) => row.event === "lifecycle.due_soon",
    );

    expect(dueSoon).toMatchObject({ state: "dropped", lastCode: "lifecycle_ended" });
  });

  it("a deleted workspace signs nothing, and nothing it stored can be opened", async () => {
    const { ws, agent } = await workspaceWithAgent("Delete for good");

    const treasury = await api().call("createTreasury", {
      params: { workspaceId: ws },
      body: { label: "Treasury" },
    });

    // A sweep signed and sent, not yet followed to its block: finalize must wait for it.
    const sweepRequest = await api().call("requestSweep", {
      params: { workspaceId: ws, walletId: agent.walletId },
      body: { chainId: TEST_CHAIN_ID, asset: "native", to: treasury.address },
    });

    const sweepId = sweepRequest.id;
    expect((await f.t.approve(sweepId, [f.t.owner])).status).toBe("executed");
    await api().call("pauseWorkspace", { params: { workspaceId: ws }, body: {} });

    const destroyAfter = now() + WEEK + 60;
    const opened = await requestDelete(ws, destroyAfter);
    expect(opened.title).toBe("Delete this workspace and destroy 2 wallet keys");
    expect((await f.t.approve(opened.id, [f.t.owner])).status).toBe("executed");
    // A run of the workspace, keyed as the World keys it: by run id, with the workspace as tenant.
    const runId = `wrun_lifecycle_${ws}`;
    await f.t.ctx.keys.getOrCreate("run", runId, ws);

    const [someEvent] = await f.t.ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, ws))
      .limit(1);

    if (!someEvent) throw new Error("no audit event");

    // Not before the destroy time.
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 0 });
    await advance(WEEK + 120);
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 1 });
    expect(skipsOf(ws).at(-1)).toBe("unmined_transactions");
    const steps = engineOf(f.t.ctx).steps();

    for (let i = 0; i < 20 && !(await steps.followUp(sweepId)).done; i += 1);

    const [sent] = await f.t.ctx.db
      .select({ status: transactions.status })
      .from(transactions)
      .where(eq(transactions.approvalId, sweepId));

    expect(sent?.status).toBe("confirmed");

    // A crash between the signer's destruction and shredding: the next round finishes it.
    const shred = vi.spyOn(f.t.ctx.keys, "shredTenant").mockRejectedValueOnce(new Error("crashed"));

    try {
      expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 1 });
    } finally {
      shred.mockRestore();
    }

    expect((await f.t.ctx.signer.getWorkspace(ws)).state).toBe("deleted");
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 1, skipped: 0 });
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 0 });

    // Nothing sealed for the workspace opens, nor any payload of its runs.
    await expect(openAuditDetail(f.t.ctx, someEvent)).rejects.toBeInstanceOf(
      DataKeyUnavailableError,
    );
    await expect(f.t.ctx.keys.get("run", runId)).rejects.toBeInstanceOf(DataKeyUnavailableError);
    // The chain still verifies without the key, and ends with the deletion.
    expect(await verifyAudit(f.t.ctx, ws)).toMatchObject({ ok: true, brokenAt: null });

    const [last] = await f.t.ctx.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, ws))
      .orderBy(desc(auditEvents.seq))
      .limit(1);

    expect(last?.action).toBe("workspace.deleted");

    const deletedEvents = await f.t.ctx.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, ws), eq(auditEvents.action, "workspace.deleted")));

    expect(deletedEvents).toHaveLength(1);

    // The signer destroyed every key and answers nothing of the workspace but its state.
    expect(await f.t.ctx.signer.getWorkspace(ws)).toMatchObject({ state: "deleted" });

    for (const walletId of [agent.walletId, treasury.id]) {
      await expect(f.t.ctx.signer.getWallet(walletId)).rejects.toMatchObject({
        code: "workspace_deleted",
      });
    }

    // The tombstone: ids and hashes stay, names and memberships go.
    const [tomb] = await f.t.ctx.db.select().from(workspaces).where(eq(workspaces.id, ws));
    expect(tomb).toMatchObject({ name: "Deleted workspace", lifecycle: "deleted", paused: true });
    expect(tomb?.deletedAt).not.toBeNull();
    const walletRows = await f.t.ctx.db.select().from(wallets).where(eq(wallets.workspaceId, ws));
    expect(walletRows.map((row) => [row.label, row.lifecycle])).toEqual([
      ["", "destroyed"],
      ["", "destroyed"],
    ]);
    const [agentRow] = await f.t.ctx.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(agentRow).toMatchObject({ status: "disabled", name: "Removed agent" });
    expect(agentRow?.tokenHash).toBe(`removed:${agent.id}`);
    expect(
      await f.t.ctx.db.select().from(memberships).where(eq(memberships.workspaceId, ws)),
    ).toEqual([]);
    expect(
      await f.t.ctx.db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.workspaceId, ws),
            eq(notificationDeliveries.state, "pending"),
          ),
        ),
    ).toEqual([]);
    expect(await refusal(api().call("getWorkspace", { params: { workspaceId: ws } }))).toEqual({
      code: "not_found",
    });
    const listed = await api().call("listWorkspaces", {});
    expect(listed.items.map((item) => item.id)).not.toContain(ws);
    await expect(f.mcp(agent.token)).rejects.toThrow();

    // Every request of the workspace ended before its keys went.
    const open = await f.t.ctx.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(eq(approvals.workspaceId, ws), sql`${approvals.status} IN ('pending', 'approved')`),
      );

    expect(open).toEqual([]);
  });

  it("waits for runs of requests it cancelled, and a proposal racing the tombstone does not deadlock", async () => {
    const { ws, agent } = await workspaceWithAgent("Delete under load");
    await api().call("pauseWorkspace", { params: { workspaceId: ws }, body: {} });
    // Still waiting when the deletion applies, so it is cancelled then.
    const resume = await api().call("requestResume", { params: { workspaceId: ws }, body: {} });
    const opened = await requestDelete(ws, now() + WEEK + 60);
    expect((await f.t.approve(opened.id, [f.t.owner])).status).toBe("executed");
    const engine = engineOf(f.t.ctx);
    expect(await engine.row(resume.id)).toMatchObject({
      status: "cancelled",
      resumeState: "needed",
    });
    await advance(WEEK + 120);
    // Its run has not seen the cancel yet, so nothing of the workspace is shredded.
    expect(await finalizeDue(f.t.ctx)).toEqual({ finalized: 0, skipped: 1 });
    expect(skipsOf(ws).at(-1)).toBe("unfinished_runs");
    // What the sweeper does for a request whose run is gone: end it, then mark it seen.
    expect(await engine.recoverOrphan(await engine.row(resume.id))).toBe("abandoned");

    // A proposal holds the locks inserting rows that refer to the agent and the workspace
    // takes, then appends its audit event, which locks the workspace row.
    const proposal = await f.t.ctx.pool.connect();

    try {
      await proposal.query("BEGIN");
      await proposal.query("SELECT 1 FROM os.agents WHERE id = $1 FOR KEY SHARE", [agent.id]);
      await proposal.query("SELECT 1 FROM os.workspaces WHERE id = $1 FOR KEY SHARE", [ws]);
      const finalizing = finalizeDue(f.t.ctx);

      // Wait until finalize waits on the proposal. Postgres decides when a lock is granted, so
      // this polls its lock table; no clock the test controls can stand in for it.
      for (let i = 0; i < 400; i += 1) {
        const { rows } = await f.t.ctx.pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );

        if ((rows[0]?.waiting ?? 0) > 0) break;
        await delay(25);
      }

      await proposal.query("SELECT 1 FROM os.workspaces WHERE id = $1 FOR NO KEY UPDATE", [ws]);
      await proposal.query("COMMIT");
      expect(await finalizing).toEqual({ finalized: 1, skipped: 0 });
    } finally {
      proposal.release();
    }

    const [tomb] = await f.t.ctx.db
      .select({ lifecycle: workspaces.lifecycle })
      .from(workspaces)
      .where(eq(workspaces.id, ws));

    expect(tomb?.lifecycle).toBe("deleted");
  });
});
