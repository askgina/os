import type { UserId } from "@askgina/os-protocol";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { AppContext, Executor, Session, Sessions } from "../context.ts";
import { sessions, users } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { randomToken, sha256Hex } from "./secrets.ts";

type Deps = Pick<AppContext, "db" | "config" | "now">;

/**
 * How long ago the passkey that signed the session in may have been used to export a record or
 * to erase the person.
 */
export const RECENT_SIGN_IN_MAX_AGE_SECONDS = 300;

/**
 * Over HTTPS the cookie gets the `__Host-` prefix, which browsers only accept with `Secure`, no
 * `Domain` and `Path=/`, so no other host or path can plant or shadow it. Plain HTTP is only
 * allowed for localhost, where `Secure` cookies would not be sent at all.
 */
export function sessionCookieName(config: AppContext["config"]): string {
  return isHttps(config) ? "__Host-os_session" : "os_session";
}

function isHttps(config: AppContext["config"]): boolean {
  return config.publicOrigin.startsWith("https:");
}

/** The value of one cookie in a `Cookie` header, or undefined. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function createSessions(deps: Deps): Sessions {
  const name = sessionCookieName(deps.config);
  return {
    async resolve(request) {
      const value = readCookie(request.headers.get("cookie"), name);
      // A cookie value is 32 random bytes; anything else cannot be ours, so skip the query.
      if (value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
      const idHash = sha256Hex(value);
      const [row] = await deps.db
        .select({
          idHash: sessions.idHash,
          userId: users.id,
          displayName: users.displayName,
          credentialId: sessions.credentialId,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.idHash, idHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date(deps.now() * 1000)),
          ),
        );
      if (!row) return null;
      const session: Session = {
        user: { id: row.userId, displayName: row.displayName },
        credentialId: row.credentialId,
        idHash: row.idHash,
      };
      return session;
    },
  };
}

/** Start a session for someone who just proved a passkey, and set its cookie on the response. */
export async function issueSession(
  ctx: Deps,
  c: Context,
  input: { userId: UserId; credentialId: string },
  executor: Executor = ctx.db,
): Promise<void> {
  const value = randomToken(32);
  const now = ctx.now();
  await executor.insert(sessions).values({
    idHash: sha256Hex(value),
    userId: input.userId,
    credentialId: input.credentialId,
    // On the app's clock, as `expiresAt` is: a record export asks how long ago the passkey was used.
    createdAt: new Date(now * 1000),
    expiresAt: new Date((now + ctx.config.sessionTtlSeconds) * 1000),
  });
  c.header("set-cookie", serializeCookie(ctx.config, value, ctx.config.sessionTtlSeconds), {
    append: true,
  });
}

/**
 * Refuse unless the session's passkey sign-in is recent. A record opens every sealed detail of a
 * workspace and erasing a person cannot be undone, so a session left signed in on a shared
 * machine must not do either. `purpose` ends the refusal's message, for example "export the
 * record".
 */
export async function requireRecentSignIn(
  ctx: Pick<AppContext, "db" | "now">,
  session: Session,
  purpose: string,
): Promise<void> {
  const [row] = await ctx.db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(eq(sessions.idHash, session.idHash));
  const age = row ? ctx.now() - Math.floor(row.createdAt.getTime() / 1000) : Infinity;
  if (age > RECENT_SIGN_IN_MAX_AGE_SECONDS) {
    throw new HttpError(
      "forbidden",
      `sign in again with your passkey to ${purpose}`,
      "sign_in_again",
    );
  }
}

/** Revoke the session behind a request and tell the browser to forget its cookie. */
export async function endSession(ctx: Deps, c: Context, session: Session): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: new Date(ctx.now() * 1000) })
    .where(eq(sessions.idHash, session.idHash));
  clearSessionCookie(ctx.config, c);
}

/** Tell the browser to forget its session cookie. */
export function clearSessionCookie(config: AppContext["config"], c: Context): void {
  c.header("set-cookie", serializeCookie(config, "", 0), { append: true });
}

function serializeCookie(config: AppContext["config"], value: string, maxAge: number): string {
  const parts = [
    `${sessionCookieName(config)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(config)) parts.push("Secure");
  return parts.join("; ");
}
