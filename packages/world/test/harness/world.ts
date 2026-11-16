// The World the proof host runs on, selected through WORKFLOW_TARGET_WORLD. `HARNESS_WORLD=stock`
// selects the unmodified Postgres World (the control); otherwise it is the encrypting World,
// instrumented to record every key request so the test can see who asks for keys and when. Its
// key provider comes from the environment as in `@askgina/os-world/target`: the keyring file in
// `HARNESS_KEYRING_FILE`, or `KEY_PROVIDER=openbao` with the `OPENBAO_*` variables.
// `HARNESS_KEY_CACHE=off` makes it hold no unwrapped key between requests.
import { DataKeyStore, keyProviderFromEnv } from "@askgina/os-keys";
import { createWorld as createStockWorld } from "@workflow/world-postgres";
import pg from "pg";
import { createEncryptedWorld } from "../../src/index.ts";

export interface KeyRequest {
  runId: string;
  context: Record<string, unknown> | null;
}

interface HarnessGlobals {
  __harnessKeyRequests?: KeyRequest[];
}

/** Shared with server.ts through globalThis, because the SDK loads this module on its own. */
export function keyRequests(): KeyRequest[] {
  const globals = globalThis as HarnessGlobals;
  globals.__harnessKeyRequests ??= [];
  return globals.__harnessKeyRequests;
}

export function createWorld() {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is not set");
  if (process.env.HARNESS_WORLD === "stock") return createStockWorld({ connectionString });

  const provider = keyProviderFromEnv(process.env, { keyringFileVariable: "HARNESS_KEYRING_FILE" });
  const pool = new pg.Pool({ connectionString, max: 4 });
  pool.on("error", () => {});
  return createEncryptedWorld({
    postgres: { connectionString },
    dataKeys: new DataKeyStore({
      pool,
      provider,
      ...(process.env.HARNESS_KEY_CACHE === "off" ? { cacheTtlMs: 0 } : {}),
    }),
    // `kind` is the proof's readable attribute. `fence_probe` is written by upstream's
    // conformance suite as a workflow-body attribute, which is refused unless listed.
    readableAttributeKeys: ["kind", "fence_probe"],
    onKeyRequest: (runId, context) => {
      if (process.env.HARNESS_KEY_FAIL === "1") throw new Error("harness: injected key failure");
      keyRequests().push({ runId, context: context ?? null });
    },
  });
}

export default createWorld;
