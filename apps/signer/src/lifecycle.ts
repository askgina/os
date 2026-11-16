import type { DatabaseSync } from "node:sqlite";
import type {
  Address,
  ApprovalId,
  Authorization,
  DeleteWorkspaceEnvelope,
  Envelope,
  MandateId,
  RetireWalletEnvelope,
  WalletId,
  WorkspaceId,
} from "@askgina/os-protocol";
import type { SignerErrorCode, WalletState, WorkspaceState } from "@askgina/os-protocol/signer";
import { transaction } from "./db.ts";
import { appendDecision } from "./decisions.ts";
import { SignerFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { AuthorizedChangeInput, WalletRow, WorkspaceRow } from "./signer.ts";
import { type Vault, VaultError } from "./vault.ts";

/**
 * Retiring a wallet and deleting a workspace (`docs/approval-protocol.md`, section 8, "Retiring a
 * wallet and deleting a workspace"). Destroying a key is treated like signing: people approve a
 * `retire-wallet` or `delete-workspace` envelope with passkeys at the admin threshold, naming the
 * exact wallets and the destroy time, and the signer keeps the key until that time by its own
 * clock. Applying stops the wallets from signing and ends their mandates at once; cancelling only
 * keeps a key, and finalizing only does what people approved, so both need no passkey.
 *
 * Finalizing is the one irreversible step. It runs in one write transaction: the state is read
 * again under the lock, each key is deleted from the key store, and only then are the rows
 * changed. A failure rolls the rows back; the key store treats a key already gone as deleted, so
 * the next finalize completes.
 */

/** `SIGNER_MIN_DESTROY_DELAY_SECONDS` unless set: seven days (owner decision D2). */
export const DEFAULT_MIN_DESTROY_DELAY_SECONDS = 604_800;

/** `SIGNER_MAX_DESTROY_DELAY_SECONDS` unless set: 90 days. */
export const DEFAULT_MAX_DESTROY_DELAY_SECONDS = 7_776_000;

/**
 * Decision-log actions. Applying a retirement or a deletion is recorded under its approval id;
 * cancelling, finalizing and the operator's export are recorded with none. Finalizing a deletion
 * records `destroy-wallet` for each key it destroys, then `delete-workspace`.
 */
export const LIFECYCLE_ACTIONS = {
  retire: "retire-wallet",
  cancelRetire: "cancel-retire-wallet",
  destroy: "destroy-wallet",
  delete: "delete-workspace",
  cancelDelete: "cancel-delete-workspace",
  export: "export-wallet-by-operator",
} as const;

/** Why the signer refuses an envelope because of where its workspace or wallet stands. */
export type LifecycleRefusal = Extract<
  SignerErrorCode,
  | "workspace_deleting"
  | "workspace_deleted"
  | "wallet_retired"
  | "wallet_set_mismatch"
  | "envelope_mismatch"
  | "destroy_delay_out_of_range"
>;

/** What the lifecycle operations need from the signer core (`signer.ts`). */
export interface LifecycleInternals {
  db: DatabaseSync;
  vault: Vault;
  now: () => number;
  log: Logger;
  minDestroyDelaySeconds: number;
  maxDestroyDelaySeconds: number;
  decide<T>(
    workspaceId: string,
    approvalId: ApprovalId | null,
    action: string,
    work: (allow: () => void) => T | Promise<T>,
  ): Promise<T>;
  authorizedChange<T>(input: AuthorizedChangeInput<T>): Promise<T>;
  requireWorkspace(workspaceId: string): WorkspaceRow;
  findWorkspace(workspaceId: string): WorkspaceRow | undefined;
  findWallet(walletId: string): WalletRow | undefined;
  assertWorkspaceActive(workspaceId: string): WorkspaceRow;
  assertNotDeleted(workspaceId: string): WorkspaceRow;
  workspaceState(workspaceId: string): WorkspaceState;
  walletState(walletId: string): WalletState;
  /** Revoke every live mandate of the wallet with reason `requested`, inside the transaction. */
  revokeWalletMandates(walletId: string): MandateId[];
  /** Revoke every live mandate of the workspace with reason `requested`, inside the transaction. */
  revokeWorkspaceMandates(workspaceId: string): MandateId[];
}

export function createLifecycleOperations(internals: LifecycleInternals) {
  const { db, now, log } = internals;

  /** `destroyAfter − issuedAt` within the signer's bounds. */
  function delayInRange(envelope: { issuedAt: number; destroyAfter: number }): boolean {
    const delay = envelope.destroyAfter - envelope.issuedAt;

    return delay >= internals.minDestroyDelaySeconds && delay <= internals.maxDestroyDelaySeconds;
  }

  /** A wallet of this workspace, by the path's ids; anything else is `not_found`. */
  function walletOf(walletId: string, workspaceId: string): WalletRow {
    internals.requireWorkspace(workspaceId);
    const wallet = internals.findWallet(walletId);

    if (!wallet || wallet.workspace_id !== workspaceId) throw new SignerFailure("not_found");

    return wallet;
  }

  /** The wallets a deletion must name: every wallet of the workspace not destroyed, by id. */
  function walletsToDelete(workspaceId: string): WalletRow[] {
    // SAFETY: `SELECT *` of the STRICT `wallets` table returns exactly WalletRow's columns (db.ts,
    // versions 1 and 7), typed as WalletRow's comment (signer.ts) says.
    return db
      .prepare(
        "SELECT * FROM wallets WHERE workspace_id = ? AND state <> 'destroyed' ORDER BY wallet_id",
      )
      .all(workspaceId) as WalletRow[];
  }

  function retireRefusal(envelope: RetireWalletEnvelope): LifecycleRefusal | null {
    const wallet = internals.findWallet(envelope.wallet.walletId);

    if (
      !wallet ||
      wallet.workspace_id !== envelope.workspaceId ||
      wallet.address !== envelope.wallet.address
    ) {
      return "envelope_mismatch";
    }

    if (wallet.state !== "active" && wallet.state !== "held") return "wallet_retired";

    return delayInRange(envelope) ? null : "destroy_delay_out_of_range";
  }

  function deleteRefusal(envelope: DeleteWorkspaceEnvelope): LifecycleRefusal | null {
    const held = walletsToDelete(envelope.workspaceId);

    const same =
      held.length === envelope.wallets.length &&
      held.every((wallet, index) => {
        const listed = envelope.wallets[index];

        return listed?.walletId === wallet.wallet_id && listed.address === wallet.address;
      });

    if (!same) return "wallet_set_mismatch";

    return delayInRange(envelope) ? null : "destroy_delay_out_of_range";
  }

  /**
   * Why the signer would refuse `envelope` because of where its workspace or wallet stands, or
   * null. The same rules decide applying and signing, and the confirmation page's `superseded`.
   * While a deletion waits only a `cancel-transaction` may still be approved, so a transaction
   * that is stuck can be cleared before its key is destroyed (owner decision D7).
   */
  function refusal(envelope: Envelope): LifecycleRefusal | null {
    const workspace = internals.findWorkspace(envelope.workspaceId);

    if (!workspace) return null;

    if (workspace.state === "deleted") return "workspace_deleted";

    if (workspace.state === "deleting" && envelope.type !== "cancel-transaction") {
      return "workspace_deleting";
    }

    const walletState = (walletId: string) => internals.findWallet(walletId)?.state ?? null;

    switch (envelope.type) {
      case "approve-intent":
      case "sweep-wallet":
      case "grant-mandate": {
        const state = walletState(envelope.walletId);

        return state === null || state === "active" ? null : "wallet_retired";
      }

      case "set-policy": {
        // A new policy is how a held wallet signs again.
        const state = walletState(envelope.walletId);

        return state === "retiring" || state === "destroyed" ? "wallet_retired" : null;
      }

      case "cancel-transaction":
        return walletState(envelope.walletId) === "destroyed" ? "wallet_retired" : null;
      case "retire-wallet":
        return retireRefusal(envelope);
      case "delete-workspace":
        return deleteRefusal(envelope);
      default:
        return null;
    }
  }

  /**
   * Delete the wallet's key from the key store, then empty its sealed credential and every
   * signed transaction and venue request of it the signer kept, attempts and venue cancels
   * included, and mark it destroyed. Call inside the finalizing transaction, after its checks.
   */
  function destroyKey(wallet: WalletRow, destroyAfter: number): void {
    try {
      internals.vault.destroyWallet(wallet.wallet_id);
    } catch (error) {
      log.error("vault destroy failed", {
        walletId: wallet.wallet_id,
        reason: error instanceof VaultError ? error.reason : "unknown",
      });
      throw new SignerFailure("vault_error");
    }

    db.prepare(
      "UPDATE signature_attempts SET signed_transaction = '' WHERE approval_id IN (SELECT approval_id FROM signatures WHERE wallet_id = ?)",
    ).run(wallet.wallet_id);
    db.prepare("UPDATE signatures SET signed_transaction = '' WHERE wallet_id = ?").run(
      wallet.wallet_id,
    );
    db.prepare(
      "UPDATE venue_cancels SET request = '' WHERE approval_id IN (SELECT approval_id FROM venue_signatures WHERE wallet_id = ?)",
    ).run(wallet.wallet_id);
    db.prepare("UPDATE venue_signatures SET request = '' WHERE wallet_id = ?").run(
      wallet.wallet_id,
    );
    db.prepare(
      "UPDATE wallets SET sealed_credential = x'', state = 'destroyed', destroyed_at = ?, destroy_after = COALESCE(destroy_after, ?), state_before_delete = NULL WHERE wallet_id = ?",
    ).run(now(), destroyAfter, wallet.wallet_id);
  }

  /**
   * After a finalize committed: write its pages into the database file and empty the WAL, so the
   * emptied values do not stay readable in the log.
   */
  function checkpoint(): void {
    // SAFETY: `PRAGMA wal_checkpoint` returns one row of three integer columns, `busy` first, read
    // as numbers because the statement does not set `readBigInts`.
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy: number }
      | undefined;

    if (result !== undefined && result.busy !== 0) {
      log.warn("wal checkpoint incomplete", { code: "checkpoint_busy" });
    }
  }

  // --- retiring a wallet -------------------------------------------------------------------

  /**
   * Apply a `retire-wallet` envelope: the wallet signs nothing from now on, and every live
   * mandate of it ends with reason `requested` in the same transaction (owner decision D8).
   */
  function retireWallet(walletId: string, authorization: Authorization): Promise<WalletState> {
    const wallet = internals.findWallet(walletId);

    if (!wallet) throw new SignerFailure("not_found");

    const check = (envelope: Envelope) => {
      if (envelope.type !== "retire-wallet" || envelope.wallet.walletId !== walletId) {
        throw new SignerFailure("envelope_mismatch");
      }

      const refused = retireRefusal(envelope);

      if (refused !== null) throw new SignerFailure(refused);
    };

    return internals.authorizedChange({
      workspaceId: wallet.workspace_id,
      authorization,
      type: "retire-wallet",
      action: LIFECYCLE_ACTIONS.retire,
      check,
      apply: (envelope) => {
        if (envelope.type !== "retire-wallet") throw new SignerFailure("envelope_mismatch");
        db.prepare(
          "UPDATE wallets SET state = 'retiring', destroy_after = ? WHERE wallet_id = ?",
        ).run(envelope.destroyAfter, walletId);
        internals.revokeWalletMandates(walletId);
      },
      state: () => internals.walletState(walletId),
    });
  }

  /**
   * A retiring wallet keeps its key and becomes `held`: it signs nothing until a new policy is
   * approved for it. Its mandates stay revoked. Refused while its workspace is being deleted:
   * the deletion decides for every wallet, so cancel that instead.
   */
  function cancelRetireWallet(walletId: string, workspaceId: string): Promise<WalletState> {
    walletOf(walletId, workspaceId);

    return internals.decide(workspaceId, null, LIFECYCLE_ACTIONS.cancelRetire, (allow) =>
      transaction(db, () => {
        internals.assertWorkspaceActive(workspaceId);

        if (internals.findWallet(walletId)?.state !== "retiring") {
          throw new SignerFailure("conflict");
        }

        db.prepare(
          "UPDATE wallets SET state = 'held', destroy_after = NULL WHERE wallet_id = ?",
        ).run(walletId);
        allow();

        return internals.walletState(walletId);
      }),
    );
  }

  /** Destroy a retiring wallet's key once `destroyAfter` has passed. A repeat returns the state. */
  function finalizeRetireWallet(walletId: string, workspaceId: string): Promise<WalletState> {
    walletOf(walletId, workspaceId);

    return internals.decide(workspaceId, null, LIFECYCLE_ACTIONS.destroy, (allow) => {
      const destroyed = transaction(db, () => {
        internals.assertNotDeleted(workspaceId);
        const current = internals.findWallet(walletId);

        if (!current) throw new SignerFailure("internal");

        if (current.state === "destroyed") return false;

        if (current.state !== "retiring" || current.destroy_after === null) {
          throw new SignerFailure("conflict");
        }

        if (now() < current.destroy_after) throw new SignerFailure("destroy_not_due");
        destroyKey(current, current.destroy_after);
        allow();

        return true;
      });

      if (destroyed) checkpoint();

      return internals.walletState(walletId);
    });
  }

  // --- deleting a workspace ----------------------------------------------------------------

  /**
   * Apply a `delete-workspace` envelope: the workspace is paused and `deleting`, every listed
   * wallet `retiring` with the envelope's destroy time, and every live mandate of the workspace
   * ends with reason `requested`, all in one transaction.
   */
  function deleteWorkspace(
    workspaceId: string,
    authorization: Authorization,
  ): Promise<WorkspaceState> {
    return internals.authorizedChange({
      workspaceId,
      authorization,
      type: "delete-workspace",
      action: LIFECYCLE_ACTIONS.delete,
      check: (envelope) => {
        if (envelope.type !== "delete-workspace") throw new SignerFailure("envelope_mismatch");
        const refused = deleteRefusal(envelope);

        if (refused !== null) throw new SignerFailure(refused);
      },
      apply: (envelope) => {
        if (envelope.type !== "delete-workspace") throw new SignerFailure("envelope_mismatch");
        db.prepare(
          "UPDATE workspaces SET paused = 1, state = 'deleting', destroy_after = ? WHERE workspace_id = ?",
        ).run(envelope.destroyAfter, workspaceId);
        // A wallet retiring on its own is recorded as held: cancelling the deletion keeps every
        // key and never brings a destroy time back.
        db.prepare(
          "UPDATE wallets SET state_before_delete = CASE state WHEN 'active' THEN 'active' ELSE 'held' END, state = 'retiring', destroy_after = ? WHERE workspace_id = ? AND state <> 'destroyed'",
        ).run(envelope.destroyAfter, workspaceId);
        internals.revokeWorkspaceMandates(workspaceId);
      },
      state: () => internals.workspaceState(workspaceId),
    });
  }

  /**
   * A deleting workspace becomes `active` again, still paused (resuming needs `resume-workspace`),
   * and each wallet the deletion retired goes back to what it was, `active` or `held`. Mandates
   * stay revoked.
   */
  function cancelDeleteWorkspace(workspaceId: string): Promise<WorkspaceState> {
    internals.requireWorkspace(workspaceId);

    return internals.decide(workspaceId, null, LIFECYCLE_ACTIONS.cancelDelete, (allow) =>
      transaction(db, () => {
        const workspace = internals.assertNotDeleted(workspaceId);

        if (workspace.state !== "deleting") throw new SignerFailure("conflict");
        db.prepare(
          "UPDATE workspaces SET state = 'active', destroy_after = NULL WHERE workspace_id = ?",
        ).run(workspaceId);
        db.prepare(
          "UPDATE wallets SET state = state_before_delete, destroy_after = NULL WHERE workspace_id = ? AND state = 'retiring' AND state_before_delete IS NOT NULL",
        ).run(workspaceId);
        db.prepare(
          "UPDATE wallets SET state_before_delete = NULL WHERE workspace_id = ? AND state_before_delete IS NOT NULL",
        ).run(workspaceId);
        allow();

        return internals.workspaceState(workspaceId);
      }),
    );
  }

  /**
   * Once `destroyAfter` has passed: destroy every key of the workspace, remove its approvers,
   * confirmations, assertions and possession challenges, blank the text of its mandates (owner
   * decision D9), and mark it `deleted`. Used nonces, approvals, spends, policies, mandate ids,
   * hashes, grantors and uses, and the decision log stay, so nothing of it can be replayed. A
   * repeat returns the state.
   */
  function finalizeDeleteWorkspace(workspaceId: string): Promise<WorkspaceState> {
    internals.requireWorkspace(workspaceId);

    return internals.decide(workspaceId, null, LIFECYCLE_ACTIONS.delete, (allow) => {
      const finalized = transaction(db, () => {
        const workspace = internals.requireWorkspace(workspaceId);

        if (workspace.state === "deleted") return false;

        if (workspace.state !== "deleting" || workspace.destroy_after === null) {
          throw new SignerFailure("conflict");
        }

        if (now() < workspace.destroy_after) throw new SignerFailure("destroy_not_due");

        for (const wallet of walletsToDelete(workspaceId)) {
          destroyKey(wallet, workspace.destroy_after);
          appendDecision(db, {
            workspaceId,
            approvalId: null,
            action: LIFECYCLE_ACTIONS.destroy,
            outcome: "allowed",
            code: null,
            at: now(),
          });
        }

        const confirmations = "SELECT approval_id FROM confirmations WHERE workspace_id = ?";
        db.prepare(`DELETE FROM possession_challenges WHERE approval_id IN (${confirmations})`).run(
          workspaceId,
        );
        db.prepare(
          `DELETE FROM confirmation_assertions WHERE approval_id IN (${confirmations})`,
        ).run(workspaceId);
        db.prepare("DELETE FROM confirmations WHERE workspace_id = ?").run(workspaceId);
        db.prepare("DELETE FROM approvers WHERE workspace_id = ?").run(workspaceId);
        db.prepare("UPDATE mandates SET mandate = '' WHERE workspace_id = ?").run(workspaceId);
        db.prepare(
          "UPDATE workspaces SET state = 'deleted', paused = 1 WHERE workspace_id = ?",
        ).run(workspaceId);
        allow();

        return true;
      });

      if (finalized) checkpoint();

      return internals.workspaceState(workspaceId);
    });
  }

  // --- the operator's export ---------------------------------------------------------------

  /**
   * Read a wallet's key from the key store for the operator, recorded as
   * `export-wallet-by-operator`. Only the admin CLI on the signer host calls it (owner decision
   * D4: no HTTP route); `exportSecret` reads the key store itself. Runs under the write lock, so a
   * finalize cannot destroy the key halfway. A destroyed wallet has no key (`wallet_retired`).
   */
  function exportWalletByOperator(
    workspaceId: WorkspaceId,
    walletId: WalletId,
    exportSecret: (walletId: WalletId) => string,
  ): Promise<{ address: Address; secret: string }> {
    walletOf(walletId, workspaceId);

    return internals.decide(workspaceId, null, LIFECYCLE_ACTIONS.export, (allow) =>
      transaction(db, () => {
        internals.assertNotDeleted(workspaceId);
        const wallet = internals.findWallet(walletId);

        if (!wallet) throw new SignerFailure("internal");

        if (wallet.state === "destroyed") throw new SignerFailure("wallet_retired");
        let secret: string;

        try {
          secret = exportSecret(walletId);
        } catch (error) {
          log.error("vault export failed", {
            walletId,
            reason: error instanceof VaultError ? error.reason : "unknown",
          });
          throw new SignerFailure("vault_error");
        }

        allow();

        return { address: wallet.address, secret };
      }),
    );
  }

  return {
    refusal,
    retireWallet,
    cancelRetireWallet,
    finalizeRetireWallet,
    deleteWorkspace,
    cancelDeleteWorkspace,
    finalizeDeleteWorkspace,
    exportWalletByOperator,
  };
}
