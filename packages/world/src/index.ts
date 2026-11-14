import type { DataKeyStore } from "@askgina/os-keys";
import type { Queue, WorkflowRun, World } from "@workflow/world";
import {
  createWorld as createPostgresWorld,
  type PostgresWorldConfig,
} from "@workflow/world-postgres";

/**
 * The option of the Workflow SDK's `start()` that names the tenant a run belongs to, for
 * example `start(workflow, args, { [TENANT_START_OPTION]: workspaceId })`. The runtime passes
 * its start options to the World only when a run is created, so this is the one moment a run's
 * key can be bound to a tenant.
 */
export const TENANT_START_OPTION = "osTenantId";

export type EncryptedWorld = World &
  Required<Pick<Queue, "registerHandler" | "registerRoute">> & {
    start(): Promise<void>;
  };

export interface EncryptedWorldConfig {
  /** Passed through to `createWorld()` of `@workflow/world-postgres`. */
  postgres: PostgresWorldConfig;
  /** Where each run's data key is kept. Run keys use the `run` scope. */
  dataKeys: DataKeyStore;
  /** Called on every key request, for measurement and tests. */
  onKeyRequest?: (runId: string, context: Record<string, unknown> | undefined) => void;
}

/**
 * The upstream Postgres World stores every payload in plaintext, because it has no
 * `getEncryptionKeyForRun()`. This World adds that one method, which makes the SDK's runtime
 * encrypt workflow and step inputs and outputs, hook metadata and payloads, stream chunks and
 * step errors with AES-256-GCM under a key that exists once per run.
 *
 * It never answers "no key". Upstream reads `undefined` as "store plaintext", so every failure
 * here throws: a run that cannot get its key stalls and retries; it does not leak.
 */
export function createEncryptedWorld(config: EncryptedWorldConfig): EncryptedWorld {
  const base = createPostgresWorld(config.postgres);

  async function getEncryptionKeyForRun(
    run: WorkflowRun | string,
    context?: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const runId = typeof run === "string" ? run : run.runId;
    if (typeof runId !== "string" || !runId.startsWith("wrun_")) {
      throw new Error(`refusing a key request for an invalid run id: ${String(runId)}`);
    }
    config.onKeyRequest?.(runId, context);
    const tenant = context?.[TENANT_START_OPTION];
    return config.dataKeys.getOrCreate("run", runId, typeof tenant === "string" ? tenant : null);
  }

  const startBase = base.start.bind(base);
  return Object.assign(base, {
    getEncryptionKeyForRun: getEncryptionKeyForRun as NonNullable<World["getEncryptionKeyForRun"]>,
    async start() {
      await config.dataKeys.ensureMigrated();
      await startBase();
    },
  });
}
