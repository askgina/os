import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "@askgina/os-keys/seal";
import {
  type Address,
  type ApprovalId,
  type ApproverCredential,
  type AssetRef,
  type Authorization,
  type ChainId,
  canonicalJson,
  type Envelope,
  envelopeChallenge,
  evaluateIntent,
  evmChainNumber,
  type Hex,
  type Intent,
  intentHash,
  intentSpend,
  policyHash,
  type UserId,
  type WalletId,
  WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import type {
  AddApproverRequest,
  ApprovalState,
  CreateWalletRequest,
  CreateWorkspaceRequest,
  SetPolicyRequest,
  SignerDecision,
  SignRequest,
  SignResponse,
  WalletState,
  WorkspaceState,
} from "@askgina/os-protocol/signer";
import { type RelyingParty, verifyAuthorization } from "@askgina/os-protocol/webauthn";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  keccak256,
  parseTransaction,
  serializeTransaction,
} from "viem";
import { transaction } from "./db.ts";
import { appendDecision, listDecisions, verifyDecisions } from "./decisions.ts";
import { SignerFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import { type EvmTransaction, type Vault, VaultError } from "./vault.ts";

const DAY_SECONDS = 86_400;

export interface SignerCoreOptions {
  db: DatabaseSync;
  vault: Vault;
  relyingParty: RelyingParty;
  tokenKey: Uint8Array;
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
  now: () => number;
  log: Logger;
}

type WorkspaceRow = {
  workspace_id: string;
  admin_threshold: number;
  paused: number;
  created_request: string;
};
type ApproverRow = { credential_id: string; user_id: string; public_key: string; added_at: number };
type WalletRow = {
  wallet_id: string;
  workspace_id: string;
  kind: string;
  label: string;
  address: string;
  sealed_credential: Uint8Array;
};
type ApprovalRow = {
  approval_id: string;
  workspace_id: string;
  state: "revoked" | "signed" | "applied";
  envelope_digest: string | null;
};
type SignatureRow = {
  approval_id: string;
  wallet_id: string;
  signed_transaction: string;
  transaction_hash: string;
};

const envelopeDigest = (envelope: Envelope) =>
  Buffer.from(envelopeChallenge(envelope)).toString("hex");
const credentialContext = (walletId: string) => `signer.wallets.credential:${walletId}`;

/**
 * True when `signed` is exactly `expected` plus a signature made by `address`. The vault is
 * native code behind a string interface; this check means a vault that returns a signature for
 * another key, another transaction or a malformed one is caught before anything is recorded, so
 * the approval is not spent on a transaction that could never be the approved one. A signature
 * with a high `s` is refused too: it recovers to the right key, but nodes reject it (EIP-2).
 */
function isSignedBy(signed: Hex, expected: EvmTransaction, address: string): boolean {
  try {
    const { r, s, yParity, v: _v, ...unsigned } = parseTransaction(signed);
    if (r === undefined || s === undefined || yParity === undefined) return false;
    const rebuilt = serializeTransaction({ ...unsigned, type: "eip1559" } as EvmTransaction);
    if (rebuilt !== serializeTransaction({ ...expected, type: "eip1559" })) return false;
    const signature = new secp256k1.Signature(BigInt(r), BigInt(s));
    if (signature.hasHighS()) return false;
    const publicKey = signature
      .addRecoveryBit(yParity)
      .recoverPublicKey(hexToBytes(keccak256(rebuilt)))
      .toBytes(false);
    return `0x${keccak256(publicKey.subarray(1)).slice(-40)}` === address.toLowerCase();
  } catch {
    return false;
  }
}

/** The signer's rules, independent of HTTP. Every method either acts or throws a SignerFailure. */
export function createSignerCore(options: SignerCoreOptions) {
  const { db, vault, log } = options;

  // --- reads -------------------------------------------------------------------------------

  function findWorkspace(workspaceId: string): WorkspaceRow | undefined {
    return db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as
      | WorkspaceRow
      | undefined;
  }

  function requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = findWorkspace(workspaceId);
    if (!row) throw new SignerFailure("not_found");
    return row;
  }

  function approverRows(workspaceId: string): ApproverRow[] {
    return db
      .prepare("SELECT * FROM approvers WHERE workspace_id = ? ORDER BY added_at, credential_id")
      .all(workspaceId) as ApproverRow[];
  }

  function approvers(workspaceId: string): ApproverCredential[] {
    return approverRows(workspaceId).map((row) => ({
      userId: row.user_id as UserId,
      credentialId: row.credential_id,
      publicKey: row.public_key,
    }));
  }

  function distinctApproverCount(workspaceId: string): number {
    const row = db
      .prepare("SELECT COUNT(DISTINCT user_id) AS n FROM approvers WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    return row.n;
  }

  function workspaceState(workspaceId: string): WorkspaceState {
    const row = requireWorkspace(workspaceId);
    return {
      workspaceId: row.workspace_id as WorkspaceId,
      adminThreshold: row.admin_threshold,
      paused: row.paused === 1,
      approvers: approverRows(workspaceId).map((approver) => ({
        userId: approver.user_id as UserId,
        credentialId: approver.credential_id,
        addedAt: approver.added_at,
      })),
    };
  }

  function findWallet(walletId: string): WalletRow | undefined {
    return db.prepare("SELECT * FROM wallets WHERE wallet_id = ?").get(walletId) as
      | WalletRow
      | undefined;
  }

  function currentPolicy(walletId: string): { policy: WalletPolicy; hash: string } | null {
    const row = db
      .prepare(
        "SELECT policy, policy_hash FROM policies WHERE wallet_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(walletId) as { policy: string; policy_hash: string } | undefined;
    if (!row) return null;
    return { policy: WalletPolicy.parse(JSON.parse(row.policy)), hash: row.policy_hash };
  }

  function spentSince(walletId: string, since: number): Map<string, bigint> {
    const rows = db
      .prepare("SELECT chain_id, asset, amount FROM spends WHERE wallet_id = ? AND at > ?")
      .all(walletId, since) as { chain_id: string; asset: string; amount: string }[];
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      const key = `${row.chain_id}|${row.asset}`;
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(row.amount));
    }
    return totals;
  }

  function walletState(walletId: string): WalletState {
    const row = findWallet(walletId);
    if (!row) throw new SignerFailure("not_found");
    const policy = currentPolicy(walletId);
    const spent = [...spentSince(walletId, options.now() - DAY_SECONDS)]
      .filter(([, amount]) => amount > 0n)
      .map(([key, amount]) => {
        const [chainId, asset] = key.split("|") as [ChainId, AssetRef];
        return { chainId, asset, amount: amount.toString() };
      });
    return {
      walletId: row.wallet_id as WalletId,
      workspaceId: row.workspace_id as WorkspaceId,
      kind: row.kind as WalletState["kind"],
      label: row.label,
      address: row.address as Address,
      policy: policy?.policy ?? null,
      policyHash: policy?.hash ?? null,
      spent,
    };
  }

  function findApproval(approvalId: string): ApprovalRow | undefined {
    return db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as
      | ApprovalRow
      | undefined;
  }

  function storedSignature(approvalId: string): SignResponse {
    const row = db.prepare("SELECT * FROM signatures WHERE approval_id = ?").get(approvalId) as
      | SignatureRow
      | undefined;
    if (!row) throw new SignerFailure("internal");
    const wallet = findWallet(row.wallet_id);
    if (!wallet) throw new SignerFailure("internal");
    return {
      approvalId: row.approval_id as ApprovalId,
      walletId: row.wallet_id as WalletId,
      from: wallet.address as Address,
      signedTransaction: row.signed_transaction as Hex,
      transactionHash: row.transaction_hash as Hex,
    };
  }

  // --- decisions ---------------------------------------------------------------------------

  /**
   * Run one decision. A refusal is recorded after the failed transaction rolled back, so the
   * record survives; an allowed action records itself inside its own transaction.
   */
  async function decide<T>(
    workspaceId: string,
    approvalId: string | null,
    action: string,
    work: (allow: () => void) => T | Promise<T>,
  ): Promise<T> {
    const allow = () =>
      appendDecision(db, {
        workspaceId: workspaceId as WorkspaceId,
        approvalId,
        action,
        outcome: "allowed",
        code: null,
        at: options.now(),
      });
    try {
      const result = await work(allow);
      log.info("decision", { action, outcome: "allowed", workspaceId, approvalId });
      return result;
    } catch (error) {
      const failure = error instanceof SignerFailure ? error : new SignerFailure("internal");
      // A refusal for a workspace this signer does not know has nowhere to be recorded.
      if (failure.code !== "not_found" && findWorkspace(workspaceId)) {
        appendDecision(db, {
          workspaceId: workspaceId as WorkspaceId,
          approvalId,
          action,
          outcome: "denied",
          code: failure.code,
          at: options.now(),
        });
      }
      log.info("decision", {
        action,
        outcome: "denied",
        code: failure.code,
        detail: failure.detail ?? null,
        workspaceId,
        approvalId,
      });
      throw error;
    }
  }

  async function verify(
    authorization: Authorization,
    workspaceId: string,
    threshold: number,
    maxTtlSeconds: number,
  ): Promise<void> {
    const verdict = await verifyAuthorization({
      authorization,
      approvers: approvers(workspaceId),
      relyingParty: options.relyingParty,
      threshold,
      maxTtlSeconds,
      now: options.now(),
    });
    if (!verdict.ok) throw new SignerFailure(verdict.code);
  }

  /** Re-checked inside the transaction: an approver removed during verification no longer counts. */
  function assertApproversStillPresent(authorization: Authorization, workspaceId: string): void {
    const present = new Set(approverRows(workspaceId).map((row) => row.credential_id));
    for (const assertion of authorization.assertions) {
      if (!present.has(assertion.credentialId)) throw new SignerFailure("approver_unknown");
    }
  }

  function consumeNonce(envelope: Envelope): void {
    const used = db.prepare("SELECT 1 FROM used_nonces WHERE nonce = ?").get(envelope.nonce);
    if (used) throw new SignerFailure("nonce_reused");
    db.prepare(
      "INSERT INTO used_nonces (nonce, workspace_id, approval_id, used_at) VALUES (?, ?, ?, ?)",
    ).run(envelope.nonce, envelope.workspaceId, envelope.approvalId, options.now());
  }

  function recordApproval(envelope: Envelope, state: "signed" | "applied"): void {
    db.prepare(
      "INSERT INTO approvals (approval_id, workspace_id, state, envelope_digest, at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      envelope.approvalId,
      envelope.workspaceId,
      state,
      envelopeDigest(envelope),
      options.now(),
    );
  }

  /** What an approval id already means: null when the signer has never acted on it. */
  function priorOutcome(envelope: Envelope, state: "signed" | "applied"): "replay" | null {
    const row = findApproval(envelope.approvalId);
    if (!row) return null;
    if (row.state === "revoked") throw new SignerFailure("approval_revoked");
    if (row.state === state && row.envelope_digest === envelopeDigest(envelope)) return "replay";
    throw new SignerFailure("conflict");
  }

  /**
   * The shared shape of every change that adds authority without signing a transaction: the
   * envelope is of the right type for this workspace, enough current approvers signed it, its
   * nonce is unused, and the change, the nonce and the decision commit together.
   */
  async function authorizedChange<T>(input: {
    workspaceId: string;
    authorization: Authorization;
    type: Envelope["type"];
    action: string;
    check?: (envelope: Envelope) => void;
    apply: (envelope: Envelope) => void;
    state: () => T;
  }): Promise<T> {
    const { envelope } = input.authorization;
    requireWorkspace(input.workspaceId);
    return decide(input.workspaceId, envelope.approvalId, input.action, async (allow) => {
      if (envelope.type !== input.type || envelope.workspaceId !== input.workspaceId) {
        throw new SignerFailure("envelope_mismatch");
      }
      if (priorOutcome(envelope, "applied") === "replay") return input.state();
      input.check?.(envelope);
      const workspace = requireWorkspace(input.workspaceId);
      await verify(
        input.authorization,
        input.workspaceId,
        workspace.admin_threshold,
        options.maxAdminTtlSeconds,
      );
      return transaction(db, () => {
        if (priorOutcome(envelope, "applied") === "replay") return input.state();
        assertApproversStillPresent(input.authorization, input.workspaceId);
        const current = requireWorkspace(input.workspaceId);
        if (input.authorization.assertions.length < current.admin_threshold) {
          // The threshold was raised while this request was being verified.
          throw new SignerFailure("insufficient_approvals");
        }
        consumeNonce(envelope);
        input.check?.(envelope);
        input.apply(envelope);
        recordApproval(envelope, "applied");
        allow();
        return input.state();
      });
    });
  }

  function highestPolicyThreshold(workspaceId: string): number {
    const wallets = db
      .prepare("SELECT wallet_id FROM wallets WHERE workspace_id = ?")
      .all(workspaceId) as { wallet_id: string }[];
    let highest = 0;
    for (const wallet of wallets) {
      const policy = currentPolicy(wallet.wallet_id);
      if (policy) highest = Math.max(highest, policy.policy.approvals.threshold);
    }
    return highest;
  }

  // The most any current threshold requires: removing approvers may not go below it.
  function requiredApprovers(workspaceId: string): number {
    return Math.max(
      requireWorkspace(workspaceId).admin_threshold,
      highestPolicyThreshold(workspaceId),
    );
  }

  function insertApprover(workspaceId: string, approver: ApproverCredential): void {
    const existing = db
      .prepare("SELECT 1 FROM approvers WHERE workspace_id = ? AND credential_id = ?")
      .get(workspaceId, approver.credentialId);
    if (existing) throw new SignerFailure("conflict");
    db.prepare(
      "INSERT INTO approvers (workspace_id, credential_id, user_id, public_key, added_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, approver.credentialId, approver.userId, approver.publicKey, options.now());
  }

  // --- operations --------------------------------------------------------------------------

  function createWorkspace(request: CreateWorkspaceRequest): WorkspaceState {
    const identity = canonicalJson(request);
    const existing = findWorkspace(request.workspaceId);
    if (existing) {
      if (existing.created_request === identity) return workspaceState(request.workspaceId);
      throw new SignerFailure("conflict");
    }
    const credentialIds = new Set(request.approvers.map((approver) => approver.credentialId));
    if (credentialIds.size !== request.approvers.length) {
      throw new SignerFailure("invalid_request");
    }
    const people = new Set(request.approvers.map((approver) => approver.userId));
    if (request.adminThreshold > people.size) throw new SignerFailure("threshold_unreachable");
    return transaction(db, () => {
      db.prepare(
        "INSERT INTO workspaces (workspace_id, admin_threshold, paused, created_request, created_at) VALUES (?, ?, 0, ?, ?)",
      ).run(request.workspaceId, request.adminThreshold, identity, options.now());
      for (const approver of request.approvers) insertApprover(request.workspaceId, approver);
      appendDecision(db, {
        workspaceId: request.workspaceId,
        approvalId: null,
        action: "create-workspace",
        outcome: "allowed",
        code: null,
        at: options.now(),
      });
      return workspaceState(request.workspaceId);
    });
  }

  async function pauseWorkspace(workspaceId: string): Promise<WorkspaceState> {
    requireWorkspace(workspaceId);
    return decide(workspaceId, null, "pause-workspace", (allow) =>
      transaction(db, () => {
        db.prepare("UPDATE workspaces SET paused = 1 WHERE workspace_id = ?").run(workspaceId);
        allow();
        return workspaceState(workspaceId);
      }),
    );
  }

  function resumeWorkspace(workspaceId: string, authorization: Authorization) {
    return authorizedChange({
      workspaceId,
      authorization,
      type: "resume-workspace",
      action: "resume-workspace",
      apply: () => {
        db.prepare("UPDATE workspaces SET paused = 0 WHERE workspace_id = ?").run(workspaceId);
      },
      state: () => workspaceState(workspaceId),
    });
  }

  function addApprover(workspaceId: string, request: AddApproverRequest): Promise<WorkspaceState> {
    return authorizedChange({
      workspaceId,
      authorization: request.authorization,
      type: "add-approver",
      action: "add-approver",
      apply: (envelope) => {
        if (envelope.type !== "add-approver") throw new SignerFailure("envelope_mismatch");
        insertApprover(workspaceId, {
          userId: envelope.userId,
          credentialId: envelope.credentialId,
          publicKey: envelope.publicKey,
        });
      },
      state: () => workspaceState(workspaceId),
    });
  }

  /**
   * Enroll an approver with no passkey assertions, for an operator who has lost every passkey.
   * Only reachable from the admin CLI on the signer host: whoever can run it there is the root of
   * trust, and the key enrolled is the one the operator typed, not one a relay chose.
   */
  function enrollApproverByOperator(workspaceId: WorkspaceId, approver: ApproverCredential): void {
    transaction(db, () => {
      requireWorkspace(workspaceId);
      insertApprover(workspaceId, approver);
      appendDecision(db, {
        workspaceId,
        approvalId: null,
        action: "enroll-approver-by-operator",
        outcome: "allowed",
        code: null,
        at: options.now(),
      });
    });
    log.info("decision", {
      action: "enroll-approver-by-operator",
      outcome: "allowed",
      workspaceId,
    });
  }

  function removeApprover(workspaceId: string, authorization: Authorization) {
    return authorizedChange({
      workspaceId,
      authorization,
      type: "remove-approver",
      action: "remove-approver",
      apply: (envelope) => {
        if (envelope.type !== "remove-approver") throw new SignerFailure("envelope_mismatch");
        const removed = db
          .prepare(
            "DELETE FROM approvers WHERE workspace_id = ? AND credential_id = ? AND user_id = ?",
          )
          .run(workspaceId, envelope.credentialId, envelope.userId);
        if (removed.changes === 0) throw new SignerFailure("not_found");
        if (distinctApproverCount(workspaceId) < requiredApprovers(workspaceId)) {
          throw new SignerFailure("threshold_unreachable");
        }
      },
      state: () => workspaceState(workspaceId),
    });
  }

  function setAdminThreshold(workspaceId: string, authorization: Authorization) {
    return authorizedChange({
      workspaceId,
      authorization,
      type: "set-admin-threshold",
      action: "set-admin-threshold",
      apply: (envelope) => {
        if (envelope.type !== "set-admin-threshold") throw new SignerFailure("envelope_mismatch");
        if (envelope.adminThreshold > distinctApproverCount(workspaceId)) {
          throw new SignerFailure("threshold_unreachable");
        }
        // Lowering the admin threshold below a wallet's threshold would let fewer people
        // approve a policy that lowers the wallet's threshold, voiding it.
        if (envelope.adminThreshold < highestPolicyThreshold(workspaceId)) {
          throw new SignerFailure("threshold_unreachable");
        }
        db.prepare("UPDATE workspaces SET admin_threshold = ? WHERE workspace_id = ?").run(
          envelope.adminThreshold,
          workspaceId,
        );
      },
      state: () => workspaceState(workspaceId),
    });
  }

  async function createWallet(request: CreateWalletRequest): Promise<WalletState> {
    requireWorkspace(request.workspaceId);
    const existing = findWallet(request.walletId);
    if (existing) {
      const same =
        existing.workspace_id === request.workspaceId &&
        existing.kind === request.kind &&
        existing.label === request.label;
      if (same) return walletState(request.walletId);
      throw new SignerFailure("conflict");
    }
    return decide(request.workspaceId, null, "create-wallet", (allow) => {
      let created: { address: Address; credential: string };
      try {
        created = vault.createWallet(request.walletId);
      } catch (error) {
        log.error("vault create failed", {
          walletId: request.walletId,
          reason: error instanceof VaultError ? error.reason : "unknown",
        });
        throw new SignerFailure("vault_error");
      }
      return transaction(db, () => {
        db.prepare(
          "INSERT INTO wallets (wallet_id, workspace_id, kind, label, address, sealed_credential, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          request.walletId,
          request.workspaceId,
          request.kind,
          request.label,
          created.address,
          seal(
            options.tokenKey,
            Buffer.from(created.credential, "utf8"),
            credentialContext(request.walletId),
          ),
          options.now(),
        );
        allow();
        return walletState(request.walletId);
      });
    });
  }

  async function setPolicy(walletId: string, request: SetPolicyRequest): Promise<WalletState> {
    const wallet = findWallet(walletId);
    if (!wallet) throw new SignerFailure("not_found");
    const { policy } = request;
    const checkChain = (envelope: Envelope) => {
      if (
        envelope.type !== "set-policy" ||
        envelope.walletId !== walletId ||
        policy.walletId !== walletId ||
        policy.workspaceId !== wallet.workspace_id ||
        envelope.policyHash !== policyHash(policy)
      ) {
        throw new SignerFailure("envelope_mismatch");
      }
      const current = currentPolicy(walletId);
      if (envelope.previousPolicyHash !== (current?.hash ?? null)) {
        throw new SignerFailure("policy_changed");
      }
      const revision = current ? current.policy.revision + 1 : 1;
      if (policy.revision !== revision || policy.previousHash !== (current?.hash ?? null)) {
        throw new SignerFailure("policy_invalid");
      }
      if (policy.approvals.threshold > distinctApproverCount(wallet.workspace_id)) {
        throw new SignerFailure("threshold_unreachable");
      }
      // Policies are approved at the admin threshold, so a wallet threshold above it protects
      // nothing: fewer people could approve a policy that lowers it.
      if (policy.approvals.threshold > requireWorkspace(wallet.workspace_id).admin_threshold) {
        throw new SignerFailure("policy_invalid");
      }
      // A policy that lets approvals live longer than this signer accepts would produce
      // approvals that can never be used; refuse it now, where the person can still fix it.
      if (policy.approvals.ttlSeconds > options.maxIntentTtlSeconds) {
        throw new SignerFailure("policy_invalid");
      }
    };
    return authorizedChange({
      workspaceId: wallet.workspace_id,
      authorization: request.authorization,
      type: "set-policy",
      action: "set-policy",
      check: checkChain,
      apply: (envelope) => {
        db.prepare(
          "INSERT INTO policies (wallet_id, revision, policy_hash, policy, approval_id, set_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          walletId,
          policy.revision,
          policyHash(policy),
          canonicalJson(policy),
          envelope.approvalId,
          options.now(),
        );
      },
      state: () => walletState(walletId),
    });
  }

  function buildTransaction(intent: Intent, params: SignRequest["transaction"]): EvmTransaction {
    const { operation } = intent;
    const base = {
      chainId: evmChainNumber(intent.chainId),
      nonce: params.nonce,
      gas: BigInt(params.gas),
      maxFeePerGas: BigInt(params.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(params.maxPriorityFeePerGas),
    };
    switch (operation.type) {
      case "evm.transfer":
        return { ...base, to: operation.to, value: BigInt(operation.valueWei) };
      case "evm.erc20.transfer":
        return {
          ...base,
          to: operation.token,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [operation.to, BigInt(operation.amount)],
          }),
        };
      case "evm.call":
        return {
          ...base,
          to: operation.to,
          value: BigInt(operation.valueWei),
          data: operation.data,
        };
    }
  }

  async function sign(request: SignRequest): Promise<SignResponse> {
    const { intent, authorization, transaction: params } = request;
    const { envelope } = authorization;
    requireWorkspace(envelope.workspaceId);
    return decide(envelope.workspaceId, envelope.approvalId, "sign", async (allow) => {
      // Idempotency first: a retry of an approval already signed gets the same transaction.
      if (priorOutcome(envelope, "signed") === "replay")
        return storedSignature(envelope.approvalId);

      if (envelope.type !== "approve-intent") throw new SignerFailure("envelope_mismatch");
      const wallet = findWallet(envelope.walletId);
      if (!wallet) throw new SignerFailure("not_found");
      if (
        wallet.workspace_id !== envelope.workspaceId ||
        intent.workspaceId !== envelope.workspaceId ||
        intent.walletId !== envelope.walletId ||
        intent.agentId !== envelope.agentId ||
        intent.chainId !== envelope.chainId
      ) {
        throw new SignerFailure("envelope_mismatch");
      }
      if (intentHash(intent) !== envelope.intentHash) throw new SignerFailure("intent_mismatch");

      if (requireWorkspace(envelope.workspaceId).paused === 1) {
        throw new SignerFailure("workspace_paused");
      }
      const policy = currentPolicy(wallet.wallet_id);
      if (!policy) throw new SignerFailure("policy_missing");
      if (policy.hash !== envelope.policyHash) throw new SignerFailure("policy_changed");

      await verify(
        authorization,
        envelope.workspaceId,
        policy.policy.approvals.threshold,
        Math.min(policy.policy.approvals.ttlSeconds, options.maxIntentTtlSeconds),
      );

      const gas = BigInt(params.gas);
      const maxFee = BigInt(params.maxFeePerGas);
      if (gas * maxFee > BigInt(intent.maxFeeWei) || BigInt(params.maxPriorityFeePerGas) > maxFee) {
        throw new SignerFailure("fee_cap_exceeded");
      }

      // The critical section. Synchronous from here to COMMIT: no other request can see the
      // ledger between the check and the record.
      return transaction(db, () => {
        if (priorOutcome(envelope, "signed") === "replay") {
          return storedSignature(envelope.approvalId);
        }
        const workspace = requireWorkspace(envelope.workspaceId);
        if (workspace.paused === 1) throw new SignerFailure("workspace_paused");
        const live = currentPolicy(wallet.wallet_id);
        if (!live || live.hash !== envelope.policyHash) throw new SignerFailure("policy_changed");
        assertApproversStillPresent(authorization, envelope.workspaceId);
        consumeNonce(envelope);
        // The account nonce of the transaction is the caller's choice and may repeat: a local
        // chain that was reset starts counting from zero again, and replacing a transaction that
        // never landed needs its nonce. What cannot repeat is the approval: one approval, one
        // signature.

        const spent = spentSince(wallet.wallet_id, options.now() - DAY_SECONDS);
        const decision = evaluateIntent(
          live.policy,
          intent,
          (chainId, asset) => spent.get(`${chainId}|${asset}`) ?? 0n,
        );
        if (!decision.allowed) throw new SignerFailure("policy_denied", decision.code);

        const credential = open(
          options.tokenKey,
          wallet.sealed_credential,
          credentialContext(wallet.wallet_id),
        ).toString("utf8");
        const unsigned = buildTransaction(intent, params);
        let signed: Hex;
        try {
          signed = vault.signEvmTransaction(wallet.wallet_id as WalletId, credential, unsigned);
        } catch (error) {
          log.error("vault sign failed", {
            walletId: wallet.wallet_id,
            reason: error instanceof VaultError ? error.reason : "unknown",
          });
          throw new SignerFailure("vault_error");
        }
        if (!isSignedBy(signed, unsigned, wallet.address)) {
          log.error("vault returned a signature that does not match", {
            walletId: wallet.wallet_id,
          });
          throw new SignerFailure("vault_error");
        }
        const transactionHash = keccak256(signed);
        const at = options.now();
        recordApproval(envelope, "signed");
        db.prepare(
          "INSERT INTO signatures (approval_id, wallet_id, chain_id, tx_nonce, signed_transaction, transaction_hash, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          envelope.approvalId,
          wallet.wallet_id,
          intent.chainId,
          params.nonce,
          signed,
          transactionHash,
          at,
        );
        const { asset, amount } = intentSpend(intent);
        db.prepare(
          "INSERT INTO spends (approval_id, wallet_id, chain_id, asset, amount, at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(envelope.approvalId, wallet.wallet_id, intent.chainId, asset, amount.toString(), at);
        allow();
        return {
          approvalId: envelope.approvalId,
          walletId: wallet.wallet_id as WalletId,
          from: wallet.address as Address,
          signedTransaction: signed,
          transactionHash,
        };
      });
    });
  }

  /**
   * Refuse an approval id for good. Revoking twice is a no-op; an id already signed or applied,
   * or revoked in another workspace, is a conflict. Recorded in the workspace's decision log.
   */
  function revokeApproval(approvalId: string, workspaceId: string): Promise<ApprovalState> {
    requireWorkspace(workspaceId);
    return decide(workspaceId, approvalId, "revoke-approval", (allow) =>
      transaction(db, () => {
        const row = findApproval(approvalId);
        if (row && (row.state !== "revoked" || row.workspace_id !== workspaceId)) {
          throw new SignerFailure("conflict");
        }
        if (!row) {
          db.prepare(
            "INSERT INTO approvals (approval_id, workspace_id, state, envelope_digest, at) VALUES (?, ?, 'revoked', NULL, ?)",
          ).run(approvalId, workspaceId, options.now());
          allow();
        }
        return getApproval(approvalId);
      }),
    );
  }

  function getApproval(approvalId: string): ApprovalState {
    const row = findApproval(approvalId);
    if (!row)
      return { approvalId: approvalId as ApprovalId, state: "unknown", transactionHash: null };
    const signature =
      row.state === "signed"
        ? (db
            .prepare("SELECT transaction_hash FROM signatures WHERE approval_id = ?")
            .get(approvalId) as { transaction_hash: string } | undefined)
        : undefined;
    return {
      approvalId: approvalId as ApprovalId,
      state: row.state,
      transactionHash: (signature?.transaction_hash as Hex | undefined) ?? null,
    };
  }

  function decisions(workspaceId: string, after: number, limit: number): SignerDecision[] {
    requireWorkspace(workspaceId);
    return listDecisions(db, workspaceId as WorkspaceId, after, limit);
  }

  return {
    createWorkspace,
    getWorkspace: workspaceState,
    pauseWorkspace,
    resumeWorkspace,
    addApprover,
    removeApprover,
    setAdminThreshold,
    listDecisions: decisions,
    createWallet,
    getWallet: walletState,
    setPolicy,
    sign,
    revokeApproval,
    getApproval,
    enrollApproverByOperator,
    verifyDecisionLog: (workspaceId: WorkspaceId) => {
      // An unknown workspace has no log; reporting it as intact would mislead an operator.
      requireWorkspace(workspaceId);
      return verifyDecisions(db, workspaceId);
    },
  };
}
