/**
 * Voluntary Application Server Identification (VAPID), RFC 8292: the `Authorization` header that
 * proves to a push service that a message comes from the key a subscription was made for.
 */

/** How long a token is valid. RFC 8292 §2 allows at most 24 hours. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** Import the VAPID private key (PKCS#8 DER, P-256) for signing. */
export function importVapidKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(pkcs8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * `vapid t=<JWT>, k=<public key>`: an ES256 JWT whose audience is the endpoint's origin, valid
 * for 12 hours from `now`, with the operator's contact as subject, and the public key as
 * base64url of its uncompressed point.
 */
export async function vapidAuthorization(input: {
  endpoint: URL;
  subject: string;
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  /** Unix seconds. */
  now: number;
}): Promise<string> {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));

  const claims = base64url(
    JSON.stringify({
      aud: input.endpoint.origin,
      exp: input.now + TOKEN_LIFETIME_SECONDS,
      sub: input.subject,
    }),
  );

  const signingInput = `${header}.${claims}`;

  // WebCrypto's ECDSA signature is r and s concatenated, the form JWS ES256 uses.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `vapid t=${signingInput}.${base64url(new Uint8Array(signature))}, k=${base64url(input.publicKeyRaw)}`;
}
