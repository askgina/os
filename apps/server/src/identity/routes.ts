import type { ApprovalSummary, PasskeySummary, SessionInfo } from "@askgina/os-api";
import { newId, type UserId } from "@askgina/os-protocol";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppContext, Session } from "../context.ts";
import {
  approverCredentials,
  credentials,
  installation,
  memberships,
  users,
} from "../db/schema.ts";
import { openAddApprover, withdrawApprover } from "../directory/approvers.ts";
import { HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import {
  finishLogin,
  finishRegistration,
  insertPasskey,
  startLogin,
  startRegistration,
} from "./ceremonies.ts";
import { eraseOnRequest } from "./erase.ts";
import { revokePasskey } from "./passkeys.ts";
import { clearSessionCookie, endSession, issueSession, requireRecentSignIn } from "./sessions.ts";
import { checkSetupToken, SETUP_LOCK, setupRequired, setupTokenKey } from "./setup.ts";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export async function sessionInfo(
  ctx: AppContext,
  user: Session["user"] | null,
): Promise<SessionInfo> {
  return {
    setupRequired: await setupRequired(ctx),
    user,
    relyingParty: { id: ctx.config.relyingParty.id, name: ctx.config.relyingParty.name },
  };
}

function passkeySummary(row: typeof credentials.$inferSelect): PasskeySummary {
  return {
    credentialId: row.id,
    label: row.label,
    createdAt: seconds(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : seconds(row.lastUsedAt),
    deviceType: row.deviceType,
    backedUp: row.backedUp,
  };
}

/** Workspaces where a person's passkeys approve or should: those where they are owner or approver. */
async function approvingWorkspaces(ctx: AppContext, userId: UserId) {
  return ctx.db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.role, ["owner", "approver"])));
}

export function registerIdentity(app: Hono, ctx: AppContext): void {
  handle(app, ctx, "getSession", async ({ session }) => sessionInfo(ctx, session?.user ?? null));

  handle(app, ctx, "startSetup", async ({ body }) => {
    // Both refusals look the same, so the endpoint does not say whether setup already happened.
    if (!(await setupRequired(ctx)) || !(await checkSetupToken(ctx, body.setupToken))) {
      throw new HttpError("forbidden", "the setup token is not valid");
    }
    return startRegistration(ctx, {
      kind: "setup",
      userId: newId("usr"),
      displayName: body.displayName,
      context: { displayName: body.displayName },
    });
  });

  handle(app, ctx, "finishSetup", async ({ body, c }) => {
    const { ceremony, passkey } = await finishRegistration(ctx, {
      ceremonyId: body.ceremonyId,
      kind: "setup",
      response: body.response,
    });
    const userId = ceremony.userId as UserId;
    const displayName = ceremony.context.displayName ?? "Owner";
    await ctx.db.transaction(async (tx) => {
      // Two setups racing with two ceremonies started from the same token: the second one waits
      // here, then finds a user and stops.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [existing] = await tx.select({ n: count() }).from(users);
      if ((existing?.n ?? 0) > 0) throw new HttpError("forbidden", "the setup token is not valid");
      await tx.insert(users).values({ id: userId, displayName });
      await insertPasskey(tx, userId, passkey, "First passkey");
      await tx.delete(installation).where(eq(installation.key, setupTokenKey));
      await issueSession(ctx, c, { userId, credentialId: passkey.id }, tx);
    });
    ctx.log.info("setup completed", { event: "setup.completed", userId });
    return sessionInfo(ctx, { id: userId, displayName });
  });

  handle(app, ctx, "startLogin", async () => startLogin(ctx));

  handle(app, ctx, "finishLogin", async ({ body, c }) => {
    const { userId, credentialId } = await finishLogin(ctx, {
      ceremonyId: body.ceremonyId,
      response: body.response as never,
    });
    await issueSession(ctx, c, { userId, credentialId });
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new HttpError("unauthenticated", "this passkey is not registered here");
    return sessionInfo(ctx, { id: user.id, displayName: user.displayName });
  });

  handle(app, ctx, "logout", async ({ session, c }) => {
    await endSession(ctx, c, session);
    return {};
  });

  handle(app, ctx, "listPasskeys", async ({ session }) => {
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, session.user.id), isNull(credentials.revokedAt)))
      .orderBy(asc(credentials.createdAt));
    return { items: rows.map(passkeySummary) };
  });

  handle(app, ctx, "startAddPasskey", async ({ session }) => {
    const existing = await ctx.db
      .select({ id: credentials.id, transports: credentials.transports })
      .from(credentials)
      .where(and(eq(credentials.userId, session.user.id), isNull(credentials.revokedAt)));
    return startRegistration(ctx, {
      kind: "add-passkey",
      userId: session.user.id,
      displayName: session.user.displayName,
      context: {},
      exclude: existing,
    });
  });

  handle(app, ctx, "finishAddPasskey", async ({ session, body }) => {
    const { ceremony, passkey } = await finishRegistration(ctx, {
      ceremonyId: body.ceremonyId,
      kind: "add-passkey",
      response: body.response,
    });
    // A ceremony started by one person cannot be finished in another person's session.
    if (ceremony.userId !== session.user.id) {
      throw new HttpError("not_found", "this sign-in step expired; start again");
    }
    await insertPasskey(ctx.db, session.user.id, passkey, body.label);
    const opened: ApprovalSummary[] = [];
    for (const { workspaceId } of await approvingWorkspaces(ctx, session.user.id)) {
      opened.push(
        await openAddApprover(ctx, {
          workspaceId,
          userId: session.user.id,
          credentialId: passkey.id,
          requestedBy: { type: "user", id: session.user.id },
        }),
      );
    }
    const [row] = await ctx.db.select().from(credentials).where(eq(credentials.id, passkey.id));
    if (!row) throw new HttpError("internal", "the passkey was not stored");
    return { passkey: passkeySummary(row), approvals: opened };
  });

  handle(app, ctx, "removePasskey", async ({ session, params }) => {
    const live = await ctx.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.userId, session.user.id), isNull(credentials.revokedAt)));
    if (!live.some((row) => row.id === params.credentialId)) {
      throw new HttpError("not_found", "no such passkey");
    }
    if (live.length === 1) {
      throw new HttpError("conflict", "add another passkey before removing your last one");
    }
    const mine = await ctx.db
      .select()
      .from(approverCredentials)
      .where(eq(approverCredentials.userId, session.user.id));
    const approving = mine.filter(
      (row) => row.credentialId === params.credentialId && row.state !== "pending",
    );
    // Removing the person's only active approver passkey in a workspace would leave them no
    // passkey able to approve its own removal, or anything else, there.
    for (const row of approving) {
      const otherActive = mine.some(
        (other) =>
          other.workspaceId === row.workspaceId &&
          other.credentialId !== params.credentialId &&
          other.state === "active",
      );
      if (!otherActive) {
        throw new HttpError(
          "conflict",
          "this is your only passkey that can approve in a workspace; add and activate another passkey first",
        );
      }
    }
    const workspaceIds = [
      ...new Set(
        mine
          .filter((row) => row.credentialId === params.credentialId)
          .map((row) => row.workspaceId),
      ),
    ];
    const opened: ApprovalSummary[] = [];
    for (const workspaceId of workspaceIds) {
      opened.push(
        ...(await withdrawApprover(ctx, {
          workspaceId,
          userId: session.user.id,
          credentialIds: [params.credentialId],
          afterwards: "keep",
          revokeSignIn: true,
          requestedBy: { type: "user", id: session.user.id },
        })),
      );
    }
    // A passkey that approves nowhere stops signing in at once. One that still approves stops
    // when its last `remove-approver` request is applied (see the remove-approver kind).
    if (opened.length === 0) {
      await ctx.db.transaction((tx) =>
        revokePasskey(tx, params.credentialId, new Date(ctx.now() * 1000)),
      );
    }
    ctx.log.info("passkey removed", { event: "passkey.removed", userId: session.user.id });
    return { approvals: opened };
  });

  handle(app, ctx, "eraseMe", async ({ session, c }) => {
    await requireRecentSignIn(ctx, session, "erase yourself");
    const outcome = await eraseOnRequest(ctx, session.user.id);
    // Erasing deleted every session of the person, this one included.
    if (outcome.status === "erased") clearSessionCookie(ctx.config, c);
    return outcome;
  });
}
