import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AddApproverEnvelope,
  type Address,
  type ApprovalId,
  type ApproverCredential,
  type Assertion,
  AssertionResponse,
  type AssetLabel,
  type ChainLabel,
  type ConfirmationState,
  ConfirmationSubject,
  type ConfirmationView,
  canonicalJson,
  checkMandateAgainstPolicy,
  checkSubject,
  Envelope,
  envelopeChallenge,
  intentSpend,
  keyFingerprint,
  PROTOCOL_VERSION,
  possessionChallenge,
  renderConfirmation,
  type UserId,
  type WalletId,
  type WorkspaceId,
  walletsToDestroy,
} from "@askgina/os-protocol";
import type {
  GetPossessionResponse,
  ListConfirmationAssertionsResponse,
  OpenConfirmationRequest,
  OpenConfirmationResponse,
  SignerErrorCode,
  SubmitConfirmationResponse,
  SubmitPossessionResponse,
} from "@askgina/os-protocol/signer";
import { verifyAuthorization, verifyPossession } from "@askgina/os-protocol/webauthn";
import { transaction } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import { envelopeDigest, type SignerRecords } from "./signer.ts";

/**
 * Confirmation pages. The control plane opens one for a pending approval with the envelope and
 * the subject its hash names; the `approve` service fetches the view and submits passkey
 * assertions made on the confirmation page; the control plane lists the stored assertions and
 * uses them as before. The view is built from the stored envelope and subject and the signer's
 * own records, never from anything the control plane says about them, and an assertion is
 * accepted only if the browser made it at the approval origin.
 *
 * An approver change has one more step: the person being added proves on the same page, with
 * the passkey the envelope carries, that they hold it. Until then the request takes no
 * approval, and the signer adds no approver for it (`possession_unproven`).
 *
 * Nothing here adds authority: an assertion is verified again, with all the others, when the
 * signer signs or applies the approval, and a proven possession only lifts a refusal. These
 * routes are logged to stdout, not to the decision log.
 */

/** Submissions per confirmation, counted whatever their outcome. */
const MAX_ATTEMPTS = 64;
const TOKEN_BYTES = 16;
/** A possession challenge's nonce, the size of an envelope's. */
const NONCE_BYTES = 16;
/** How long the page lets the browser wait for the passkey, in milliseconds. */
const WEBAUTHN_TIMEOUT_MS = 120_000;

export interface ConfirmationOptions {
  db: DatabaseSync;
  records: SignerRecords;
  /** The RP ID passkeys were registered under. */
  rpId: string;
  /** The confirmation page's origin: the only origin an assertion submitted here may come from. */
  approvalOrigin: string;
  /** The control plane's origin, where the page sends the person afterwards. */
  returnOrigin: string;
  chains: readonly ChainLabel[];
  assets: readonly AssetLabel[];
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
  /** The signer's lifetime ceiling for mandates, as it applies to a grant. */
  maxMandateSeconds: number;
  /** Attempts per approval, the first included: a cancel needs room for one more. */
  maxTxAttempts: number;
  now: () => number;
  log: Logger;
}

export interface Confirmations {
  /** Control scope. */
  openConfirmation(
    approvalId: ApprovalId,
    request: OpenConfirmationRequest,
  ): OpenConfirmationResponse;
  /** Confirm scope. A wrong token is `not_found`. */
  getConfirmation(approvalId: ApprovalId, token: string): ConfirmationView;
  /** Confirm scope. A wrong token is `not_found`. */
  submitConfirmation(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitConfirmationResponse>;
  /** Control scope. */
  listConfirmationAssertions(approvalId: ApprovalId): ListConfirmationAssertionsResponse;
  /**
   * Confirm scope. The challenge for the new passkey of an approver change: the same one until
   * an answer uses it, then a new one. Another kind of request has no such step: `not_found`.
   */
  getPossession(approvalId: ApprovalId, token: string): GetPossessionResponse;
  /** Confirm scope. The answer to the current challenge, made at the approval origin. */
  submitPossession(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitPossessionResponse>;
}

type ConfirmationRow = {
  approval_id: string;
  workspace_id: string;
  envelope_digest: string;
  envelope: string;
  subject: string;
  token_hash: string;
  attempts: number;
  possession_proven_at: number | null;
  created_at: number;
};

type AssertionRow = { user_id: string; credential_id: string; response: string };

/** What the signer requires of an approval: how many people, and how long its envelope may live. */
type Rules = { required: number; maxTtlSeconds: number };

/** Why the signer would refuse an envelope however many people approve it. */
type Superseded = {
  code: Extract<
    SignerErrorCode,
    | "envelope_fenced"
    | "policy_missing"
    | "policy_changed"
    | "mandate_invalid"
    | "fee_cap_exceeded"
    | "attempts_exhausted"
  >;
  /** The grant-time reason, for `mandate_invalid`. */
  detail?: string;
};

const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest();

function walletIdOf(envelope: Envelope): WalletId | null {
  switch (envelope.type) {
    case "approve-intent":
    case "set-policy":
    case "sweep-wallet":
    case "grant-mandate":
    case "cancel-transaction":
      return envelope.walletId;
    default:
      return null;
  }
}

export function createConfirmations(options: ConfirmationOptions): Confirmations {
  const { db, records, log } = options;
  const relyingParty = { id: options.rpId, origins: [options.approvalOrigin] };

  function find(approvalId: string): ConfirmationRow | undefined {
    return db.prepare("SELECT * FROM confirmations WHERE approval_id = ?").get(approvalId) as
      | ConfirmationRow
      | undefined;
  }

  /** The row when `token` is its current token. Everything else is `not_found`. */
  function rowForToken(approvalId: ApprovalId, token: string): ConfirmationRow {
    const row = find(approvalId);
    if (!row || !/^[A-Za-z0-9_-]{22}$/.test(token)) throw new SignerFailure("not_found");
    if (!timingSafeEqual(tokenHash(token), Buffer.from(row.token_hash, "hex"))) {
      throw new SignerFailure("not_found");
    }
    return row;
  }

  // Written by `openConfirmation` from parsed values; parsed again only to type them.
  function stored(row: ConfirmationRow): { envelope: Envelope; subject: ConfirmationSubject } {
    return {
      envelope: Envelope.parse(JSON.parse(row.envelope)),
      subject: ConfirmationSubject.parse(JSON.parse(row.subject)),
    };
  }

  function workspaceOf(row: ConfirmationRow) {
    const workspace = records.findWorkspace(row.workspace_id);
    if (!workspace) throw new SignerFailure("internal");
    return workspace;
  }

  /**
   * As the signer checks when it acts: a payment needs its policy's threshold within its
   * policy's lifetime, a cancel its wallet's current policy's, everything else the workspace's
   * admin threshold. A payment's policy is the one its envelope names, which opening checked was
   * current, so it is in the signer's history; a cancel's wallet had a policy when it was opened,
   * and a wallet's policy is only ever replaced.
   */
  function rulesFor(envelope: Envelope, adminThreshold: number): Rules {
    const policy =
      envelope.type === "approve-intent"
        ? records.policyByHash(envelope.walletId, envelope.policyHash)
        : envelope.type === "cancel-transaction"
          ? (records.currentPolicy(envelope.walletId)?.policy ?? null)
          : undefined;
    if (policy === undefined) {
      return { required: adminThreshold, maxTtlSeconds: options.maxAdminTtlSeconds };
    }
    if (policy === null) throw new SignerFailure("internal");
    return {
      required: policy.approvals.threshold,
      maxTtlSeconds: Math.min(policy.approvals.ttlSeconds, options.maxIntentTtlSeconds),
    };
  }

  /**
   * Why the signer would refuse this envelope however many people approve it, or null. A grant
   * is superseded while the wallet has no policy or the mandate does not fit the current policy,
   * the signer's clock or its lifetime ceiling (`mandate_invalid` with the reason): no approval
   * can make it apply then. A policy edited back to admit it reopens it, since this is computed
   * each time. The cap on live mandates is not part of it: that only waits for one to end.
   */
  function supersededBy(envelope: Envelope, subject: ConfirmationSubject): Superseded | null {
    if (records.isFenced(envelope)) return { code: "envelope_fenced" };
    if (envelope.type === "approve-intent") {
      const current = records.currentPolicy(envelope.walletId);
      if (!current) return { code: "policy_missing" };
      return current.hash === envelope.policyHash ? null : { code: "policy_changed" };
    }
    if (envelope.type === "set-policy") {
      const current = records.currentPolicy(envelope.walletId);
      return (current?.hash ?? null) === envelope.previousPolicyHash
        ? null
        : { code: "policy_changed" };
    }
    if (envelope.type === "grant-mandate" && subject.kind === "grant-mandate") {
      const current = records.currentPolicy(envelope.walletId);
      if (!current) return { code: "policy_missing" };
      const refusal = checkMandateAgainstPolicy(subject.mandate, current.policy, {
        now: options.now(),
        maxSeconds: options.maxMandateSeconds,
      });
      return refusal === null ? null : { code: "mandate_invalid", detail: refusal };
    }
    if (envelope.type === "cancel-transaction") {
      const current = records.currentPolicy(envelope.walletId);
      if (!current) return { code: "policy_missing" };
      if (BigInt(envelope.maxFeeWei) > BigInt(current.policy.fees.maxPerTxWei)) {
        return { code: "fee_cap_exceeded" };
      }
      const target = records.cancelTarget(envelope);
      if (target !== null && target.attempts >= options.maxTxAttempts) {
        return { code: "attempts_exhausted" };
      }
    }
    return null;
  }

  /**
   * The stored assertions of people who are still approvers with the same passkey, oldest
   * first. An assertion from a removed passkey would fail the whole authorization at signing.
   */
  function collected(row: ConfirmationRow, approvers: readonly ApproverCredential[]): Assertion[] {
    const current = new Map(approvers.map((approver) => [approver.credentialId, approver.userId]));
    const rows = db
      .prepare(
        "SELECT user_id, credential_id, response FROM confirmation_assertions WHERE approval_id = ? ORDER BY at, user_id",
      )
      .all(row.approval_id) as AssertionRow[];
    return rows
      .filter((stored) => current.get(stored.credential_id) === stored.user_id)
      .map((stored) => ({
        userId: stored.user_id as UserId,
        credentialId: stored.credential_id,
        response: AssertionResponse.parse(JSON.parse(stored.response)),
      }));
  }

  function stateOf(
    envelope: Envelope,
    subject: ConfirmationSubject,
    collectedCount: number,
    required: number,
  ): ConfirmationState {
    const approval = records.findApproval(envelope.approvalId);
    if (approval?.state === "revoked") return "revoked";
    if (approval) return "used";
    if (options.now() >= envelope.expiresAt) return "expired";
    if (supersededBy(envelope, subject) !== null) return "superseded";
    if (collectedCount >= required) return "complete";
    return "open";
  }

  const returnUrl = (row: ConfirmationRow) =>
    `${options.returnOrigin}/w/${row.workspace_id}/approvals/${row.approval_id}`;

  function openConfirmation(
    approvalId: ApprovalId,
    request: OpenConfirmationRequest,
  ): OpenConfirmationResponse {
    const { envelope, subject } = request;
    if (envelope.approvalId !== approvalId) throw new SignerFailure("envelope_mismatch");
    if (!records.findWorkspace(envelope.workspaceId)) throw new SignerFailure("not_found");
    const mismatch = checkSubject(envelope, subject);
    if (mismatch !== null) throw new SignerFailure(mismatch);
    const walletId = walletIdOf(envelope);
    if (walletId !== null) {
      const wallet = records.findWallet(walletId);
      if (!wallet) throw new SignerFailure("not_found");
      if (wallet.workspace_id !== envelope.workspaceId) {
        throw new SignerFailure("envelope_mismatch");
      }
    }
    // A cancel names a signature of this signer: its wallet, chain and account nonce.
    if (envelope.type === "cancel-transaction" && records.cancelTarget(envelope) === null) {
      throw new SignerFailure("envelope_mismatch");
    }
    if (options.now() >= envelope.expiresAt) throw new SignerFailure("envelope_expired");

    const digest = envelopeDigest(envelope);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const reopened = transaction(db, () => {
      const approval = records.findApproval(approvalId);
      if (approval?.state === "revoked") throw new SignerFailure("approval_revoked");
      if (approval) throw new SignerFailure("confirmation_closed");
      const superseded = supersededBy(envelope, subject);
      if (superseded !== null) throw new SignerFailure(superseded.code, superseded.detail);
      const existing = find(approvalId);
      if (existing && existing.envelope_digest !== digest) throw new SignerFailure("conflict");
      const hash = tokenHash(token).toString("hex");
      if (existing) {
        db.prepare("UPDATE confirmations SET token_hash = ? WHERE approval_id = ?").run(
          hash,
          approvalId,
        );
      } else {
        db.prepare(
          "INSERT INTO confirmations (approval_id, workspace_id, envelope_digest, envelope, subject, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          approvalId,
          envelope.workspaceId,
          digest,
          canonicalJson(envelope),
          canonicalJson(subject),
          hash,
          options.now(),
        );
      }
      return existing !== undefined;
    });
    log.info("confirmation.opened", {
      approvalId,
      workspaceId: envelope.workspaceId,
      kind: envelope.type,
      reopened,
    });
    return { path: `/a/${approvalId}#${token}` };
  }

  function getConfirmation(approvalId: ApprovalId, token: string): ConfirmationView {
    const row = rowForToken(approvalId, token);
    const { envelope, subject } = stored(row);
    const workspace = workspaceOf(row);
    const approvers = records.approvers(row.workspace_id);
    const assertions = collected(row, approvers);
    const { required } = rulesFor(envelope, workspace.admin_threshold);
    const walletId = walletIdOf(envelope);
    const wallet = walletId === null ? undefined : records.findWallet(walletId);
    const spent24h =
      subject.kind === "approve-intent"
        ? records.spentInLastDay(
            subject.intent.walletId,
            subject.intent.chainId,
            intentSpend(subject.intent).asset,
          )
        : 0n;
    const approvals = { collected: assertions.length, required };
    const rendered = renderConfirmation({
      envelope,
      subject,
      wallet: wallet ? { label: wallet.label, address: wallet.address as Address } : null,
      chains: options.chains,
      assets: options.assets,
      currentPolicy: walletId === null ? null : (records.currentPolicy(walletId)?.policy ?? null),
      spent24h,
      approvals,
      adminThreshold: workspace.admin_threshold,
      possessionProven: row.possession_proven_at !== null,
      treasuries: walletId === null ? [] : records.treasuryAddresses(row.workspace_id, walletId),
      cancelTarget: envelope.type === "cancel-transaction" ? records.cancelTarget(envelope) : null,
      wallets: walletsToDestroy(envelope).flatMap((listed) => {
        const held = records.findWallet(listed.walletId);
        return held?.workspace_id === row.workspace_id
          ? [{ walletId: listed.walletId, label: held.label, address: held.address as Address }]
          : [];
      }),
    });
    const approved = new Set(assertions.map((assertion) => assertion.userId));
    return {
      v: PROTOCOL_VERSION,
      approvalId,
      workspaceId: row.workspace_id as WorkspaceId,
      kind: envelope.type,
      state: stateOf(envelope, subject, assertions.length, required),
      expiresAt: envelope.expiresAt,
      ...rendered,
      approvals,
      envelope,
      subject,
      webauthn: {
        rpId: options.rpId,
        challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
        allowCredentials: approvers
          .filter((approver) => !approved.has(approver.userId))
          .map((approver) => approver.credentialId),
        userVerification: "required",
        timeoutMs: WEBAUTHN_TIMEOUT_MS,
      },
      returnUrl: returnUrl(row),
    };
  }

  /**
   * Count one submission, an approval or a possession step's answer, in its own transaction
   * before anything else, so a refused one still counts.
   */
  function countAttempt(fields: { approvalId: ApprovalId; workspaceId: string }): void {
    const { attempts } = transaction(
      db,
      () =>
        db
          .prepare(
            "UPDATE confirmations SET attempts = attempts + 1 WHERE approval_id = ? RETURNING attempts",
          )
          .get(fields.approvalId) as { attempts: number },
    );
    if (attempts > MAX_ATTEMPTS) {
      log.warn("confirmation.rate_limited", { ...fields, attempts });
      throw new SignerFailure("rate_limited");
    }
  }

  async function submitConfirmation(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitConfirmationResponse> {
    const row = rowForToken(approvalId, token);
    const fields = { approvalId, workspaceId: row.workspace_id };
    countAttempt(fields);
    try {
      const { envelope, subject } = stored(row);
      const open = () => {
        const approvers = records.approvers(row.workspace_id);
        const rules = rulesFor(envelope, workspaceOf(row).admin_threshold);
        const assertions = collected(row, approvers);
        if (stateOf(envelope, subject, assertions.length, rules.required) !== "open") {
          throw new SignerFailure("confirmation_closed");
        }
        return { approvers, rules, collected: assertions.length };
      };

      const { approvers, rules } = open();
      // An approval of a key nobody has shown they hold could hand the workspace to whoever
      // chose that key. A proven possession is never withdrawn, so checking once is enough.
      if (
        envelope.type === "add-approver" &&
        (find(approvalId)?.possession_proven_at ?? null) === null
      ) {
        throw new SignerFailure("possession_unproven");
      }
      const approver = approvers.find((candidate) => candidate.credentialId === response.id);
      if (!approver) throw new SignerFailure("approver_unknown");
      // Refuses an assertion made anywhere but top-level on the approval origin.
      const verdict = await verifyAuthorization({
        authorization: {
          envelope,
          assertions: [{ userId: approver.userId, credentialId: approver.credentialId, response }],
        },
        approvers: [approver],
        relyingParty,
        threshold: 1,
        maxTtlSeconds: rules.maxTtlSeconds,
        now: options.now(),
      });
      if (!verdict.ok) throw new SignerFailure(verdict.code);

      const counted = transaction(db, () => {
        // Re-checked: while the assertion was verified the approval may have been used, revoked
        // or completed, or the passkey removed.
        const now = open();
        const still = now.approvers.some(
          (candidate) =>
            candidate.credentialId === approver.credentialId &&
            candidate.userId === approver.userId,
        );
        if (!still) throw new SignerFailure("approver_unknown");
        const previous = db
          .prepare(
            "SELECT credential_id FROM confirmation_assertions WHERE approval_id = ? AND user_id = ?",
          )
          .get(approvalId, approver.userId) as { credential_id: string } | undefined;
        // One assertion per person. One made with a passkey that is no longer theirs counts for
        // nothing, so a new one replaces it.
        if (previous && now.approvers.some((c) => c.credentialId === previous.credential_id)) {
          throw new SignerFailure("conflict");
        }
        db.prepare(
          "INSERT INTO confirmation_assertions (approval_id, user_id, credential_id, response, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (approval_id, user_id) DO UPDATE SET credential_id = excluded.credential_id, response = excluded.response, at = excluded.at",
        ).run(
          approvalId,
          approver.userId,
          approver.credentialId,
          JSON.stringify(response),
          options.now(),
        );
        return { collected: now.collected + 1, required: now.rules.required };
      });
      log.info("confirmation.assertion", { ...fields, outcome: "stored", code: null });
      return { ...counted, returnUrl: returnUrl(row) };
    } catch (error) {
      log.info("confirmation.assertion", {
        ...fields,
        outcome: "refused",
        code: error instanceof SignerFailure ? error.code : "internal",
      });
      throw error;
    }
  }

  function listConfirmationAssertions(approvalId: ApprovalId): ListConfirmationAssertionsResponse {
    const row = find(approvalId);
    if (!row) throw new SignerFailure("not_found");
    return { assertions: collected(row, records.approvers(row.workspace_id)) };
  }

  /** The envelope of an approver change. No other kind of request has a possession step. */
  function approverChange(row: ConfirmationRow): AddApproverEnvelope {
    const { envelope } = stored(row);
    if (envelope.type !== "add-approver") throw new SignerFailure("not_found");
    return envelope;
  }

  /**
   * The possession step stays open while the request can still be applied: while it is `open`,
   * and while it is `complete` with approvals collected before the step existed, which the
   * signer refuses to apply until the step is done.
   */
  function assertPossessionOpen(row: ConfirmationRow, envelope: AddApproverEnvelope): void {
    const approvers = records.approvers(row.workspace_id);
    const { required } = rulesFor(envelope, workspaceOf(row).admin_threshold);
    // An approver change names everything in its envelope.
    const state = stateOf(
      envelope,
      { kind: "envelope-only" },
      collected(row, approvers).length,
      required,
    );
    if (state !== "open" && state !== "complete") throw new SignerFailure("confirmation_closed");
  }

  function getPossession(approvalId: ApprovalId, token: string): GetPossessionResponse {
    const row = rowForToken(approvalId, token);
    const envelope = approverChange(row);
    // One challenge at a time, kept until an answer uses it: the page asks for it when it
    // loads, so the passkey prompt can run straight from the person's tap, and a second page
    // open on the same request does not end the first one's challenge.
    const nonce = transaction(db, () => {
      assertPossessionOpen(row, envelope);
      db.prepare(
        "INSERT INTO possession_challenges (approval_id, nonce) VALUES (?, ?) ON CONFLICT (approval_id) DO NOTHING",
      ).run(approvalId, randomBytes(NONCE_BYTES).toString("base64url"));
      // Present: inserted just above unless it was there already.
      const issued = db
        .prepare("SELECT nonce FROM possession_challenges WHERE approval_id = ?")
        .get(approvalId) as { nonce: string };
      return issued.nonce;
    });
    const challenge = possessionChallenge({
      approvalId,
      credentialId: envelope.credentialId,
      nonce,
    });
    return {
      rpId: options.rpId,
      challenge: Buffer.from(challenge).toString("base64url"),
      // Only the passkey being added may answer.
      allowCredentials: [envelope.credentialId],
      userVerification: "required",
      timeoutMs: WEBAUTHN_TIMEOUT_MS,
    };
  }

  async function submitPossession(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitPossessionResponse> {
    const row = rowForToken(approvalId, token);
    const fields = { approvalId, workspaceId: row.workspace_id };
    countAttempt(fields);
    try {
      const envelope = approverChange(row);
      assertPossessionOpen(row, envelope);
      // Only an answer to the challenge the signer issued, and that no answer used yet, counts.
      const issued = db
        .prepare("SELECT nonce FROM possession_challenges WHERE approval_id = ?")
        .get(approvalId) as { nonce: string } | undefined;
      if (issued === undefined) throw new SignerFailure("assertion_invalid");
      const { nonce } = issued;
      // Against the key the envelope carries, under the rule every approval meets: top-level
      // at the approval origin, `webauthn.get`, user verification.
      const verdict = await verifyPossession({
        possession: { approvalId, credentialId: envelope.credentialId, nonce },
        publicKey: envelope.publicKey,
        response,
        relyingParty,
      });
      if (!verdict.ok) throw new SignerFailure(verdict.code);
      transaction(db, () => {
        // Re-checked: while the answer was verified the request may have closed, or another
        // answer may have used the challenge.
        assertPossessionOpen(row, envelope);
        const used = db
          .prepare("DELETE FROM possession_challenges WHERE approval_id = ? AND nonce = ?")
          .run(approvalId, nonce);
        if (used.changes === 0) throw new SignerFailure("assertion_invalid");
        db.prepare(
          "UPDATE confirmations SET possession_proven_at = COALESCE(possession_proven_at, ?) WHERE approval_id = ?",
        ).run(options.now(), approvalId);
      });
      log.info("confirmation.possession", { ...fields, outcome: "proven", code: null });
      return { fingerprint: keyFingerprint(envelope.publicKey) };
    } catch (error) {
      log.info("confirmation.possession", {
        ...fields,
        outcome: "refused",
        code: error instanceof SignerFailure ? error.code : "internal",
      });
      throw error;
    }
  }

  return {
    openConfirmation,
    getConfirmation,
    submitConfirmation,
    listConfirmationAssertions,
    getPossession,
    submitPossession,
  };
}
