import type { MandateId, WorkspaceId } from "@askgina/os-protocol";
import type { Hono } from "hono";
import { requireMember } from "../access.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import { engineOf } from "./approvals.ts";
import { requestCancel } from "./cancel.ts";
import { getIntentRow, intentDetail, intentSummary, listIntentRows } from "./intents.ts";
import {
  listMandates,
  loadMandate,
  mandateSummary,
  openMandateGrant,
  revokeMandate,
} from "./mandates.ts";
import { cancelVenueOrder } from "./orders.ts";
import { speedUpIntent } from "./repricing.ts";
import { requestSweep } from "./sweeps.ts";

/** The approval, intent, sweep and mandate endpoints of the contract in `@askgina/os-api`. */
export function registerApprovalAndIntentRoutes(app: Hono, ctx: AppContext): void {
  const engine = engineOf(ctx);

  handle(app, ctx, "proposeMandate", async ({ params, body, session }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    // Adding standing authority is an owner's call, as a policy change is; approving it takes
    // the workspace's admin threshold.
    await requireMember(ctx, session, workspaceId, "owner");

    return openMandateGrant(ctx, {
      workspaceId,
      walletId: params.walletId,
      draft: body,
      requestedBy: session.user.id,
    });
  });

  handle(app, ctx, "listMandates", async ({ params, query, session }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId);

    return listMandates(ctx, workspaceId, query);
  });

  handle(app, ctx, "getMandate", async ({ params, session }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId);
    const { row, state } = await loadMandate(ctx, workspaceId, params.mandateId);
    const { rows, nextCursor } = await listIntentRows(ctx, { workspaceId, mandateId: row.id });

    return {
      ...(await mandateSummary(ctx, row, state)),
      intents: await Promise.all(rows.map((intent) => intentSummary(ctx, intent))),
      intentsCursor: nextCursor,
    };
  });

  // Stopping a mandate only removes authority, so anyone who may approve may do it, at once.
  handle(app, ctx, "revokeMandate", async ({ params, session }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "approver");
    const { row } = await loadMandate(ctx, workspaceId, params.mandateId);
    await revokeMandate(ctx, {
      workspaceId,
      mandateId: row.id,
      reason: "revoked",
      actor: { type: "user", id: session.user.id },
    });
    const revoked = await loadMandate(ctx, workspaceId, row.id);

    return mandateSummary(ctx, revoked.row, revoked.state);
  });

  handle(app, ctx, "requestSweep", async ({ params, body, session }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    // Moving funds without an agent or a cap is an owner's call; approving it takes the
    // workspace's admin threshold.
    await requireMember(ctx, session, workspaceId, "owner");

    return requestSweep(ctx, {
      workspaceId,
      walletId: params.walletId,
      ...body,
      requestedBy: session.user.id,
    });
  });

  handle(app, ctx, "listApprovals", async ({ params, query, session }) => {
    await requireMember(ctx, session, params.workspaceId as never);

    return engine.list(params.workspaceId as never, query);
  });

  // Reading a waiting request also counts the approvals made on the signer's confirmation page,
  // so the page the person returns to, and polls, moves on by itself.
  handle(app, ctx, "getApproval", async ({ params, session }) => {
    const row = await engine.request(params.approvalId);
    await requireMember(ctx, session, row.workspaceId);
    await engine.collect(row);

    return engine.detail(await engine.request(row.id), session);
  });

  handle(app, ctx, "collectApproval", async ({ params, session }) => {
    const row = await engine.request(params.approvalId);
    await requireMember(ctx, session, row.workspaceId);
    await engine.collect(row);

    return engine.detail(await engine.request(row.id), session);
  });

  handle(app, ctx, "reject", async ({ params, session }) => {
    const row = await engine.request(params.approvalId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    await engine.reject(row, session);

    return engine.detail(await engine.request(row.id), session);
  });

  // Stopping a transaction moves nothing, so anyone who may approve may ask; people approve the
  // cancel with their passkeys at the wallet policy's threshold.
  handle(app, ctx, "requestSweepCancel", async ({ params, session }) => {
    const row = await engine.request(params.approvalId);
    await requireMember(ctx, session, row.workspaceId, "approver");

    if (row.kind !== "sweep-wallet") throw new HttpError("not_found", "no such sweep");

    return requestCancel(ctx, {
      workspaceId: row.workspaceId,
      targetApprovalId: row.id,
      intentId: null,
      requestedBy: session.user.id,
    });
  });

  handle(app, ctx, "listIntents", async ({ params, query, session }) => {
    await requireMember(ctx, session, params.workspaceId as never);

    const { rows, nextCursor } = await listIntentRows(ctx, {
      workspaceId: params.workspaceId as never,
      mandateId: query.mandateId as MandateId | undefined,
      cursor: query.cursor,
    });

    return { items: await Promise.all(rows.map((row) => intentSummary(ctx, row))), nextCursor };
  });

  handle(app, ctx, "getIntent", async ({ params, session }) => {
    const row = await getIntentRow(ctx, params.intentId);
    await requireMember(ctx, session, row.workspaceId);

    return intentDetail(ctx, row);
  });

  // Raising a fee needs no passkey: the signer lets only the two fees rise, under the ceiling
  // people approved, within its window.
  handle(app, ctx, "speedUp", async ({ params, session }) => {
    const row = await getIntentRow(ctx, params.intentId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    await speedUpIntent(ctx, row, session.user.id);

    return intentDetail(ctx, await getIntentRow(ctx, row.id));
  });

  // Approving an order includes the right to cancel it (D4): no passkey, also while paused.
  handle(app, ctx, "cancelOrder", async ({ params, session }) => {
    const row = await getIntentRow(ctx, params.intentId);
    await requireMember(ctx, session, row.workspaceId, "approver");
    await cancelVenueOrder(ctx, row, { type: "user", id: session.user.id });

    return intentDetail(ctx, await getIntentRow(ctx, row.id));
  });

  handle(app, ctx, "requestCancel", async ({ params, session }) => {
    const row = await getIntentRow(ctx, params.intentId);
    await requireMember(ctx, session, row.workspaceId, "approver");

    return requestCancel(ctx, {
      workspaceId: row.workspaceId,
      targetApprovalId: row.approvalId,
      intentId: row.id,
      requestedBy: session.user.id,
    });
  });
}
