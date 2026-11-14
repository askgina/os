import { ApprovalId } from "@askgina/os-protocol";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { approvals } from "../db/schema.ts";
import { engineOf } from "./approvals.ts";
import { type ExecutionOptions, registerIntentKind } from "./intents.ts";
import { registerApprovalAndIntentRoutes } from "./routes.ts";
import { registerSteps, unregisterSteps } from "./steps.ts";
import { loadGenerated, migrateWorld, workflowRuntime } from "./workflow-runtime.ts";

export { mountMcp } from "../mcp/gateway.ts";
export { createApprovalEngine } from "./approvals.ts";
export { createChains } from "./chains.ts";

/** How long a decision may wait for its wake-up before the sweeper delivers it again. */
const RESUME_GRACE_SECONDS = 5;
/** How long a new request may wait for its workflow before the sweeper starts one. */
const START_GRACE_SECONDS = 10;
const SWEEP_INTERVAL_MS = 3_000;
const DEFAULT_OPTIONS: ExecutionOptions = { pollSeconds: 5 };

/** The approval and intent routes, and the `approve-intent` kind. */
export function registerExecution(
  app: Hono,
  ctx: AppContext,
  options: ExecutionOptions = DEFAULT_OPTIONS,
): void {
  registerIntentKind(ctx, options);
  registerApprovalAndIntentRoutes(app, ctx);
}

/**
 * The Workflow runtime's delivery routes, for the loopback listener only: upstream leaves them
 * unauthenticated. In this process the World delivers in-process (see `startBackground`), so
 * these serve only a delivery that arrives over HTTP.
 */
export function mountWorkflowDelivery(internal: Hono, ctx: AppContext): void {
  workflowRuntime(ctx);
  internal.post("/.well-known/workflow/v1/flow", async (c) =>
    (await loadGenerated()).flow(c.req.raw),
  );
  internal.post("/.well-known/workflow/v1/webhook/:token", async (c) =>
    (await loadGenerated()).webhook(c.req.raw),
  );
}

/** One pass of the outbox and start sweeper. Exported so tests can run it without a timer. */
export async function sweep(ctx: AppContext): Promise<{ woken: number; started: number }> {
  const engine = engineOf(ctx);
  const runtime = workflowRuntime(ctx);
  const now = ctx.now();
  let woken = 0;
  let started = 0;

  const waiting = await ctx.db
    .select({ id: approvals.id, runId: approvals.runId })
    .from(approvals)
    .where(
      and(
        eq(approvals.resumeState, "needed"),
        lt(approvals.decidedAt, new Date((now - RESUME_GRACE_SECONDS) * 1000)),
      ),
    );
  for (const row of waiting) {
    if (await engine.wake(row.id)) {
      woken += 1;
      continue;
    }
    // A run that already finished has nothing left to wake.
    const run = row.runId
      ? await runtime.world.runs.get(row.runId, { resolveData: "none" } as never).catch(() => null)
      : null;
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
      await ctx.db
        .update(approvals)
        .set({ resumeState: "done" })
        .where(and(eq(approvals.id, row.id), eq(approvals.resumeState, "needed")));
    }
  }

  const unstarted = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "pending"),
        isNull(approvals.runId),
        lt(approvals.createdAt, new Date((now - START_GRACE_SECONDS) * 1000)),
      ),
    );
  for (const row of unstarted) {
    await engine.startRun(
      ApprovalId.parse(row.id),
      row.workspaceId,
      Math.floor(row.expiresAt.getTime() / 1000),
    );
    started += 1;
  }
  return { woken, started };
}

/**
 * Start the Workflow runtime and the sweeper. The World's tables are migrated first, the step
 * implementations registered, and runs delivered in this process.
 */
export async function startBackground(ctx: AppContext): Promise<{ stop(): Promise<void> }> {
  const runtime = workflowRuntime(ctx);
  const generated = await loadGenerated();
  await migrateWorld(ctx.pool);
  const steps = engineOf(ctx).steps();
  registerSteps(steps);
  runtime.world.registerHandler("__wkf_workflow_", generated.flow);
  await runtime.world.start();
  engineOf(ctx).attachRuntime(runtime);

  let running: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    running = running
      .then(() => sweep(ctx))
      .catch((error: unknown) => {
        ctx.log.warn("sweep failed", { error: error instanceof Error ? error.name : "unknown" });
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await running;
      engineOf(ctx).attachRuntime(null);
      await runtime.world.close?.();
      unregisterSteps(steps);
    },
  };
}
