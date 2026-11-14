import type { UserSummary } from "@askgina/os-api";
import {
  type ApprovalId,
  type Authorization,
  policyHash,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { and, eq, ne, sql } from "drizzle-orm";
import { ApprovalFailure, type ApprovalKindHandler } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  approverCredentials,
  credentials,
  memberships,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import type { AddApproverDetail, RemoveApproverDetail } from "./approvers.ts";
import { loadWallet, walletSummary } from "./views.ts";

export interface SetPolicyDetail {
  policy: WalletPolicy;
}

/**
 * Run a call at the signer. A refusal the signer gave for a reason that will not change (a bad
 * assertion, a used nonce, a threshold that cannot be met) ends the request as failed with the
 * signer's code; transport errors and the signer's own internal errors are retried.
 */
async function atSigner<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SignerError && error.code !== "internal" && error.code !== "vault_error") {
      throw new ApprovalFailure(error.code, "the signer refused this change");
    }
    throw error;
  }
}

/**
 * Whether the signer already applied this approval. A workflow step can run again after a
 * crash; the signer would refuse the reused nonce, so a second run only updates our mirror.
 */
async function alreadyApplied(ctx: AppContext, approvalId: ApprovalId): Promise<boolean> {
  return (await ctx.signer.getApproval(approvalId)).state === "applied";
}

async function personAndPasskey(ctx: AppContext, detail: AddApproverDetail) {
  const [row] = await ctx.db
    .select({ id: users.id, displayName: users.displayName, label: credentials.label })
    .from(credentials)
    .innerJoin(users, eq(users.id, credentials.userId))
    .where(eq(credentials.id, detail.credentialId));
  const user: UserSummary = { id: detail.userId, displayName: row?.displayName ?? "unknown" };
  return { user, label: row?.label ?? "removed passkey" };
}

const systemActor = { type: "system", id: null } as const;

const addApprover: ApprovalKindHandler<"add-approver"> = {
  kind: "add-approver",
  async title(ctx, _approval, detail) {
    const { user, label } = await personAndPasskey(ctx, detail as AddApproverDetail);
    return `Let ${user.displayName} approve with the passkey "${label}"`;
  },
  async describe(ctx, _approval, detail) {
    const { user, label } = await personAndPasskey(ctx, detail as AddApproverDetail);
    const { credentialId } = detail as AddApproverDetail;
    return { kind: "add-approver", user, credentialId, passkeyLabel: label };
  },
  async execute(ctx, approval, authorization, detail) {
    const { credentialId, userId } = detail as AddApproverDetail;
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.addApprover(approval.workspaceId, { authorization }));
    }
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(approverCredentials)
        .set({ state: "active" })
        .where(
          and(
            eq(approverCredentials.workspaceId, approval.workspaceId),
            eq(approverCredentials.credentialId, credentialId),
            eq(approverCredentials.state, "pending"),
          ),
        )
        .returning();
      if (changed.length > 0) {
        await appendAudit(
          ctx,
          {
            workspaceId: approval.workspaceId,
            actor: systemActor,
            action: "approver.added",
            subject: { type: "user", id: userId },
            detail: { approvalId: approval.id, credentialId },
          },
          tx,
        );
      }
    });
  },
  async abandon(ctx, approval, _status, detail) {
    const { credentialId } = detail as AddApproverDetail;
    await ctx.db
      .delete(approverCredentials)
      .where(
        and(
          eq(approverCredentials.workspaceId, approval.workspaceId),
          eq(approverCredentials.credentialId, credentialId),
          eq(approverCredentials.state, "pending"),
        ),
      );
  },
};

const removeApprover: ApprovalKindHandler<"remove-approver"> = {
  kind: "remove-approver",
  async title(ctx, _approval, detail) {
    const { user, label } = await personAndPasskey(ctx, detail as RemoveApproverDetail);
    return `Stop ${user.displayName}'s passkey "${label}" from approving`;
  },
  async describe(ctx, _approval, detail) {
    const { user, label } = await personAndPasskey(ctx, detail as RemoveApproverDetail);
    const { credentialId } = detail as RemoveApproverDetail;
    return { kind: "remove-approver", user, credentialId, passkeyLabel: label };
  },
  async execute(ctx, approval, authorization, detail) {
    const { credentialId, userId, afterwards } = detail as RemoveApproverDetail;
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.removeApprover(approval.workspaceId, authorization));
    }
    await ctx.db.transaction(async (tx) => {
      const removed = await tx
        .delete(approverCredentials)
        .where(
          and(
            eq(approverCredentials.workspaceId, approval.workspaceId),
            eq(approverCredentials.credentialId, credentialId),
          ),
        )
        .returning();
      if (removed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: "approver.removed",
          subject: { type: "user", id: userId },
          detail: { approvalId: approval.id, credentialId },
        },
        tx,
      );
      if (afterwards === "keep") return;
      // The role changes only once none of the member's passkeys can approve any more.
      const remaining = await tx
        .select({ id: approverCredentials.credentialId })
        .from(approverCredentials)
        .where(
          and(
            eq(approverCredentials.workspaceId, approval.workspaceId),
            eq(approverCredentials.userId, userId),
          ),
        );
      if (remaining.length > 0) return;
      const membership = and(
        eq(memberships.workspaceId, approval.workspaceId),
        eq(memberships.userId, userId),
      );
      if (afterwards === "viewer") {
        await tx.update(memberships).set({ role: "viewer" }).where(membership);
      } else {
        await tx.delete(memberships).where(membership);
      }
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: afterwards === "viewer" ? "member.role_changed" : "member.removed",
          subject: { type: "user", id: userId },
          detail: afterwards === "viewer" ? { role: "viewer" } : {},
        },
        tx,
      );
    });
  },
  async abandon(ctx, approval, _status, detail) {
    const { credentialId } = detail as RemoveApproverDetail;
    await ctx.db
      .update(approverCredentials)
      .set({ state: "active" })
      .where(
        and(
          eq(approverCredentials.workspaceId, approval.workspaceId),
          eq(approverCredentials.credentialId, credentialId),
          eq(approverCredentials.state, "removing"),
        ),
      );
  },
};

const setPolicy: ApprovalKindHandler<"set-policy"> = {
  kind: "set-policy",
  async title(ctx, approval, detail) {
    const { policy } = detail as SetPolicyDetail;
    const { wallet } = await loadWallet(ctx, approval.workspaceId, policy.walletId);
    return `Set revision ${policy.revision} of the policy of ${wallet.label}`;
  },
  async describe(ctx, approval, detail) {
    const { policy } = detail as SetPolicyDetail;
    const { wallet, agentId } = await loadWallet(ctx, approval.workspaceId, policy.walletId);
    return {
      kind: "set-policy",
      wallet: walletSummary(wallet, agentId),
      current: wallet.policy,
      proposed: policy,
    };
  },
  async execute(ctx, approval, authorization, detail) {
    const { policy } = detail as SetPolicyDetail;
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.setPolicy(policy.walletId, { policy, authorization }));
    }
    const hash = policyHash(policy);
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(wallets)
        .set({ policy, policyHash: hash })
        // IS DISTINCT FROM, because a wallet's first policy replaces NULL.
        .where(
          and(eq(wallets.id, policy.walletId), sql`${wallets.policyHash} IS DISTINCT FROM ${hash}`),
        )
        .returning({ id: wallets.id });
      if (changed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: "policy.changed",
          subject: { type: "wallet", id: policy.walletId },
          detail: { approvalId: approval.id, revision: policy.revision, policyHash: hash },
        },
        tx,
      );
    });
  },
};

async function workspaceRow(ctx: AppContext, workspaceId: WorkspaceId) {
  const [row] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  return row;
}

const setAdminThreshold: ApprovalKindHandler<"set-admin-threshold"> = {
  kind: "set-admin-threshold",
  async title(_ctx, approval) {
    const envelope = approval.envelope as Extract<
      Authorization["envelope"],
      { type: "set-admin-threshold" }
    >;
    return `Require ${envelope.adminThreshold} approvals for changes to approvers and policies`;
  },
  async describe(ctx, approval) {
    const envelope = approval.envelope as Extract<
      Authorization["envelope"],
      { type: "set-admin-threshold" }
    >;
    const workspace = await workspaceRow(ctx, approval.workspaceId);
    return {
      kind: "set-admin-threshold",
      current: workspace?.adminThreshold ?? 1,
      proposed: envelope.adminThreshold,
    };
  },
  async execute(ctx, approval, authorization) {
    const envelope = approval.envelope as Extract<
      Authorization["envelope"],
      { type: "set-admin-threshold" }
    >;
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.setAdminThreshold(approval.workspaceId, authorization));
    }
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ adminThreshold: envelope.adminThreshold })
        .where(
          and(
            eq(workspaces.id, approval.workspaceId),
            ne(workspaces.adminThreshold, envelope.adminThreshold),
          ),
        )
        .returning({ id: workspaces.id });
      if (changed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: "workspace.admin_threshold_changed",
          subject: { type: "workspace", id: approval.workspaceId },
          detail: { approvalId: approval.id, adminThreshold: envelope.adminThreshold },
        },
        tx,
      );
    });
  },
};

const resumeWorkspace: ApprovalKindHandler<"resume-workspace"> = {
  kind: "resume-workspace",
  async title() {
    return "Let this workspace sign again";
  },
  async describe() {
    return { kind: "resume-workspace" };
  },
  async execute(ctx, approval, authorization) {
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.resumeWorkspace(approval.workspaceId, authorization));
    }
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ paused: false })
        .where(and(eq(workspaces.id, approval.workspaceId), eq(workspaces.paused, true)))
        .returning({ id: workspaces.id });
      if (changed.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: "workspace.resumed",
          subject: { type: "workspace", id: approval.workspaceId },
          detail: { approvalId: approval.id },
        },
        tx,
      );
    });
  },
};

/** The approval kinds this module owns. */
export function registerDirectoryKinds(engine: AppContext["approvals"]): void {
  engine.register(setPolicy);
  engine.register(addApprover);
  engine.register(removeApprover);
  engine.register(setAdminThreshold);
  engine.register(resumeWorkspace);
}
