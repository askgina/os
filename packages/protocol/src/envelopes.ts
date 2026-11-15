import { z } from "zod";
import { DomainTag, digest } from "./canonical.ts";
import {
  AgentId,
  ApprovalId,
  Base64Url,
  ChainId,
  Digest,
  EpochSeconds,
  MandateId,
  Nonce,
  PositiveAmount,
  PROTOCOL_VERSION,
  UserId,
  WalletId,
  WorkspaceId,
} from "./primitives.ts";

/**
 * An envelope states one thing a person authorizes. Its digest is the WebAuthn challenge, so a
 * passkey assertion over an envelope cannot be moved to any other envelope: not to another
 * intent, wallet, policy, workspace, expiry or kind of operation.
 */
const envelopeHeader = {
  v: z.literal(PROTOCOL_VERSION),
  /** The control plane's approval request. The signer acts at most once per approval id. */
  approvalId: ApprovalId,
  workspaceId: WorkspaceId,
  /** Single use. The signer records it when it acts and refuses to see it again. */
  nonce: Nonce,
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds,
};

/** Sign exactly one transaction for exactly one intent under exactly one policy revision. */
export const ApproveIntentEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("approve-intent"),
  intentHash: Digest,
  walletId: WalletId,
  agentId: AgentId,
  chainId: ChainId,
  policyHash: Digest,
});
export type ApproveIntentEnvelope = z.infer<typeof ApproveIntentEnvelope>;

/** Replace a wallet's policy. `previousPolicyHash` is null only for the wallet's first policy. */
export const SetPolicyEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("set-policy"),
  walletId: WalletId,
  policyHash: Digest,
  previousPolicyHash: Digest.nullable(),
});
export type SetPolicyEnvelope = z.infer<typeof SetPolicyEnvelope>;

/** Let one more passkey approve for this workspace. */
export const AddApproverEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("add-approver"),
  userId: UserId,
  credentialId: Base64Url,
  /** The credential's COSE public key, base64url. */
  publicKey: Base64Url,
});
export type AddApproverEnvelope = z.infer<typeof AddApproverEnvelope>;

/** Stop one passkey from approving for this workspace. */
export const RemoveApproverEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("remove-approver"),
  userId: UserId,
  credentialId: Base64Url,
});
export type RemoveApproverEnvelope = z.infer<typeof RemoveApproverEnvelope>;

/** Change how many people must approve changes to approvers and policies. */
export const SetAdminThresholdEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("set-admin-threshold"),
  adminThreshold: z.number().int().min(1).max(16),
});
export type SetAdminThresholdEnvelope = z.infer<typeof SetAdminThresholdEnvelope>;

/** Let a paused workspace sign again. Pausing needs no envelope: it only removes authority. */
export const ResumeWorkspaceEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("resume-workspace"),
});
export type ResumeWorkspaceEnvelope = z.infer<typeof ResumeWorkspaceEnvelope>;

/**
 * Sign exactly one transaction that empties a wallet: the `Sweep` whose hash is `sweepHash`.
 * Approved at the admin threshold; no agent and no wallet cap is involved.
 */
export const SweepWalletEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("sweep-wallet"),
  walletId: WalletId,
  chainId: ChainId,
  sweepHash: Digest,
});
export type SweepWalletEnvelope = z.infer<typeof SweepWalletEnvelope>;

/**
 * Let one agent transfer from one wallet without a passkey per payment, within the `Mandate`
 * whose hash is `mandateHash`. Approved at the admin threshold; the wallet's policy still applies
 * to every payment.
 */
export const GrantMandateEnvelope = z.strictObject({
  ...envelopeHeader,
  type: z.literal("grant-mandate"),
  mandateId: MandateId,
  walletId: WalletId,
  agentId: AgentId,
  mandateHash: Digest,
});
export type GrantMandateEnvelope = z.infer<typeof GrantMandateEnvelope>;

/**
 * Try to stop a transaction that was signed and never mined: sign, at its account nonce
 * `txNonce`, a transfer of nothing from the wallet to itself, with `gas × maxFeePerGas` at most
 * `maxFeeWei`. `targetApprovalId` is the approval whose transaction it replaces; the signer
 * checks the wallet, chain and nonce against its own record of that signature. Approved at the
 * wallet policy's threshold. Whichever of the two the network includes first wins, so a cancel is
 * an attempt, not a guarantee.
 */
export const CancelTransactionEnvelope = z
  .strictObject({
    ...envelopeHeader,
    type: z.literal("cancel-transaction"),
    targetApprovalId: ApprovalId,
    walletId: WalletId,
    chainId: ChainId,
    txNonce: z.number().int().min(0),
    maxFeeWei: PositiveAmount,
  })
  .refine((envelope) => envelope.targetApprovalId !== envelope.approvalId, {
    path: ["targetApprovalId"],
    message: "a cancel cannot target its own approval",
  });
export type CancelTransactionEnvelope = z.infer<typeof CancelTransactionEnvelope>;

export const Envelope = z
  .discriminatedUnion("type", [
    ApproveIntentEnvelope,
    SetPolicyEnvelope,
    AddApproverEnvelope,
    RemoveApproverEnvelope,
    SetAdminThresholdEnvelope,
    ResumeWorkspaceEnvelope,
    SweepWalletEnvelope,
    GrantMandateEnvelope,
    CancelTransactionEnvelope,
  ])
  .refine((envelope) => envelope.expiresAt > envelope.issuedAt, {
    path: ["expiresAt"],
    message: "expiresAt must be after issuedAt",
  });
export type Envelope = z.infer<typeof Envelope>;
export type EnvelopeType = Envelope["type"];

/** The 32 bytes a passkey signs: the WebAuthn challenge for this envelope. */
export function envelopeChallenge(envelope: Envelope): Uint8Array {
  return digest(DomainTag.authorize, Envelope.parse(envelope));
}

/**
 * A WebAuthn authentication response as `@simplewebauthn/browser` returns it. Unknown members
 * are kept: the signature covers `clientDataJSON` and `authenticatorData`, not this wrapper.
 */
export const AssertionResponse = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Base64Url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});
export type AssertionResponse = z.infer<typeof AssertionResponse>;

/** One person's passkey assertion over an envelope's challenge. */
export const Assertion = z.strictObject({
  userId: UserId,
  credentialId: Base64Url,
  response: AssertionResponse,
});
export type Assertion = z.infer<typeof Assertion>;

/** An envelope together with the assertions that authorize it. */
export const Authorization = z.strictObject({
  envelope: Envelope,
  assertions: z.array(Assertion).min(1).max(16),
});
export type Authorization = z.infer<typeof Authorization>;

/** A passkey that may approve for a workspace, as the signer stores it. */
export const ApproverCredential = z.strictObject({
  userId: UserId,
  credentialId: Base64Url,
  /** The credential's COSE public key, base64url. */
  publicKey: Base64Url,
});
export type ApproverCredential = z.infer<typeof ApproverCredential>;
