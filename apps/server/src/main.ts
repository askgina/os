import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import { createSignerClient } from "@askgina/os-protocol/signer";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ZodError } from "zod";
import type { ApprovalEngine } from "./approvals/kinds.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { migrateDatabase } from "./db/migrate.ts";
import * as schema from "./db/schema.ts";
import { createSealer } from "./db/sealed.ts";
import { createApprovalEngine, createChains, startBackground } from "./execution/index.ts";
import { createInternalApp, createPublicApp } from "./http/app.ts";
import { createSessions, prepareSetup } from "./identity/index.ts";
import { createLogger } from "./log.ts";

async function main(): Promise<void> {
  const log = createLogger("server");
  const config = loadConfig();
  // Each workflow worker holds a connection while it runs a step; the rest serve requests.
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.workflowWorkerConcurrency + 12,
  });
  // An idle client losing its connection must not take the process down; the pool reconnects.
  pool.on("error", (error) => log.warn("idle database connection failed", { name: error.name }));

  await migrateDatabase(pool);
  const keys = new DataKeyStore({ pool, provider: LocalKeyring.fromFile(config.keyringFile) });
  await keys.ensureMigrated();

  const db = drizzle(pool, { schema });
  const now = () => Math.floor(Date.now() / 1000);
  const ctx: AppContext = {
    config,
    pool,
    db,
    keys,
    sealer: createSealer(keys),
    signer: createSignerClient({ baseUrl: config.signerUrl, secret: config.signerSecret }),
    sessions: createSessions({ db, config, now }),
    chains: createChains(config),
    // Assigned right below: the engine keeps this object and reads `approvals` lazily.
    approvals: undefined as unknown as ApprovalEngine,
    log,
    now,
  };
  ctx.approvals = createApprovalEngine(ctx);

  // The encrypted World is created and installed with `setWorld()` by the execution module
  // (`workflowRuntime(ctx)`) and started by `startBackground`, so there is exactly one.
  // The runtime posts its deliveries here; it must be the loopback listener.
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${config.internalPort}`;

  const publicServer = serve({
    fetch: createPublicApp(ctx).fetch,
    hostname: config.host,
    port: config.port,
  });
  const internalServer = serve({
    fetch: createInternalApp(ctx).fetch,
    hostname: "127.0.0.1",
    port: config.internalPort,
  });
  await prepareSetup(ctx);
  // Migrates and starts the World, loads the workflow bundle, starts the sweepers.
  const background = await startBackground(ctx);
  log.info("listening", { event: "server.started", port: config.port });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { event: "server.stopping", signal });
    const closed = (server: { close(callback: () => void): void }) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    };
    // Stop taking requests, let in-flight work settle, then let go of the database.
    await Promise.all([closed(publicServer), closed(internalServer)]);
    await background.stop();
    await pool.end();
    log.info("stopped", { event: "server.stopped" });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  // Boot errors can quote configuration values; log only their kind, and for a rejected
  // setting, which one it was and why in a word.
  createLogger("server").error("failed to start", {
    name: error instanceof Error ? error.name : "unknown",
    code: (error as { code?: string } | null)?.code,
    invalid:
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`).join("; ")
        : undefined,
  });
  process.exit(1);
});
