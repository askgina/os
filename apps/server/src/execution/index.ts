import { join } from "node:path";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { approvals } from "../db/schema.ts";
import { finalizeIfDue } from "../lifecycle/finalize.ts";
import { registerLifecycleKinds } from "../lifecycle/kinds.ts";
import { registerLifecycleRoutes } from "../lifecycle/routes.ts";
import { type DeliveryCounts, deliverDueNotifications } from "../notify/outbox.ts";
import { engineOf } from "./approvals.ts";
import { BundleMismatchError, holdBundleLock } from "./bundle-guard.ts";
import { registerCancelKind } from "./cancel.ts";
import { registerIntentKind } from "./intents.ts";
import { registerMandateKinds } from "./mandates.ts";
import { reconcileOpenOrders, venueHooks } from "./orders.ts";
import { repriceAutomatically } from "./repricing.ts";
import { registerApprovalAndIntentRoutes } from "./routes.ts";
import { registerSteps, unregisterSteps } from "./steps.ts";
import { registerSweepKind } from "./sweeps.ts";
import type { ExecutionOptions } from "./transactions.ts";
import { GENERATED_DIR, loadGenerated, migrateWorld, workflowRuntime } from "./workflow-runtime.ts";

export { mountMcp } from "../mcp/gateway.ts";

export { createApprovalEngine } from "./approvals.ts";

export { createChains } from "./chains.ts";

/** How long a decision may wait for its wake-up before the sweeper delivers it again. */
const RESUME_GRACE_SECONDS = 5;

/** How long a new request may wait for its workflow before the sweeper starts one. */
const START_GRACE_SECONDS = 10;

const SWEEP_INTERVAL_MS = 3_000;

const DEFAULT_OPTIONS: ExecutionOptions = { pollSeconds: 5 };

/**
 * The approval, intent, sweep, mandate and lifecycle routes, and the kinds that sign, grant or
 * end: `approve-intent`, `mandate-use`, `sweep-wallet`, `grant-mandate`, `cancel-transaction`,
 * `retire-wallet` and `delete-workspace`.
 */
export function registerExecution(
  app: Hono,
  ctx: AppContext,
  options: ExecutionOptions = DEFAULT_OPTIONS,
): void {
  registerIntentKind(ctx, options, repriceAutomatically, venueHooks);
  registerSweepKind(ctx, options);
  registerMandateKinds(ctx);
  registerCancelKind(ctx);
  registerLifecycleKinds(ctx);
  registerApprovalAndIntentRoutes(app, ctx);
  registerLifecycleRoutes(app, ctx);
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

/**
 * One pass of the sweeper: the workflow wake-up outbox, starts, the notification outbox, at most
 * every five minutes the venue orders the follow-up stopped watching (`venueOrders`, how many
 * were read back), and at most once a minute the retirements and deletions that are due
 * (`lifecycle`); each null in passes that did not look. Exported so tests can run it without a
 * timer.
 */
export async function sweep(ctx: AppContext): Promise<{
  woken: number;
  started: number;
  abandoned: number;
  notifications: DeliveryCounts;
  venueOrders: number | null;
  lifecycle: { finalized: number; skipped: number } | null;
}> {
  const engine = engineOf(ctx);
  const runtime = workflowRuntime(ctx);
  const now = ctx.now();
  let woken = 0;
  let started = 0;
  let abandoned = 0;

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
        isNull(approvals.runId),
        lt(approvals.createdAt, new Date((now - START_GRACE_SECONDS) * 1000)),
        // Waiting or approved requests need a run; one that ended before any run was recorded
        // (decided, then the process died) still has its outbox entry and is abandoned here.
        or(
          inArray(approvals.status, ["pending", "approved"]),
          and(
            inArray(approvals.status, ["rejected", "expired", "cancelled"]),
            eq(approvals.resumeState, "needed"),
          ),
        ),
      ),
    );

  for (const row of unstarted) {
    const outcome = await engine.recoverOrphan(row);

    if (outcome === "started") started += 1;

    if (outcome === "abandoned") abandoned += 1;
  }

  // A request recovered above was announced in the transaction that opened it, so its rows are
  // delivered here like any other.
  const notifications = await deliverDueNotifications(ctx);
  const venueOrders = await reconcileOpenOrders(ctx);
  // Last: a request it cancels is recovered by the next pass above, and a deletion finishes
  // only once every run of the workspace has.
  const lifecycle = await finalizeIfDue(ctx);

  return { woken, started, abandoned, notifications, venueOrders, lifecycle };
}

/**
 * Start the Workflow runtime and the sweeper. The World's tables are migrated first, the step
 * implementations registered, and runs delivered in this process.
 *
 * Every replica runs the sweeper. That is safe: a wake-up only resumes a hook and marks the
 * outbox done when it worked, starts are serialized per request, notification rows are claimed
 * with `SKIP LOCKED` under a lease, and retirements and deletions are finished at most once a
 * minute across all replicas, by steps that may repeat. N replicas poll N times as often.
 *
 * Before the queue starts, this process takes the workflow-bundle lock: while another process
 * on the database delivers runs from a different bundle, it refuses with
 * {@link BundleMismatchError}, since runs are not pinned to a bundle. Should that lock be lost
 * and another bundle be running when it is taken again, this process stops delivering and
 * `onFatal` hears it.
 */
export async function startBackground(
  ctx: AppContext,
  options: { onFatal?: (error: Error) => void } = {},
): Promise<{ stop(): Promise<void> }> {
  const runtime = workflowRuntime(ctx);
  const generated = await loadGenerated();
  await migrateWorld(ctx.pool);

  const mismatch = (error: BundleMismatchError) =>
    ctx.log.error("another workflow bundle runs on this database", {
      event: "workflow.bundle_mismatch",
      bundleId: error.bundleId,
    });

  const bundle = await holdBundleLock(ctx.pool, join(GENERATED_DIR, "flow.mjs"), (error) => {
    mismatch(error);
    void stop().then(() => options.onFatal?.(error));
  }).catch((error: unknown) => {
    if (error instanceof BundleMismatchError) mismatch(error);
    throw error;
  });

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

  let stopped: Promise<void> | undefined;

  const stop = () => {
    stopped ??= (async () => {
      clearInterval(timer);
      await running;
      engineOf(ctx).attachRuntime(null);
      await runtime.world.close?.();
      unregisterSteps(steps);
      await bundle.release();
    })();

    return stopped;
  };

  return { stop };
}
