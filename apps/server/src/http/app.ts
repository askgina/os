import { type ApiErrorBody, CONTENT_SECURITY_POLICY } from "@askgina/os-api";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { registerDirectory } from "../directory/index.ts";
import { engineOf } from "../execution/approvals.ts";
import { mountMcp, mountWorkflowDelivery, registerExecution } from "../execution/index.ts";
import { registerIdentity } from "../identity/index.ts";
import { registerNotify } from "../notify/routes.ts";
import { installErrorHandler } from "./route.ts";
import { serveWebApp } from "./static.ts";

/** Everything people and agents reach: the API, the MCP gateway and the UI. */
export function createPublicApp(ctx: AppContext): Hono {
  const app = new Hono();
  installErrorHandler(app, ctx);
  const https = ctx.config.publicOrigin.startsWith("https:");
  app.use(async (c, next) => {
    await next();
    c.header("content-security-policy", CONTENT_SECURITY_POLICY);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header("cross-origin-opener-policy", "same-origin");
    c.header("cross-origin-resource-policy", "same-origin");
    c.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (https) c.header("strict-transport-security", "max-age=63072000; includeSubDomains");
    if (new URL(c.req.url).pathname.startsWith("/api/")) c.header("cache-control", "no-store");
  });
  app.notFound((c) => {
    const body: ApiErrorBody = { error: { code: "not_found", message: "no such endpoint" } };
    return c.json(body, 404);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  // For load balancers and Kubernetes: ready once the database answers and the World started.
  app.get("/readyz", async (c) => {
    const ok =
      engineOf(ctx).delivering &&
      (await ctx.db.execute(sql`SELECT 1`).then(
        () => true,
        () => false,
      ));
    return c.json({ ok }, ok ? 200 : 503);
  });
  registerIdentity(app, ctx);
  registerDirectory(app, ctx);
  registerExecution(app, ctx);
  registerNotify(app, ctx);
  mountMcp(app, ctx);
  if (ctx.config.webDistDir !== undefined) serveWebApp(app, ctx.config.webDistDir);
  return app;
}

/**
 * The Workflow runtime's delivery routes. Upstream leaves them unauthenticated, so they live on
 * a listener bound to 127.0.0.1 and are never mounted on the public app.
 */
export function createInternalApp(ctx: AppContext): Hono {
  const internal = new Hono();
  installErrorHandler(internal, ctx);
  mountWorkflowDelivery(internal, ctx);
  return internal;
}
