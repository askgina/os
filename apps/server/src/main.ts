import { DataKeyStore, keyProviderFromEnv } from "@askgina/os-keys";
import { createSignerClient } from "@askgina/os-protocol/signer";
import { createSignerFetch } from "@askgina/os-protocol/signer-transport";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ZodError } from "zod";
import type { ApprovalEngine } from "./approvals/kinds.ts";
import { ConfigError, loadConfig } from "./config.ts";
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

  // Each workflow worker holds a connection while it runs a step; two are held for good, one
  // listening for data-key shreds and one holding the workflow-bundle lock; the rest serve
  // requests and the World's own listeners.
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.workflowWorkerConcurrency + 14,
  });

  // An idle client losing its connection must not take the process down; the pool reconnects.
  pool.on("error", (error) => log.warn("idle database connection failed", { name: error.name }));

  await migrateDatabase(pool);

  const keyProvider = keyProviderFromEnv(process.env, {
    keyringFileVariable: "KEYRING_FILE",
    // `event` is keys.provider_unavailable or keys.provider_refresh_failed, with ids and counts.
    onEvent: (event) => log.warn("key provider", { ...event }),
  });

  // Listening, so a shred in any replica (or the operator's CLI) reaches this cache at once.
  const keys = new DataKeyStore({
    pool,
    provider: keyProvider,
    cacheTtlMs: config.dataKeyCacheSeconds * 1000,
    listen: true,
  });

  await keys.ensureMigrated();
  await keys.start();

  const db = drizzle(pool, { schema });
  const now = () => Math.floor(Date.now() / 1000);

  const ctx: AppContext = {
    config,
    pool,
    db,
    keys,
    sealer: createSealer(keys),
    signer: createSignerClient({
      baseUrl: config.signerUrl,
      secret: config.signerSecret,
      // Mutual TLS to an `https:` signer on its own host, which must present the certificate
      // issued for the host name in SIGNER_URL; plain HTTP on one machine, as before.
      fetch:
        config.signerTls === null
          ? undefined
          : createSignerFetch(config.signerTls, new URL(config.signerUrl).hostname),
    }),
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

  // Migrates and starts the World, loads the workflow bundle, starts the sweepers. Another
  // bundle found running later stops this process, so its orchestrator starts it again and
  // the boot check refuses it until the other is gone.
  const background = await startBackground(ctx, {
    onFatal: () => void stop("workflow.bundle_mismatch", 1),
  });

  log.info("listening", { event: "server.started", port: config.port });

  let stopping = false;

  const stop = async (signal: string, exitCode = 0) => {
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
    await keys.close();
    await keyProvider.close();
    await pool.end();
    log.info("stopped", { event: "server.stopped" });
    process.exit(exitCode);
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
    // Names the variable and what is wrong with its file, never the file's content.
    reason: error instanceof ConfigError ? error.message : undefined,
  });
  process.exit(1);
});
