import {
  type PolicyDraft,
  type PolicyTemplate,
  type TemplateWalletRef,
  WorkspaceTemplate,
} from "@askgina/os-api";
import type { AgentId, WalletPolicy, WorkspaceId } from "@askgina/os-protocol";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import {
  agents,
  memberships,
  type WalletLifecycleColumn,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";

/** A wallet whose key is being destroyed, or is gone, has no configuration worth carrying. */
const ENDING: Partial<Record<WalletLifecycleColumn, true>> = { retiring: true, destroyed: true };

/** A policy without its ids, revision and hash chain; requesters become template wallet refs. */
function policyTemplate(
  policy: WalletPolicy,
  refOfAgent: ReadonlyMap<AgentId, TemplateWalletRef>,
): PolicyTemplate {
  const template: PolicyTemplate = {
    chains: [...policy.chains],
    // An agent left out of the template (disabled) is dropped from every requester list.
    requesters: policy.requesters.flatMap((agentId) => {
      const ref = refOfAgent.get(agentId);

      return ref === undefined ? [] : [ref];
    }),
    assets: policy.assets.map((limit) => ({
      chainId: limit.chainId,
      asset: limit.asset,
      maxPerTx: limit.maxPerTx,
      maxPerDay: limit.maxPerDay,
    })),
    recipients: policy.recipients,
    contractCalls: policy.contractCalls,
    fees: { maxPerTxWei: policy.fees.maxPerTxWei },
    approvals: { threshold: policy.approvals.threshold, ttlSeconds: policy.approvals.ttlSeconds },
  };

  // A policy without venue rules has no `venues` key at all, as in the policy itself.
  if (policy.venues !== undefined) template.venues = policy.venues;

  return template;
}

/**
 * A workspace's configuration as a template: its name, admin threshold, notification
 * content level, members and roles, and per wallet its kind, label, agent name and policy (the
 * policy the control plane mirrors from the signer). No key, address, token, mandate or history.
 * Wallets that are retiring or destroyed and agents that are disabled are left out.
 */
export async function toTemplate(
  ctx: AppContext,
  workspaceId: WorkspaceId,
): Promise<WorkspaceTemplate> {
  const [workspace] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

  if (!workspace) throw new HttpError("not_found", "no such workspace");

  const walletRows = await ctx.db
    .select()
    .from(wallets)
    .where(eq(wallets.workspaceId, workspaceId))
    .orderBy(asc(wallets.createdAt), asc(wallets.id));

  const agentRows = await ctx.db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
  const agentOfWallet = new Map(agentRows.map((agent) => [agent.walletId, agent]));

  const kept = walletRows.filter((wallet) => {
    if (ENDING[wallet.lifecycle]) return false;

    if (wallet.kind === "treasury") return true;

    return agentOfWallet.get(wallet.id)?.status === "active";
  });

  const refOfWallet = new Map(kept.map((wallet, index) => [wallet.id, `w${index + 1}`]));
  const refOfAgent = new Map<AgentId, TemplateWalletRef>();

  for (const wallet of kept) {
    const agent = agentOfWallet.get(wallet.id);
    const ref = refOfWallet.get(wallet.id);

    if (agent && ref) refOfAgent.set(agent.id, ref);
  }

  const members = await ctx.db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.userId));

  return WorkspaceTemplate.parse({
    format: "askgina.os/workspace-template/v1",
    name: workspace.name,
    adminThreshold: workspace.adminThreshold,
    notificationDetail: workspace.notificationDetail,
    wallets: kept.map((wallet) => {
      const agent = agentOfWallet.get(wallet.id);

      return {
        ref: refOfWallet.get(wallet.id),
        kind: wallet.kind,
        label: wallet.label,
        agent: wallet.kind === "agent" && agent ? { name: agent.name } : null,
        policy: wallet.policy === null ? null : policyTemplate(wallet.policy, refOfAgent),
      };
    }),
    members,
  });
}

/**
 * The draft a clone proposes for one of its wallets: requesters become the clone's agents (a
 * ref with no agent in the clone is dropped), and the approval threshold is at most the clone's
 * admin threshold, which a policy may not exceed. The shared policy path fills in the new ids,
 * revision 1 and no previous hash.
 */
export function instantiatePolicy(
  policy: PolicyTemplate,
  ids: { agents: ReadonlyMap<TemplateWalletRef, AgentId>; adminThreshold: number },
): PolicyDraft {
  return {
    ...policy,
    requesters: policy.requesters.flatMap((ref) => {
      const agentId = ids.agents.get(ref);

      return agentId === undefined ? [] : [agentId];
    }),
    approvals: {
      threshold: Math.min(policy.approvals.threshold, ids.adminThreshold),
      ttlSeconds: policy.approvals.ttlSeconds,
    },
  };
}
