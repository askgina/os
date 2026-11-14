import type { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { registerDirectoryKinds } from "./kinds.ts";
import { registerDirectoryRoutes } from "./routes.ts";

/** Workspaces, members, agents, wallets and audit, and the approval kinds they open. */
export function registerDirectory(app: Hono, ctx: AppContext): void {
  registerDirectoryKinds(ctx.approvals);
  registerDirectoryRoutes(app, ctx);
}
