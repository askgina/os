import {
  RegistrationResponse,
  type RegistrationResponse as RegistrationResponseValue,
  type WebAuthnOptions,
} from "@askgina/os-api";
import {
  AssertionResponse,
  type AssertionResponse as AssertionResponseValue,
} from "@askgina/os-protocol";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

/**
 * The server builds WebAuthn options with @simplewebauthn/server and the contract carries them
 * as opaque JSON; they go to the browser library unchanged, which validates them itself. The
 * browser's answer is checked against the contract's schema before it is sent.
 */
export async function createPasskey(options: WebAuthnOptions): Promise<RegistrationResponseValue> {
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });

  return RegistrationResponse.parse(response);
}

export async function signWithPasskey(options: WebAuthnOptions): Promise<AssertionResponseValue> {
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });

  return AssertionResponse.parse(response);
}
