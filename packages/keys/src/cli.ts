/**
 * Operator entry point for the key operations that are run by hand:
 *
 *   node packages/keys/src/cli.ts rewrap [--batch <n>]
 *   node packages/keys/src/cli.ts shred <run|workspace> <id>
 *   node packages/keys/src/cli.ts shred-tenant <run|workspace> <tenant id>
 *
 * Each reads `DATABASE_URL`, and `DATABASE_PASSWORD_FILE` where the database password is kept in
 * a file instead of in the URL (as in the Compose stack, so the commands work inside the server's
 * container as they are), and the key provider's settings the server reads: `KEYRING_FILE`, or
 * `KEY_PROVIDER=openbao` with the `OPENBAO_*` variables (see `keyProviderFromEnv`). The shred
 * commands do not contact the key provider. Each prints one JSON line with identifiers and
 * counts, never key material.
 *
 * Exit codes: 0 done; 1 usage or configuration error; 2 `rewrap` finished but some rows could
 * not be unwrapped (they are listed, and the old KEK must stay in the keyring until they are
 * dealt with); 3 `shred` found no live key (already shredded, or never created; a tombstone is
 * in place either way); 4 the key provider could not be reached or refused the operation (rows
 * `rewrap` moved before that stay moved; run it again). `shred-tenant` exits 0 with the count it
 * destroyed, also when that is 0: a repeat finds nothing left to shred.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { DataKeyStore, type KeyScope } from "./data-key-store.ts";
import {
  type KeyProvider,
  KeyProviderConfigError,
  KeyProviderRefusedError,
  KeyProviderUnavailableError,
} from "./keyring.ts";
import { keyProviderFromEnv } from "./providers.ts";

const USAGE =
  "usage: cli.ts rewrap [--batch <n>] | cli.ts shred <run|workspace> <id> | cli.ts shred-tenant <run|workspace> <tenant id>";

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
  let operation:
    | { kind: "rewrap"; batch: number }
    | { kind: "shred" | "shred-tenant"; scope: KeyScope; id: string };
  try {
    if (command === "rewrap") operation = { kind: "rewrap", batch: parseBatch(args) };
    else if (command === "shred" || command === "shred-tenant") {
      operation = { kind: command, ...parseShred(args) };
    } else throw new UsageError(USAGE);
    if (!env.DATABASE_URL) throw new UsageError("DATABASE_URL is not set");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    emit({ event: "keys.cli.usage_error", message: error.message });
    return 1;
  }

  let provider: KeyProvider;
  try {
    provider = keyProviderFromEnv(env, { keyringFileVariable: "KEYRING_FILE" });
  } catch (error) {
    // Both kinds carry fixed messages that name variables or fields, never values.
    const event =
      error instanceof KeyProviderConfigError ? "keys.cli.usage_error" : "keys.cli.keyring_error";
    emit({ event, message: (error as Error).message });
    return 1;
  }

  const databaseUrl = new URL(env.DATABASE_URL);
  if (env.DATABASE_PASSWORD_FILE) {
    try {
      databaseUrl.password = readFileSync(env.DATABASE_PASSWORD_FILE, "utf8").trim();
    } catch {
      await provider.close();
      emit({ event: "keys.cli.usage_error", message: "DATABASE_PASSWORD_FILE cannot be read" });
      return 1;
    }
  }
  const pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });
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
    if (operation.kind === "shred-tenant") {
      const { shredded } = await store.shredTenant(operation.scope, operation.id);
      emit({
        event: "keys.shred_tenant",
        scope: operation.scope,
        tenantId: operation.id,
        shredded,
      });
      return 0;
    }
    const shredded = await store.shred(operation.scope, operation.id);
    emit({ event: "keys.shred", scope: operation.scope, id: operation.id, shredded });
    return shredded ? 0 : 3;
  } catch (error) {
    if (
      !(error instanceof KeyProviderUnavailableError) &&
      !(error instanceof KeyProviderRefusedError)
    ) {
      throw error;
    }
    // Provider messages carry ids and HTTP statuses, never key material.
    emit({ event: "keys.cli.provider_error", error: error.name, message: error.message });
    return 4;
  } finally {
    await pool.end();
    await provider.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
