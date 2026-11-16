import type { Envelope } from "@askgina/os-protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { ApprovalKindHandler } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { agents, wallets } from "../db/schema.ts";
import { alreadyApplied, atSigner, envelopeOnly } from "../directory/kinds.ts";
import { loadWallet, walletSummary } from "../directory/views.ts";
import { endMandateMirrors } from "../execution/mandates.ts";
import { enqueueLifecycleNotifications } from "../notify/outbox.ts";
import { cancelRequests, mirrorWallet, mirrorWorkspace, waitingRequests } from "./state.ts";

type RetireWalletEnvelope = Extract<Envelope, { type: "retire-wallet" }>;

type DeleteWorkspaceEnvelope = Extract<Envelope, { type: "delete-workspace" }>;

const systemActor = { type: "system", id: null } as const;

/**
 * Requests that stay open when a retirement or deletion is applied: a cancel of a stuck
 * transaction is how people clear what finalize waits for (D7), and the signer still accepts it.
 */
const KEPT_WHILE_RETIRING = ["cancel-transaction"] as const;

const retireWallet: ApprovalKindHandler<"retire-wallet"> = {
  kind: "retire-wallet",
  async title(ctx, approval) {
    const envelope = approval.envelope as RetireWalletEnvelope;

    const [wallet] = await ctx.db
      .select({ label: wallets.label })
      .from(wallets)
      .where(eq(wallets.id, envelope.wallet.walletId));

    return `Retire ${wallet?.label || "a wallet"} and destroy its key`;
  },
  async describe(ctx, approval) {
    const envelope = approval.envelope as RetireWalletEnvelope;

    const { wallet, agentId } = await loadWallet(
      ctx,
      approval.workspaceId,
      envelope.wallet.walletId,
    );

    return {
      kind: "retire-wallet",
      wallet: walletSummary(wallet, agentId),
      destroyAfter: envelope.destroyAfter,
    };
  },
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization) {
    const envelope = approval.envelope as RetireWalletEnvelope;
    const { workspaceId } = approval;
    const walletId = envelope.wallet.walletId;

    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.retireWallet(walletId, authorization));
    }

    // Mirror what the signer holds now: a cancel that came first must not be undone here.
    const state = await atSigner(() => ctx.signer.getWallet(walletId));
    await ctx.db.transaction(async (tx) => {
      if (!(await mirrorWallet(tx, state))) return;

      if (state.state !== "retiring" || state.destroyAfter !== envelope.destroyAfter) return;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: systemActor,
          action: "wallet.retiring",
          subject: { type: "wallet", id: walletId },
          detail: { approvalId: approval.id, destroyAfter: envelope.destroyAfter },
        },
        tx,
      );
      await enqueueLifecycleNotifications(ctx, tx, {
        approvalId: approval.id,
        workspaceId,
        appliedAt: ctx.now(),
        destroyAfter: envelope.destroyAfter,
      });
    });
    // The signer refuses all of these now; ending them here keeps nobody approving in vain.
    await cancelRequests(
      ctx,
      await waitingRequests(
        ctx,
        { workspaceId, walletId },
        { except: approval.id, keep: KEPT_WHILE_RETIRING },
      ),
    );
    // The signer revoked the wallet's mandates in the step that applied this (D8).
    await endMandateMirrors(ctx, workspaceId, walletId);
  },
};

const deleteWorkspace: ApprovalKindHandler<"delete-workspace"> = {
  kind: "delete-workspace",
  async title(_ctx, approval) {
    const count = (approval.envelope as DeleteWorkspaceEnvelope).wallets.length;

    return count === 1
      ? "Delete this workspace and destroy 1 wallet key"
      : `Delete this workspace and destroy ${count} wallet keys`;
  },
  async describe(ctx, approval) {
    const envelope = approval.envelope as DeleteWorkspaceEnvelope;
    const ids = envelope.wallets.map((wallet) => wallet.walletId);

    const rows =
      ids.length === 0
        ? []
        : await ctx.db
            .select({ wallet: wallets, agentId: agents.id })
            .from(wallets)
            .leftJoin(agents, eq(agents.walletId, wallets.id))
            .where(and(eq(wallets.workspaceId, approval.workspaceId), inArray(wallets.id, ids)));

    return {
      kind: "delete-workspace",
      wallets: ids.flatMap((id) => {
        const row = rows.find((candidate) => candidate.wallet.id === id);

        return row ? [walletSummary(row.wallet, row.agentId)] : [];
      }),
      destroyAfter: envelope.destroyAfter,
    };
  },
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization) {
    const envelope = approval.envelope as DeleteWorkspaceEnvelope;
    const { workspaceId } = approval;

    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.deleteWorkspace(workspaceId, authorization));
    }

    const state = await atSigner(() => ctx.signer.getWorkspace(workspaceId));

    const walletStates = await Promise.all(
      envelope.wallets.map((wallet) => atSigner(() => ctx.signer.getWallet(wallet.walletId))),
    );

    await ctx.db.transaction(async (tx) => {
      // The workspace row first: the audit append below takes the same lock.
      const changed = await mirrorWorkspace(tx, state);

      for (const wallet of walletStates) await mirrorWallet(tx, wallet);

      if (!changed || state.state !== "deleting") return;

      if (state.destroyAfter !== envelope.destroyAfter) return;
      await appendAudit(
        ctx,
        {
          workspaceId,
          actor: systemActor,
          action: "workspace.deleting",
          subject: { type: "workspace", id: workspaceId },
          detail: {
            approvalId: approval.id,
            destroyAfter: envelope.destroyAfter,
            wallets: envelope.wallets.map((wallet) => wallet.walletId),
          },
        },
        tx,
      );
      await enqueueLifecycleNotifications(ctx, tx, {
        approvalId: approval.id,
        workspaceId,
        appliedAt: ctx.now(),
        destroyAfter: envelope.destroyAfter,
      });
    });
    await cancelRequests(
      ctx,
      await waitingRequests(
        ctx,
        { workspaceId, walletId: null },
        { except: approval.id, keep: KEPT_WHILE_RETIRING },
      ),
    );
    await endMandateMirrors(ctx, workspaceId, null);
  },
};

/** The approval kinds that end a wallet or a workspace. */
export function registerLifecycleKinds(ctx: AppContext): void {
  ctx.approvals.register(retireWallet);
  ctx.approvals.register(deleteWorkspace);
}
