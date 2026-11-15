import { count, eq, sql } from "drizzle-orm";
import type { AppContext, Executor } from "../context.ts";
import { installation, users } from "../db/schema.ts";
import { digestsEqual, randomToken, sha256Hex } from "./secrets.ts";

const SETUP_TOKEN_KEY = "setup_token_sha256";

/**
 * Arbitrary constant: serializes the creation of the first owner, and the minting of the setup
 * token, across every replica.
 */
export const SETUP_LOCK = 0x05_0a_77_10;

/** True until the first owner exists. */
export async function setupRequired(ctx: { db: Executor }): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(users);
  return (row?.n ?? 0) === 0;
}

/**
 * Store a new setup token's hash in place of any earlier one, under {@link SETUP_LOCK}. Null,
 * and nothing stored, once the first owner exists. `onlyIfNone` keeps a token already stored.
 */
async function mint(
  ctx: Pick<AppContext, "db">,
  onlyIfNone: boolean,
): Promise<{ token: string | null; setupDone: boolean }> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`);
    if (!(await setupRequired({ db: tx }))) {
      await tx.delete(installation).where(eq(installation.key, SETUP_TOKEN_KEY));
      return { token: null, setupDone: true };
    }
    if (onlyIfNone) {
      const [stored] = await tx
        .select({ key: installation.key })
        .from(installation)
        .where(eq(installation.key, SETUP_TOKEN_KEY));
      if (stored) return { token: null, setupDone: false };
    }
    const token = randomToken(24);
    await tx
      .insert(installation)
      .values({ key: SETUP_TOKEN_KEY, value: sha256Hex(token) })
      .onConflictDoUpdate({ target: installation.key, set: { value: sha256Hex(token) } });
    return { token, setupDone: false };
  });
}

/**
 * At boot, before the first owner exists: mint the setup token that creates the first owner,
 * once per installation, however many replicas boot at once, store its hash and log it. It is
 * the one secret any log line may carry: the operator reads it from the server's log to prove
 * they control the deployment. A later boot keeps the stored token and logs only that it waits
 * (`setup.token_pending`); `node apps/server/src/cli.ts setup-token` replaces it. With
 * `SETUP_TOKEN_IN_LOG=false` no boot mints one; the command does. Once the first owner exists
 * the stored hash is deleted. Returns the token it logged, or null.
 */
export async function prepareSetup(
  ctx: Pick<AppContext, "db" | "log" | "config">,
): Promise<string | null> {
  if (!ctx.config.setupTokenInLog) {
    if (await setupRequired(ctx)) {
      ctx.log.info("setup waits for a setup token: run `node apps/server/src/cli.ts setup-token`", {
        event: "setup.token_pending",
      });
    }
    return null;
  }
  const { token, setupDone } = await mint(ctx, true);
  if (token !== null) {
    // Logged once the hash is committed, so a token in the log always works.
    ctx.log.info(`setup token: ${token}`, { event: "setup.token_issued" });
  } else if (!setupDone) {
    ctx.log.info(
      "a setup token was issued before; run `node apps/server/src/cli.ts setup-token` for a new one",
      { event: "setup.token_pending" },
    );
  }
  return token;
}

/**
 * Replace the setup token with a new one and return it, for the operator's command; nothing is
 * logged. Null once the first owner exists.
 */
export async function rotateSetupToken(ctx: Pick<AppContext, "db">): Promise<string | null> {
  return (await mint(ctx, false)).token;
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
