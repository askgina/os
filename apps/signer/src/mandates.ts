import type { DatabaseSync } from "node:sqlite";
import {
  type ApprovalId,
  canonicalJson,
  checkMandateAgainstPolicy,
  type Envelope,
  evaluateIntent,
  evaluateMandate,
  type Intent,
  intentHash,
  Mandate,
  type MandateId,
  type MandateUsage,
  mandateHash,
  mandateTimeState,
  mandateUseDigest,
  type UserId,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import type {
  GrantMandateRequest,
  ListMandatesResponse,
  MandateRevokedReason,
  MandateState,
  MandateStatus,
  SignResponse,
  SignUnderMandateRequest,
  TransactionParams,
} from "@askgina/os-protocol/signer";
import { transaction } from "./db.ts";
import { appendDecision } from "./decisions.ts";
import { SignerFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import type {
  ApprovalRow,
  AuthorizedChangeInput,
  SignAndRecordInput,
  WalletRow,
  WorkspaceRow,
} from "./signer.ts";
import type { EvmTransaction } from "./vault.ts";

/**
 * Mandates: people approve once, at the workspace's admin threshold, that one agent may transfer
 * bounded amounts from one wallet to listed recipients for a while; the signer then signs the
 * agent's transfers that fit with no passkey per payment (`docs/approval-protocol.md`, section 8,
 * "Mandates"). Everything that decides lives here and in the signer's own database: the mandate
 * as approved, who granted it, and every use, counted in the same transaction as its signature
 * and never refunded. The wallet's policy is checked at every use as well and stays the outer
 * limit. A mandate ends by its own `notAfter` or by revocation, never by anything the control
 * plane says about how a transaction fared.
 */

/** `SIGNER_MAX_MANDATE_SECONDS` unless set: seven days. */
export const DEFAULT_MAX_MANDATE_SECONDS = 604_800;
/** `SIGNER_MAX_LIVE_MANDATES_PER_WALLET` unless set. */
export const DEFAULT_MAX_LIVE_MANDATES_PER_WALLET = 16;

/** Decision-log actions. Each revocation is recorded under the grant's approval id. */
export const MANDATE_ACTIONS = {
  grant: "grant-mandate",
  use: "sign-under-mandate",
  /** Asked for over HTTP (`requested`). */
  revoke: "revoke-mandate",
  /** A passkey that granted it was removed (`grantor_removed`). */
  revokeOnGrantorRemoval: "revoke-mandate-on-grantor-removal",
  /** The operator's admin command on the signer host (`operator`). */
  revokeByOperator: "revoke-mandate-by-operator",
  /** The restore fence moved (`operator`). */
  revokeOnFence: "revoke-mandate-on-fence",
} as const;

const DAY_SECONDS = 86_400;

type MandateRow = {
  mandate_id: string;
  workspace_id: string;
  wallet_id: string;
  agent_id: string;
  mandate_hash: string;
  mandate: string;
  grant_approval_id: string;
  not_before: number;
  not_after: number;
  granted_at: number;
  revoked_at: number | null;
  revoked_reason: MandateRevokedReason | null;
};

/** End one mandate for good. False when it was revoked already. */
function markRevoked(
  db: DatabaseSync,
  mandateId: string,
  reason: MandateRevokedReason,
  at: number,
): boolean {
  const result = db
    .prepare(
      "UPDATE mandates SET revoked_at = ?, revoked_reason = ? WHERE mandate_id = ? AND revoked_at IS NULL",
    )
    .run(at, reason, mandateId);
  return result.changes > 0;
}

/**
 * Revoke each of `rows` not revoked yet, with one decision each in its workspace's log under the
 * grant's approval id. Call inside the transaction of the revocation's cause.
 */
function revokeEach(
  db: DatabaseSync,
  rows: readonly MandateRow[],
  reason: MandateRevokedReason,
  action: string,
  at: number,
): MandateId[] {
  const revoked: MandateId[] = [];
  for (const row of rows) {
    if (!markRevoked(db, row.mandate_id, reason, at)) continue;
    appendDecision(db, {
      workspaceId: row.workspace_id as WorkspaceId,
      approvalId: row.grant_approval_id,
      action,
      outcome: "allowed",
      code: null,
      at,
    });
    revoked.push(row.mandate_id as MandateId);
  }
  return revoked;
}

/**
 * When the restore fence moves (`fence.ts`), every live mandate ends with reason `operator`: a
 * restored database has forgotten the uses counted after its backup, so its counts would let
 * more leave the wallet than people approved. They must be granted again. Call inside the
 * transaction that moves the fence.
 */
export function revokeMandatesOnFence(db: DatabaseSync, at: number): MandateId[] {
  const rows = db
    .prepare(
      "SELECT * FROM mandates WHERE revoked_at IS NULL AND not_after > ? ORDER BY workspace_id, mandate_id",
    )
    .all(at) as MandateRow[];
  return revokeEach(db, rows, "operator", MANDATE_ACTIONS.revokeOnFence, at);
}

/** What the mandate operations need from the signer core (`signer.ts`). */
export interface MandateInternals {
  db: DatabaseSync;
  now: () => number;
  log: Logger;
  maxMandateSeconds: number;
  maxLiveMandatesPerWallet: number;
  decide<T>(
    workspaceId: string,
    approvalId: string | null,
    action: string,
    work: (allow: () => void) => T | Promise<T>,
  ): Promise<T>;
  authorizedChange<T>(input: AuthorizedChangeInput<T>): Promise<T>;
  requireWorkspace(workspaceId: string): WorkspaceRow;
  findWallet(walletId: string): WalletRow | undefined;
  currentPolicy(walletId: string): { policy: WalletPolicy; hash: string } | null;
  spentSince(walletId: string, since: number): Map<string, bigint>;
  findApproval(approvalId: string): ApprovalRow | undefined;
  storedSignature(approvalId: string): SignResponse;
  signAndRecord(input: SignAndRecordInput): SignResponse;
  buildTransaction(intent: Intent, params: TransactionParams): EvmTransaction;
  assertFeeWithin(params: TransactionParams, maxFeeWei: string): void;
}

export function createMandateOperations(internals: MandateInternals) {
  const { db, now, log } = internals;

  function findMandate(mandateId: string): MandateRow | undefined {
    return db.prepare("SELECT * FROM mandates WHERE mandate_id = ?").get(mandateId) as
      | MandateRow
      | undefined;
  }

  /**
   * What was signed under one mandate, from this signer's records only: every use, and per asset
   * what moved in total and after `now - windowSeconds`.
   */
  function usageOf(row: MandateRow, mandate: Mandate, at: number): MandateUsage {
    const { uses } = db
      .prepare("SELECT COUNT(*) AS uses FROM mandate_uses WHERE mandate_id = ?")
      .get(row.mandate_id) as { uses: number };
    const spends = db
      .prepare(
        "SELECT s.chain_id, s.asset, s.amount, u.at FROM mandate_uses u JOIN spends s ON s.approval_id = u.approval_id WHERE u.mandate_id = ?",
      )
      .all(row.mandate_id) as { chain_id: string; asset: string; amount: string; at: number }[];
    const since = at - mandate.windowSeconds;
    const total = new Map<string, bigint>();
    const inWindow = new Map<string, bigint>();
    for (const spend of spends) {
      const key = `${spend.chain_id}|${spend.asset}`;
      const amount = BigInt(spend.amount);
      total.set(key, (total.get(key) ?? 0n) + amount);
      if (spend.at > since) inWindow.set(key, (inWindow.get(key) ?? 0n) + amount);
    }
    return {
      uses,
      total: (chainId, asset) => total.get(`${chainId}|${asset}`) ?? 0n,
      inWindow: (chainId, asset) => inWindow.get(`${chainId}|${asset}`) ?? 0n,
    };
  }

  function statusOf(
    row: MandateRow,
    mandate: Mandate,
    usage: MandateUsage,
    at: number,
  ): MandateStatus {
    if (row.revoked_at !== null) return "revoked";
    const time = mandateTimeState(mandate, at);
    if (time !== "live") return time;
    const spent =
      usage.uses >= mandate.maxUses ||
      mandate.assets.every(
        (limit) => usage.total(limit.chainId, limit.asset) >= BigInt(limit.maxTotal),
      );
    return spent ? "exhausted" : "active";
  }

  function grantors(mandateId: string): UserId[] {
    const rows = db
      .prepare("SELECT user_id FROM mandate_grantors WHERE mandate_id = ? ORDER BY user_id")
      .all(mandateId) as { user_id: string }[];
    return rows.map((row) => row.user_id as UserId);
  }

  /** The mandate as the signer holds it, with its status computed now. */
  function stateOf(row: MandateRow): MandateState {
    // Written by `grantMandate` from a parsed mandate; parsed again only to type it.
    const mandate = Mandate.parse(JSON.parse(row.mandate));
    const at = now();
    const usage = usageOf(row, mandate, at);
    return {
      mandate,
      mandateHash: row.mandate_hash,
      status: statusOf(row, mandate, usage, at),
      grantApprovalId: row.grant_approval_id as ApprovalId,
      grantedAt: row.granted_at,
      grantedBy: grantors(row.mandate_id),
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
      usage: {
        uses: usage.uses,
        assets: mandate.assets.map((limit) => ({
          chainId: limit.chainId,
          asset: limit.asset,
          total: usage.total(limit.chainId, limit.asset).toString(),
          inWindow: usage.inWindow(limit.chainId, limit.asset).toString(),
        })),
      },
    };
  }

  /** Not revoked and not past `notAfter`, as the cap on live mandates counts them. */
  function liveMandateCount(walletId: string, at: number): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM mandates WHERE wallet_id = ? AND revoked_at IS NULL AND not_after > ?",
      )
      .get(walletId, at) as { n: number };
    return row.n;
  }

  /**
   * The grant's checks in place of the envelope and policy steps of the other kinds, in the
   * order of section 8. Run before verification and again inside the transaction, so a policy
   * edited or a mandate granted meanwhile is seen.
   */
  function assertGrantable(
    mandateId: MandateId,
    mandate: Mandate,
    wallet: WalletRow,
    envelope: Envelope,
  ): void {
    if (
      envelope.type !== "grant-mandate" ||
      envelope.mandateId !== mandateId ||
      mandate.id !== mandateId ||
      envelope.walletId !== mandate.walletId ||
      envelope.agentId !== mandate.agentId ||
      envelope.workspaceId !== mandate.workspaceId ||
      wallet.workspace_id !== mandate.workspaceId ||
      envelope.mandateHash !== mandateHash(mandate)
    ) {
      throw new SignerFailure("envelope_mismatch");
    }
    const policy = internals.currentPolicy(wallet.wallet_id);
    if (!policy) throw new SignerFailure("policy_missing");
    const at = now();
    const refusal = checkMandateAgainstPolicy(mandate, policy.policy, {
      now: at,
      maxSeconds: internals.maxMandateSeconds,
    });
    if (refusal !== null) throw new SignerFailure("mandate_invalid", refusal);
    if (liveMandateCount(wallet.wallet_id, at) >= internals.maxLiveMandatesPerWallet) {
      throw new SignerFailure("mandate_invalid", "too_many_live_mandates");
    }
    // A repeat of this grant was answered before the checks; any other holder of the id differs.
    if (findMandate(mandateId)) throw new SignerFailure("conflict");
  }

  /**
   * Store a mandate approved at the workspace's admin threshold, with the people whose
   * assertions granted it. A repeat of the same grant returns the stored state.
   */
  async function grantMandate(
    mandateId: MandateId,
    request: GrantMandateRequest,
  ): Promise<MandateState> {
    const { mandate, authorization } = request;
    const wallet = internals.findWallet(mandate.walletId);
    if (!wallet) throw new SignerFailure("not_found");
    const { approvalId } = authorization.envelope;
    return internals.authorizedChange({
      workspaceId: wallet.workspace_id,
      authorization,
      type: "grant-mandate",
      action: MANDATE_ACTIONS.grant,
      check: (envelope) => assertGrantable(mandateId, mandate, wallet, envelope),
      apply: () => {
        db.prepare(
          "INSERT INTO mandates (mandate_id, workspace_id, wallet_id, agent_id, mandate_hash, mandate, grant_approval_id, not_before, not_after, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          mandate.id,
          mandate.workspaceId,
          mandate.walletId,
          mandate.agentId,
          mandateHash(mandate),
          canonicalJson(mandate),
          approvalId,
          mandate.notBefore,
          mandate.notAfter,
          now(),
        );
        const grantor = db.prepare(
          "INSERT INTO mandate_grantors (mandate_id, user_id, credential_id) VALUES (?, ?, ?)",
        );
        for (const assertion of authorization.assertions) {
          grantor.run(mandate.id, assertion.userId, assertion.credentialId);
        }
      },
      state: () => {
        const row = db
          .prepare("SELECT * FROM mandates WHERE grant_approval_id = ?")
          .get(approvalId) as MandateRow | undefined;
        // A repeat of an applied grant answers for the mandate it granted, under its own id only.
        if (!row || row.mandate_id !== mandateId) throw new SignerFailure("envelope_mismatch");
        return stateOf(row);
      },
    });
  }

  function getMandate(mandateId: MandateId): MandateState {
    const row = findMandate(mandateId);
    if (!row) throw new SignerFailure("not_found");
    return stateOf(row);
  }

  /** Every mandate of a wallet, live or ended, by `notAfter` then id. */
  function listMandates(walletId: WalletId): ListMandatesResponse {
    if (!internals.findWallet(walletId)) throw new SignerFailure("not_found");
    const rows = db
      .prepare("SELECT * FROM mandates WHERE wallet_id = ? ORDER BY not_after, mandate_id")
      .all(walletId) as MandateRow[];
    return { mandates: rows.map(stateOf) };
  }

  /**
   * Sign one transfer under a mandate, with no passkey. Every check and the record of the use
   * run in one transaction with nothing awaited, in the order of section 8, so two requests can
   * never both take the last of a cap.
   */
  async function signUnderMandate(
    mandateId: MandateId,
    request: SignUnderMandateRequest,
  ): Promise<SignResponse> {
    const { approvalId, intent, transaction: params } = request;
    const found = findMandate(mandateId);
    if (!found) throw new SignerFailure("not_found");
    const wallet = internals.findWallet(found.wallet_id);
    if (!wallet) throw new SignerFailure("not_found");
    internals.requireWorkspace(found.workspace_id);
    const hash = intentHash(intent);
    const digest = mandateUseDigest({ approvalId, mandateId, intentHash: hash });

    return internals.decide(found.workspace_id, approvalId, MANDATE_ACTIONS.use, (allow) =>
      transaction(db, () => {
        // Idempotency: a retry of a use already signed gets the same transaction, even if the
        // mandate ended or the workspace was paused since.
        const prior = internals.findApproval(approvalId);
        if (prior) {
          if (prior.state === "revoked") throw new SignerFailure("approval_revoked");
          if (prior.state === "signed" && prior.envelope_digest === digest) {
            return internals.storedSignature(approvalId);
          }
          throw new SignerFailure("conflict");
        }

        const workspace = internals.requireWorkspace(found.workspace_id);
        if (workspace.paused === 1) throw new SignerFailure("workspace_paused");

        // Read again under the write lock: the operator may have revoked it meanwhile.
        const row = findMandate(mandateId);
        if (!row) throw new SignerFailure("not_found");
        if (row.revoked_at !== null) throw new SignerFailure("mandate_revoked");
        const mandate = Mandate.parse(JSON.parse(row.mandate));
        const at = now();
        const time = mandateTimeState(mandate, at);
        if (time === "not_yet_valid") throw new SignerFailure("mandate_not_yet_valid");
        if (time === "expired") throw new SignerFailure("mandate_expired");

        // Raising the admin threshold stops every mandate granted by fewer people.
        if (grantors(mandateId).length < workspace.admin_threshold) {
          throw new SignerFailure("mandate_denied", "mandate_grant_below_threshold");
        }

        if (db.prepare("SELECT 1 FROM mandate_uses WHERE intent_id = ?").get(intent.id)) {
          throw new SignerFailure("conflict");
        }

        const policy = internals.currentPolicy(row.wallet_id);
        if (!policy) throw new SignerFailure("policy_missing");
        const spent = internals.spentSince(row.wallet_id, at - DAY_SECONDS);
        const allowedByPolicy = evaluateIntent(
          policy.policy,
          intent,
          (chainId, asset) => spent.get(`${chainId}|${asset}`) ?? 0n,
        );
        if (!allowedByPolicy.allowed) {
          throw new SignerFailure("policy_denied", allowedByPolicy.code);
        }

        const decision = evaluateMandate(mandate, intent, usageOf(row, mandate, at));
        if (!decision.allowed) throw new SignerFailure("mandate_denied", decision.code);

        internals.assertFeeWithin(params, intent.maxFeeWei);

        const response = internals.signAndRecord({
          approvalId,
          workspaceId: row.workspace_id,
          digest,
          wallet,
          chainId: intent.chainId,
          params,
          unsigned: internals.buildTransaction(intent, params),
          spend: decision.spend,
        });
        db.prepare(
          "INSERT INTO mandate_uses (approval_id, mandate_id, intent_id, intent_hash, at) VALUES (?, ?, ?, ?, ?)",
        ).run(approvalId, mandateId, intent.id, hash, at);
        allow();
        return response;
      }),
    );
  }

  /**
   * End a mandate for good, on request. Needs no passkey because it only removes authority. A
   * mandate of another workspace is `not_found`; revoking twice changes nothing.
   */
  function revokeMandate(mandateId: MandateId, workspaceId: WorkspaceId): Promise<MandateState> {
    internals.requireWorkspace(workspaceId);
    const found = findMandate(mandateId);
    if (!found || found.workspace_id !== workspaceId) throw new SignerFailure("not_found");
    return internals.decide(workspaceId, found.grant_approval_id, MANDATE_ACTIONS.revoke, (allow) =>
      transaction(db, () => {
        if (markRevoked(db, mandateId, "requested", now())) allow();
        const row = findMandate(mandateId);
        if (!row) throw new SignerFailure("internal");
        return stateOf(row);
      }),
    );
  }

  /**
   * Every live mandate that `credentialId` helped grant in this workspace ends, with reason
   * `grantor_removed`. Runs inside the transaction that removes the approver.
   */
  function revokeMandatesOfCredential(workspaceId: string, credentialId: string): MandateId[] {
    const at = now();
    const rows = db
      .prepare(
        "SELECT m.* FROM mandates m JOIN mandate_grantors g ON g.mandate_id = m.mandate_id WHERE m.workspace_id = ? AND g.credential_id = ? AND m.revoked_at IS NULL AND m.not_after > ? ORDER BY m.mandate_id",
      )
      .all(workspaceId, credentialId, at) as MandateRow[];
    return revokeEach(db, rows, "grantor_removed", MANDATE_ACTIONS.revokeOnGrantorRemoval, at);
  }

  /**
   * End one mandate from the signer host, with reason `operator`. Returns the ids it revoked:
   * none when the mandate was revoked already. Not reachable over HTTP.
   */
  function revokeMandateByOperator(mandateId: MandateId): MandateId[] {
    const { workspaceId, revoked } = transaction(db, () => {
      const row = findMandate(mandateId);
      if (!row) throw new SignerFailure("not_found");
      return {
        workspaceId: row.workspace_id,
        revoked: revokeEach(db, [row], "operator", MANDATE_ACTIONS.revokeByOperator, now()),
      };
    });
    log.info("decision", {
      action: MANDATE_ACTIONS.revokeByOperator,
      outcome: "allowed",
      workspaceId,
      count: revoked.length,
    });
    return revoked;
  }

  /**
   * End every live mandate of a workspace from the signer host, with reason `operator`, as after
   * restoring an older signer volume. Not reachable over HTTP.
   */
  function revokeWorkspaceMandatesByOperator(workspaceId: WorkspaceId): MandateId[] {
    const revoked = transaction(db, () => {
      internals.requireWorkspace(workspaceId);
      const at = now();
      const rows = db
        .prepare(
          "SELECT * FROM mandates WHERE workspace_id = ? AND revoked_at IS NULL AND not_after > ? ORDER BY mandate_id",
        )
        .all(workspaceId, at) as MandateRow[];
      return revokeEach(db, rows, "operator", MANDATE_ACTIONS.revokeByOperator, at);
    });
    log.info("decision", {
      action: MANDATE_ACTIONS.revokeByOperator,
      outcome: "allowed",
      workspaceId,
      count: revoked.length,
    });
    return revoked;
  }

  /** Every mandate of a workspace, by wallet, `notAfter` and id, for the admin CLI. */
  function listWorkspaceMandates(workspaceId: WorkspaceId): MandateState[] {
    internals.requireWorkspace(workspaceId);
    const rows = db
      .prepare(
        "SELECT * FROM mandates WHERE workspace_id = ? ORDER BY wallet_id, not_after, mandate_id",
      )
      .all(workspaceId) as MandateRow[];
    return rows.map(stateOf);
  }

  return {
    grantMandate,
    getMandate,
    listMandates,
    revokeMandate,
    signUnderMandate,
    revokeMandatesOfCredential,
    revokeMandateByOperator,
    revokeWorkspaceMandatesByOperator,
    listWorkspaceMandates,
  };
}
