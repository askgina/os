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

/** What a person reads when the server's options cannot start a prompt; nothing was sent. */
const MALFORMED_OPTIONS = "The server sent passkey options this browser cannot use. Try again.";

/**
 * The server builds WebAuthn options with @simplewebauthn/server and the contract carries them
 * as opaque JSON; they go to the browser library unchanged, which validates them itself. The
 * browser's answer is checked against the contract's schema before it is sent.
 */
export async function createPasskey(options: WebAuthnOptions): Promise<RegistrationResponseValue> {
  const decoded = CreationOptions.safeParse(options);

  if (!decoded.success) throw new Error(MALFORMED_OPTIONS);

  const response = await startRegistration({ optionsJSON: decoded.data });

  return RegistrationResponse.parse(response);
}

export async function signWithPasskey(options: WebAuthnOptions): Promise<AssertionResponseValue> {
  const decoded = RequestOptions.safeParse(options);

  if (!decoded.success) throw new Error(MALFORMED_OPTIONS);

  const response = await startAuthentication({ optionsJSON: decoded.data });

  return AssertionResponse.parse(response);
}
