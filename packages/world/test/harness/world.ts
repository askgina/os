// The World the proof host runs on, selected through WORKFLOW_TARGET_WORLD. `HARNESS_WORLD=stock`
// selects the unmodified Postgres World (the control); otherwise it is the encrypting World,
// instrumented to record every key request so the test can see who asks for keys and when.
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
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

  const keyringFile = process.env.HARNESS_KEYRING_FILE;
  if (!keyringFile) throw new Error("HARNESS_KEYRING_FILE is not set");
  const pool = new pg.Pool({ connectionString, max: 4 });
  pool.on("error", () => {});
  return createEncryptedWorld({
    postgres: { connectionString },
    dataKeys: new DataKeyStore({ pool, provider: LocalKeyring.fromFile(keyringFile) }),
    readableAttributeKeys: ["kind"],
    onKeyRequest: (runId, context) => {
      if (process.env.HARNESS_KEY_FAIL === "1") throw new Error("harness: injected key failure");
      keyRequests().push({ runId, context: context ?? null });
    },
  });
}

export default createWorld;
