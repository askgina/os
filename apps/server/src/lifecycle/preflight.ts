import type { AssetBalance, DeletionBlocker, DeletionPreflight } from "@askgina/os-api";
import type { AssetRef, ChainId, WorkspaceId } from "@askgina/os-protocol";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { agents, wallets } from "../db/schema.ts";
import { walletSummary } from "../directory/views.ts";
import { fromSignerError } from "../http/errors.ts";
import {
  hasUnfinishedRuns,
  hasUnminedTransactions,
  type Subject,
  waitingRequests,
} from "./state.ts";

/**
 * Slack added to the earliest destroy time offered, for the time between reading it and asking:
 * the signer counts the delay from when the request is opened.
 */
const EARLIEST_SLACK_SECONDS = 60;

/**
 * Advisory, for the person about to delete the workspace: each wallet's balances as this server
 * reads them (the native coin of every configured chain and every asset its policy lists), and
 * what would lose something or make the deletion wait. The signer cannot see balances; a
 * wallet's are null when they could not be read. A destroyed wallet is not listed.
 */
export async function deletionPreflight(
  ctx: AppContext,
  workspaceId: WorkspaceId,
): Promise<DeletionPreflight> {
  const state = await ctx.signer.getWorkspace(workspaceId).catch((cause: unknown) => {
    throw fromSignerError(cause);
  });

  const rows = await ctx.db
    .select({ wallet: wallets, agentId: agents.id })
    .from(wallets)
    .leftJoin(agents, eq(agents.walletId, wallets.id))
    .where(eq(wallets.workspaceId, workspaceId))
    .orderBy(asc(wallets.createdAt));

  const chains = ctx.chains.list().map((chain) => chain.chainId);

  const listed = await Promise.all(
    rows
      .filter(({ wallet }) => wallet.lifecycle !== "destroyed")
      .map(async ({ wallet, agentId }) => {
        const assets = new Map<string, { chainId: ChainId; asset: AssetRef }>();

        for (const chainId of chains) assets.set(`${chainId}/native`, { chainId, asset: "native" });

        for (const limit of wallet.policy?.assets ?? []) {
          if (!chains.includes(limit.chainId)) continue;
          assets.set(`${limit.chainId}/${limit.asset}`, {
            chainId: limit.chainId,
            asset: limit.asset,
          });
        }

        const balances: AssetBalance[] | null = await ctx.chains
          .balances(wallet.address, [...assets.values()])
          .catch(() => null);

        return { wallet: walletSummary(wallet, agentId), balances };
      }),
  );

  const subject: Subject = { workspaceId, walletId: null };
  const blockers: DeletionBlocker[] = [];

  if ((await waitingRequests(ctx, subject)).length > 0) blockers.push("pending_approvals");

  if (await hasUnfinishedRuns(ctx, subject, false)) blockers.push("unfinished_runs");

  if (await hasUnminedTransactions(ctx, subject)) blockers.push("unmined_transactions");

  if (listed.some(({ balances }) => balances?.some((balance) => BigInt(balance.amount) > 0n))) {
    blockers.push("nonzero_balance");
  }

  return {
    workspaceId,
    source: "control-plane",
    wallets: listed,
    blockers,
    minDestroyDelaySeconds: state.minDestroyDelaySeconds,
    earliestDestroyAfter: ctx.now() + state.minDestroyDelaySeconds + EARLIEST_SLACK_SECONDS,
  };
}
