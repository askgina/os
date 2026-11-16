import type { DataKeyStore } from "@askgina/os-keys";
import type { Queue, WorkflowRun, World } from "@workflow/world";
import {
  createWorld as createPostgresWorld,
  type PostgresWorldConfig,
} from "@workflow/world-postgres";
import { z } from "zod";
import { withholdRunAttributes } from "./attributes.ts";

export { ALWAYS_READABLE_ATTRIBUTE_KEYS, WITHHELD_ATTRIBUTE_VALUE } from "./attributes.ts";

/**
 * The option of the Workflow SDK's `start()` that names the tenant a run belongs to, for
 * example `start(workflow, args, { [TENANT_START_OPTION]: workspaceId })`. The runtime passes
 * its start options to the World only when a run is created, so this is the one moment a run's
 * key can be bound to a tenant.
 */
export const TENANT_START_OPTION = "osTenantId";

/**
 * What the Workflow SDK passes with a run id when it asks for that run's key, as its World
 * interface types it: the start options when a run is created, other world-specific data or
 * nothing otherwise.
 */
export type KeyRequestContext = Parameters<NonNullable<World["getEncryptionKeyForRun"]>>[1];

/** The run id of a key request, which names the run itself or only its id. */
const KeyRequestRunId = z.union([
  z.string(),
  z.object({ runId: z.string() }).transform((run) => run.runId),
]);

/** The tenant a key request's context names, when it names one as a string. */
const KeyRequestTenant = z
  .object({ [TENANT_START_OPTION]: z.string() })
  .transform((context) => context[TENANT_START_OPTION]);

export type EncryptedWorld = World &
  Required<Pick<Queue, "registerHandler" | "registerRoute">> & {
    start(): Promise<void>;
  };

export interface EncryptedWorldConfig {
  /** Passed through to `createWorld()` of `@workflow/world-postgres`. */
  postgres: PostgresWorldConfig;
  /** Where each run's data key is kept. Run keys use the `run` scope. */
  dataKeys: DataKeyStore;
  /**
   * Run attribute keys whose values may be stored readable, besides the three the Workflow SDK
   * needs. Attributes cannot be encrypted, so every other attribute's value is replaced with
   * `[withheld]` before it is stored. List a key only if its value never carries content.
   */
  readableAttributeKeys?: readonly string[];
  /** Called on every key request, for measurement and tests. */
  onKeyRequest?: (runId: string, context: KeyRequestContext) => void;
}

/**
 * The upstream Postgres World stores every payload in plaintext, because it has no
 * `getEncryptionKeyForRun()`. This World adds that one method, which makes the SDK's runtime
 * encrypt workflow and step inputs and outputs, hook metadata and payloads, stream chunks and
 * step errors with AES-256-GCM under a key that exists once per run.
 *
 * It never answers "no key". Upstream reads `undefined` as "store plaintext", so every failure
 * here throws: a run that cannot get its key stalls and retries; it does not leak.
 *
 * Run attributes are the one thing the SDK stores that it never encrypts. This World replaces
 * their values unless the key is listed as readable; see `withholdRunAttributes`.
 */
export function createEncryptedWorld(config: EncryptedWorldConfig): EncryptedWorld {
  const base = createPostgresWorld(config.postgres);
  withholdRunAttributes(base, config.readableAttributeKeys ?? []);

  async function getEncryptionKeyForRun(
    run: WorkflowRun | string,
    context?: KeyRequestContext,
  ): Promise<Uint8Array> {
    const runId = KeyRequestRunId.safeParse(run).data;

    if (runId === undefined || !runId.startsWith("wrun_")) {
      throw new Error(`refusing a key request for an invalid run id: ${String(runId)}`);
    }

    config.onKeyRequest?.(runId, context);
    const tenant = KeyRequestTenant.safeParse(context).data;

    return config.dataKeys.getOrCreate("run", runId, tenant ?? null);
  }

  // One function answers both of the SDK's overloads: a run, or a run id with its context.
  const keyForRun: NonNullable<World["getEncryptionKeyForRun"]> = getEncryptionKeyForRun;
  const startBase = base.start.bind(base);

  return Object.assign(base, {
    getEncryptionKeyForRun: keyForRun,
    async start() {
      await config.dataKeys.ensureMigrated();
      await startBase();
    },
  });
}
