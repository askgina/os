import {
  type ApiErrorBody,
  type PathParams,
  type RouteDefinition,
  type RouteName,
  type Routes,
  routes,
} from "@askgina/os-api";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext, Session } from "../context.ts";
import { memberships, workspaces } from "../db/schema.ts";
import { HttpError } from "./errors.ts";

type Infer<S> = S extends z.ZodType ? z.infer<S> : undefined;

export interface HandlerInput<R extends RouteDefinition> {
  params: PathParams<R["path"]>;
  query: Infer<R["query"]>;
  body: Infer<R["body"]>;
  /** Always set on `session` routes; on `public` routes it is set when someone is signed in. */
  session: R["auth"] extends "session" ? Session : Session | null;
  /** For handlers that set or clear cookies. */
  c: Context;
}

export type Handler<N extends RouteName> = (
  input: HandlerInput<Routes[N]>,
) => Promise<z.input<Routes[N]["response"]>>;

/**
 * The writes to a workspace that still work while it is being deleted, or after: they pause,
 * cancel, end authority, or change what notifications say. Reads always work.
 */
const ALLOWED_WHILE_DELETING: Partial<Record<RouteName, true>> = {
  pauseWorkspace: true,
  cancelDeleteWorkspace: true,
  cancelRetireWallet: true,
  revokeMandate: true,
  setNotificationDetail: true,
};

/**
 * Serve one endpoint of the contract in `@askgina/os-api`. This is the only way routes under
 * `/api/v1` are registered, so every endpoint gets the same treatment: session check, origin
 * check on writes, input validation, a write to a workspace being deleted refused (`conflict`,
 * detail `workspace_deleting` or `workspace_deleted`) unless it is one of
 * {@link ALLOWED_WHILE_DELETING}, and a response that matches the contract.
 */
export function handle<N extends RouteName>(
  app: Hono,
  ctx: AppContext,
  name: N,
  handler: Handler<N>,
): void {
  const route: RouteDefinition = routes[name];
  app.on(route.method, route.path, async (c) => {
    // A browser attaches the session cookie to any request it sends here, so a write must
    // come from our own page. SameSite=Strict already blocks most of this; this is the backstop.
    if (route.method !== "GET") {
      const origin = c.req.header("origin");

      if (origin === undefined || !ctx.config.relyingParty.origins.includes(origin)) {
        throw new HttpError("forbidden", "requests that change state must come from this site");
      }
    }

    const session = await ctx.sessions.resolve(c.req.raw);

    if (route.auth === "session" && session === null) {
      throw new HttpError("unauthenticated", "sign in first");
    }

    const workspaceId = (c.req.param() as Record<string, string | undefined>).workspaceId;

    if (
      route.method !== "GET" &&
      session !== null &&
      workspaceId !== undefined &&
      ALLOWED_WHILE_DELETING[name] !== true
    ) {
      // Only a member learns the state; anyone else gets the handler's `not_found`.
      const [row] = await ctx.db
        .select({ lifecycle: workspaces.lifecycle })
        .from(workspaces)
        .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
        .where(
          and(eq(workspaces.id, workspaceId as never), eq(memberships.userId, session.user.id)),
        );

      if (row && row.lifecycle !== "active") {
        throw new HttpError(
          "conflict",
          "this workspace is being deleted: only pausing, cancelling and notification settings still work",
          `workspace_${row.lifecycle}`,
        );
      }
    }

    const body =
      route.body === null ? undefined : route.body.parse(await c.req.json().catch(() => null));

    const query = route.query === null ? undefined : route.query.parse(c.req.query());

    const output = await handler({
      params: c.req.param() as never,
      query: query as never,
      body: body as never,
      session: session as never,
      c,
    });

    return c.json(route.response.parse(output) as object);
  });
}

/** Turn anything thrown while handling a request into the contract's error body. */
export function installErrorHandler(app: Hono, ctx: Pick<AppContext, "log">): void {
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      };

      return c.json(body, error.status as 400);
    }

    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const where = first?.path.join(".") ?? "";

      const body: ApiErrorBody = {
        error: {
          code: "invalid_request",
          message:
            where === "" ? (first?.message ?? "invalid request") : `${where}: ${first?.message}`,
        },
      };

      return c.json(body, 400);
    }

    // The message may quote user data; log only what kind of error it was and where.
    ctx.log.error("unhandled error", { name: error.name, path: new URL(c.req.url).pathname });
    const body: ApiErrorBody = { error: { code: "internal", message: "something went wrong" } };

    return c.json(body, 500);
  });
}
