import { parseArgs } from "node:util";
import { DataKeyStore, keyProviderFromEnv } from "@askgina/os-keys";
import { UserId } from "@askgina/os-protocol";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadConfig } from "../config.ts";
import * as schema from "../db/schema.ts";
import { createSealer } from "../db/sealed.ts";
import { HttpError } from "../http/errors.ts";
import { createLogger } from "../log.ts";
import { checkErasable, type ErasureDeps, eraseUser } from "./erase.ts";

const USAGE = "usage: node apps/server/src/identity/erase-cli.ts --user <usr_id>\n";

/**
 * `node apps/server/src/identity/erase-cli.ts --user <usr_id>`: erase a person as the operator,
 * for someone who asks and cannot sign in to do it themselves (decision D6, see
 * `src/identity/erase.ts`). Run it where the server runs, with the server's configuration. Its
 * result is the last JSON line on stdout, after the log line an erasure writes:
 *
 * - `{ ok: true, userId, alreadyErased }`, exit 0: erased, now or before.
 * - `{ ok: false, code: "still_approving", workspaces }`, exit 3: their passkeys still approve,
 *   or wait to be added, in these workspaces. Nothing changed. The signer stops accepting a
 *   passkey only through a `remove-approver` request its people approve, which this command
 *   cannot open: an owner of each workspace removes the person there (or makes them a viewer),
 *   and once those requests are applied this command erases.
 * - `{ ok: false, code, detail, message }`, exit 2: refused, with the API's code and detail
 *   (`last_owner`, `workspace_deleting`, `last_approver`, `try_again`), or `not_found`.
 * - usage on stderr, exit 1.
 */
export async function main(
  argv: readonly string[],
  ctx: ErasureDeps,
  print: (line: object) => void = (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
): Promise<number> {
  let user: string | undefined;

  try {
    user = parseArgs({ args: [...argv], options: { user: { type: "string" } }, strict: true })
      .values.user;
  } catch {
    user = undefined;
  }

  const userId = UserId.safeParse(user);

  if (!userId.success) {
    process.stderr.write(USAGE);

    return 1;
  }

  try {
    const approving = await checkErasable(ctx, userId.data);

    if (approving.length > 0) {
      print({
        ok: false,
        code: "still_approving",
        workspaces: [...new Set(approving.map((row) => row.workspaceId))],
      });

      return 3;
    }

    const { alreadyErased } = await eraseUser(ctx, userId.data, "operator");
    print({ ok: true, userId: userId.data, alreadyErased });

    return 0;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    print({ ok: false, code: error.code, detail: error.detail ?? null, message: error.message });

    return 2;
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  const provider = keyProviderFromEnv(process.env, { keyringFileVariable: "KEYRING_FILE" });
  const keys = new DataKeyStore({ pool, provider });

  try {
    process.exitCode = await main(process.argv.slice(2), {
      db: drizzle(pool, { schema }),
      sealer: createSealer(keys),
      now: () => Math.floor(Date.now() / 1000),
      log: createLogger("erase"),
    });
  } finally {
    await pool.end();
    await provider.close();
  }
}
