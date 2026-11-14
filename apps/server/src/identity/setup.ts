import { count, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { installation, users } from "../db/schema.ts";
import { digestsEqual, randomToken, sha256Hex } from "./secrets.ts";

const SETUP_TOKEN_KEY = "setup_token_sha256";

/** True until the first owner exists. */
export async function setupRequired(ctx: Pick<AppContext, "db">): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(users);
  return (row?.n ?? 0) === 0;
}

/**
 * On a boot with no people yet, mint the setup token that creates the first owner, store its
 * hash, and log it. It is the one secret any log line may carry: the operator reads it from the
 * server's log to prove they control the deployment. Each boot before setup replaces the token,
 * so an operator who lost the log line restarts the server to get a new one; once the first
 * owner exists no token is minted again and the stored hash is deleted.
 */
export async function prepareSetup(ctx: Pick<AppContext, "db" | "log">): Promise<string | null> {
  if (!(await setupRequired(ctx))) {
    await ctx.db.delete(installation).where(eq(installation.key, SETUP_TOKEN_KEY));
    return null;
  }
  const token = randomToken(24);
  await ctx.db
    .insert(installation)
    .values({ key: SETUP_TOKEN_KEY, value: sha256Hex(token) })
    .onConflictDoUpdate({ target: installation.key, set: { value: sha256Hex(token) } });
  ctx.log.info(`setup token: ${token}`, { event: "setup.token_issued" });
  return token;
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
