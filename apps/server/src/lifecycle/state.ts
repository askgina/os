import type { ApprovalId, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { SignerError, type WalletState, type WorkspaceState } from "@askgina/os-protocol/signer";
import { and, eq, inArray, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext, Executor } from "../context.ts";
import { approvals, mandates, transactions, wallets, workspaces } from "../db/schema.ts";

const at = (epochSeconds: number | null) =>
  epochSeconds === null ? null : new Date(epochSeconds * 1000);

/**
 * Mirror the signer's lifecycle of one wallet. True when the mirror changed, so the caller
 * records the change once even when a step runs twice.
 */
export async function mirrorWallet(tx: Executor, state: WalletState): Promise<boolean> {
  const destroyAfter = at(state.destroyAfter);

  const changed = await tx
    .update(wallets)
    .set({ lifecycle: state.state, destroyAfter })
    .where(
      and(
        eq(wallets.id, state.walletId),
        or(
          ne(wallets.lifecycle, state.state),
          sql`${wallets.destroyAfter} IS DISTINCT FROM ${destroyAfter}`,
        ),
      ),
    )
    .returning({ id: wallets.id });

  return changed.length > 0;
}

/**
 * Mirror the signer's lifecycle and pause flag of a workspace, never moving a `deleted`
 * tombstone back. True when the mirror changed.
 */
export async function mirrorWorkspace(tx: Executor, state: WorkspaceState): Promise<boolean> {
  const destroyAfter = at(state.destroyAfter);
  // The control plane alone finishes a deletion (its tombstone); the signer's `deleted` is
  // mirrored by the finalize step, not here.
  const lifecycle = state.state === "deleted" ? "deleting" : state.state;

  const changed = await tx
    .update(workspaces)
    .set({ lifecycle, destroyAfter, paused: state.paused })
    .where(
      and(
        eq(workspaces.id, state.workspaceId),
        ne(workspaces.lifecycle, "deleted"),
        or(
          ne(workspaces.lifecycle, lifecycle),
          ne(workspaces.paused, state.paused),
          sql`${workspaces.destroyAfter} IS DISTINCT FROM ${destroyAfter}`,
        ),
      ),
    )
    .returning({ id: workspaces.id });

  return changed.length > 0;
}

/**
 * What a retirement or deletion is about: one wallet of a workspace, or the whole workspace
 * (`walletId` null).
 */
export interface Subject {
  workspaceId: WorkspaceId;
  walletId: WalletId | null;
}

/** Rows of `approvals` about the subject: every row of the workspace, or those of one wallet. */
function aboutSubject(subject: Subject): SQL | undefined {
  const inWorkspace = eq(approvals.workspaceId, subject.workspaceId);

  if (subject.walletId === null) return inWorkspace;

  return and(
    inWorkspace,
    or(
      eq(approvals.subjectId, subject.walletId),
      sql`${approvals.envelope}->>'walletId' = ${subject.walletId}`,
      // A use of a mandate has no envelope; its mandate names the wallet.
      inArray(
        approvals.mandateId,
        sql`(SELECT ${mandates.id} FROM ${mandates} WHERE ${mandates.walletId} = ${subject.walletId})`,
      ),
    ),
  );
}

/**
 * The subject's requests still waiting for people, except the kinds in `keep` and the request
 * `except` (the retirement or deletion itself).
 */
export async function waitingRequests(
  ctx: Pick<AppContext, "db">,
  subject: Subject,
  options: { except?: ApprovalId; keep?: readonly ApprovalRow["kind"][] } = {},
): Promise<{ id: ApprovalId; workspaceId: WorkspaceId }[]> {
  return ctx.db
    .select({ id: approvals.id, workspaceId: approvals.workspaceId })
    .from(approvals)
    .where(
      and(
        aboutSubject(subject),
        eq(approvals.status, "pending"),
        options.except === undefined ? undefined : ne(approvals.id, options.except),
        options.keep === undefined || options.keep.length === 0
          ? undefined
          : notInArray(approvals.kind, [...options.keep]),
      ),
    );
}

/**
 * End waiting requests with no effect and make sure the signer never acts on them: the engine
 * cancels each (its run then abandons it, which also revokes it at the signer), and this
 * revokes it at the signer at once, so nothing depends on the run being alive. A signer that
 * cannot be reached is logged and left to the run. Returns how many this call cancelled.
 */
export async function cancelRequests(
  ctx: AppContext,
  rows: readonly { id: ApprovalId; workspaceId: WorkspaceId }[],
): Promise<number> {
  let cancelled = 0;

  for (const row of rows) {
    if (!(await ctx.approvals.cancel(row.id))) continue;
    cancelled += 1;
    await ctx.signer.revokeApproval(row.id, row.workspaceId).catch((cause: unknown) => {
      ctx.log.warn("revoking a cancelled approval failed", {
        approvalId: row.id,
        code: cause instanceof SignerError ? cause.code : "unreachable",
      });
    });
  }

  return cancelled;
}

/**
 * Whether a run of the subject is still being carried out: a request being applied (a
 * mandate's use included), one that ended without effect whose run has not seen that yet, and
 * with `waiting`, a request still waiting for people. Shredding a run's key while it still
 * runs would leave it retrying forever.
 */
export async function hasUnfinishedRuns(
  ctx: Pick<AppContext, "db">,
  subject: Subject,
  waiting: boolean,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        aboutSubject(subject),
        or(
          inArray(approvals.status, waiting ? ["pending", "approved"] : ["approved"]),
          and(
            inArray(approvals.status, ["rejected", "expired", "cancelled"]),
            eq(approvals.resumeState, "needed"),
          ),
        ),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * Whether a transaction of the subject could still be mined (D7): one on its way (`signed`,
 * `broadcast`, `stuck`), or one given up on (`rejected`) while no later transaction of its
 * wallet on its chain has used its account nonce. A destroyed key cannot replace either.
 */
export async function hasUnminedTransactions(
  ctx: Pick<AppContext, "db">,
  subject: Subject,
): Promise<boolean> {
  const ofSubject =
    subject.walletId === null
      ? inArray(
          transactions.walletId,
          sql`(SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.workspaceId} = ${subject.workspaceId})`,
        )
      : eq(transactions.walletId, subject.walletId);

  const [row] = await ctx.db
    .select({ id: transactions.approvalId })
    .from(transactions)
    .where(
      and(
        ofSubject,
        or(
          inArray(transactions.status, ["signed", "broadcast", "stuck"]),
          and(
            eq(transactions.status, "rejected"),
            sql`NOT EXISTS (
              SELECT 1 FROM ${transactions} AS later
               WHERE later.wallet_id = ${transactions.walletId}
                 AND later.chain_id = ${transactions.chainId}
                 AND later.approval_id <> ${transactions.approvalId}
                 AND later.nonce >= ${transactions.nonce}
                 AND later.status IN ('confirmed', 'reverted', 'cancelled', 'superseded'))`,
          ),
        ),
      ),
    )
    .limit(1);

  return row !== undefined;
}
