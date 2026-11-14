import {
  type AuthenticationResponseJSON,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { type ApproverCredential, type Authorization, envelopeChallenge } from "../envelopes.ts";
import type { UserId } from "../primitives.ts";

/** The WebAuthn relying party a deployment is configured as. Never derived from a request. */
export interface RelyingParty {
  /** The RP ID passkeys were registered under, for example `localhost` or `os.example.com`. */
  id: string;
  /** Exact origins the approval page may be served from, for example `https://os.example.com`. */
  origins: readonly string[];
}

export const AUTHORIZATION_FAILURES = [
  "envelope_expired",
  "envelope_not_yet_valid",
  "envelope_ttl_too_long",
  "approver_unknown",
  "assertion_invalid",
  "insufficient_approvals",
] as const;
export type AuthorizationFailure = (typeof AUTHORIZATION_FAILURES)[number];

export type AuthorizationVerdict =
  | { ok: true; approvedBy: UserId[] }
  | { ok: false; code: AuthorizationFailure; message: string };

export interface VerifyAuthorizationInput {
  authorization: Authorization;
  /** The workspace's approvers, from the verifier's own records. */
  approvers: readonly ApproverCredential[];
  relyingParty: RelyingParty;
  /** How many different people must have approved. */
  threshold: number;
  /** Longest lifetime this kind of envelope may have. */
  maxTtlSeconds: number;
  /** The verifier's clock, in seconds since the Unix epoch. */
  now: number;
}

/** How far ahead of the verifier's clock an envelope's `issuedAt` may be. */
export const CLOCK_SKEW_SECONDS = 30;

/**
 * Check that enough known approvers signed this exact envelope with their passkeys.
 *
 * The challenge is recomputed here from the envelope; nothing the caller says about the
 * challenge is trusted. Every assertion must be valid: one unknown approver or one bad signature
 * fails the whole authorization, so a person removed from a workspace invalidates the pending
 * approvals they took part in.
 *
 * This proves that the approvers' authenticators signed the envelope's digest with user
 * verification. It does not prove the approvers saw the right details, and it does not stop a
 * replay: the caller must record the envelope's nonce as used, atomically with acting on it.
 */
export async function verifyAuthorization(
  input: VerifyAuthorizationInput,
): Promise<AuthorizationVerdict> {
  const { envelope, assertions } = input.authorization;
  if (envelope.issuedAt > input.now + CLOCK_SKEW_SECONDS) {
    return fail("envelope_not_yet_valid", "the envelope is dated in the future");
  }
  if (input.now >= envelope.expiresAt) {
    return fail("envelope_expired", "the envelope has expired");
  }
  if (envelope.expiresAt - envelope.issuedAt > input.maxTtlSeconds) {
    return fail("envelope_ttl_too_long", "the envelope is valid for longer than allowed");
  }

  const expectedChallenge = Buffer.from(envelopeChallenge(envelope)).toString("base64url");
  const approvedBy = new Set<UserId>();
  for (const assertion of assertions) {
    const approver = input.approvers.find(
      (candidate) =>
        candidate.credentialId === assertion.credentialId && candidate.userId === assertion.userId,
    );
    if (!approver) {
      return fail(
        "approver_unknown",
        "an assertion comes from a passkey that may not approve here",
      );
    }
    if (assertion.response.id !== approver.credentialId || approvedBy.has(approver.userId)) {
      return fail("assertion_invalid", "an assertion is mislabelled or repeats a person");
    }
    try {
      const { verified } = await verifyAuthenticationResponse({
        // Shape-checked by the `AssertionResponse` schema; the library validates the contents.
        response: assertion.response as unknown as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: [...input.relyingParty.origins],
        expectedRPID: input.relyingParty.id,
        credential: {
          id: approver.credentialId,
          publicKey: new Uint8Array(Buffer.from(approver.publicKey, "base64url")),
          // Synced passkeys report a counter of 0 forever, so the counter cannot stop a replay.
          // The envelope's single-use nonce does that.
          counter: 0,
        },
        requireUserVerification: true,
      });
      if (!verified) return fail("assertion_invalid", "an assertion did not verify");
    } catch (error) {
      return fail(
        "assertion_invalid",
        error instanceof Error ? error.message : "invalid assertion",
      );
    }
    approvedBy.add(approver.userId);
  }
  if (approvedBy.size < input.threshold) {
    return fail(
      "insufficient_approvals",
      `${approvedBy.size} of ${input.threshold} required approvals`,
    );
  }
  return { ok: true, approvedBy: [...approvedBy] };
}

function fail(code: AuthorizationFailure, message: string): AuthorizationVerdict {
  return { ok: false, code, message };
}
