import { z } from "zod";
import { ConfirmationSubject, PasskeyRequest } from "../confirmation.ts";
import {
  ApproveIntentEnvelope,
  ApproverCredential,
  Assertion,
  AssertionResponse,
  Authorization,
  Envelope,
} from "../envelopes.ts";
import { Intent } from "../intent.ts";
import { Mandate, mandateHash } from "../mandate.ts";
import { WalletPolicy } from "../policy.ts";
import {
  Address,
  Amount,
  ApprovalId,
  AssetRef,
  Base64Url,
  ChainId,
  Digest,
  EpochSeconds,
  Hex,
  Hex32,
  MandateId,
  PositiveAmount,
  UserId,
  WalletId,
  WorkspaceId,
} from "../primitives.ts";
import { Sweep } from "../sweep.ts";

/**
 * Which secret signs a route's requests (see `request-signature.ts`).
 * - `control`: the control plane's secret. Everything except the confirm routes.
 * - `confirm`: the `approve` service's secret. Only the routes the confirmation page needs.
 * - `unsigned`: the health check.
 * A request signed with the other scope's secret is `unauthenticated`.
 */
export type SignerRouteScope = "control" | "confirm" | "unsigned";

/**
 * The signer's HTTP API. Only the control plane and the `approve` service can reach it, and every
 * request except the health check carries a request signature made with the secret of its
 * route's scope. That signature only says which of the two sent it. Whatever adds authority
 * (signing, a new policy, a new approver, resuming) or schedules a key's destruction (retiring a
 * wallet, deleting a workspace) also needs passkey assertions that the signer verifies itself.
 * Cancelling a scheduled destruction, and finalizing one whose time has come, need only the
 * request signature: the first only keeps a key, and the second does what people approved.
 */
export const signerRoutes = {
  health: { method: "GET", path: "/healthz", scope: "unsigned" },
  createWorkspace: { method: "POST", path: "/v1/workspaces", scope: "control" },
  getWorkspace: { method: "GET", path: "/v1/workspaces/:workspaceId", scope: "control" },
  pauseWorkspace: { method: "POST", path: "/v1/workspaces/:workspaceId/pause", scope: "control" },
  resumeWorkspace: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/resume",
    scope: "control",
  },
  addApprover: { method: "POST", path: "/v1/workspaces/:workspaceId/approvers", scope: "control" },
  removeApprover: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/approvers/remove",
    scope: "control",
  },
  setAdminThreshold: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/admin-threshold",
    scope: "control",
  },
  listDecisions: { method: "GET", path: "/v1/workspaces/:workspaceId/decisions", scope: "control" },
  createWallet: { method: "POST", path: "/v1/wallets", scope: "control" },
  getWallet: { method: "GET", path: "/v1/wallets/:walletId", scope: "control" },
  setPolicy: { method: "PUT", path: "/v1/wallets/:walletId/policy", scope: "control" },
  retireWallet: { method: "POST", path: "/v1/wallets/:walletId/retire", scope: "control" },
  cancelRetireWallet: {
    method: "POST",
    path: "/v1/wallets/:walletId/retire/cancel",
    scope: "control",
  },
  finalizeRetireWallet: {
    method: "POST",
    path: "/v1/wallets/:walletId/retire/finalize",
    scope: "control",
  },
  deleteWorkspace: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/delete",
    scope: "control",
  },
  cancelDeleteWorkspace: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/delete/cancel",
    scope: "control",
  },
  finalizeDeleteWorkspace: {
    method: "POST",
    path: "/v1/workspaces/:workspaceId/delete/finalize",
    scope: "control",
  },
  sign: { method: "POST", path: "/v1/sign", scope: "control" },
  sweep: { method: "POST", path: "/v1/wallets/:walletId/sweep", scope: "control" },
  revokeApproval: { method: "POST", path: "/v1/approvals/:approvalId/revoke", scope: "control" },
  getApproval: { method: "GET", path: "/v1/approvals/:approvalId", scope: "control" },
  reprice: { method: "POST", path: "/v1/approvals/:approvalId/reprice", scope: "control" },
  cancelTransaction: {
    method: "POST",
    path: "/v1/approvals/:approvalId/cancel",
    scope: "control",
  },
  grantMandate: { method: "PUT", path: "/v1/mandates/:mandateId", scope: "control" },
  getMandate: { method: "GET", path: "/v1/mandates/:mandateId", scope: "control" },
  listMandates: { method: "GET", path: "/v1/wallets/:walletId/mandates", scope: "control" },
  revokeMandate: { method: "POST", path: "/v1/mandates/:mandateId/revoke", scope: "control" },
  signUnderMandate: { method: "POST", path: "/v1/mandates/:mandateId/sign", scope: "control" },
  openConfirmation: {
    method: "POST",
    path: "/v1/approvals/:approvalId/confirmation",
    scope: "control",
  },
  listConfirmationAssertions: {
    method: "GET",
    path: "/v1/approvals/:approvalId/assertions",
    scope: "control",
  },
  getConfirmation: { method: "GET", path: "/v1/confirm/:approvalId", scope: "confirm" },
  submitConfirmation: {
    method: "POST",
    path: "/v1/confirm/:approvalId/assertions",
    scope: "confirm",
  },
  getPossession: { method: "GET", path: "/v1/confirm/:approvalId/possession", scope: "confirm" },
  submitPossession: {
    method: "POST",
    path: "/v1/confirm/:approvalId/possession",
    scope: "confirm",
  },
} as const satisfies Record<
  string,
  { method: "GET" | "POST" | "PUT"; path: string; scope: SignerRouteScope }
>;

export const HealthResponse = z.strictObject({ ok: z.literal(true), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

// --- workspaces -------------------------------------------------------------------------------

/**
 * Register a workspace with its first approvers. Trust on first use: the signer cannot check who
 * these people are, only keep the set from changing later without their passkeys. Repeating the
 * identical request is a no-op; a different request for an existing workspace is a conflict.
 */
export const CreateWorkspaceRequest = z.strictObject({
  workspaceId: WorkspaceId,
  adminThreshold: z.number().int().min(1).max(16),
  approvers: z.array(ApproverCredential).min(1).max(64),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/**
 * Where a workspace stands in its lifecycle.
 * - `active`: as always; it may also be paused.
 * - `deleting`: a `delete-workspace` envelope applied; the workspace is paused and its wallets
 *   are retiring until `destroyAfter`. Any member can still cancel.
 * - `deleted`: the deletion was finalized; its keys are destroyed and the signer refuses every
 *   request for it except reading its state and its decision log.
 */
export const WorkspaceLifecycle = z.enum(["active", "deleting", "deleted"]);
export type WorkspaceLifecycle = z.infer<typeof WorkspaceLifecycle>;

export const WorkspaceState = z
  .strictObject({
    workspaceId: WorkspaceId,
    adminThreshold: z.number().int(),
    paused: z.boolean(),
    approvers: z.array(
      z.strictObject({ userId: UserId, credentialId: Base64Url, addedAt: EpochSeconds }),
    ),
    state: WorkspaceLifecycle,
    /** When the deletion destroys keys, kept once deleted; null exactly while `active`. */
    destroyAfter: EpochSeconds.nullable(),
    /**
     * The shortest delay the signer accepts from a retire or delete envelope's `issuedAt` to its
     * `destroyAfter`, for the control plane to offer as the earliest destroy time.
     */
    minDestroyDelaySeconds: z.number().int().min(0),
  })
  .refine((state) => (state.state === "active") === (state.destroyAfter === null), {
    path: ["destroyAfter"],
    message: "only a workspace being deleted or deleted has a destroy time",
  });
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/**
 * Carries an `add-approver`, `remove-approver`, `set-admin-threshold`, `resume-workspace`,
 * `retire-wallet` or `delete-workspace` envelope.
 */
export const AuthorizedRequest = z.strictObject({ authorization: Authorization });
export type AuthorizedRequest = z.infer<typeof AuthorizedRequest>;

/**
 * Add an approver with assertions from existing approvers. There is no way over HTTP to add one
 * without them: recovery after every passkey is lost happens on the signer host itself, through
 * the operator's admin CLI, because whoever relays a request over HTTP (the control plane) would
 * otherwise choose the key that gets enrolled. The person being added must also have proven on
 * the confirmation page of this envelope that they hold its key, else `possession_unproven`.
 */
export const AddApproverRequest = AuthorizedRequest;
export type AddApproverRequest = z.infer<typeof AddApproverRequest>;

/** One line of the signer's own append-only, hash-chained record of what it allowed and refused. */
export const SignerDecision = z.strictObject({
  seq: z.number().int().min(1),
  at: EpochSeconds,
  workspaceId: WorkspaceId,
  approvalId: ApprovalId.nullable(),
  action: z.string(),
  outcome: z.enum(["allowed", "denied"]),
  /** A {@link SignerErrorCode} when denied. */
  code: z.string().nullable(),
  previousHash: Digest.nullable(),
  hash: Digest,
});
export type SignerDecision = z.infer<typeof SignerDecision>;

export const ListDecisionsResponse = z.strictObject({ decisions: z.array(SignerDecision) });
export type ListDecisionsResponse = z.infer<typeof ListDecisionsResponse>;

// --- approvals --------------------------------------------------------------------------------

/** Names the workspace, so the revocation is recorded in that workspace's decision log. */
export const RevokeApprovalRequest = z.strictObject({ workspaceId: WorkspaceId });
export type RevokeApprovalRequest = z.infer<typeof RevokeApprovalRequest>;

// --- wallets ----------------------------------------------------------------------------------

export const WalletKind = z.enum(["agent", "treasury"]);
export type WalletKind = z.infer<typeof WalletKind>;

/** Create a wallet with no policy: it can sign nothing until a policy is approved. Idempotent by id. */
export const CreateWalletRequest = z.strictObject({
  workspaceId: WorkspaceId,
  walletId: WalletId,
  kind: WalletKind,
  label: z.string().min(1).max(64),
});
export type CreateWalletRequest = z.infer<typeof CreateWalletRequest>;

/**
 * Where a wallet stands in its lifecycle.
 * - `active`: signs within its policy.
 * - `retiring`: a `retire-wallet` or `delete-workspace` envelope applied; it signs nothing, and
 *   its key is destroyed at `destroyAfter` or later unless the retirement is cancelled.
 * - `held`: its retirement was cancelled; it keeps its key and signs nothing until a new policy
 *   is approved for it, which makes it `active` again.
 * - `destroyed`: its key is gone.
 */
export const WalletLifecycle = z.enum(["active", "retiring", "held", "destroyed"]);
export type WalletLifecycle = z.infer<typeof WalletLifecycle>;

export const WalletState = z
  .strictObject({
    walletId: WalletId,
    workspaceId: WorkspaceId,
    kind: WalletKind,
    label: z.string(),
    address: Address,
    policy: WalletPolicy.nullable(),
    policyHash: Digest.nullable(),
    /** What the signer has signed for in the last 24 hours, per asset. */
    spent: z.array(z.strictObject({ chainId: ChainId, asset: AssetRef, amount: Amount })),
    state: WalletLifecycle,
    /** When its key is, or was, destroyed; null exactly while `active` or `held`. */
    destroyAfter: EpochSeconds.nullable(),
  })
  .refine(
    (wallet) =>
      (wallet.state === "retiring" || wallet.state === "destroyed") ===
      (wallet.destroyAfter !== null),
    {
      path: ["destroyAfter"],
      message: "only a retiring or destroyed wallet has a destroy time",
    },
  );
export type WalletState = z.infer<typeof WalletState>;

/**
 * Cancel or finalize a wallet's retirement. Needs no passkey; names the workspace, so the step is
 * recorded in that workspace's decision log. The workspace routes of the same steps take an
 * empty body.
 */
export const RetireWalletStepRequest = z.strictObject({ workspaceId: WorkspaceId });
export type RetireWalletStepRequest = z.infer<typeof RetireWalletStepRequest>;

/** Carries a `set-policy` envelope whose `policyHash` is the hash of `policy`. */
export const SetPolicyRequest = z.strictObject({
  policy: WalletPolicy,
  authorization: Authorization,
});
export type SetPolicyRequest = z.infer<typeof SetPolicyRequest>;

// --- signing ----------------------------------------------------------------------------------

/**
 * The only parts of a transaction the caller chooses after approval. The signer derives `to`,
 * `value`, `data` and the chain from the intent, and refuses when `gas * maxFeePerGas` exceeds
 * the intent's `maxFeeWei` or when `maxPriorityFeePerGas` exceeds `maxFeePerGas`.
 */
export const TransactionParams = z.strictObject({
  nonce: z.number().int().min(0),
  gas: PositiveAmount,
  maxFeePerGas: PositiveAmount,
  maxPriorityFeePerGas: Amount,
});
export type TransactionParams = z.infer<typeof TransactionParams>;

/**
 * Sign one EIP-1559 transaction for an approved intent. Carries an `approve-intent` envelope.
 * Repeating the request for an approval that was already signed returns the same signed
 * transaction; it never produces a second signature.
 */
export const SignRequest = z.strictObject({
  intent: Intent,
  authorization: Authorization,
  transaction: TransactionParams,
});
export type SignRequest = z.infer<typeof SignRequest>;

export const SignResponse = z.strictObject({
  approvalId: ApprovalId,
  walletId: WalletId,
  from: Address,
  signedTransaction: Hex,
  transactionHash: Hex32,
});
export type SignResponse = z.infer<typeof SignResponse>;

/**
 * Sign the one transaction of an approved sweep. Carries a `sweep-wallet` envelope whose
 * `sweepHash` is the hash of `sweep`. The signer builds the transfer from `sweep`, refuses a
 * destination that is neither on the wallet's recipient allowlist nor a treasury wallet of the
 * same workspace, and returns the same transaction for a repeated request.
 */
export const SweepRequest = z.strictObject({
  sweep: Sweep,
  authorization: Authorization,
  transaction: TransactionParams,
});
export type SweepRequest = z.infer<typeof SweepRequest>;

// --- attempts ---------------------------------------------------------------------------------

/**
 * What an attempt is. Every attempt of one approval has the account nonce of its first
 * signature, so at most one of them can be mined.
 * - `original`: attempt 0, the first signature (`POST /v1/sign`, a sweep, or a mandate use).
 * - `reprice`: the same transaction with both fees higher, signed with no new passkey.
 * - `cancel`: a transfer of nothing from the wallet to itself, approved by a `cancel-transaction`
 *   envelope, or a later reprice of one: once a cancel exists, every later attempt is one.
 */
export const TransactionAttemptKind = z.enum(["original", "reprice", "cancel"]);
export type TransactionAttemptKind = z.infer<typeof TransactionAttemptKind>;

/** One signed transaction of an approval, as the signer recorded it. */
export const TransactionAttempt = z
  .strictObject({
    attempt: z.number().int().min(0),
    kind: TransactionAttemptKind,
    transactionHash: Hex32,
    gas: PositiveAmount,
    maxFeePerGas: PositiveAmount,
    maxPriorityFeePerGas: Amount,
    signedAt: EpochSeconds,
  })
  .refine((attempt) => (attempt.kind === "original") === (attempt.attempt === 0), {
    path: ["kind"],
    message: "attempt 0, and only attempt 0, is the original",
  });
export type TransactionAttempt = z.infer<typeof TransactionAttempt>;

/** The fees of one more attempt. `attempt` is the number the caller expects to create. */
const NextAttempt = {
  /** The latest attempt's number plus one. Any other number is a `conflict`. */
  attempt: z.number().int().min(1),
  maxFeePerGas: PositiveAmount,
  maxPriorityFeePerGas: Amount,
};

/**
 * Sign the transaction of an already signed approval again with both fees higher
 * (`POST /v1/approvals/:approvalId/reprice`). No passkey: the request names what the first
 * signature was bound to, and the signer checks it against its own record.
 * - An approved intent: the `intent` and the `approve-intent` envelope people approved, without
 *   assertions. The envelope's digest must be the one the signer stored, and the intent's hash
 *   the envelope's.
 * - A mandate use: the `intent` and the `mandateId` it was signed under. The use's
 *   `mandateUseDigest` must be the one the signer stored.
 * Repeating a request for an attempt that exists with the same fees returns it.
 */
export const RepriceRequest = z.union([
  z.strictObject({ intent: Intent, envelope: ApproveIntentEnvelope, ...NextAttempt }),
  z.strictObject({ intent: Intent, mandateId: MandateId, ...NextAttempt }),
]);
export type RepriceRequest = z.infer<typeof RepriceRequest>;

/**
 * Sign a cancel of an already signed approval (`POST /v1/approvals/:approvalId/cancel`). Carries
 * a `cancel-transaction` envelope whose `targetApprovalId` is the path's approval id. Repeating
 * the request with the same envelope returns the attempt it produced.
 */
export const CancelTransactionRequest = z.strictObject({
  authorization: Authorization,
  ...NextAttempt,
});
export type CancelTransactionRequest = z.infer<typeof CancelTransactionRequest>;

/** One attempt the signer signed, with its bytes, ready to broadcast. */
export const AttemptResponse = z.strictObject({
  /** The approval whose transaction the attempt replaces: the path's approval id. */
  approvalId: ApprovalId,
  walletId: WalletId,
  from: Address,
  attempt: TransactionAttempt,
  signedTransaction: Hex,
});
export type AttemptResponse = z.infer<typeof AttemptResponse>;

/**
 * What the signer knows about an approval id.
 * - `unknown`: never seen.
 * - `revoked`: refused for good; no signature exists or will exist.
 * - `signed`: an intent, a sweep or a mandate use was signed; `transactionHash` is the first
 *   signature's, and `attempts` lists every attempt, the first included, by number.
 * - `applied`: a non-signing envelope (policy, approver, threshold, resume, grant, retire,
 *   delete) took effect.
 *   For a `cancel-transaction` envelope, `attempts` holds the one attempt it produced and
 *   `transactionHash` is that attempt's.
 * Otherwise `attempts` is empty.
 */
export const ApprovalState = z.strictObject({
  approvalId: ApprovalId,
  state: z.enum(["unknown", "revoked", "signed", "applied"]),
  transactionHash: Hex32.nullable(),
  attempts: z.array(TransactionAttempt).max(64),
});
export type ApprovalState = z.infer<typeof ApprovalState>;

// --- mandates ---------------------------------------------------------------------------------

/**
 * Grant a mandate. Carries a `grant-mandate` envelope whose `mandateId`, wallet, agent and
 * workspace are the mandate's and whose `mandateHash` is its hash, approved at the workspace's
 * admin threshold. The signer refuses a mandate that does not fit the wallet's current policy
 * or its own lifetime ceiling (`mandate_invalid`). Repeating the identical grant returns the
 * stored state.
 */
export const GrantMandateRequest = z.strictObject({
  mandate: Mandate,
  authorization: Authorization,
});
export type GrantMandateRequest = z.infer<typeof GrantMandateRequest>;

/**
 * End a mandate for good. Needs no passkey, because it only removes authority; names the
 * workspace, so the revocation is recorded in that workspace's decision log. Revoking twice
 * changes nothing.
 */
export const RevokeMandateRequest = z.strictObject({ workspaceId: WorkspaceId });
export type RevokeMandateRequest = z.infer<typeof RevokeMandateRequest>;

/**
 * Sign one EIP-1559 transaction for an intent under a mandate, with no passkey. `approvalId` is
 * the control plane's id for this one use. The signer checks the mandate and the wallet's policy
 * against its own records and counts the use in the same database transaction as the signature.
 * Repeating the request for a use that was already signed returns the same signed transaction.
 */
export const SignUnderMandateRequest = z.strictObject({
  approvalId: ApprovalId,
  intent: Intent,
  transaction: TransactionParams,
});
export type SignUnderMandateRequest = z.infer<typeof SignUnderMandateRequest>;

/**
 * Where a mandate stands, computed by the signer when it answers.
 * - `revoked`: ended for good.
 * - `not_yet_valid`, `expired`: the signer's clock is before `notBefore`, or at or after `notAfter`.
 * - `exhausted`: `maxUses` uses were made, or every asset reached its `maxTotal`.
 * - `active`: none of the above; a use can still be refused by its caps or the wallet's policy.
 */
export const MandateStatus = z.enum(["active", "not_yet_valid", "expired", "exhausted", "revoked"]);
export type MandateStatus = z.infer<typeof MandateStatus>;

/**
 * Why a mandate was revoked: someone asked (`requested`), an approver who granted it was removed
 * (`grantor_removed`), or the operator ended it on the signer host (`operator`).
 */
export const MandateRevokedReason = z.enum(["requested", "grantor_removed", "operator"]);
export type MandateRevokedReason = z.infer<typeof MandateRevokedReason>;

/** A mandate as the signer holds it, with what was signed under it so far. */
export const MandateState = z
  .strictObject({
    mandate: Mandate,
    mandateHash: Digest,
    status: MandateStatus,
    /** The approval id of the `grant-mandate` envelope. */
    grantApprovalId: ApprovalId,
    grantedAt: EpochSeconds,
    /** The people whose assertions granted it. */
    grantedBy: z.array(UserId).min(1).max(16),
    revokedAt: EpochSeconds.nullable(),
    revokedReason: MandateRevokedReason.nullable(),
    usage: z.strictObject({
      uses: z.number().int().min(0),
      /** One entry per asset of the mandate: all-time and in the last `windowSeconds`. */
      assets: z
        .array(
          z.strictObject({ chainId: ChainId, asset: AssetRef, total: Amount, inWindow: Amount }),
        )
        .max(16),
    }),
  })
  .refine(
    (state) =>
      (state.status === "revoked") === (state.revokedAt !== null) &&
      (state.revokedAt === null) === (state.revokedReason === null),
    { path: ["revokedAt"], message: "only a revoked mandate has a revocation time and reason" },
  )
  .refine(
    (state) =>
      Mandate.safeParse(state.mandate).success && mandateHash(state.mandate) === state.mandateHash,
    { path: ["mandateHash"], message: "mandateHash must be the mandate's hash" },
  );
export type MandateState = z.infer<typeof MandateState>;

/** Every mandate of a wallet the signer holds, live or ended. */
export const ListMandatesResponse = z.strictObject({ mandates: z.array(MandateState) });
export type ListMandatesResponse = z.infer<typeof ListMandatesResponse>;

// --- confirmations ----------------------------------------------------------------------------

/**
 * The header that carries a confirmation token on the confirm routes. The token is the
 * secret part of a confirmation link: 16 random bytes, base64url. The signer keeps only its
 * SHA-256, and a wrong token is `not_found`.
 */
export const CONFIRM_TOKEN_HEADER = "x-confirm-token";
export const ConfirmToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "expected 16 bytes, base64url");

/**
 * Open the confirmation page for a pending approval (control scope). The signer checks that the
 * subject is exactly what the envelope names and stores both; the page is then built from them
 * and the signer's own records. Opening again with the same envelope issues a new token and the
 * old link stops working; another envelope for the same approval is a `conflict`.
 */
export const OpenConfirmationRequest = z.strictObject({
  envelope: Envelope,
  subject: ConfirmationSubject,
});
export type OpenConfirmationRequest = z.infer<typeof OpenConfirmationRequest>;

/** `/a/<approvalId>#<token>`, to append to the confirmation page's origin. */
export const OpenConfirmationResponse = z.strictObject({
  path: z.string().refine((path) => {
    const parts = /^\/a\/([^/#]+)#([^#]*)$/.exec(path);
    return (
      parts !== null &&
      ApprovalId.safeParse(parts[1]).success &&
      ConfirmToken.safeParse(parts[2]).success
    );
  }, "expected /a/<approval id>#<token>"),
});
export type OpenConfirmationResponse = z.infer<typeof OpenConfirmationResponse>;

/**
 * The assertions people made on the confirmation page for one approval (control scope), from
 * people who are still approvers of the workspace, each with the signer's own record of who
 * they are. The control plane counts them and sends them back to sign or apply as today.
 */
export const ListConfirmationAssertionsResponse = z.strictObject({
  assertions: z.array(Assertion).max(256),
});
export type ListConfirmationAssertionsResponse = z.infer<typeof ListConfirmationAssertionsResponse>;

/**
 * One person's passkey assertion, made on the confirmation page (confirm scope). The signer
 * finds the approver by the credential id and accepts only an assertion the browser made at the
 * approval origin, not in a cross-origin frame.
 */
export const SubmitConfirmationRequest = z.strictObject({ response: AssertionResponse });
export type SubmitConfirmationRequest = z.infer<typeof SubmitConfirmationRequest>;

export const SubmitConfirmationResponse = z.strictObject({
  collected: z.number().int().min(0),
  required: z.number().int().min(1),
  /** The control plane's page for the request, where the page sends the person next. */
  returnUrl: z.url({ protocol: /^https?$/ }),
});
export type SubmitConfirmationResponse = z.infer<typeof SubmitConfirmationResponse>;

/**
 * The possession step of an `add-approver` request (confirm scope): what the confirmation page
 * asks the new passkey to sign. Only the envelope's credential may answer, and the challenge is
 * `possessionChallenge({ approvalId, credentialId, nonce })` with a random nonce the signer
 * keeps until an answer uses it; the next call after that gets a new one.
 */
export const GetPossessionResponse = PasskeyRequest;
export type GetPossessionResponse = z.infer<typeof GetPossessionResponse>;

/**
 * The new person's answer to the possession step (confirm scope). The signer verifies it against
 * the envelope's public key, made top-level at the approval origin with user verification, and
 * records that the key's holder was there. Until then the request takes no approval and the
 * signer adds no approver for it (`possession_unproven`).
 */
export const SubmitPossessionRequest = z.strictObject({ response: AssertionResponse });
export type SubmitPossessionRequest = z.infer<typeof SubmitPossessionRequest>;

export const SubmitPossessionResponse = z.strictObject({
  /** `keyFingerprint` of the proven key, for the new person to read to the approvers. */
  fingerprint: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/),
});
export type SubmitPossessionResponse = z.infer<typeof SubmitPossessionResponse>;

// --- errors -----------------------------------------------------------------------------------

export const SignerErrorCode = z.enum([
  // 400
  "invalid_request",
  // 401
  "unauthenticated",
  // 404
  "not_found",
  // 409
  "conflict",
  /** The approval can no longer collect assertions: revoked, used, expired, superseded or complete. */
  "confirmation_closed",
  /**
   * An approver change whose new person has not proven on the confirmation page that they hold
   * the passkey it adds: it takes no approval and the signer adds no one.
   */
  "possession_unproven",
  /** A finalize before `destroyAfter` by the signer's clock. */
  "destroy_not_due",
  // 429
  /** More than 64 assertions were submitted for one confirmation. */
  "rate_limited",
  // 403: the request was understood and refused
  "workspace_paused",
  "approval_revoked",
  "envelope_mismatch",
  "envelope_expired",
  "envelope_not_yet_valid",
  "envelope_ttl_too_long",
  /** Issued before the signer's restore fence: propose it again. */
  "envelope_fenced",
  "nonce_reused",
  "intent_mismatch",
  "policy_missing",
  "policy_changed",
  "policy_denied",
  "policy_invalid",
  "fee_cap_exceeded",
  "insufficient_approvals",
  "assertion_invalid",
  "approver_unknown",
  "threshold_unreachable",
  /** A sweep to an address that is neither allowlisted for the wallet nor its workspace's treasury. */
  "sweep_destination_not_allowed",
  "mandate_revoked",
  "mandate_expired",
  "mandate_not_yet_valid",
  /** The mandate does not cover the intent; `detail` is a `MandateDenyCode`. */
  "mandate_denied",
  /** The mandate cannot be granted; `detail` is a `MandateGrantRefusal`. */
  "mandate_invalid",
  /** A reprice or cancel whose fees are not both above the latest attempt's. */
  "fee_not_raised",
  /** The approval has `SIGNER_MAX_TX_ATTEMPTS` attempts already. */
  "attempts_exhausted",
  /** More than `SIGNER_REPRICE_WINDOW_SECONDS` since the first signature: only a cancel now. */
  "reprice_window_closed",
  /** The workspace is being deleted: only cancelling or finalizing the deletion, and reads. */
  "workspace_deleting",
  /** The workspace was deleted: only reading its state and its decision log. */
  "workspace_deleted",
  /** The wallet is retiring, held or destroyed: it signs nothing and takes no mandate. */
  "wallet_retired",
  /** A retire or delete envelope's wallets are not exactly the signer's, by id and address. */
  "wallet_set_mismatch",
  /** `destroyAfter − issuedAt` is outside the signer's minimum and maximum destroy delay. */
  "destroy_delay_out_of_range",
  // 500
  "vault_error",
  "internal",
]);
export type SignerErrorCode = z.infer<typeof SignerErrorCode>;

export const signerErrorStatus: Record<SignerErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 500> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  confirmation_closed: 409,
  possession_unproven: 409,
  rate_limited: 429,
  workspace_paused: 403,
  approval_revoked: 403,
  envelope_mismatch: 403,
  envelope_expired: 403,
  envelope_not_yet_valid: 403,
  envelope_ttl_too_long: 403,
  envelope_fenced: 403,
  nonce_reused: 403,
  intent_mismatch: 403,
  policy_missing: 403,
  policy_changed: 403,
  policy_denied: 403,
  policy_invalid: 403,
  fee_cap_exceeded: 403,
  insufficient_approvals: 403,
  assertion_invalid: 403,
  approver_unknown: 403,
  threshold_unreachable: 403,
  sweep_destination_not_allowed: 403,
  mandate_revoked: 403,
  mandate_expired: 403,
  mandate_not_yet_valid: 403,
  mandate_denied: 403,
  mandate_invalid: 403,
  fee_not_raised: 403,
  attempts_exhausted: 403,
  reprice_window_closed: 403,
  workspace_deleting: 403,
  workspace_deleted: 403,
  wallet_retired: 403,
  wallet_set_mismatch: 403,
  destroy_delay_out_of_range: 403,
  destroy_not_due: 409,
  vault_error: 500,
  internal: 500,
};

export const SignerErrorBody = z.strictObject({
  error: z.strictObject({
    code: SignerErrorCode,
    message: z.string(),
    /**
     * The reason code for `policy_denied` (a `PolicyDenyCode`), `mandate_denied` (a
     * `MandateDenyCode`) and `mandate_invalid` (a `MandateGrantRefusal`). Never secret material.
     */
    detail: z.string().optional(),
  }),
});
export type SignerErrorBody = z.infer<typeof SignerErrorBody>;
