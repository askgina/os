import { randomInt } from "node:crypto";
import { DisplayName } from "@askgina/os-api";
import { type AgentId, newId, PairingId, WorkspaceId } from "@askgina/os-protocol";
import { and, eq, gt, isNull, lt, not, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { requireMember } from "../access.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { agentPairings, agents, wallets, workspaces } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import { digestsEqual, randomToken, sha256Hex } from "../identity/secrets.ts";
import { clientOf, takeToken } from "../rate-limit.ts";
import { createAgentIn, mintAgentToken } from "./routes.ts";

/**
 * Pairing: an agent connects without anyone copying a token. The agent starts a pairing and shows
 * its person a short code and a link; the person, signed in to the web app, checks that the code
 * matches and allows it; the agent's next poll receives a token.
 *
 * Allowing always creates a new agent with its own new wallet, which has no policy and so can
 * sign nothing until an owner sets one with a passkey. Someone tricked into allowing another
 * person's pairing therefore hands over an empty wallet that cannot pay, never an existing one.
 * No token is stored: the agent created on approval gets a fresh token at the moment the poll
 * claims the pairing, and only the holder of the poll secret can claim it.
 */

/** How long a person has to answer, and how long an agent has to collect an allowed pairing. */
const PAIRING_TTL_SECONDS = 600;

const STARTS_PER_MINUTE = 10;

/** An agent polls every `POLL_INTERVAL_SECONDS`; this leaves room for several at once. */
const POLLS_PER_MINUTE = 120;

const POLL_INTERVAL_SECONDS = 2;

/** No 0, O, 1, I or L: a person reads the code from one screen and compares it with another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type PairingRow = typeof agentPairings.$inferSelect;

type PairingStatus = "pending" | "approved" | "denied" | "expired" | "claimed";

const StartBody = z.strictObject({ clientName: DisplayName });

const PollBody = z.strictObject({
  pairingId: z.string().max(64),
  pollSecret: z.string().max(128),
});

function userCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const half = () => Array.from({ length: 4 }, pick).join("");

  return `${half()}-${half()}`;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function statusOf(row: PairingRow, now: number): PairingStatus {
  if (row.claimedAt !== null) return "claimed";

  if (row.deniedAt !== null) return "denied";
  // Allowed in time: the agent has as long again to collect it.

  if (row.approvedAt !== null) {
    return now < seconds(row.approvedAt) + PAIRING_TTL_SECONDS ? "approved" : "expired";
  }

  return now < seconds(row.expiresAt) ? "pending" : "expired";
}

async function loadPairing(ctx: AppContext, segment: string): Promise<PairingRow> {
  const id = PairingId.safeParse(segment);

  if (!id.success) throw new HttpError("not_found", "no such pairing");
  const [row] = await ctx.db.select().from(agentPairings).where(eq(agentPairings.id, id.data));

  if (!row) throw new HttpError("not_found", "no such pairing");

  return row;
}

/**
 * The agent's side, beside `/mcp` and outside `/api/v1`: no session and no cookie, so the
 * same-origin rule for writes there does not apply. Requests from a browser page on another
 * origin are refused, as at `/mcp`, and both endpoints are rate-limited per client.
 */
function mountAgentEndpoints(app: Hono, ctx: AppContext): void {
  const publicUrl = new URL(ctx.config.publicOrigin);

  const guard = async (c: Context, bucket: string, perMinute: number) => {
    const request = c.req.raw;
    const host = request.headers.get("host") ?? new URL(request.url).host;

    if (host !== publicUrl.host) throw new HttpError("forbidden", "unexpected Host");
    const origin = request.headers.get("origin");

    if (origin !== null && origin !== ctx.config.publicOrigin) {
      throw new HttpError("forbidden", "unexpected Origin");
    }

    const client = clientOf(request, ctx.config.forwardedHops);

    if (!(await takeToken(ctx.db, `${bucket}:${client}`, perMinute))) {
      throw new HttpError("rate_limited", "too many requests; slow down");
    }

    c.header("cache-control", "no-store");
  };

  app.post("/agent-pairing", async (c) => {
    await guard(c, "pairing-start", STARTS_PER_MINUTE);
    const body = StartBody.parse(await c.req.json().catch(() => null));
    const now = ctx.now();

    // Pairings nobody collected are useless a day after they ended; drop them as new ones come.
    await ctx.db
      .delete(agentPairings)
      .where(lt(agentPairings.expiresAt, new Date((now - 24 * 3600) * 1000)));

    const pairingId = newId("pai");
    const pollSecret = randomToken(32);
    const code = userCode();
    const expiresAt = now + PAIRING_TTL_SECONDS;
    await ctx.db.insert(agentPairings).values({
      id: pairingId,
      clientName: body.clientName,
      userCode: code,
      pollSecretHash: sha256Hex(pollSecret),
      expiresAt: new Date(expiresAt * 1000),
    });

    return c.json(
      {
        pairingId,
        userCode: code,
        verificationUrl: `${ctx.config.publicOrigin}/pair/${pairingId}`,
        pollSecret,
        expiresAt,
        interval: POLL_INTERVAL_SECONDS,
      },
      201,
    );
  });

  app.post("/agent-pairing/poll", async (c) => {
    await guard(c, "pairing-poll", POLLS_PER_MINUTE);
    const body = PollBody.parse(await c.req.json().catch(() => null));
    const id = PairingId.safeParse(body.pairingId);

    const [row] = id.success
      ? await ctx.db.select().from(agentPairings).where(eq(agentPairings.id, id.data))
      : [];

    // An unknown pairing and a wrong secret answer alike.
    if (!row || !digestsEqual(sha256Hex(body.pollSecret), row.pollSecretHash)) {
      throw new HttpError("not_found", "no such pairing");
    }

    const status = statusOf(row, ctx.now());

    // Allowed, but the agent and its wallet are still being created: keep waiting.
    if (status !== "approved" || row.agentId === null || row.workspaceId === null) {
      return c.json({ status: status === "approved" ? "pending" : status });
    }

    const claimed = await claim(ctx, row, row.agentId, row.workspaceId);

    return c.json(claimed);
  });
}

/**
 * Deliver the agent's token exactly once: mark the pairing claimed and give the agent a fresh
 * token in one transaction, so of two polls at once only one gets it. The token the agent got
 * when it was created was never stored or shown, so this one is the only one that works.
 */
async function claim(ctx: AppContext, row: PairingRow, agentId: AgentId, workspaceId: WorkspaceId) {
  const minted = mintAgentToken(agentId);

  const result = await ctx.db.transaction(async (tx) => {
    const [won] = await tx
      .update(agentPairings)
      .set({ claimedAt: new Date(ctx.now() * 1000) })
      .where(and(eq(agentPairings.id, row.id), isNull(agentPairings.claimedAt)))
      .returning({ id: agentPairings.id });

    if (!won) return { status: "claimed" as const };

    // A removed agent's token hash starts with `removed:`; a disabled agent gets no token either.
    const [agent] = await tx
      .update(agents)
      .set({ tokenHash: minted.hash, tokenPrefix: minted.prefix })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.status, "active"),
          not(sql`${agents.tokenHash} LIKE 'removed:%'`),
        ),
      )
      .returning({ walletId: agents.walletId });

    if (!agent) return { status: "denied" as const };

    const [wallet] = await tx
      .select({ address: wallets.address })
      .from(wallets)
      .where(eq(wallets.id, agent.walletId));

    await appendAudit(
      ctx,
      {
        workspaceId,
        actor: { type: "agent", id: agentId },
        action: "agent.pairing_claimed",
        subject: { type: "agent", id: agentId },
      },
      tx,
    );

    return {
      status: "approved" as const,
      token: minted.token,
      mcpUrl: `${ctx.config.publicOrigin}/mcp`,
      workspaceId,
      agentId,
      walletId: agent.walletId,
      walletAddress: wallet?.address ?? null,
    };
  });

  if (result.status === "approved") {
    ctx.log.info("agent pairing claimed", { event: "agent.pairing_claimed", workspaceId, agentId });
  }

  return result;
}

/** The person's side, in the `/api/v1` contract: see a pairing, allow it into a workspace, deny it. */
export function registerPairing(app: Hono, ctx: AppContext): void {
  mountAgentEndpoints(app, ctx);

  handle(app, ctx, "getPairing", async ({ session, params }) => {
    const row = await loadPairing(ctx, params.pairingId);
    // Where it went is for the person who allowed it; anyone signed in with the link sees the rest.
    const mine = row.approvedBy === session.user.id;

    return {
      id: row.id,
      clientName: row.clientName,
      userCode: row.userCode,
      status: statusOf(row, ctx.now()),
      expiresAt: seconds(row.expiresAt),
      workspaceId: mine ? row.workspaceId : null,
      walletId: mine ? row.walletId : null,
    };
  });

  handle(app, ctx, "approvePairing", async ({ session, params, body }) => {
    const row = await loadPairing(ctx, params.pairingId);
    const workspaceId = WorkspaceId.safeParse(body.workspaceId);

    if (!workspaceId.success) throw new HttpError("not_found", "no such workspace");
    await requireMember(ctx, session, workspaceId.data, "owner");

    const [workspace] = await ctx.db
      .select({ lifecycle: workspaces.lifecycle })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId.data));

    if (workspace?.lifecycle !== "active") {
      throw new HttpError("conflict", "this workspace is being deleted", "workspace_deleting");
    }

    const now = new Date(ctx.now() * 1000);
    // Taken before the agent is created, so two people allowing at once create one agent.

    const [taken] = await ctx.db
      .update(agentPairings)
      .set({ approvedBy: session.user.id, approvedAt: now, workspaceId: workspaceId.data })
      .where(
        and(
          eq(agentPairings.id, row.id),
          isNull(agentPairings.approvedAt),
          isNull(agentPairings.deniedAt),
          gt(agentPairings.expiresAt, now),
        ),
      )
      .returning({ id: agentPairings.id });

    if (!taken) throw new HttpError("conflict", "this pairing is no longer waiting");

    // Give the pairing back, so the person can try again while it lasts.
    const release = () =>
      ctx.db
        .update(agentPairings)
        .set({ approvedBy: null, approvedAt: null, workspaceId: null })
        .where(and(eq(agentPairings.id, row.id), isNull(agentPairings.agentId)));

    // The token `createAgentIn` mints is dropped here: the agent receives its own when it claims.
    const created = await createAgentIn(ctx, session, workspaceId.data, body.name).catch(
      async (cause: unknown) => {
        await release();
        throw cause;
      },
    );

    await ctx.db
      .transaction(async (tx) => {
        await tx
          .update(agentPairings)
          .set({ agentId: created.agent.id, walletId: created.wallet.id })
          .where(eq(agentPairings.id, row.id));
        await appendAudit(
          ctx,
          {
            workspaceId: workspaceId.data,
            actor: { type: "user", id: session.user.id },
            action: "agent.paired",
            subject: { type: "agent", id: created.agent.id },
            detail: { clientName: row.clientName },
          },
          tx,
        );
      })
      .catch(async (cause: unknown) => {
        // Nobody holds a token for the agent just created; disable it rather than leave it
        // looking usable, and let the person allow again.
        await ctx.db
          .update(agents)
          .set({ status: "disabled" })
          .where(eq(agents.id, created.agent.id));
        await release();
        throw cause;
      });

    return {
      workspaceId: workspaceId.data,
      agentId: created.agent.id,
      walletId: created.wallet.id,
    };
  });

  handle(app, ctx, "denyPairing", async ({ params }) => {
    const row = await loadPairing(ctx, params.pairingId);
    const now = new Date(ctx.now() * 1000);

    const [denied] = await ctx.db
      .update(agentPairings)
      .set({ deniedAt: now })
      .where(
        and(
          eq(agentPairings.id, row.id),
          isNull(agentPairings.approvedAt),
          isNull(agentPairings.deniedAt),
          gt(agentPairings.expiresAt, now),
        ),
      )
      .returning({ id: agentPairings.id });

    if (!denied) throw new HttpError("conflict", "this pairing is no longer waiting");

    return {};
  });
}
