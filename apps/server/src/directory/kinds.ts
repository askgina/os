import type { UserSummary } from "@askgina/os-api";
import {
  type ApprovalId,
  type ConfirmationSubject,
  policyHash,
  WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ApprovalFailure, type ApprovalKindHandler, envelopeOf } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Executor } from "../context.ts";
import {
  approverCredentials,
  credentials,
  memberships,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { revokePasskey } from "../identity/passkeys.ts";
import { mirrorWallet } from "../lifecycle/state.ts";
import { AddApproverDetail, RemoveApproverDetail } from "./approvers.ts";
import { anotherOwnerRemains, dropInvitesOf } from "./members.ts";
import { loadWallet, walletSummary } from "./views.ts";

/** The sealed detail of a `set-policy` request: the policy the people approve. */
export const SetPolicyDetail = z.object({ policy: WalletPolicy });

export type SetPolicyDetail = z.infer<typeof SetPolicyDetail>;

/**
 * Run a call at the signer. A refusal the signer gave for a reason that will not change (a bad
 * assertion, a used nonce, a threshold that cannot be met) ends the request as failed with the
 * signer's code; transport errors and the signer's own internal errors are retried.
 */
export async function atSigner<T>(call: () => Promise<T>): Promise<T> {
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
export async function alreadyApplied(ctx: AppContext, approvalId: ApprovalId): Promise<boolean> {
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

/** For kinds whose envelope carries everything the confirmation page shows. */
export const envelopeOnly = async (): Promise<ConfirmationSubject> => ({ kind: "envelope-only" });

/**
 * End sign-in for a passkey its owner removed, once no workspace still lists it as an approver.
 * Runs in the transaction that deleted the last such row.
 */
async function revokeSignInOnceUnused(ctx: AppContext, tx: Executor, credentialId: string) {
  const [still] = await tx
    .select({ id: approverCredentials.credentialId })
    .from(approverCredentials)
    .where(eq(approverCredentials.credentialId, credentialId))
    .limit(1);

  if (still) return;
  await revokePasskey(tx, credentialId, new Date(ctx.now() * 1000));
}

const addApprover: ApprovalKindHandler<"add-approver"> = {
  kind: "add-approver",
  async title(ctx, _approval, detail) {
    const { user, label } = await personAndPasskey(ctx, AddApproverDetail.parse(detail));

    return `Let ${user.displayName} approve with the passkey "${label}"`;
  },
  async describe(ctx, _approval, detail) {
    const added = AddApproverDetail.parse(detail);
    const { user, label } = await personAndPasskey(ctx, added);

    return { kind: "add-approver", user, credentialId: added.credentialId, passkeyLabel: label };
  },
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization, detail) {
    const { credentialId, userId } = AddApproverDetail.parse(detail);

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
    const { credentialId } = AddApproverDetail.parse(detail);
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
    const { user, label } = await personAndPasskey(ctx, RemoveApproverDetail.parse(detail));

    return `Stop ${user.displayName}'s passkey "${label}" from approving`;
  },
  async describe(ctx, _approval, detail) {
    const removed = RemoveApproverDetail.parse(detail);
    const { user, label } = await personAndPasskey(ctx, removed);

    return {
      kind: "remove-approver",
      user,
      credentialId: removed.credentialId,
      passkeyLabel: label,
    };
  },
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization, detail) {
    const { credentialId, userId, afterwards, revokeSignIn } = RemoveApproverDetail.parse(detail);

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

      // Only now did the signer stop accepting this passkey here; once it approves nowhere, a
      // passkey the person removed stops signing in too.
      if (revokeSignIn === true) await revokeSignInOnceUnused(ctx, tx, credentialId);

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

      const [current] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(membership);

      if (!current) return;

      if (current.role === "owner") {
        // Another owner may have been removed while this request waited. The passkey is gone at
        // the signer either way; the workspace keeps this person as its owner.
        if (!(await anotherOwnerRemains(tx, approval.workspaceId, userId))) {
          await appendAudit(
            ctx,
            {
              workspaceId: approval.workspaceId,
              actor: systemActor,
              action: "member.kept_last_owner",
              subject: { type: "user", id: userId },
              detail: { approvalId: approval.id },
            },
            tx,
          );

          return;
        }

        await dropInvitesOf(tx, approval.workspaceId, userId);
      }

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
    const { credentialId } = RemoveApproverDetail.parse(detail);
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
    const { policy } = SetPolicyDetail.parse(detail);
    const { wallet } = await loadWallet(ctx, approval.workspaceId, policy.walletId);

    return `Set revision ${policy.revision} of the policy of ${wallet.label}`;
  },
  async describe(ctx, approval, detail) {
    const { policy } = SetPolicyDetail.parse(detail);
    const { wallet, agentId } = await loadWallet(ctx, approval.workspaceId, policy.walletId);

    return {
      kind: "set-policy",
      wallet: walletSummary(wallet, agentId),
      current: wallet.policy,
      proposed: policy,
    };
  },
  async confirmationSubject(_ctx, _approval, detail) {
    return { kind: "set-policy", policy: SetPolicyDetail.parse(detail).policy };
  },
  async execute(ctx, approval, authorization, detail) {
    const { policy } = SetPolicyDetail.parse(detail);

    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.setPolicy(policy.walletId, { policy, authorization }));
    }

    const hash = policyHash(policy);

    const applied = await ctx.db.transaction(async (tx) => {
      // Only move the mirror forward from the policy this one replaces. A step that runs late,
      // after a newer policy was mirrored, must not put the older one back.
      const changed = await tx
        .update(wallets)
        .set({ policy, policyHash: hash })
        // IS NOT DISTINCT FROM, because a wallet's first policy replaces NULL.
        .where(
          and(
            eq(wallets.id, policy.walletId),
            sql`${wallets.policyHash} IS NOT DISTINCT FROM ${policy.previousHash}`,
          ),
        )
        .returning({ id: wallets.id });

      if (changed.length === 0) return false;
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

      return true;
    });

    const state = await atSigner(() => ctx.signer.getWallet(policy.walletId));
    // A new policy makes a held wallet (its retirement cancelled) active again.
    await mirrorWallet(ctx.db, state);

    if (applied) return;
    // The mirror had moved on (or was never this policy's predecessor): copy what the signer
    // enforces now.
    await ctx.db
      .update(wallets)
      .set({ policy: state.policy, policyHash: state.policyHash })
      .where(eq(wallets.id, policy.walletId));
  },
};

async function workspaceRow(ctx: AppContext, workspaceId: WorkspaceId) {
  const [row] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  return row;
}

const setAdminThreshold: ApprovalKindHandler<"set-admin-threshold"> = {
  kind: "set-admin-threshold",
  async title(_ctx, approval) {
    const envelope = envelopeOf(approval, "set-admin-threshold");

    return `Require ${envelope.adminThreshold} approvals for changes to approvers and policies`;
  },
  async describe(ctx, approval) {
    const envelope = envelopeOf(approval, "set-admin-threshold");

    const workspace = await workspaceRow(ctx, approval.workspaceId);

    return {
      kind: "set-admin-threshold",
      current: workspace?.adminThreshold ?? 1,
      proposed: envelope.adminThreshold,
    };
  },
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization) {
    const envelope = envelopeOf(approval, "set-admin-threshold");

    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.setAdminThreshold(approval.workspaceId, authorization));
    }

    // Mirror what the signer holds now, not what this request asked for: a late re-run after a
    // newer change must not bring the old value back.
    const state = await atSigner(() => ctx.signer.getWorkspace(approval.workspaceId));
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ adminThreshold: state.adminThreshold })
        .where(
          and(
            eq(workspaces.id, approval.workspaceId),
            ne(workspaces.adminThreshold, state.adminThreshold),
          ),
        )
        .returning({ id: workspaces.id });

      if (changed.length === 0 || state.adminThreshold !== envelope.adminThreshold) return;
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
  confirmationSubject: envelopeOnly,
  async execute(ctx, approval, authorization) {
    if (!(await alreadyApplied(ctx, approval.id))) {
      await atSigner(() => ctx.signer.resumeWorkspace(approval.workspaceId, authorization));
    }

    // Mirror the signer's flag now: if someone paused again after this resume, a late re-run
    // must not show the workspace as running.
    const state = await atSigner(() => ctx.signer.getWorkspace(approval.workspaceId));
    await ctx.db.transaction(async (tx) => {
      const changed = await tx
        .update(workspaces)
        .set({ paused: state.paused })
        .where(and(eq(workspaces.id, approval.workspaceId), ne(workspaces.paused, state.paused)))
        .returning({ id: workspaces.id });

      if (changed.length === 0 || state.paused) return;
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
