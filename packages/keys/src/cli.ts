/**
 * Operator entry point for the two key operations that are run by hand:
 *
 *   node packages/keys/src/cli.ts rewrap [--batch <n>]
 *   node packages/keys/src/cli.ts shred <run|workspace> <id>
 *
 * Both read `DATABASE_URL` and `KEYRING_FILE` from the environment. Each prints one JSON line
 * with identifiers and counts, never key material.
 *
 * Exit codes: 0 done; 1 usage or configuration error; 2 `rewrap` finished but some rows could
 * not be unwrapped (they are listed, and the old KEK must stay in the keyring until they are
 * dealt with); 3 `shred` found no live key (already shredded, or never created; a tombstone is
 * in place either way).
 */
import pg from "pg";
import { DataKeyStore, type KeyScope } from "./data-key-store.ts";
import { LocalKeyring } from "./keyring.ts";

const USAGE = "usage: cli.ts rewrap [--batch <n>] | cli.ts shred <run|workspace> <id>";

class UsageError extends Error {
  override readonly name = "UsageError";
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function parseBatch(args: string[]): number {
  if (args.length === 0) return 500;
  const [flag, value, ...rest] = args;
  const batch = Number(value);
  if (flag !== "--batch" || rest.length > 0 || !Number.isInteger(batch) || batch < 1) {
    throw new UsageError(USAGE);
  }
  return batch;
}

function parseShred(args: string[]): { scope: KeyScope; id: string } {
  const [scope, id, ...rest] = args;
  if ((scope !== "run" && scope !== "workspace") || !id || rest.length > 0) {
    throw new UsageError(USAGE);
  }
  return { scope, id };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...args] = argv;
  // Parse everything before touching the database, so a typo never half-runs an operation.
  let operation: { kind: "rewrap"; batch: number } | { kind: "shred"; scope: KeyScope; id: string };
  try {
    if (command === "rewrap") operation = { kind: "rewrap", batch: parseBatch(args) };
    else if (command === "shred") operation = { kind: "shred", ...parseShred(args) };
    else throw new UsageError(USAGE);
    if (!env.DATABASE_URL) throw new UsageError("DATABASE_URL is not set");
    if (!env.KEYRING_FILE) throw new UsageError("KEYRING_FILE is not set");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    emit({ event: "keys.cli.usage_error", message: error.message });
    return 1;
  }

  let provider: LocalKeyring;
  try {
    provider = LocalKeyring.fromFile(env.KEYRING_FILE);
  } catch (error) {
    // Keyring errors carry fixed messages that name fields, never values.
    emit({ event: "keys.cli.keyring_error", message: (error as Error).message });
    return 1;
  }

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    const store = new DataKeyStore({ pool, provider, cacheTtlMs: 0 });
    if (operation.kind === "rewrap") {
      const result = await store.rewrap(operation.batch);
      emit({
        event: "keys.rewrap",
        activeKek: provider.activeKekId(),
        rewrapped: result.rewrapped,
        failedCount: result.failed.length,
        failed: result.failed,
      });
      return result.failed.length === 0 ? 0 : 2;
    }
    const shredded = await store.shred(operation.scope, operation.id);
    emit({ event: "keys.shred", scope: operation.scope, id: operation.id, shredded });
    return shredded ? 0 : 3;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
