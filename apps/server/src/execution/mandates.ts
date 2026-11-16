import type {
  ApprovalSummary,
  MandateAssetView,
  MandateDraft,
  MandateEndedReason,
  MandateSummary,
  MandateUsageSummary,
  UserSummary,
} from "@askgina/os-api";
import {
  type AgentId,
  type AssetRef,
  type ChainId,
  checkMandateAgainstPolicy,
  evaluateMandate,
  type Intent,
  Mandate,
  type MandateDenyCode,
  MandateId,
  type MandateUsage,
  mandateHash,
  mandateTimeState,
  mandateWorstCase,
  newId,
  normalizeMandate,
  PROTOCOL_VERSION,
  type UserId,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { type MandateState, SignerError } from "@askgina/os-protocol/signer";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ApprovalFailure, type ApprovalKindHandler } from "../approvals/kinds.ts";
import { type AuditInput, appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  agents,
  approvalAssertions,
  approvals,
  mandates,
  users,
  wallets,
  workspaces,
} from "../db/schema.ts";
import { loadWallet, walletSummary } from "../directory/views.ts";
import { HttpError } from "../http/errors.ts";
import { engineOf } from "./approvals.ts";
import { chainAccess } from "./chains.ts";

/**
 * Mandates: people approve once, at the admin threshold, a bounded series of one agent's
 * transfers, which the signer then signs with no person asked (`specs/approval-mandates.md`).
 * The signer holds every mandate, counts every use and decides; this control plane opens the
 * `grant-mandate` request, keeps a sealed mirror (`mandates`) to find the mandates an agent may
 * use, routes covered proposals to them, and revokes. The signer also ends mandates on its own
 * (a grantor's passkey removed, the restore fence, the operator), so the mirror is refreshed
 * from the signer whenever a mandate is used or shown.
 */

export type MandateRow = typeof mandates.$inferSelect;

/**
 * What `grant-mandate` keeps sealed in its approval's detail. The mandate was sealed as
 * `normalizeMandate` returned it, a Mandate the schema parsed, so parsing it again changes
 * nothing that is hashed or sent.
 */
const GrantDetail = z.object({ mandate: Mandate });

type GrantDetail = z.infer<typeof GrantDetail>;

/** The mirror's status for one state the signer reported. */
type Mirror = { status: "active" | "ended"; endedReason: MandateEndedReason | null };

const PAGE_SIZE = 50;

const mandateLocation = (id: string) => `mandates.mandate:${id}`;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const systemActor = { type: "system", id: null } as const;

/** Ask the signer something while serving a request; an unreachable signer is `internal`. */
async function fromSigner<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new HttpError(
      "internal",
      "the signer could not be reached",
      error instanceof SignerError ? error.code : undefined,
    );
  }
}

/**
 * Run a call at the signer inside a workflow step. A refusal for a reason that will not change
 * ends the request as failed, with the grant-time reason for `mandate_invalid`; transport errors
 * and the signer's own internal errors are retried.
 */
async function atSigner<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SignerError && error.code !== "internal" && error.code !== "vault_error") {
      throw new ApprovalFailure(
        error.code === "mandate_invalid" && error.detail ? error.detail : error.code,
        "the signer refused this mandate",
      );
    }

    throw error;
  }
}

/** The mirror's status for a state the signer reported. */
function mirrorOf(state: MandateState): Mirror {
  switch (state.status) {
    case "active":
    case "not_yet_valid":
      return { status: "active", endedReason: null };
    case "expired":
    case "exhausted":
      return { status: "ended", endedReason: state.status };
    case "revoked":
      return {
        status: "ended",
        endedReason:
          state.revokedReason === "requested" ? "revoked" : (state.revokedReason ?? "revoked"),
      };
  }
}

/**
 * Record that a mandate ended, the first time only: the reason first seen stays. True when this
 * call ended it.
 */
async function endMirror(
  ctx: AppContext,
  row: Pick<MandateRow, "id" | "workspaceId">,
  reason: MandateEndedReason,
  actor: AuditInput["actor"] = systemActor,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const ended = await tx
      .update(mandates)
      .set({ status: "ended", endedReason: reason, updatedAt: new Date(ctx.now() * 1000) })
      .where(and(eq(mandates.id, row.id), eq(mandates.status, "active")))
      .returning({ id: mandates.id });

    if (ended.length === 0) return false;
    await appendAudit(
      ctx,
      {
        workspaceId: row.workspaceId,
        actor,
        action:
          reason === "revoked" || reason === "agent_disabled" ? "mandate.revoked" : "mandate.ended",
        subject: { type: "mandate", id: row.id },
        detail: { reason },
      },
      tx,
    );

    return true;
  });
}

/**
 * The mandate as the signer holds it now, with the mirror brought up to date. Null when the
 * signer does not hold it at all, which happens only after its volume was restored from a
 * backup older than the grant: the mandate can never sign there, so the mirror ends it.
 */
async function refresh(
  ctx: AppContext,
  row: MandateRow,
): Promise<{ row: MandateRow; state: MandateState | null }> {
  let state: MandateState | null;

  try {
    state = await ctx.signer.getMandate(row.id);
  } catch (error) {
    if (!(error instanceof SignerError && error.code === "not_found")) {
      throw new HttpError(
        "internal",
        "the signer could not be reached",
        error instanceof SignerError ? error.code : undefined,
      );
    }

    state = null;
  }

  const mirror =
    state === null
      ? { status: "ended" as const, endedReason: "operator" as const }
      : mirrorOf(state);

  if (row.status === "active" && mirror.endedReason !== null) {
    await endMirror(ctx, row, mirror.endedReason);
    const [current] = await ctx.db.select().from(mandates).where(eq(mandates.id, row.id));

    return { row: current ?? row, state };
  }

  return { row, state };
}

/** The signer's count, as `evaluateMandate` reads it. */
function usageOf(state: MandateState): MandateUsage {
  const find = (chainId: ChainId, asset: AssetRef) =>
    state.usage.assets.find((entry) => entry.chainId === chainId && entry.asset === asset);

  return {
    uses: state.usage.uses,
    total: (chainId, asset) => BigInt(find(chainId, asset)?.total ?? "0"),
    inWindow: (chainId, asset) => BigInt(find(chainId, asset)?.inWindow ?? "0"),
  };
}

/**
 * Why this mandate does not cover the intent now, with the code the signer would give, or null
 * when it does. The signer decides again, with its own clock and counts, when it signs.
 */
function refusalOf(
  state: MandateState | null,
  intent: Intent,
  adminThreshold: number,
  now: number,
): MandateDenyCode | "mandate_revoked" | "mandate_not_yet_valid" | "mandate_expired" | null {
  if (state === null || state.status === "revoked") return "mandate_revoked";
  const time = mandateTimeState(state.mandate, now);

  if (time === "not_yet_valid") return "mandate_not_yet_valid";

  if (time === "expired") return "mandate_expired";

  // Raising the admin threshold above the people who granted it stops it at the signer.
  if (state.grantedBy.length < adminThreshold) return "mandate_grant_below_threshold";
  const decision = evaluateMandate(state.mandate, intent, usageOf(state));

  return decision.allowed ? null : decision.code;
}

/**
 * The mandate that covers an agent's intent, or null when none does and people must approve it.
 * With `pinned`, only that mandate of this agent is considered, and one that does not cover the
 * intent is refused here (`policy_denied` with the reason) so nothing is recorded. Otherwise the
 * agent's live mandates on the wallet are tried in order of `notAfter`, then id, and the first
 * that covers it wins. Each is read from the signer first, so a mandate the signer ended is
 * skipped and its mirror ends too.
 *
 * Two proposals racing for the last of a budget can both be routed here; the signer signs one
 * and refuses the other with its counter code, and that intent ends `denied`.
 */
export async function findCoveringMandate(
  ctx: AppContext,
  agent: { id: AgentId; workspaceId: WorkspaceId },
  walletId: WalletId,
  intent: Intent,
  pinned?: MandateId,
): Promise<MandateId | null> {
  // No contract call is ever signed under a mandate.
  if (pinned === undefined && intent.operation.type === "evm.call") return null;
  const conditions = [eq(mandates.workspaceId, agent.workspaceId), eq(mandates.agentId, agent.id)];

  if (pinned === undefined) {
    conditions.push(eq(mandates.walletId, walletId), eq(mandates.status, "active"));
  } else {
    conditions.push(eq(mandates.id, pinned));
  }

  const rows = await ctx.db
    .select()
    .from(mandates)
    .where(and(...conditions))
    .orderBy(asc(mandates.notAfter), asc(mandates.id));

  // Another agent's mandate looks exactly like one that does not exist.
  if (pinned !== undefined && rows.length === 0) {
    throw new HttpError("not_found", "no such mandate");
  }

  if (rows.length === 0) return null;

  const [workspace] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId));

  if (!workspace) throw new HttpError("not_found", "no such workspace");
  const refreshed = await Promise.all(rows.map((row) => refresh(ctx, row)));

  for (const { row, state } of refreshed) {
    const refusal = refusalOf(state, intent, workspace.adminThreshold, ctx.now());

    if (refusal === null) return row.id;

    if (pinned !== undefined) {
      throw new HttpError("policy_denied", "the mandate you named does not cover this", refusal);
    }
  }

  return null;
}

// --- granting ---------------------------------------------------------------------------------

/**
 * Open a `grant-mandate` request for an owner's draft. The mandate starts now and is checked
 * against the signer's copy of the wallet's policy and `MANDATE_MAX_SECONDS` first, so a draft
 * the signer would refuse is refused here with its reason; the signer's answer when people
 * grant it is final.
 */
export async function openMandateGrant(
  ctx: AppContext,
  input: { workspaceId: WorkspaceId; walletId: string; draft: MandateDraft; requestedBy: UserId },
): Promise<ApprovalSummary> {
  const { workspaceId, draft } = input;
  const { wallet } = await loadWallet(ctx, workspaceId, input.walletId);

  const [workspace] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) throw new HttpError("not_found", "no such workspace");

  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, draft.agentId), eq(agents.workspaceId, workspaceId)));

  if (!agent) throw new HttpError("invalid_request", "agentId: not an agent of this workspace");

  if (agent.status !== "active") throw new HttpError("conflict", "this agent is disabled");

  // An agent proposes from its own wallet or from a treasury; a mandate anywhere else is unusable.
  if (wallet.id !== agent.walletId && wallet.kind !== "treasury") {
    throw new HttpError("invalid_request", "agentId: this agent cannot propose from this wallet");
  }

  const chains = chainAccess(ctx);

  if (draft.assets.some((limit) => !chains.has(limit.chainId))) {
    throw new HttpError("invalid_request", "assets: a chain is not configured here");
  }

  const state = await fromSigner(() => ctx.signer.getWallet(wallet.id));

  if (state.policy === null) {
    throw new HttpError(
      "policy_denied",
      "this wallet has no approved policy yet",
      "policy_missing",
    );
  }

  const now = ctx.now();

  // Refuses a draft the protocol does not accept (for example caps out of order) with the field.
  const mandate = normalizeMandate({
    v: PROTOCOL_VERSION,
    id: newId("mnd"),
    workspaceId,
    walletId: wallet.id,
    agentId: agent.id,
    assets: draft.assets,
    windowSeconds: draft.windowSeconds,
    recipients: draft.recipients,
    maxUses: draft.maxUses,
    maxFeePerActionWei: draft.maxFeePerActionWei,
    notBefore: now,
    notAfter: draft.notAfter,
    purpose: draft.purpose,
  });

  const refusal = checkMandateAgainstPolicy(mandate, state.policy, {
    now,
    maxSeconds: ctx.config.mandateMaxSeconds,
  });

  if (refusal !== null) {
    throw new HttpError(
      "invalid_request",
      "the wallet's policy or the longest mandate life refuses this mandate",
      refusal,
    );
  }

  const hash = mandateHash(mandate);

  return ctx.approvals.open({
    workspaceId,
    kind: "grant-mandate",
    subjectId: mandate.id,
    envelope: { mandateId: mandate.id, walletId: wallet.id, agentId: agent.id, mandateHash: hash },
    threshold: workspace.adminThreshold,
    ttlSeconds: ctx.config.adminApprovalTtlSeconds,
    detail: { mandate } satisfies GrantDetail,
    requestedBy: { type: "user", id: input.requestedBy },
    alongside: (tx) =>
      appendAudit(
        ctx,
        {
          workspaceId,
          actor: { type: "user", id: input.requestedBy },
          action: "mandate.requested",
          subject: { type: "mandate", id: mandate.id },
          detail: { walletId: wallet.id, agentId: agent.id, mandateHash: hash },
        },
        tx,
      ),
  });
}

/** How one asset is shown; null parts when its chain is not configured or the token is unreadable. */
async function assetDisplay(
  ctx: AppContext,
  chainId: ChainId,
  asset: AssetRef,
): Promise<{ symbol: string | null; decimals: number | null }> {
  const chains = chainAccess(ctx);

  if (!chains.has(chainId)) return { symbol: null, decimals: null };

  if (asset === "native") return { symbol: chains.config(chainId).nativeSymbol, decimals: 18 };
  const token = await chains.token(chainId, asset).catch(() => null);

  return token
    ? { symbol: token.symbol, decimals: token.decimals }
    : { symbol: null, decimals: null };
}

/** Every asset of a mandate as a person reads it, next to the wallet policy's caps for it. */
async function assetViews(
  ctx: AppContext,
  mandate: Mandate,
  policy: WalletPolicy | null,
): Promise<MandateAssetView[]> {
  return Promise.all(
    mandateWorstCase(mandate).map(async ({ chainId, asset, amount }) => {
      const limit = policy?.assets.find(
        (candidate) => candidate.chainId === chainId && candidate.asset === asset,
      );

      return {
        chainId,
        asset,
        ...(await assetDisplay(ctx, chainId, asset)),
        worstCase: amount.toString(),
        policy: limit ? { maxPerTx: limit.maxPerTx, maxPerDay: limit.maxPerDay } : null,
      };
    }),
  );
}

function usageSummary(state: MandateState): MandateUsageSummary {
  return {
    uses: state.usage.uses,
    usesLeft: Math.max(0, state.mandate.maxUses - state.usage.uses),
    assets: state.usage.assets.map((entry) => ({
      chainId: entry.chainId,
      asset: entry.asset,
      usedTotal: entry.total,
      usedInWindow: entry.inWindow,
    })),
  };
}

async function agentName(ctx: AppContext, agentId: AgentId): Promise<string> {
  const [agent] = await ctx.db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId));

  return agent?.name ?? "";
}

const grantMandate: ApprovalKindHandler<"grant-mandate"> = {
  kind: "grant-mandate",
  async title(ctx, approval, detail) {
    const { mandate } = GrantDetail.parse(detail);
    const { wallet } = await loadWallet(ctx, approval.workspaceId, mandate.walletId);
    const payments = mandate.maxUses === 1 ? "1 payment" : `${mandate.maxUses} payments`;

    return `Let ${await agentName(ctx, mandate.agentId)} make up to ${payments} from ${wallet.label} without asking`;
  },
  async describe(ctx, approval, detail) {
    const { mandate } = GrantDetail.parse(detail);
    const { wallet, agentId } = await loadWallet(ctx, approval.workspaceId, mandate.walletId);
    const [granted] = await ctx.db.select().from(mandates).where(eq(mandates.id, mandate.id));
    const state = granted ? (await refresh(ctx, granted)).state : null;

    return {
      kind: "grant-mandate",
      wallet: walletSummary(wallet, agentId),
      agent: { id: mandate.agentId, name: await agentName(ctx, mandate.agentId) },
      mandate,
      mandateHash: mandateHash(mandate),
      assets: await assetViews(ctx, mandate, wallet.policy),
      usage: state ? usageSummary(state) : null,
    };
  },
  async confirmationSubject(_ctx, _approval, detail) {
    return { kind: "grant-mandate", mandate: GrantDetail.parse(detail).mandate };
  },
  async execute(ctx, approval, authorization, detail) {
    const { mandate } = GrantDetail.parse(detail);

    const agentActive = async () => {
      const [agent] = await ctx.db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, mandate.agentId));

      return agent?.status === "active";
    };

    // The gateway refuses a disabled agent anyway; no authority is added for one.
    if (!(await agentActive())) {
      throw new ApprovalFailure("agent_disabled", "the agent was disabled");
    }

    // A repeat of an applied grant returns the stored state, so a re-run of this step is safe.
    const state = await atSigner(() =>
      ctx.signer.grantMandate(mandate.id, { mandate, authorization }),
    );

    const mirror = mirrorOf(state);
    const at = new Date(ctx.now() * 1000);
    await ctx.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(mandates)
        .values({
          id: mandate.id,
          workspaceId: mandate.workspaceId,
          walletId: mandate.walletId,
          agentId: mandate.agentId,
          mandateHash: state.mandateHash,
          mandate: await ctx.sealer.seal(mandate.workspaceId, mandateLocation(mandate.id), mandate),
          notBefore: new Date(mandate.notBefore * 1000),
          notAfter: new Date(mandate.notAfter * 1000),
          grantApprovalId: approval.id,
          status: mirror.status,
          endedReason: mirror.endedReason,
          createdAt: new Date(state.grantedAt * 1000),
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: mandates.id });

      if (inserted.length === 0) return;
      await appendAudit(
        ctx,
        {
          workspaceId: approval.workspaceId,
          actor: systemActor,
          action: "mandate.granted",
          subject: { type: "mandate", id: mandate.id },
          detail: {
            approvalId: approval.id,
            walletId: mandate.walletId,
            agentId: mandate.agentId,
            mandateHash: state.mandateHash,
            notAfter: mandate.notAfter,
          },
        },
        tx,
      );
    });

    // Disabling the agent while the signer granted: its revocation may have listed the signer's
    // mandates just before this one existed, so it is revoked here.
    if (!(await agentActive())) {
      await revokeMandate(ctx, {
        workspaceId: approval.workspaceId,
        mandateId: mandate.id,
        reason: "agent_disabled",
        actor: systemActor,
      });
    }
  },
};

export function registerMandateKinds(ctx: AppContext): void {
  engineOf(ctx).register(grantMandate);
}

// --- revoking ---------------------------------------------------------------------------------

/**
 * End a mandate for good at the signer, then in the mirror. Needs no passkey: it only removes
 * authority. Revoking an ended mandate changes nothing at the signer; the mirror keeps the first
 * reason it saw. A mandate the signer does not hold in this workspace is `not_found`.
 */
export async function revokeMandate(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    mandateId: MandateId;
    reason: "revoked" | "agent_disabled";
    actor: AuditInput["actor"];
  },
): Promise<MandateState> {
  let state: MandateState;

  try {
    state = await ctx.signer.revokeMandate(input.mandateId, input.workspaceId);
  } catch (error) {
    if (error instanceof SignerError && error.code === "not_found") {
      throw new HttpError("not_found", "no such mandate");
    }

    throw new HttpError(
      "internal",
      "the signer could not be reached",
      error instanceof SignerError ? error.code : undefined,
    );
  }

  await endMirror(
    ctx,
    { id: input.mandateId, workspaceId: input.workspaceId },
    input.reason,
    input.actor,
  );

  return state;
}

/**
 * Revoke every mandate of an agent, when it is disabled. Grants still waiting for approval are
 * cancelled. The signer has no route per agent, so every wallet the agent could hold a mandate
 * on (its own and the workspace's treasury) is listed at the signer, which also catches a
 * mandate the mirror missed; then every mirror row of the agent ends. Returns how many mandates
 * the signer revoked.
 */
export async function revokeAgentMandates(
  ctx: AppContext,
  agent: { id: AgentId; workspaceId: WorkspaceId; walletId: WalletId },
  actor: AuditInput["actor"],
): Promise<number> {
  const waiting = await ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, agent.workspaceId),
        eq(approvals.kind, "grant-mandate"),
        eq(approvals.status, "pending"),
        sql`${approvals.envelope}->>'agentId' = ${agent.id}`,
      ),
    );

  for (const grant of waiting) await ctx.approvals.cancel(grant.id);

  const treasuries = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.workspaceId, agent.workspaceId), eq(wallets.kind, "treasury")));

  let revoked = 0;

  for (const walletId of [agent.walletId, ...treasuries.map((wallet) => wallet.id)]) {
    const { mandates: held } = await ctx.signer.listMandates(walletId);

    for (const state of held) {
      if (state.mandate.agentId !== agent.id || state.status === "revoked") continue;
      await ctx.signer.revokeMandate(state.mandate.id, agent.workspaceId);
      revoked += 1;
    }
  }

  const rows = await ctx.db
    .select({ id: mandates.id, workspaceId: mandates.workspaceId })
    .from(mandates)
    .where(and(eq(mandates.agentId, agent.id), eq(mandates.status, "active")));

  for (const row of rows) await endMirror(ctx, row, "agent_disabled", actor);

  return revoked;
}

/**
 * End the mirror of every live mandate of one wallet, or of the whole workspace when `walletId`
 * is null, once a retirement or deletion was applied: the signer revoked them in that same step
 * (reason `requested`, shown as `revoked`). Returns how many this call ended.
 */
export async function endMandateMirrors(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  walletId: WalletId | null,
): Promise<number> {
  const rows = await ctx.db
    .select({ id: mandates.id, workspaceId: mandates.workspaceId })
    .from(mandates)
    .where(
      and(
        eq(mandates.workspaceId, workspaceId),
        eq(mandates.status, "active"),
        walletId === null ? undefined : eq(mandates.walletId, walletId),
      ),
    );

  let ended = 0;

  for (const row of rows) if (await endMirror(ctx, row, "revoked")) ended += 1;

  return ended;
}

// --- reading ----------------------------------------------------------------------------------

/** A mandate of the workspace, as the signer holds it now, or `not_found`. */
export async function loadMandate(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  mandateId: string,
): Promise<{ row: MandateRow; state: MandateState | null }> {
  // A string that is no mandate id names no mandate, and is refused as one that does not exist.
  const id = MandateId.safeParse(mandateId);

  if (!id.success) throw new HttpError("not_found", "no such mandate");

  const [row] = await ctx.db
    .select()
    .from(mandates)
    .where(and(eq(mandates.id, id.data), eq(mandates.workspaceId, workspaceId)));

  if (!row) throw new HttpError("not_found", "no such mandate");

  return refresh(ctx, row);
}

/** The mandate as people granted it, opened from this control plane's mirror. */
export async function openMandate(
  ctx: Pick<AppContext, "sealer">,
  row: MandateRow,
): Promise<Mandate> {
  return Mandate.parse(
    await ctx.sealer.open(row.workspaceId, mandateLocation(row.id), row.mandate),
  );
}

/** A mandate as a person reads it. `row` and `state` come from {@link loadMandate}. */
export async function mandateSummary(
  ctx: AppContext,
  row: MandateRow,
  state: MandateState | null,
): Promise<MandateSummary> {
  const [sealed, [wallet], grantedBy] = await Promise.all([
    ctx.sealer.open(row.workspaceId, mandateLocation(row.id), row.mandate),
    ctx.db.select({ policy: wallets.policy }).from(wallets).where(eq(wallets.id, row.walletId)),
    ctx.db
      .select({ id: users.id, displayName: users.displayName })
      .from(approvalAssertions)
      .innerJoin(users, eq(users.id, approvalAssertions.userId))
      .where(eq(approvalAssertions.approvalId, row.grantApprovalId))
      .orderBy(asc(approvalAssertions.createdAt)),
  ]);

  const mandate = Mandate.parse(sealed);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    walletId: row.walletId,
    agent: { id: row.agentId, name: await agentName(ctx, row.agentId) },
    mandate,
    mandateHash: row.mandateHash,
    // The signer no longer holding it means it can never sign again, as if revoked.
    status: state?.status ?? "revoked",
    endedReason: row.status === "ended" ? row.endedReason : null,
    grantApprovalId: row.grantApprovalId,
    grantedAt: state?.grantedAt ?? seconds(row.createdAt),
    grantedBy: grantedBy satisfies UserSummary[],
    revokedAt: state?.revokedAt ?? null,
    assets: await assetViews(ctx, mandate, wallet?.policy ?? null),
    usage: state ? usageSummary(state) : null,
  };
}

/**
 * A page of the workspace's mandates, newest first. Every mandate the mirror still calls active
 * among the filtered ones is read from the signer first, so `status` filters on what the signer
 * holds now.
 */
export async function listMandates(
  ctx: AppContext,
  workspaceId: WorkspaceId,
  filter: {
    walletId?: WalletId | undefined;
    agentId?: AgentId | undefined;
    status?: "active" | "ended" | undefined;
    cursor?: string | undefined;
  },
): Promise<{ items: MandateSummary[]; nextCursor: string | null }> {
  const scope = [eq(mandates.workspaceId, workspaceId)];

  if (filter.walletId !== undefined) scope.push(eq(mandates.walletId, filter.walletId));

  if (filter.agentId !== undefined) scope.push(eq(mandates.agentId, filter.agentId));

  const live = await ctx.db
    .select()
    .from(mandates)
    .where(and(...scope, eq(mandates.status, "active")));

  const refreshed = await Promise.all(live.map((row) => refresh(ctx, row)));

  const states = new Map<MandateId, MandateState | null>(
    refreshed.map(({ row, state }) => [row.id, state]),
  );

  const conditions = [...scope];

  if (filter.status !== undefined) conditions.push(eq(mandates.status, filter.status));

  if (filter.cursor !== undefined) {
    const [at, id] = Buffer.from(filter.cursor, "base64url").toString("utf8").split("|");
    const time = Number(at);

    if (!id || !Number.isSafeInteger(time)) {
      throw new HttpError("invalid_request", "cursor: not a cursor from this list");
    }

    // SAFETY: the cursor's id is only compared with `<` against mandates.id to order the page;
    // any string orders, and one that names no mandate still starts the page there.
    const before = or(
      lt(mandates.createdAt, new Date(time)),
      and(eq(mandates.createdAt, new Date(time)), lt(mandates.id, id as MandateId)),
    );

    if (before) conditions.push(before);
  }

  const rows = await ctx.db
    .select()
    .from(mandates)
    .where(and(...conditions))
    .orderBy(desc(mandates.createdAt), desc(mandates.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);

  const items = await Promise.all(
    page.map(async (row) => {
      if (states.has(row.id)) return mandateSummary(ctx, row, states.get(row.id) ?? null);
      const loaded = await refresh(ctx, row);

      return mandateSummary(ctx, loaded.row, loaded.state);
    }),
  );

  return {
    items,
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? Buffer.from(`${last.createdAt.getTime()}|${last.id}`).toString("base64url")
        : null,
  };
}

/**
 * The agent's mandates that can sign now, as the signer holds them, for `whoami`. Ordered as
 * proposals try them: by `notAfter`, then id.
 */
export async function activeMandatesOf(
  ctx: AppContext,
  agent: { id: AgentId; workspaceId: WorkspaceId },
  walletIds: readonly WalletId[],
): Promise<MandateState[]> {
  if (walletIds.length === 0) return [];

  const rows = await ctx.db
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.workspaceId, agent.workspaceId),
        eq(mandates.agentId, agent.id),
        eq(mandates.status, "active"),
        inArray(mandates.walletId, [...walletIds]),
      ),
    )
    .orderBy(asc(mandates.notAfter), asc(mandates.id));

  const refreshed = await Promise.all(rows.map((row) => refresh(ctx, row)));

  return refreshed.flatMap(({ state }) =>
    state !== null && state.status === "active" ? [state] : [],
  );
}
