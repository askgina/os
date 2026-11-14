import { type SignerErrorCode, signerErrorStatus } from "@askgina/os-protocol/signer";

// One fixed message per code. Responses and logs never quote what a caller sent.
const MESSAGES: Record<SignerErrorCode, string> = {
  invalid_request: "the request is malformed",
  unauthenticated: "the request signature is missing, invalid or stale",
  not_found: "not found",
  conflict: "the request conflicts with what the signer already holds",
  workspace_paused: "the workspace is paused",
  approval_revoked: "the approval was revoked",
  envelope_mismatch: "the envelope does not match the request",
  envelope_expired: "the envelope has expired",
  envelope_not_yet_valid: "the envelope is dated in the future",
  envelope_ttl_too_long: "the envelope is valid for longer than allowed",
  nonce_reused: "the nonce was already used",
  intent_mismatch: "the intent does not match the approved intent hash",
  policy_missing: "the wallet has no policy",
  policy_changed: "the wallet's policy changed since the approval",
  policy_denied: "the wallet's policy denies this",
  policy_invalid: "the policy is not a valid next revision",
  fee_cap_exceeded: "the transaction fee exceeds the approved ceiling",
  insufficient_approvals: "not enough approvals",
  assertion_invalid: "a passkey assertion is invalid",
  approver_unknown: "an assertion comes from a passkey that may not approve here",
  recovery_code_invalid: "the recovery code is invalid, used or expired",
  threshold_unreachable: "the change would leave a threshold that cannot be met",
  vault_error: "the key store failed",
  internal: "internal error",
};

/** A refusal with a contract error code. `detail` is a policy reason code, never user content. */
export class SignerFailure extends Error {
  override readonly name = "SignerFailure";
  readonly code: SignerErrorCode;
  readonly detail: string | undefined;

  constructor(code: SignerErrorCode, detail?: string) {
    super(MESSAGES[code]);
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return signerErrorStatus[this.code];
  }

  body() {
    return {
      error: {
        code: this.code,
        message: MESSAGES[this.code],
        ...(this.detail === undefined ? {} : { detail: this.detail }),
      },
    };
  }
}
