import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalId, WorkspaceId } from "@askgina/os-protocol";
import { createEncryptedWorld, type EncryptedWorld, TENANT_START_OPTION } from "@askgina/os-world";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { makeWorkerUtils } from "graphile-worker";
import type { Pool } from "pg";
import { resumeHook, start } from "workflow/api";
import { setWorld } from "workflow/runtime";
import type { AppContext } from "../context.ts";

/**
 * `workflow build` (run from `apps/server`) writes the bundled workflow here. The path is fixed
 * by the Workflow CLI; the directory is generated and not committed.
 */
export const GENERATED_DIR = fileURLToPath(
  new URL("../../.well-known/workflow/v1/", import.meta.url),
);

type DeliveryHandler = (request: Request) => Promise<Response>;

interface Generated {
  flow: DeliveryHandler;
  webhook: DeliveryHandler;
  approvalWorkflowId: string;
}

let generated: Promise<Generated> | undefined;

/** Load the bundle once. A missing bundle stops boot with an instruction instead of a stack. */
export function loadGenerated(): Promise<Generated> {
  generated ??= (async () => {
    let manifestText: string;
    try {
      manifestText = await readFile(join(GENERATED_DIR, "manifest.json"), "utf8");
    } catch {
      throw new Error(
        "the workflow bundle is missing; run `bun run build:workflows` in apps/server",
      );
    }
    const manifest = JSON.parse(manifestText) as {
      workflows: Record<string, Record<string, { workflowId: string }>>;
    };
    const entry = manifest.workflows["workflows/approval.ts"]?.approval;
    if (entry === undefined) throw new Error("the workflow bundle has no approval workflow");
    const flow = (await import(join(GENERATED_DIR, "flow.mjs"))) as { POST: DeliveryHandler };
    const webhook = (await import(join(GENERATED_DIR, "webhook.mjs"))) as {
      POST: DeliveryHandler;
    };
    return { flow: flow.POST, webhook: webhook.POST, approvalWorkflowId: entry.workflowId };
  })();
  generated.catch(() => {
    generated = undefined;
  });
  return generated;
}

/**
 * Create the Workflow runtime's tables (its own schemas) and Graphile Worker's, the same way the
 * upstream `bootstrap` command does, under an advisory lock so two starting processes do not
 * race on `CREATE SCHEMA`.
 */
export async function migrateWorld(pool: Pool): Promise<void> {
  const packageDir = dirname(
    dirname(fileURLToPath(import.meta.resolve("@workflow/world-postgres"))),
  );
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('askgina.os.world-migrate', 0))");
    try {
      await migrate(drizzle(client), {
        migrationsFolder: join(packageDir, "src", "drizzle", "migrations"),
        migrationsTable: "workflow_migrations",
        migrationsSchema: "workflow_drizzle",
      });
      const utils = await makeWorkerUtils({ pgPool: pool });
      try {
        await utils.migrate();
      } finally {
        await utils.release();
      }
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('askgina.os.world-migrate', 0))",
      );
    }
  } finally {
    client.release();
  }
}

export interface WorkflowRuntime {
  world: EncryptedWorld;
  /** Start the run that waits for this approval; returns the run id. */
  startRun(input: {
    approvalId: ApprovalId;
    workspaceId: WorkspaceId;
    expiresAt: number;
  }): Promise<string>;
  /**
   * Tell the run that owns the request to look at the database again. False when its hook is
   * not there yet.
   */
  wake(approvalId: ApprovalId, runId: string): Promise<boolean>;
}

const runtimes = new WeakMap<AppContext, WorkflowRuntime>();

/**
 * The encrypted World for this context, installed as the process's World. Every run's key is
 * bound to its workspace through the tenant start option.
 */
export function workflowRuntime(ctx: AppContext): WorkflowRuntime {
  const existing = runtimes.get(ctx);
  if (existing) return existing;
  const world = createEncryptedWorld({
    postgres: {
      pool: ctx.pool,
      queueConcurrency: ctx.config.workflowWorkerConcurrency,
      applicationManagedShutdown: true,
      // A process that dies in the middle of a step leaves that step's job locked. Without
      // this, upstream releases it after 5 minutes at best and 4 hours at worst, and an
      // approved payment waits that long. A running step renews its lock every few seconds,
      // so 30 seconds unrenewed means its process is gone. Should a stalled process be taken
      // for a dead one, the step runs twice, which every step here is built for.
      jobLockStaleSeconds: 30,
    },
    dataKeys: ctx.keys,
  });
  setWorld(world);
  const runtime: WorkflowRuntime = {
    world,
    async startRun(input) {
      const { approvalWorkflowId } = await loadGenerated();
      const run = await start(
        { workflowId: approvalWorkflowId } as never,
        [{ approvalId: input.approvalId, expiresAt: input.expiresAt }],
        { [TENANT_START_OPTION]: input.workspaceId } as never,
      );
      return run.runId;
    },
    async wake(approvalId, runId) {
      try {
        await resumeHook(`apr:${approvalId}:${runId}`, { approvalId });
        return true;
      } catch {
        // The run has not created its hook yet, or it already finished. Either way the run reads
        // the database before it waits, so the caller only needs to retry later.
        return false;
      }
    },
  };
  runtimes.set(ctx, runtime);
  return runtime;
}
