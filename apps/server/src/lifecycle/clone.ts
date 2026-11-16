import type {
  ApprovalSummary,
  CloneOptions,
  CloneResult,
  TemplateWalletRef,
  WorkspaceTemplate,
} from "@askgina/os-api";
import { type AgentId, canonicalJson, type WalletId, type WorkspaceId } from "@askgina/os-protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appendAudit } from "../audit.ts";
import type { AppContext, Session } from "../context.ts";
import { users, workspaces } from "../db/schema.ts";
import {
  createAgentIn,
  createInviteIn,
  createTreasuryIn,
  createWorkspaceFor,
  openPolicyRequest,
} from "../directory/routes.ts";
import { HttpError } from "../http/errors.ts";
import { sha256Hex } from "../identity/secrets.ts";
import { instantiatePolicy, toTemplate } from "./template.ts";

export type CloneInput = CloneOptions &
  ({ sourceId: WorkspaceId } | { template: WorkspaceTemplate });

/**
 * Make a new workspace from a template: through the existing directory paths, so the person
 * cloning is its first member, owner and approver at the signer; a new treasury and new agents
 * (new keys, new addresses, new tokens shown once); one `set-policy` request per wallet with a
 * policy, for the new workspace's approvers to approve on the confirmation page; the notification
 * content level; and, for members this installation knows, invite links with their roles. No
 * key, mandate, intent, approval, transaction, audit entry or workflow run of a source is
 * carried over. The template's admin threshold is returned as a reminder, not applied: it cannot
 * exceed the number of approvers, who are one person until others join.
 *
 * Refused with `invalid_request` before anything is created when a policy names a chain that is
 * not configured here.
 */
export async function cloneWorkspace(
  ctx: AppContext,
  session: Session,
  input: CloneInput,
): Promise<Omit<CloneResult, "workspace"> & { workspaceId: WorkspaceId }> {
  const template = "sourceId" in input ? await toTemplate(ctx, input.sourceId) : input.template;

  const created = template.wallets.filter(
    (wallet) => wallet.kind === "treasury" || input.includeAgents,
  );

  const configured = new Set<string>(ctx.chains.list().map((chain) => chain.chainId));

  for (const { policy, ref } of created) {
    const chains = policy ? [...policy.chains, ...policy.assets.map((limit) => limit.chainId)] : [];

    if (chains.some((chainId) => !configured.has(chainId))) {
      throw new HttpError(
        "invalid_request",
        `template.wallets: the policy of ${ref} names a chain that is not configured here`,
      );
    }
  }

  const workspaceId = await createWorkspaceFor(ctx, session, input.name);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ notificationDetail: template.notificationDetail })
      .where(eq(workspaces.id, workspaceId));
    await appendAudit(
      ctx,
      {
        workspaceId,
        actor: { type: "user", id: session.user.id },
        action: "workspace.cloned",
        subject: { type: "workspace", id: workspaceId },
        detail: {
          source:
            "sourceId" in input
              ? { workspaceId: input.sourceId }
              : { templateDigest: sha256Hex(canonicalJson(template)) },
          notificationDetail: template.notificationDetail,
          templateAdminThreshold: template.adminThreshold,
          includeAgents: input.includeAgents,
          includeMembers: input.includeMembers,
        },
      },
      tx,
    );
  });

  const walletOf = new Map<TemplateWalletRef, WalletId>();
  const agentOf = new Map<TemplateWalletRef, AgentId>();
  const agents: CloneResult["agents"] = [];

  for (const wallet of created) {
    if (wallet.agent === null) {
      walletOf.set(
        wallet.ref,
        (await createTreasuryIn(ctx, session, workspaceId, wallet.label)).id,
      );
      continue;
    }

    const made = await createAgentIn(ctx, session, workspaceId, wallet.agent.name);
    walletOf.set(wallet.ref, made.wallet.id);
    agentOf.set(wallet.ref, made.agent.id);
    agents.push({
      agentId: made.agent.id,
      walletId: made.wallet.id,
      token: made.token,
      mcpUrl: made.mcpUrl,
    });
  }

  const [workspace] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  const adminThreshold = workspace?.adminThreshold ?? 1;
  const approvals: ApprovalSummary[] = [];

  for (const wallet of created) {
    const walletId = walletOf.get(wallet.ref);

    if (wallet.policy === null || walletId === undefined) continue;
    const draft = instantiatePolicy(wallet.policy, { agents: agentOf, adminThreshold });
    approvals.push(await openPolicyRequest(ctx, session, workspaceId, walletId, draft));
  }

  const invites: CloneResult["invites"] = [];
  const others = template.members.filter((member) => member.userId !== session.user.id);

  if (input.includeMembers && others.length > 0) {
    // A template from another installation names people unknown here, and one made before a
    // person was erased names someone who no longer exists: both are dropped.
    const known = await ctx.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(
        and(
          inArray(
            users.id,
            others.map((member) => member.userId),
          ),
          isNull(users.erasedAt),
        ),
      );

    const nameOf = new Map(known.map((user) => [user.id, user.displayName]));

    for (const member of others) {
      const displayName = nameOf.get(member.userId);

      if (displayName === undefined) continue;
      const invite = await createInviteIn(ctx, session, workspaceId, member.role);
      invites.push({
        userId: member.userId,
        displayName,
        role: member.role,
        url: invite.url,
        expiresAt: invite.expiresAt,
      });
    }
  }

  ctx.log.info("workspace cloned", {
    event: "workspace.cloned",
    workspaceId,
    wallets: walletOf.size,
    approvals: approvals.length,
    invites: invites.length,
  });

  return {
    workspaceId,
    approvals,
    agents,
    invites,
    templateAdminThreshold: template.adminThreshold,
  };
}
