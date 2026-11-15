import type { ApprovalKind } from "@askgina/os-api";
import type { ApprovalId, WalletRef, WorkspaceId } from "@askgina/os-protocol";
import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { requireMember } from "../access.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Session } from "../context.ts";
import { approvals, wallets, workspaces } from "../db/schema.ts";
import { loadWallet, walletSummary, workspaceDetail } from "../directory/views.ts";
import { fromSignerError, HttpError } from "../http/errors.ts";
import { handle } from "../http/route.ts";
import { requireRecentSignIn } from "../identity/sessions.ts";
import { cloneWorkspace } from "./clone.ts";
import { writeRecord } from "./export.ts";
import { deletionPreflight } from "./preflight.ts";
import { cancelRequests, mirrorWallet, mirrorWorkspace } from "./state.ts";
import { toTemplate } from "./template.ts";

const actorOf = (session: Session) => ({ type: "user" as const, id: session.user.id });

/** Ask the signer something; its refusals become the API's error codes. */
async function signerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw fromSignerError(error);
  }
}

/** The request of `kind` about `subjectId` that still waits for people, if any. */
async function waitingRequest(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  kind: ApprovalKind,
  subjectId: string,
): Promise<{ id: ApprovalId; workspaceId: WorkspaceId } | undefined> {
  const [row] = await ctx.db
    .select({ id: approvals.id, workspaceId: approvals.workspaceId })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.kind, kind),
        eq(approvals.subjectId, subjectId),
        eq(approvals.status, "pending"),
      ),
    );
  return row;
}

/**
 * Refuse a destroy time sooner than the signer's minimum delay from now. The signer counts the
 * delay from when the request is opened, which is now, and checks it again when it applies it.
 */
function checkDelay(ctx: AppContext, destroyAfter: number, minDelaySeconds: number): void {
  if (destroyAfter - ctx.now() < Math.max(1, minDelaySeconds)) {
    throw new HttpError(
      "invalid_request",
      `destroyAfter: the signer destroys keys no sooner than ${minDelaySeconds} seconds after the request`,
      "destroy_delay_out_of_range",
    );
  }
}

async function adminThresholdOf(ctx: AppContext, workspaceId: WorkspaceId): Promise<number> {
  const [row] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!row) throw new HttpError("not_found", "no such workspace");
  return row.adminThreshold;
}

/** Bring every wallet's mirror up to date with the signer, after a deletion was cancelled. */
async function mirrorAllWallets(ctx: AppContext, workspaceId: WorkspaceId): Promise<void> {
  const rows = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .where(eq(wallets.workspaceId, workspaceId));
  for (const { id } of rows) {
    await mirrorWallet(ctx.db, await signerCall(() => ctx.signer.getWallet(id)));
  }
}

/**
 * Retiring a wallet, deleting a workspace, cancelling either, and what a deletion would lose.
 * Opening needs an owner; the confirmation page at the admin threshold decides. Cancelling only
 * keeps keys, so it needs no passkey.
 */
export function registerLifecycleRoutes(app: Hono, ctx: AppContext): void {
  handle(app, ctx, "getDeletionPreflight", async ({ session, params }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "owner");
    return deletionPreflight(ctx, workspaceId);
  });

  handle(app, ctx, "requestDeleteWorkspace", async ({ session, params, body }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "owner");
    // The signer's own flags decide: a deletion is asked for only once nothing signs.
    const state = await signerCall(() => ctx.signer.getWorkspace(workspaceId));
    if (state.state !== "active") {
      throw new HttpError("conflict", "this workspace is already being deleted", state.state);
    }
    if (!state.paused) {
      throw new HttpError("conflict", "pause the workspace before deleting it", "not_paused");
    }
    if (await waitingRequest(ctx, workspaceId, "delete-workspace", workspaceId)) {
      throw new HttpError("conflict", "a deletion already waits for approval", "already_requested");
    }
    checkDelay(ctx, body.destroyAfter, state.minDestroyDelaySeconds);
    // Every wallet whose key the signer still holds, as the signer holds it; the signer refuses
    // the deletion if it holds one more or one less (`wallet_set_mismatch`).
    const rows = await ctx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.workspaceId, workspaceId))
      .orderBy(asc(wallets.id));
    const refs: WalletRef[] = [];
    for (const { id } of rows) {
      const wallet = await signerCall(() => ctx.signer.getWallet(id));
      if (wallet.state !== "destroyed") refs.push({ walletId: id, address: wallet.address });
    }
    refs.sort((a, b) => (a.walletId < b.walletId ? -1 : a.walletId > b.walletId ? 1 : 0));
    return ctx.approvals.open({
      workspaceId,
      kind: "delete-workspace",
      subjectId: workspaceId,
      envelope: { wallets: refs, destroyAfter: body.destroyAfter },
      threshold: await adminThresholdOf(ctx, workspaceId),
      ttlSeconds: ctx.config.adminApprovalTtlSeconds,
      detail: {},
      requestedBy: actorOf(session),
    });
  });

  handle(app, ctx, "cancelDeleteWorkspace", async ({ session, params }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    // Any member: cancelling keeps the keys and leaves the workspace paused.
    const role = await requireMember(ctx, session, workspaceId, "viewer");
    const waiting = await waitingRequest(ctx, workspaceId, "delete-workspace", workspaceId);
    if (waiting) {
      await cancelRequests(ctx, [waiting]);
      return workspaceDetail(ctx, workspaceId, role);
    }
    const before = await signerCall(() => ctx.signer.getWorkspace(workspaceId));
    if (before.state !== "deleting") {
      throw new HttpError(
        "conflict",
        "no deletion of this workspace can be cancelled",
        before.state,
      );
    }
    const state = await signerCall(() => ctx.signer.cancelDeleteWorkspace(workspaceId));
    await ctx.db.transaction(async (tx) => {
      if (!(await mirrorWorkspace(tx, state)) || state.state !== "active") return;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: actorOf(session),
          action: "workspace.deletion_cancelled",
          subject: { type: "workspace", id: workspaceId },
        },
        tx,
      );
    });
    await mirrorAllWallets(ctx, workspaceId);
    return workspaceDetail(ctx, workspaceId, role);
  });

  handle(app, ctx, "requestRetireWallet", async ({ session, params, body }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "owner");
    const { wallet } = await loadWallet(ctx, workspaceId, params.walletId);
    // The envelope names the wallet as the signer holds it, never as our mirror does.
    const state = await signerCall(() => ctx.signer.getWallet(wallet.id));
    if (state.state === "retiring" || state.state === "destroyed") {
      throw new HttpError("conflict", "this wallet is already retiring", "wallet_retired");
    }
    if (await waitingRequest(ctx, workspaceId, "retire-wallet", wallet.id)) {
      throw new HttpError(
        "conflict",
        "a retirement of this wallet already waits for approval",
        "already_requested",
      );
    }
    const workspace = await signerCall(() => ctx.signer.getWorkspace(workspaceId));
    checkDelay(ctx, body.destroyAfter, workspace.minDestroyDelaySeconds);
    return ctx.approvals.open({
      workspaceId,
      kind: "retire-wallet",
      subjectId: wallet.id,
      envelope: {
        wallet: { walletId: wallet.id, address: state.address },
        destroyAfter: body.destroyAfter,
      },
      threshold: await adminThresholdOf(ctx, workspaceId),
      ttlSeconds: ctx.config.adminApprovalTtlSeconds,
      detail: {},
      requestedBy: actorOf(session),
    });
  });

  handle(app, ctx, "cancelRetireWallet", async ({ session, params }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "approver");
    const { wallet, agentId } = await loadWallet(ctx, workspaceId, params.walletId);
    const [workspace] = await ctx.db
      .select({ lifecycle: workspaces.lifecycle })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (workspace?.lifecycle !== "active") {
      throw new HttpError(
        "conflict",
        "the workspace is being deleted; cancel the deletion instead",
        "workspace_deleting",
      );
    }
    const waiting = await waitingRequest(ctx, workspaceId, "retire-wallet", wallet.id);
    if (waiting) {
      await cancelRequests(ctx, [waiting]);
    } else {
      const before = await signerCall(() => ctx.signer.getWallet(wallet.id));
      if (before.state !== "retiring") {
        await mirrorWallet(ctx.db, before);
        throw new HttpError(
          "conflict",
          "no retirement of this wallet can be cancelled",
          before.state === "destroyed" ? "wallet_retired" : "not_retiring",
        );
      }
      const state = await signerCall(() => ctx.signer.cancelRetireWallet(wallet.id, workspaceId));
      await ctx.db.transaction(async (tx) => {
        if (!(await mirrorWallet(tx, state)) || state.state !== "held") return;
        await appendAudit(
          ctx,
          {
            workspaceId,
            actor: actorOf(session),
            action: "wallet.retirement_cancelled",
            subject: { type: "wallet", id: wallet.id },
          },
          tx,
        );
      });
    }
    const { wallet: current } = await loadWallet(ctx, workspaceId, wallet.id);
    return walletSummary(current, agentId);
  });

  // --- export and clone (D11) -----------------------------------------------------------------

  handle(app, ctx, "exportTemplate", async ({ session, params }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "owner");
    return toTemplate(ctx, workspaceId);
  });

  handle(app, ctx, "exportRecord", async ({ session, params }) => {
    const workspaceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, workspaceId, "owner");
    await requireRecentSignIn(ctx, session, "export the record");
    const lines: string[] = [];
    await writeRecord(ctx, session, workspaceId, (line) => {
      lines.push(line);
    });
    return { record: `${lines.join("\n")}\n` };
  });

  handle(app, ctx, "cloneWorkspace", async ({ session, params, body }) => {
    const sourceId = params.workspaceId as WorkspaceId;
    await requireMember(ctx, session, sourceId, "owner");
    const { workspaceId, ...result } = await cloneWorkspace(ctx, session, { ...body, sourceId });
    return { workspace: await workspaceDetail(ctx, workspaceId, "owner"), ...result };
  });

  handle(app, ctx, "importTemplate", async ({ session, body }) => {
    const { workspaceId, ...result } = await cloneWorkspace(ctx, session, body);
    return { workspace: await workspaceDetail(ctx, workspaceId, "owner"), ...result };
  });
}
