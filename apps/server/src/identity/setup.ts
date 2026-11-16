import { count, eq, sql } from "drizzle-orm";
import type { AppContext, Executor } from "../context.ts";
import { installation, users } from "../db/schema.ts";
import { digestsEqual, randomToken, sha256Hex } from "./secrets.ts";

const SETUP_TOKEN_KEY = "setup_token_sha256";

/**
 * Arbitrary constant: serializes the creation of the first owner, and the replacing of the setup
 * token, across every replica.
 */
export const SETUP_LOCK = 0x05_0a_77_10;

/** True until the first owner exists. */
export async function setupRequired(ctx: { db: Executor }): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(users);

  return (row?.n ?? 0) === 0;
}

/**
 * At boot, before the first owner exists: say in the log that setup waits and which command
 * gives the operator a setup token. No boot mints a token and no log line ever carries one: logs
 * are shipped, kept and read by more people than may create the first owner.
 */
export async function prepareSetup(ctx: Pick<AppContext, "db" | "log">): Promise<void> {
  if (await setupRequired(ctx)) {
    ctx.log.info("setup waits for a setup token: run `node apps/server/src/cli.ts setup-token`", {
      event: "setup.token_pending",
    });
  }
}

/**
 * Replace the setup token with a new one, under {@link SETUP_LOCK}, store only its hash and
 * return it, for the operator's command; nothing is logged. Null, and nothing stored, once the
 * first owner exists.
 */
export async function rotateSetupToken(ctx: Pick<AppContext, "db">): Promise<string | null> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`);

    if (!(await setupRequired({ db: tx }))) {
      await tx.delete(installation).where(eq(installation.key, SETUP_TOKEN_KEY));

      return null;
    }

    const token = randomToken(24);
    await tx
      .insert(installation)
      .values({ key: SETUP_TOKEN_KEY, value: sha256Hex(token) })
      .onConflictDoUpdate({ target: installation.key, set: { value: sha256Hex(token) } });

    return token;
  });
}

/** Whether `token` is the current setup token. */
export async function checkSetupToken(
  ctx: Pick<AppContext, "db">,
  token: string,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ value: installation.value })
    .from(installation)
    .where(eq(installation.key, SETUP_TOKEN_KEY));

  return row !== undefined && digestsEqual(row.value, sha256Hex(token));
}

export const setupTokenKey = SETUP_TOKEN_KEY;
