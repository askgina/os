import { z } from "zod";
import { ApproverCredential, Authorization } from "../envelopes.ts";
import { Intent } from "../intent.ts";
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
  PositiveAmount,
  UserId,
  WalletId,
  WorkspaceId,
} from "../primitives.ts";

/**
 * The signer's HTTP API. Only the control plane can reach it, and every request except the
 * health check carries a request signature (see `request-signature.ts`). That signature only
 * says "this came from the control plane". Whatever adds authority (signing, a new policy, a new
 * approver, resuming) also needs passkey assertions that the signer verifies itself.
 */
export const signerRoutes = {
  health: { method: "GET", path: "/healthz" },
  createWorkspace: { method: "POST", path: "/v1/workspaces" },
  getWorkspace: { method: "GET", path: "/v1/workspaces/:workspaceId" },
  pauseWorkspace: { method: "POST", path: "/v1/workspaces/:workspaceId/pause" },
  resumeWorkspace: { method: "POST", path: "/v1/workspaces/:workspaceId/resume" },
  addApprover: { method: "POST", path: "/v1/workspaces/:workspaceId/approvers" },
  removeApprover: { method: "POST", path: "/v1/workspaces/:workspaceId/approvers/remove" },
  setAdminThreshold: { method: "POST", path: "/v1/workspaces/:workspaceId/admin-threshold" },
  listDecisions: { method: "GET", path: "/v1/workspaces/:workspaceId/decisions" },
  createWallet: { method: "POST", path: "/v1/wallets" },
  getWallet: { method: "GET", path: "/v1/wallets/:walletId" },
  setPolicy: { method: "PUT", path: "/v1/wallets/:walletId/policy" },
  sign: { method: "POST", path: "/v1/sign" },
  revokeApproval: { method: "POST", path: "/v1/approvals/:approvalId/revoke" },
  getApproval: { method: "GET", path: "/v1/approvals/:approvalId" },
} as const;

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

export const WorkspaceState = z.strictObject({
  workspaceId: WorkspaceId,
  adminThreshold: z.number().int(),
  paused: z.boolean(),
  approvers: z.array(
    z.strictObject({ userId: UserId, credentialId: Base64Url, addedAt: EpochSeconds }),
  ),
});
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/** Carries an `add-approver`, `remove-approver`, `set-admin-threshold` or `resume-workspace` envelope. */
export const AuthorizedRequest = z.strictObject({ authorization: Authorization });
export type AuthorizedRequest = z.infer<typeof AuthorizedRequest>;

/**
 * Add an approver with assertions from existing approvers. There is no way over HTTP to add one
 * without them: recovery after every passkey is lost happens on the signer host itself, through
 * the operator's admin CLI, because whoever relays a request over HTTP (the control plane) would
 * otherwise choose the key that gets enrolled.
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

export const WalletState = z.strictObject({
  walletId: WalletId,
  workspaceId: WorkspaceId,
  kind: WalletKind,
  label: z.string(),
  address: Address,
  policy: WalletPolicy.nullable(),
  policyHash: Digest.nullable(),
  /** What the signer has signed for in the last 24 hours, per asset. */
  spent: z.array(z.strictObject({ chainId: ChainId, asset: AssetRef, amount: Amount })),
});
export type WalletState = z.infer<typeof WalletState>;

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
 * What the signer knows about an approval id.
 * - `unknown`: never seen.
 * - `revoked`: refused for good; no signature exists or will exist.
 * - `signed`: an intent was signed; `transactionHash` is set.
 * - `applied`: a non-signing envelope (policy, approver, threshold, resume) took effect.
 */
export const ApprovalState = z.strictObject({
  approvalId: ApprovalId,
  state: z.enum(["unknown", "revoked", "signed", "applied"]),
  transactionHash: Hex32.nullable(),
});
export type ApprovalState = z.infer<typeof ApprovalState>;

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
  // 403: the request was understood and refused
  "workspace_paused",
  "approval_revoked",
  "envelope_mismatch",
  "envelope_expired",
  "envelope_not_yet_valid",
  "envelope_ttl_too_long",
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
  // 500
  "vault_error",
  "internal",
]);
export type SignerErrorCode = z.infer<typeof SignerErrorCode>;

export const signerErrorStatus: Record<SignerErrorCode, 400 | 401 | 403 | 404 | 409 | 500> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_found: 404,
  conflict: 409,
  workspace_paused: 403,
  approval_revoked: 403,
  envelope_mismatch: 403,
  envelope_expired: 403,
  envelope_not_yet_valid: 403,
  envelope_ttl_too_long: 403,
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
  vault_error: 500,
  internal: 500,
};

export const SignerErrorBody = z.strictObject({
  error: z.strictObject({
    code: SignerErrorCode,
    message: z.string(),
    /** For `policy_denied`: the policy engine's reason code. Never secret material. */
    detail: z.string().optional(),
  }),
});
export type SignerErrorBody = z.infer<typeof SignerErrorBody>;
