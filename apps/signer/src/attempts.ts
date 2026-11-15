import type { DatabaseSync } from "node:sqlite";
import {
  type Address,
  type ApprovalId,
  type Authorization,
  type CancelTarget,
  type CancelTransactionEnvelope,
  type ChainId,
  Envelope,
  type EvmIntent,
  evmChainNumber,
  type Hex,
  intentHash,
  mandateUseDigest,
  type Operation,
  type WalletId,
  type WalletPolicy,
} from "@askgina/os-protocol";
import type {
  AttemptResponse,
  CancelTransactionRequest,
  RepriceRequest,
  TransactionAttempt,
  TransactionParams,
} from "@askgina/os-protocol/signer";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseTransaction,
  serializeTransaction,
} from "viem";
import { transaction } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import { readFence } from "./fence.ts";
import type { Logger } from "./log.ts";
import type { ApprovalRow, WalletRow, WorkspaceRow } from "./signer.ts";
import type { EvmTransaction } from "./vault.ts";

/**
 * Attempts after the first signature (`docs/approval-protocol.md`, section 8, "Reprices and
 * cancels"). A transaction the signer signed may never be mined. Every later attempt of the same
 * approval is signed at the account nonce of the first, so at most one of them can be mined:
 *
 * - A reprice is the same transaction with both fees higher, inside the ceiling people approved.
 *   It needs no passkey, adds no authority beyond the fee, and is allowed for a window after the
 *   first signature. The signer rebuilds it from its own record of the first signature and the
 *   approved intent, so only the two fee fields can change.
 * - A cancel is a transfer of nothing from the wallet to itself, approved with passkeys at the
 *   wallet policy's threshold (`cancel-transaction`). Once a cancel exists, every later attempt of
 *   that approval is a cancel: a reprice never turns it back into the payment.
 *
 * Neither adds nor releases a spend: the first signature's spend stands, whichever attempt lands.
 */

/** `SIGNER_MAX_TX_ATTEMPTS` unless set: attempts per approval, the first included. */
export const DEFAULT_MAX_TX_ATTEMPTS = 16;
/** `SIGNER_REPRICE_WINDOW_SECONDS` unless set: a day after the first signature. */
export const DEFAULT_REPRICE_WINDOW_SECONDS = 86_400;

/** Decision-log actions. A cancel is recorded under the cancel's approval id. */
export const ATTEMPT_ACTIONS = { reprice: "reprice", cancel: "cancel-transaction" } as const;

/** What a cancel costs: a plain transfer, the same on every EVM chain. */
const CANCEL_GAS = 21_000n;

export type SignatureRow = {
  approval_id: string;
  wallet_id: string;
  chain_id: string;
  tx_nonce: number;
  signed_transaction: string;
  transaction_hash: string;
  signed_at: number;
};

type AttemptRow = {
  approval_id: string;
  attempt: number;
  kind: "reprice" | "cancel";
  tx_nonce: number;
  gas: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  fee_ceiling_wei: string;
  cancel_approval_id: string | null;
  signed_transaction: string;
  transaction_hash: string;
  signed_at: number;
};

/** One attempt with what the signer keeps beside it. */
type AttemptRecord = {
  attempt: TransactionAttempt;
  signedTransaction: Hex;
  /** The ceiling a later cancel attempt is held to; null for the first signature and reprices. */
  cancelCeilingWei: string | null;
  cancelApprovalId: string | null;
};

/** What the attempt operations need from the signer core (`signer.ts`). */
export interface AttemptInternals {
  db: DatabaseSync;
  now: () => number;
  log: Logger;
  maxTxAttempts: number;
  repriceWindowSeconds: number;
  maxIntentTtlSeconds: number;
  decide<T>(
    workspaceId: string,
    approvalId: string | null,
    action: string,
    work: (allow: () => void) => T | Promise<T>,
  ): Promise<T>;
  verify(
    authorization: Authorization,
    workspaceId: string,
    threshold: number,
    maxTtlSeconds: number,
  ): Promise<void>;
  requireWorkspace(workspaceId: string): WorkspaceRow;
  /** A deleted workspace's signed transactions are emptied: it answers nothing about them. */
  assertNotDeleted(workspaceId: string): WorkspaceRow;
  findWallet(walletId: string): WalletRow | undefined;
  currentPolicy(walletId: string): { policy: WalletPolicy; hash: string } | null;
  findApproval(approvalId: string): ApprovalRow | undefined;
  priorOutcome(envelope: Envelope, state: "signed" | "applied"): "replay" | null;
  assertNotFenced(envelope: Envelope): void;
  assertApproversStillPresent(authorization: Authorization, workspaceId: string): void;
  consumeNonce(envelope: Envelope): void;
  recordApproval(
    approvalId: string,
    workspaceId: string,
    state: "signed" | "applied",
    digest: string,
  ): void;
  envelopeDigest(envelope: Envelope): string;
  buildTransaction(intent: EvmIntent, params: TransactionParams): EvmTransaction;
  /** Sign with the wallet's key and check the signature; records nothing. */
  signWith(wallet: WalletRow, unsigned: EvmTransaction): { signed: Hex; transactionHash: Hex };
}

/** A transaction the signer signed, without its signature: every fee field is present. */
type SignedFields = EvmTransaction & {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

function parseSigned(signed: string) {
  try {
    return parseTransaction(signed as Hex);
  } catch {
    return null;
  }
}

/** The transaction a stored signed one is, without its signature. */
function unsignedOf(signed: string): SignedFields {
  const parsed = parseSigned(signed);
  if (parsed?.type !== "eip1559") throw new SignerFailure("internal");
  const { r: _r, s: _s, v: _v, yParity: _yParity, ...unsigned } = parsed;
  const { chainId, gas, maxFeePerGas, maxPriorityFeePerGas } = unsigned;
  if (
    chainId === undefined ||
    gas === undefined ||
    maxFeePerGas === undefined ||
    maxPriorityFeePerGas === undefined
  ) {
    throw new SignerFailure("internal");
  }
  return { ...unsigned, type: "eip1559", chainId, gas, maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * What a signed transaction does, read back from its `to`, `value` and `data`: a coin transfer,
 * a token `transfer(to, amount)` that encodes back to exactly its calldata, or any other call.
 */
export function operationOf(signed: string): Operation {
  const transaction = unsignedOf(signed);
  const to = (transaction.to ?? "0x").toLowerCase() as Address;
  const value = transaction.value ?? 0n;
  const data = (transaction.data ?? "0x").toLowerCase() as Hex;
  if (data === "0x") return { type: "evm.transfer", to, valueWei: value.toString() };
  if (value === 0n) {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      if (decoded.functionName === "transfer") {
        const [recipient, amount] = decoded.args;
        const encoded = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        });
        if (encoded === data) {
          return {
            type: "evm.erc20.transfer",
            token: to,
            to: recipient.toLowerCase() as Address,
            amount: amount.toString(),
          };
        }
      }
    } catch {
      // Not a token transfer: shown as the call it is.
    }
  }
  return { type: "evm.call", to, valueWei: value.toString(), data };
}

export function createAttemptOperations(internals: AttemptInternals) {
  const { db, now, log } = internals;

  function signatureOf(approvalId: string): SignatureRow | undefined {
    return db.prepare("SELECT * FROM signatures WHERE approval_id = ?").get(approvalId) as
      | SignatureRow
      | undefined;
  }

  /** Attempt 0 from the first signature's bytes, then every later attempt by number. */
  function recordsOf(signature: SignatureRow): AttemptRecord[] {
    const first = unsignedOf(signature.signed_transaction);
    const records: AttemptRecord[] = [
      {
        attempt: {
          attempt: 0,
          kind: "original",
          transactionHash: signature.transaction_hash as Hex,
          gas: String(first.gas),
          maxFeePerGas: String(first.maxFeePerGas),
          maxPriorityFeePerGas: String(first.maxPriorityFeePerGas),
          signedAt: signature.signed_at,
        },
        signedTransaction: signature.signed_transaction as Hex,
        cancelCeilingWei: null,
        cancelApprovalId: null,
      },
    ];
    const rows = db
      .prepare("SELECT * FROM signature_attempts WHERE approval_id = ? ORDER BY attempt")
      .all(signature.approval_id) as AttemptRow[];
    for (const row of rows) records.push(recordOf(row));
    return records;
  }

  function recordOf(row: AttemptRow): AttemptRecord {
    return {
      attempt: {
        attempt: row.attempt,
        kind: row.kind,
        transactionHash: row.transaction_hash as Hex,
        gas: row.gas,
        maxFeePerGas: row.max_fee_per_gas,
        maxPriorityFeePerGas: row.max_priority_fee_per_gas,
        signedAt: row.signed_at,
      },
      signedTransaction: row.signed_transaction as Hex,
      cancelCeilingWei: row.kind === "cancel" ? row.fee_ceiling_wei : null,
      cancelApprovalId: row.cancel_approval_id,
    };
  }

  function latestOf(records: readonly AttemptRecord[]): AttemptRecord {
    const latest = records.at(-1);
    if (!latest) throw new SignerFailure("internal");
    return latest;
  }

  /** Every attempt of a signed approval, the first included; empty when it has no signature. */
  function attemptsOf(approvalId: string): TransactionAttempt[] {
    const signature = signatureOf(approvalId);
    return signature ? recordsOf(signature).map((record) => record.attempt) : [];
  }

  /** The attempt a `cancel-transaction` approval produced, or null for any other approval. */
  function producedBy(cancelApprovalId: string): {
    signature: SignatureRow;
    record: AttemptRecord;
  } | null {
    const row = db
      .prepare(
        "SELECT * FROM signature_attempts WHERE cancel_approval_id = ? ORDER BY attempt LIMIT 1",
      )
      .get(cancelApprovalId) as AttemptRow | undefined;
    if (!row) return null;
    const signature = signatureOf(row.approval_id);
    if (!signature) throw new SignerFailure("internal");
    return { signature, record: recordOf(row) };
  }

  function walletOf(signature: SignatureRow): WalletRow {
    const wallet = internals.findWallet(signature.wallet_id);
    if (!wallet) throw new SignerFailure("internal");
    return wallet;
  }

  function responseOf(signature: SignatureRow, record: AttemptRecord): AttemptResponse {
    return {
      approvalId: signature.approval_id as ApprovalId,
      walletId: signature.wallet_id as WalletId,
      from: walletOf(signature).address as Address,
      attempt: record.attempt,
      signedTransaction: record.signedTransaction,
    };
  }

  /**
   * The checks every new attempt shares, in order: the number is the next one (`conflict`), the
   * approval has room for it (`attempts_exhausted`), both fees rise above the latest attempt's
   * (`fee_not_raised`), and the tip is at most the fee cap (`fee_cap_exceeded`). Returns the
   * latest attempt.
   */
  function assertNextAttempt(
    records: readonly AttemptRecord[],
    request: { attempt: number; maxFeePerGas: string; maxPriorityFeePerGas: string },
  ): AttemptRecord {
    const latest = latestOf(records);
    if (request.attempt !== latest.attempt.attempt + 1) throw new SignerFailure("conflict");
    if (request.attempt >= internals.maxTxAttempts) {
      throw new SignerFailure("attempts_exhausted");
    }
    const maxFee = BigInt(request.maxFeePerGas);
    const tip = BigInt(request.maxPriorityFeePerGas);
    if (
      maxFee <= BigInt(latest.attempt.maxFeePerGas) ||
      tip <= BigInt(latest.attempt.maxPriorityFeePerGas)
    ) {
      throw new SignerFailure("fee_not_raised");
    }
    if (tip > maxFee) throw new SignerFailure("fee_cap_exceeded");
    return latest;
  }

  /** A transfer of nothing from the wallet to itself at the approval's nonce. */
  function selfTransfer(
    signature: SignatureRow,
    wallet: WalletRow,
    fees: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  ): EvmTransaction {
    return {
      chainId: evmChainNumber(signature.chain_id as ChainId),
      nonce: signature.tx_nonce,
      to: wallet.address as Address,
      value: 0n,
      gas: CANCEL_GAS,
      maxFeePerGas: BigInt(fees.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
    };
  }

  function assertCancelFeeWithin(maxFeePerGas: string, ceilingWei: string): void {
    if (CANCEL_GAS * BigInt(maxFeePerGas) > BigInt(ceilingWei)) {
      throw new SignerFailure("fee_cap_exceeded");
    }
  }

  /** Sign `unsigned` as the next attempt and store it. Records no spend and no envelope nonce. */
  function signAttempt(input: {
    signature: SignatureRow;
    wallet: WalletRow;
    attempt: number;
    kind: "reprice" | "cancel";
    unsigned: EvmTransaction;
    feeCeilingWei: string;
    cancelApprovalId: string | null;
  }): AttemptRecord {
    const { signature, unsigned } = input;
    const { signed, transactionHash } = internals.signWith(input.wallet, unsigned);
    const at = now();
    db.prepare(
      "INSERT INTO signature_attempts (approval_id, attempt, kind, tx_nonce, gas, max_fee_per_gas, max_priority_fee_per_gas, fee_ceiling_wei, cancel_approval_id, signed_transaction, transaction_hash, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      signature.approval_id,
      input.attempt,
      input.kind,
      signature.tx_nonce,
      String(unsigned.gas),
      String(unsigned.maxFeePerGas),
      String(unsigned.maxPriorityFeePerGas),
      input.feeCeilingWei,
      input.cancelApprovalId,
      signed,
      transactionHash,
      at,
    );
    return {
      attempt: {
        attempt: input.attempt,
        kind: input.kind,
        transactionHash,
        gas: String(unsigned.gas),
        maxFeePerGas: String(unsigned.maxFeePerGas),
        maxPriorityFeePerGas: String(unsigned.maxPriorityFeePerGas),
        signedAt: at,
      },
      signedTransaction: signed,
      cancelCeilingWei: input.kind === "cancel" ? input.feeCeilingWei : null,
      cancelApprovalId: input.cancelApprovalId,
    };
  }

  // --- reprice -----------------------------------------------------------------------------

  /**
   * The signature this request names, when the request is bound to exactly what the signer
   * recorded for it: the `approve-intent` envelope whose digest it stored and an intent of that
   * envelope's hash, or the mandate use it stored and that use's intent.
   */
  function boundSignature(approvalId: ApprovalId, request: RepriceRequest): SignatureRow {
    const approval = internals.findApproval(approvalId);
    if (!approval) throw new SignerFailure("not_found");
    if (approval.state === "revoked") throw new SignerFailure("approval_revoked");
    if (approval.state !== "signed") throw new SignerFailure("conflict");
    const signature = signatureOf(approvalId);
    if (!signature) {
      // A venue request was signed for it: there is no transaction to reprice.
      const venue = db
        .prepare("SELECT 1 FROM venue_signatures WHERE approval_id = ?")
        .get(approvalId);
      throw new SignerFailure(venue ? "conflict" : "internal");
    }
    const hash = intentHash(request.intent);
    if ("envelope" in request) {
      // An envelope that is not one (it expires before it is issued) is not the stored one.
      const envelope = Envelope.safeParse(request.envelope);
      if (
        !envelope.success ||
        envelope.data.approvalId !== approvalId ||
        internals.envelopeDigest(envelope.data) !== approval.envelope_digest
      ) {
        throw new SignerFailure("conflict");
      }
      if (hash !== request.envelope.intentHash) throw new SignerFailure("intent_mismatch");
    } else {
      const use = db
        .prepare("SELECT mandate_id FROM mandate_uses WHERE approval_id = ?")
        .get(approvalId) as { mandate_id: string } | undefined;
      if (!use || use.mandate_id !== request.mandateId) throw new SignerFailure("conflict");
      const digest = mandateUseDigest({
        approvalId,
        mandateId: request.mandateId,
        intentHash: hash,
      });
      if (digest !== approval.envelope_digest) throw new SignerFailure("intent_mismatch");
    }
    return signature;
  }

  /**
   * Sign the approval's transaction again with both fees higher. Every check and the record run
   * in one database transaction with nothing awaited, so two reprices of one approval are
   * ordered and the second sees the first. A repeat of an attempt that exists with the same fees
   * returns it, also after the window closed or while the workspace is paused.
   */
  async function reprice(
    approvalId: ApprovalId,
    request: RepriceRequest,
  ): Promise<AttemptResponse> {
    const approval = internals.findApproval(approvalId);
    if (!approval) throw new SignerFailure("not_found");
    internals.requireWorkspace(approval.workspace_id);
    return internals.decide(approval.workspace_id, approvalId, ATTEMPT_ACTIONS.reprice, (allow) =>
      transaction(db, () => {
        internals.assertNotDeleted(approval.workspace_id);
        const signature = boundSignature(approvalId, request);
        // Refused for a destroyed wallet only: a retiring one still clears a stuck transaction.
        if (walletOf(signature).state === "destroyed") throw new SignerFailure("wallet_retired");
        const records = recordsOf(signature);
        const existing = records.find((record) => record.attempt.attempt === request.attempt);
        if (existing) {
          if (
            existing.attempt.maxFeePerGas === request.maxFeePerGas &&
            existing.attempt.maxPriorityFeePerGas === request.maxPriorityFeePerGas
          ) {
            return responseOf(signature, existing);
          }
          throw new SignerFailure("conflict");
        }

        // A database restored from a backup may have forgotten attempts signed after it, a
        // cancel among them; a reprice built from what it remembers could be the payment again.
        const fence = readFence(db);
        if (fence !== null && signature.signed_at < fence) {
          throw new SignerFailure("envelope_fenced");
        }
        if (internals.requireWorkspace(approval.workspace_id).paused === 1) {
          throw new SignerFailure("workspace_paused");
        }
        if ("mandateId" in request) {
          const mandate = db
            .prepare("SELECT revoked_at FROM mandates WHERE mandate_id = ?")
            .get(request.mandateId) as { revoked_at: number | null } | undefined;
          if (!mandate) throw new SignerFailure("internal");
          if (mandate.revoked_at !== null) throw new SignerFailure("mandate_revoked");
        }
        if (now() >= signature.signed_at + internals.repriceWindowSeconds) {
          throw new SignerFailure("reprice_window_closed");
        }

        const latest = assertNextAttempt(records, request);
        const wallet = walletOf(signature);
        const policy = internals.currentPolicy(signature.wallet_id);
        if (!policy) throw new SignerFailure("policy_missing");
        // A policy that lowered the fee cap after signing caps every later fee too.
        const policyCeiling = BigInt(policy.policy.fees.maxPerTxWei);
        let next: AttemptRecord;
        if (latest.cancelCeilingWei !== null) {
          // Once cancelled, always cancelled: the reprice is of the self-transfer, under the
          // ceiling of the cancel people approved.
          let ceiling = BigInt(latest.cancelCeilingWei);
          if (policyCeiling < ceiling) ceiling = policyCeiling;
          assertCancelFeeWithin(request.maxFeePerGas, ceiling.toString());
          next = signAttempt({
            signature,
            wallet,
            attempt: request.attempt,
            kind: "cancel",
            unsigned: selfTransfer(signature, wallet, request),
            feeCeilingWei: latest.cancelCeilingWei,
            cancelApprovalId: latest.cancelApprovalId,
          });
        } else {
          const first = unsignedOf(signature.signed_transaction);
          const unsigned = internals.buildTransaction(request.intent, {
            nonce: signature.tx_nonce,
            gas: String(first.gas),
            maxFeePerGas: request.maxFeePerGas,
            maxPriorityFeePerGas: request.maxPriorityFeePerGas,
          });
          const expected = serializeTransaction({
            ...first,
            maxFeePerGas: unsigned.maxFeePerGas,
            maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas,
          });
          if (serializeTransaction({ ...unsigned, type: "eip1559" }) !== expected) {
            // The binding above makes this impossible unless the store was altered.
            log.error("a reprice rebuilt a different transaction", { approvalId });
            throw new SignerFailure("internal");
          }
          // The lower of what people approved and what the policy allows now.
          let ceiling = BigInt(request.intent.maxFeeWei);
          if (policyCeiling < ceiling) ceiling = policyCeiling;
          if (first.gas * BigInt(request.maxFeePerGas) > ceiling) {
            throw new SignerFailure("fee_cap_exceeded");
          }
          next = signAttempt({
            signature,
            wallet,
            attempt: request.attempt,
            kind: "reprice",
            unsigned,
            feeCeilingWei: ceiling.toString(),
            cancelApprovalId: null,
          });
        }
        allow();
        return responseOf(signature, next);
      }),
    );
  }

  // --- cancel ------------------------------------------------------------------------------

  /**
   * The signature a cancel envelope names, when it is one of this workspace with the envelope's
   * wallet, chain and account nonce; otherwise null.
   */
  function cancelTargetOf(
    envelope: CancelTransactionEnvelope,
  ): { signature: SignatureRow; wallet: WalletRow } | null {
    const approval = internals.findApproval(envelope.targetApprovalId);
    if (approval?.state !== "signed") return null;
    if (approval.workspace_id !== envelope.workspaceId) return null;
    const signature = signatureOf(envelope.targetApprovalId);
    if (
      !signature ||
      signature.wallet_id !== envelope.walletId ||
      signature.chain_id !== envelope.chainId ||
      signature.tx_nonce !== envelope.txNonce
    ) {
      return null;
    }
    const wallet = internals.findWallet(signature.wallet_id);
    if (!wallet || wallet.workspace_id !== envelope.workspaceId) return null;
    // A destroyed key signs nothing, and its signed transactions were emptied.
    if (wallet.state === "destroyed") return null;
    return { signature, wallet };
  }

  /** The wallet's current policy, when the cancel's fee ceiling fits its fee cap. */
  function cancelPolicy(envelope: CancelTransactionEnvelope): WalletPolicy {
    const policy = internals.currentPolicy(envelope.walletId);
    if (!policy) throw new SignerFailure("policy_missing");
    if (BigInt(envelope.maxFeeWei) > BigInt(policy.policy.fees.maxPerTxWei)) {
      throw new SignerFailure("fee_cap_exceeded");
    }
    return policy.policy;
  }

  /** What a confirmation page shows of the transaction a cancel would stop. */
  function cancelTarget(envelope: CancelTransactionEnvelope): CancelTarget | null {
    const target = cancelTargetOf(envelope);
    if (!target) return null;
    const records = recordsOf(target.signature);
    return {
      operation: operationOf(target.signature.signed_transaction),
      attempts: records.length,
      cancelling: records.some((record) => record.cancelCeilingWei !== null),
    };
  }

  function replayedCancel(cancelApprovalId: string): AttemptResponse {
    const produced = producedBy(cancelApprovalId);
    if (!produced) throw new SignerFailure("internal");
    return responseOf(produced.signature, produced.record);
  }

  /**
   * Sign a cancel of the approval's transaction: a transfer of nothing from the wallet to itself
   * at the same account nonce, under the cancel envelope's own fee ceiling. Allowed while the
   * workspace is paused: a cancel moves nothing and carries its own passkeys.
   */
  async function cancelTransaction(
    approvalId: ApprovalId,
    request: CancelTransactionRequest,
  ): Promise<AttemptResponse> {
    const { authorization } = request;
    const { envelope } = authorization;
    internals.requireWorkspace(envelope.workspaceId);
    return internals.decide(
      envelope.workspaceId,
      envelope.approvalId,
      ATTEMPT_ACTIONS.cancel,
      async (allow) => {
        if (envelope.type !== "cancel-transaction" || envelope.targetApprovalId !== approvalId) {
          throw new SignerFailure("envelope_mismatch");
        }
        // Allowed while the workspace is being deleted and the wallet retiring (owner decision
        // D7); refused once the key is destroyed.
        const assertKeyKept = () => {
          internals.assertNotDeleted(envelope.workspaceId);
          if (internals.findWallet(envelope.walletId)?.state === "destroyed") {
            throw new SignerFailure("wallet_retired");
          }
        };
        assertKeyKept();
        if (internals.priorOutcome(envelope, "applied") === "replay") {
          return replayedCancel(envelope.approvalId);
        }
        internals.assertNotFenced(envelope);
        if (!cancelTargetOf(envelope)) throw new SignerFailure("envelope_mismatch");
        const policy = cancelPolicy(envelope);
        await internals.verify(
          authorization,
          envelope.workspaceId,
          policy.approvals.threshold,
          Math.min(policy.approvals.ttlSeconds, internals.maxIntentTtlSeconds),
        );

        return transaction(db, () => {
          assertKeyKept();
          if (internals.priorOutcome(envelope, "applied") === "replay") {
            return replayedCancel(envelope.approvalId);
          }
          internals.assertNotFenced(envelope);
          const target = cancelTargetOf(envelope);
          if (!target) throw new SignerFailure("envelope_mismatch");
          // The policy may have changed while this request was being verified.
          const current = cancelPolicy(envelope);
          if (authorization.assertions.length < current.approvals.threshold) {
            throw new SignerFailure("insufficient_approvals");
          }
          internals.assertApproversStillPresent(authorization, envelope.workspaceId);
          internals.consumeNonce(envelope);

          const records = recordsOf(target.signature);
          assertNextAttempt(records, request);
          assertCancelFeeWithin(request.maxFeePerGas, envelope.maxFeeWei);
          // The approval row first: the attempt refers to it.
          internals.recordApproval(
            envelope.approvalId,
            envelope.workspaceId,
            "applied",
            internals.envelopeDigest(envelope),
          );
          const next = signAttempt({
            signature: target.signature,
            wallet: target.wallet,
            attempt: request.attempt,
            kind: "cancel",
            unsigned: selfTransfer(target.signature, target.wallet, request),
            feeCeilingWei: envelope.maxFeeWei,
            cancelApprovalId: envelope.approvalId,
          });
          allow();
          return responseOf(target.signature, next);
        });
      },
    );
  }

  /**
   * The attempts part of `GET /v1/approvals/:id`: every attempt of a signed approval, or the one
   * attempt a `cancel-transaction` approval produced with its hash.
   */
  function approvalAttempts(approval: ApprovalRow): {
    transactionHash: Hex | null;
    attempts: TransactionAttempt[];
  } {
    if (approval.state === "signed") {
      const signature = signatureOf(approval.approval_id);
      return {
        transactionHash: (signature?.transaction_hash as Hex | undefined) ?? null,
        // The signed bytes of a destroyed wallet were emptied; the first attempt's fees were
        // only in them, so no attempt is reported.
        attempts: signature?.signed_transaction === "" ? [] : attemptsOf(approval.approval_id),
      };
    }
    if (approval.state === "applied") {
      const produced = producedBy(approval.approval_id);
      if (produced) {
        return {
          transactionHash: produced.record.attempt.transactionHash,
          attempts: [produced.record.attempt],
        };
      }
    }
    return { transactionHash: null, attempts: [] };
  }

  return { reprice, cancelTransaction, cancelTarget, approvalAttempts };
}
