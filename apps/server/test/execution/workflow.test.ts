import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ApprovalId, IntentId, MandateId } from "@askgina/os-protocol";
import { scanForMarkers } from "@askgina/os-testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, intents, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { startBackground, sweep } from "../../src/execution/index.ts";
import { workflowRuntime } from "../../src/execution/workflow-runtime.ts";
import { TEST_CHAIN_ID } from "../support/context.ts";
import { anvil, createFixture, type Fixture, toolJson } from "./fixture.ts";

let f: Fixture;

let background: { stop(): Promise<void> };

beforeAll(async () => {
  // Needs the real bundle: `bun run build:workflows` in apps/server first (CI does this).
  f = await createFixture("exec_workflow");
  background = await startBackground(f.t.ctx);
}, 180_000);

afterAll(async () => {
  await background?.stop();
  await f?.close();
});

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

async function proposeOverMcp(memo: string, to = randomAddress()) {
  const client = await f.mcp(f.agent.token);

  const proposed = toolJson(
    await client.callTool({
      name: "propose_transfer",
      arguments: { chainId: TEST_CHAIN_ID, to, amount: "0.01", memo },
    }),
  );

  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, proposed.intentId as IntentId));

  if (!row?.approvalId) throw new Error(JSON.stringify(proposed));

  return { client, intentId: row.id, approvalId: row.approvalId, to };
}

/** Wait for a condition the workflow brings about, delivering missed wake-ups as the sweeper would. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await read();

    if (done(value)) return value;
    f.t.clock.advance(6);
    await sweep(f.t.ctx);
    await delay(250);
  }

  throw new Error("condition never reached");
}

const approvalRow = (id: ApprovalId) => engineOf(f.t.ctx).row(id);

describe("the approval workflow", () => {
  it("records its run and waits for the decision", async () => {
    const { approvalId } = await proposeOverMcp("waiting");

    const row = await until(
      () => approvalRow(approvalId),
      (value) => value.runId !== null,
    );

    expect(row.runId).toMatch(/^wrun_/);
    expect(row.status).toBe("pending");
  });

  it("signs, broadcasts and confirms after an approval, and the agent sees it with get_intent", async () => {
    const memoMarker = `OSWFMEMO${randomBytes(6).toString("hex")}`;
    const { client, intentId, approvalId, to } = await proposeOverMcp(`pay ${memoMarker}`);
    await until(
      () => approvalRow(approvalId),
      (row) => row.runId !== null,
    );
    await f.t.approveOnPage(f.t.owner, approvalId);

    const final = await until(
      async () =>
        toolJson(
          await client.callTool({ name: "get_intent", arguments: { intentId, waitSeconds: 2 } }),
        ),
      (view) => view.status === "confirmed",
    );

    expect(final.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await anvil.getBalance({ address: to })).toBe(10n ** 16n);
    expect((await approvalRow(approvalId)).status).toBe("executed");

    // Workflow inputs, outputs and events are encrypted by the World; nothing typed is readable.
    const scan = await scanForMarkers(f.t.ctx.config.databaseUrl, [memoMarker, to.slice(2)]);
    expect(scan.hits).toEqual([]);
  });

  it("ends a rejected request and revokes it at the signer", async () => {
    const { intentId, approvalId } = await proposeOverMcp("rejected");
    await until(
      () => approvalRow(approvalId),
      (row) => row.runId !== null,
    );
    await f.t.owner.browser.api.call("reject", { params: { approvalId }, body: {} });
    await until(
      async () =>
        (await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId)))[0]?.status,
      (status) => status === "rejected",
    );
    expect((await f.t.ctx.signer.getApproval(approvalId)).state).toBe("revoked");
  });

  it("ends a request nobody decided on as expired", async () => {
    const { intentId, approvalId } = await proposeOverMcp("lapses");
    await until(
      () => approvalRow(approvalId),
      (row) => row.runId !== null,
    );
    f.t.clock.advance(3_601);
    await until(
      async () => {
        await engineOf(f.t.ctx).wake(approvalId);

        return (await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId)))[0]?.status;
      },
      (status) => status === "expired",
    );
    expect((await approvalRow(approvalId)).status).toBe("expired");
  });

  it("completes an approval whose wake-up was lost, and waking twice is harmless", async () => {
    const engine = engineOf(f.t.ctx);
    const { intentId, approvalId } = await proposeOverMcp("lost wake-up");

    const { runId } = await until(
      () => approvalRow(approvalId),
      (row) => row.runId !== null,
    );

    // Wait until the run has looked at the request once and is waiting. A run that takes its
    // first look after the decision reads it without any wake-up, which is correct, and is not
    // the case this test is about.
    await until(
      async () =>
        (
          await f.t.ctx.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM workflow.workflow_steps WHERE run_id = $1 AND status = 'completed'",
            [runId],
          )
        ).rows[0]?.n ?? 0,
      (completed) => completed >= 1,
    );
    // The process "dies" between the decision and the wake-up: nothing resumes the workflow.
    engine.attachRuntime(null);
    await f.t.approveOnPage(f.t.owner, approvalId);
    engine.attachRuntime(workflowRuntime(f.t.ctx));
    expect((await approvalRow(approvalId)).resumeState).toBe("needed");

    f.t.clock.advance(6);
    await sweep(f.t.ctx);
    await engine.wake(approvalId);
    await until(
      async () =>
        (await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId)))[0]?.status,
      (status) => status === "confirmed",
    );

    const rows = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.approvalId, approvalId));

    expect(rows).toHaveLength(1);
    expect((await approvalRow(approvalId)).resumeState).toBe("done");
  });

  it("runs the effect once when the workflow was started twice", async () => {
    const engine = engineOf(f.t.ctx);
    // Opened while the runtime is away: no workflow yet, as after a crash right after opening.
    engine.attachRuntime(null);
    const { intentId, approvalId } = await proposeOverMcp("started twice");
    engine.attachRuntime(workflowRuntime(f.t.ctx));
    expect((await approvalRow(approvalId)).runId).toBeNull();

    const row = await approvalRow(approvalId);
    const expiresAt = Math.floor(row.expiresAt.getTime() / 1000);
    const runtime = workflowRuntime(f.t.ctx);
    const first = await runtime.startRun({ approvalId, workspaceId: row.workspaceId, expiresAt });
    const second = await runtime.startRun({ approvalId, workspaceId: row.workspaceId, expiresAt });
    expect(first).not.toBe(second);
    // The sweeper's own start, after the grace period, is a third.
    f.t.clock.advance(11);
    await sweep(f.t.ctx);

    const owned = await until(
      () => approvalRow(approvalId),
      (value) => value.runId !== null,
    );

    await f.t.approveOnPage(f.t.owner, approvalId);
    await until(
      async () =>
        (await f.t.ctx.db.select().from(intents).where(eq(intents.id, intentId)))[0]?.status,
      (status) => status === "confirmed",
    );

    const rows = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.intentId, intentId));

    expect(rows).toHaveLength(1);
    const [stored] = await f.t.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(stored?.runId).toBe(owned.runId);
    const nonce = rows[0]?.nonce ?? -1;
    const wallet = f.agent.address;
    expect(await anvil.getTransactionCount({ address: wallet })).toBe(nonce + 1);
  });

  it("signs a mandated payment exactly once when the process died between the use and its run", async () => {
    const engine = engineOf(f.t.ctx);
    const to = randomAddress();

    // The grant itself runs through the workflow like every other request.
    const grant = await f.t.owner.browser.api.call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: f.agent.walletId },
      body: {
        agentId: f.agent.id,
        assets: [
          {
            chainId: TEST_CHAIN_ID as `eip155:${number}`,
            asset: "native",
            maxPerAction: (10n ** 17n).toString(),
            maxPerWindow: (10n ** 17n).toString(),
            maxTotal: (10n ** 17n).toString(),
          },
        ],
        windowSeconds: 86_400,
        recipients: [to],
        maxUses: 3,
        maxFeePerActionWei: "100000000000000000",
        notAfter: f.t.clock.now() + 86_400,
        purpose: "workflow mandate",
      },
    });

    await until(
      () => approvalRow(grant.id as ApprovalId),
      (row) => row.runId !== null,
    );
    await f.t.approveOnPage(f.t.owner, grant.id as ApprovalId);
    await until(
      () => approvalRow(grant.id as ApprovalId),
      (row) => row.status === "executed",
    );

    // The use row is recorded, then the process dies before any run starts for it.
    engine.attachRuntime(null);
    const { client, intentId, approvalId } = await proposeOverMcp("mandated", to);
    engine.attachRuntime(workflowRuntime(f.t.ctx));
    const use = await approvalRow(approvalId);
    expect(use).toMatchObject({ kind: "mandate-use", status: "approved", runId: null });

    // After the restart the sweeper starts its run, which signs under the mandate.
    const final = await until(
      async () =>
        toolJson(
          await client.callTool({ name: "get_intent", arguments: { intentId, waitSeconds: 2 } }),
        ),
      (view) => view.status === "confirmed",
    );

    expect(final).toMatchObject({ authorizedBy: "mandate", mandateId: use.mandateId });

    const rows = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.intentId, intentId));

    expect(rows).toHaveLength(1);
    expect((await approvalRow(approvalId)).status).toBe("executed");
    expect(await anvil.getBalance({ address: to })).toBe(10n ** 16n);
    const mandate = await f.t.ctx.signer.getMandate(use.mandateId as MandateId);
    expect(mandate.usage.uses).toBe(1);
  });
});
