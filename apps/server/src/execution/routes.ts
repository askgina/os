import type { Hono } from "hono";
import { requireMember } from "../access.ts";
import type { AppContext } from "../context.ts";
import { handle } from "../http/route.ts";
import { engineOf } from "./approvals.ts";
import { getIntentRow, intentDetail, intentSummary, listIntentRows } from "./intents.ts";

/** The approval and intent endpoints of the contract in `@askgina/os-api`. */
export function registerApprovalAndIntentRoutes(app: Hono, ctx: AppContext): void {
  const engine = engineOf(ctx);

  handle(app, ctx, "listApprovals", async ({ params, query, session }) => {
    await requireMember(ctx, session, params.workspaceId as never);
    return engine.list(params.workspaceId as never, query);
  });

  handle(app, ctx, "getApproval", async ({ params, session }) => {
    const row = await engine.row(params.approvalId);
    await requireMember(ctx, session, row.workspaceId);
    return engine.detail(row, session);
  });

  handle(app, ctx, "startApproval", async ({ params, session }) => {
    const row = await engine.row(params.approvalId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    return { options: await engine.startCeremony(row, session) };
  });

  handle(app, ctx, "approve", async ({ params, body, session }) => {
    const row = await engine.row(params.approvalId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    await engine.approve(row, session, body.response);
    return engine.detail(await engine.row(row.id), session);
  });

  handle(app, ctx, "reject", async ({ params, session }) => {
    const row = await engine.row(params.approvalId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    await engine.reject(row, session);
    return engine.detail(await engine.row(row.id), session);
  });

  handle(app, ctx, "listIntents", async ({ params, query, session }) => {
    await requireMember(ctx, session, params.workspaceId as never);
    const { rows, nextCursor } = await listIntentRows(ctx, {
      workspaceId: params.workspaceId as never,
      cursor: query.cursor,
    });
    return { items: await Promise.all(rows.map((row) => intentSummary(ctx, row))), nextCursor };
  });

  handle(app, ctx, "getIntent", async ({ params, session }) => {
    const row = await getIntentRow(ctx, params.intentId);
    await requireMember(ctx, session, row.workspaceId);
    return intentDetail(ctx, row);
  });
}
