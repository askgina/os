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
import { z } from "zod";

/**
 * The members of creation options that @simplewebauthn/browser decodes and the browser requires;
 * options without them fail in the library or the browser whatever else they hold.
 */
const CreationOptionsCore = z.looseObject({
  challenge: z.string(),
  rp: z.looseObject({}),
  user: z.looseObject({ id: z.string() }),
  pubKeyCredParams: z.array(z.looseObject({})),
});

/** The member of request options that @simplewebauthn/browser decodes before every prompt. */
const RequestOptionsCore = z.looseObject({ challenge: z.string() });

/** Creation options, whole: the core is checked here, the rest by the library and the browser. */
const CreationOptions = z.custom<PublicKeyCredentialCreationOptionsJSON>(
  (value) => CreationOptionsCore.safeParse(value).success,
);

/** Request options, whole: the core is checked here, the rest by the library and the browser. */
const RequestOptions = z.custom<PublicKeyCredentialRequestOptionsJSON>(
  (value) => RequestOptionsCore.safeParse(value).success,
);

/**
 * The server builds WebAuthn options with @simplewebauthn/server and the contract carries them
 * as opaque JSON; they go to the browser library unchanged, which validates them itself. The
 * browser's answer is checked against the contract's schema before it is sent.
 */
export async function createPasskey(options: WebAuthnOptions): Promise<RegistrationResponseValue> {
  const response = await startRegistration({ optionsJSON: CreationOptions.parse(options) });

  return RegistrationResponse.parse(response);
}

export async function signWithPasskey(options: WebAuthnOptions): Promise<AssertionResponseValue> {
  const response = await startAuthentication({ optionsJSON: RequestOptions.parse(options) });

  return AssertionResponse.parse(response);
}
