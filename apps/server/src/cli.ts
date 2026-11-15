import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { migrateDatabase } from "./db/migrate.ts";
import * as schema from "./db/schema.ts";
import { rotateSetupToken } from "./identity/setup.ts";

const USAGE = "usage: node apps/server/src/cli.ts setup-token\n";

/**
 * The control plane's operator commands. Run them where the server runs, with its configuration
 * (`docker compose exec server node apps/server/src/cli.ts …`, or `kubectl exec`). The result
 * is one JSON line on stdout, never the server's log:
 *
 * - `setup-token`: replace the setup token with a new one and print it, `{ ok: true, setupToken }`,
 *   exit 0; every earlier token stops working. `{ ok: false, code: "setup_done" }`, exit 3, once
 *   the first owner exists. Works the same with any number of replicas running.
 * - anything else: usage on stderr, exit 1.
 */
export async function main(
  argv: readonly string[],
  ctx: Pick<AppContext, "db">,
  print: (line: object) => void = (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "setup-token") {
    process.stderr.write(USAGE);
    return 1;
  }
  const setupToken = await rotateSetupToken(ctx);
  if (setupToken === null) {
    print({ ok: false, code: "setup_done" });
    return 3;
  }
  print({ ok: true, setupToken });
  return 0;
}

if (import.meta.main) {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    // A command run before the first server start still finds its tables.
    await migrateDatabase(pool);
    process.exitCode = await main(process.argv.slice(2), { db: drizzle(pool, { schema }) });
  } finally {
    await pool.end();
  }
}
