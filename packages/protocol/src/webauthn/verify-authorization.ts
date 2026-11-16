import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { z } from "zod";
import { type PossessionChallengeInput, possessionChallenge } from "../confirmation.ts";
import {
  type ApproverCredential,
  type AssertionResponse,
  type Authorization,
  envelopeChallenge,
} from "../envelopes.ts";
import type { Base64Url, UserId } from "../primitives.ts";

/** The WebAuthn relying party a deployment is configured as. Never derived from a request. */
export interface RelyingParty {
  /** The RP ID passkeys were registered under, for example `localhost` or `os.example.com`. */
  id: string;
  /**
   * The exact origins of the confirmation page, where approvals are made, for example
   * `https://approve.os.example.com`. Never the control plane's origin: the control plane chooses
   * what its own pages show, so an assertion made there proves nothing about what a person saw.
   */
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
 * The two client data members that tell whether an assertion was made in a frame, each of any
 * value or absent. `JSON.parse` never yields `undefined`, so a member is present exactly when its
 * value is not `undefined`.
 */
const FrameClientData = z.object({
  topOrigin: z.unknown().optional(),
  crossOrigin: z.unknown().optional(),
});

/**
 * True when the browser says the assertion was made in a frame of another page (`crossOrigin`
 * true, or a `topOrigin` at all), or when its client data cannot be read. A page that frames the
 * confirmation page could otherwise obtain an assertion stamped with the confirmation page's
 * origin: `@simplewebauthn/server` accepts `crossOrigin: true` when no `topOrigin` is expected.
 */
function madeInFrame(response: AssertionResponse): boolean {
  try {
    const clientData = FrameClientData.safeParse(
      JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")),
    );

    if (!clientData.success) return true;

    if (clientData.data.topOrigin !== undefined) return true;

    return clientData.data.crossOrigin === true;
  } catch {
    return true;
  }
}

/**
 * Null when `response` is `credential`'s signature over `challenge`, made by a `webauthn.get`
 * top-level on one of the relying party's origins with user verification; otherwise why not.
 * The one rule for every assertion this package verifies.
 */
async function assertionProblem(input: {
  response: AssertionResponse;
  credential: { credentialId: string; publicKey: Base64Url };
  challenge: Uint8Array;
  relyingParty: RelyingParty;
}): Promise<string | null> {
  if (madeInFrame(input.response)) return "an assertion was made inside a frame of another page";

  try {
    const { verified } = await verifyAuthenticationResponse({
      // Shape-checked by the `AssertionResponse` schema; the library validates the contents.
      response: input.response,
      expectedChallenge: Buffer.from(input.challenge).toString("base64url"),
      expectedType: "webauthn.get",
      expectedOrigin: [...input.relyingParty.origins],
      expectedRPID: input.relyingParty.id,
      credential: {
        id: input.credential.credentialId,
        publicKey: new Uint8Array(Buffer.from(input.credential.publicKey, "base64url")),
        // Synced passkeys report a counter of 0 forever, so the counter cannot stop a replay.
        // The envelope's single-use nonce, or the possession step's, does that.
        counter: 0,
      },
      requireUserVerification: true,
    });

    return verified ? null : "an assertion did not verify";
  } catch (error) {
    return error instanceof Error ? error.message : "invalid assertion";
  }
}

/**
 * Check that enough known approvers signed this exact envelope with their passkeys.
 *
 * The challenge is recomputed here from the envelope; nothing the caller says about the
 * challenge is trusted. Every assertion must be valid: one unknown approver or one bad signature
 * fails the whole authorization, so a person removed from a workspace invalidates the pending
 * approvals they took part in. Each assertion must be a `webauthn.get` made top-level on one of
 * the relying party's origins, never inside a frame.
 *
 * This proves that the approvers' authenticators signed the envelope's digest with user
 * verification, on a page at one of those origins. It does not prove the approvers read the
 * details, and it does not stop a replay: the caller must record the envelope's nonce as used,
 * atomically with acting on it.
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

  const challenge = envelopeChallenge(envelope);
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

    const problem = await assertionProblem({
      response: assertion.response,
      credential: approver,
      challenge,
      relyingParty: input.relyingParty,
    });

    if (problem !== null) return fail("assertion_invalid", problem);
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

export interface VerifyPossessionInput {
  /** The signer's current challenge: the approval, the new credential's id, the nonce. */
  possession: PossessionChallengeInput;
  /** The new credential's COSE public key, from the `add-approver` envelope. */
  publicKey: Base64Url;
  response: AssertionResponse;
  relyingParty: RelyingParty;
}

export type PossessionVerdict =
  | { ok: true }
  | { ok: false; code: "assertion_invalid"; message: string };

/**
 * Check that the passkey an `add-approver` envelope names signed this attempt's possession
 * challenge, under the same rule as an approval: a `webauthn.get` made top-level at one of the
 * relying party's origins, with user verification. The challenge is recomputed here from
 * `possession`. This proves that whoever answered on that page holds the new key; it does not
 * say who that person is, which the people compare by the key's fingerprint.
 */
export async function verifyPossession(input: VerifyPossessionInput): Promise<PossessionVerdict> {
  if (input.response.id !== input.possession.credentialId) {
    return {
      ok: false,
      code: "assertion_invalid",
      message: "the answer comes from another passkey than the one being added",
    };
  }

  const problem = await assertionProblem({
    response: input.response,
    credential: { credentialId: input.possession.credentialId, publicKey: input.publicKey },
    challenge: possessionChallenge(input.possession),
    relyingParty: input.relyingParty,
  });

  return problem === null
    ? { ok: true }
    : { ok: false, code: "assertion_invalid", message: problem };
}
