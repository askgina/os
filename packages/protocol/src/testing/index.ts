import {
  type ApproverCredential,
  type Assertion,
  AssertionResponse,
  type Envelope,
  envelopeChallenge,
} from "../envelopes.ts";
import type { UserId } from "../primitives.ts";
import {
  b64url,
  coseEc2,
  type SoftAuthenticator,
  type SoftCredential,
} from "./soft-authenticator.ts";

export * from "./soft-authenticator.ts";

/** The record a signer keeps for a passkey that lives in a {@link SoftAuthenticator}. */
export function approverCredentialOf(
  userId: UserId,
  credential: SoftCredential,
): ApproverCredential {
  return {
    userId,
    credentialId: b64url(credential.id),
    publicKey: b64url(coseEc2(credential.publicKey)),
  };
}

/** What a browser would send after a person approved `envelope` with their passkey. */
export function assertEnvelope(
  authenticator: SoftAuthenticator,
  input: { userId: UserId; credentialId: string; envelope: Envelope; origin: string },
): Assertion {
  return {
    userId: input.userId,
    credentialId: input.credentialId,
    response: AssertionResponse.parse(
      authenticator.authenticate({
        credentialId: input.credentialId,
        challenge: b64url(envelopeChallenge(input.envelope)),
        origin: input.origin,
      }),
    ),
  };
}
