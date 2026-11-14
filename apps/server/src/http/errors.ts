import { type ApiErrorCode, apiErrorStatus } from "@askgina/os-api";
import { SignerError } from "@askgina/os-protocol/signer";

/** A refusal the caller should see. Anything else that is thrown becomes a plain `internal`. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly code: ApiErrorCode;
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return apiErrorStatus[this.code];
  }
}

/** What to tell the caller when the signer refuses or cannot be reached. */
export function fromSignerError(error: unknown): HttpError {
  if (error instanceof SignerError && error.code !== "internal" && error.code !== "vault_error") {
    return new HttpError(
      error.code === "policy_denied" ? "policy_denied" : "signer_refused",
      error.message,
      error.code === "policy_denied" ? error.detail : error.code,
    );
  }
  return new HttpError("internal", "the signer could not complete the request");
}
