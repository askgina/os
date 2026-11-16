// Software WebAuthn authenticator for tests (P-256 / ES256, attestation "none").
// Emits RegistrationResponseJSON / AuthenticationResponseJSON exactly as @simplewebauthn/browser 14 returns them.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cborEncode } from "./cbor.ts";

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export const fromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

const sha256 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(b).digest());

export type Flags = { up: boolean; uv: boolean; be: boolean; bs: boolean };

export type SoftCredential = {
  id: Uint8Array;
  rpId: string;
  userHandle: Uint8Array;
  privateKey: KeyObject;
  publicKey: KeyObject;
  signCount: number;
};

export type AuthenticatorOptions = {
  /** Default flags; per-call overrides win. */
  flags?: Partial<Flags>;
  /** Increment signCount on each assertion (false models synced passkeys that always report 0). */
  incrementCounter?: boolean;
  aaguid?: Uint8Array;
  transports?: AuthenticatorTransport[];
};

type CallOverrides = {
  flags?: Partial<Flags>;
  signCount?: number;
  /** clientDataJSON origin; defaults to `https://${rpId}`. */
  origin?: string;
  /** rpId whose hash goes into authenticatorData; defaults to the credential's rpId. */
  rpIdHashOf?: string;
  crossOrigin?: boolean;
  /** clientDataJSON `topOrigin`, which a browser writes only for an assertion made in a frame. */
  topOrigin?: string;
  /** clientDataJSON `type` of an assertion; defaults to `webauthn.get`. */
  clientDataType?: string;
};

function flagsByte(f: Flags, extra: number): number {
  return (f.up ? 0x01 : 0) | (f.uv ? 0x04 : 0) | (f.be ? 0x08 : 0) | (f.bs ? 0x10 : 0) | extra;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);

  return b;
}

export function coseEc2(pub: KeyObject): Uint8Array {
  const jwk = pub.export({ format: "jwk" });
  const x = fromB64url(jwk.x as string);
  const y = fromB64url(jwk.y as string);

  // kty: EC2(2), alg: ES256(-7), crv: P-256(1), x, y (CTAP2 canonical order)
  return cborEncode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;

  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }

  return out;
};

export class SoftAuthenticator {
  readonly credentials = new Map<string, SoftCredential>();
  private readonly defaults: Flags;
  private readonly incrementCounter: boolean;
  private readonly aaguid: Uint8Array;
  private readonly transports: AuthenticatorTransport[];

  constructor(opts: AuthenticatorOptions = {}) {
    this.defaults = { up: true, uv: true, be: false, bs: false, ...opts.flags };
    this.incrementCounter = opts.incrementCounter ?? true;
    this.aaguid = opts.aaguid ?? new Uint8Array(16);
    this.transports = opts.transports ?? ["internal"];
  }

  private clientData(
    type: string,
    challenge: string,
    origin: string,
    crossOrigin: boolean,
    topOrigin?: string,
  ): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        type,
        challenge,
        origin,
        crossOrigin,
        ...(topOrigin === undefined ? {} : { topOrigin }),
      }),
    );
  }

  register(args: { rpId: string; challenge: string; userHandle?: Uint8Array } & CallOverrides): {
    response: RegistrationResponseJSON;
    credential: SoftCredential;
  } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const id = new Uint8Array(randomBytes(32));

    const cred: SoftCredential = {
      id,
      rpId: args.rpId,
      userHandle: args.userHandle ?? new Uint8Array(randomBytes(16)),
      privateKey,
      publicKey,
      signCount: args.signCount ?? 0,
    };

    this.credentials.set(b64url(id), cred);
    const flags = { ...this.defaults, ...args.flags };
    const cosePub = coseEc2(publicKey);
    const credIdLen = new Uint8Array([id.length >> 8, id.length & 0xff]);

    const authData = concat(
      sha256(new TextEncoder().encode(args.rpIdHashOf ?? args.rpId)),
      Uint8Array.of(flagsByte(flags, 0x40)),
      u32be(cred.signCount),
      this.aaguid,
      credIdLen,
      id,
      cosePub,
    );

    const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });

    const clientDataJSON = this.clientData(
      "webauthn.create",
      args.challenge,
      args.origin ?? `https://${args.rpId}`,
      args.crossOrigin ?? false,
    );

    const spki = publicKey.export({ format: "der", type: "spki" });

    return {
      credential: cred,
      response: {
        id: b64url(id),
        rawId: b64url(id),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          authenticatorData: b64url(authData),
          transports: this.transports,
          publicKeyAlgorithm: -7,
          publicKey: b64url(new Uint8Array(spki)),
        },
      },
    };
  }

  authenticate(
    args: { credentialId: string; challenge: string } & CallOverrides,
  ): AuthenticationResponseJSON {
    const cred = this.credentials.get(args.credentialId);

    if (!cred) throw new Error(`soft authenticator: unknown credential ${args.credentialId}`);

    if (args.signCount !== undefined) cred.signCount = args.signCount;
    else if (this.incrementCounter) cred.signCount += 1;
    const flags = { ...this.defaults, ...args.flags };

    const authData = concat(
      sha256(new TextEncoder().encode(args.rpIdHashOf ?? cred.rpId)),
      Uint8Array.of(flagsByte(flags, 0)),
      u32be(cred.signCount),
    );

    const clientDataJSON = this.clientData(
      args.clientDataType ?? "webauthn.get",
      args.challenge,
      args.origin ?? `https://${cred.rpId}`,
      args.crossOrigin ?? false,
      args.topOrigin,
    );

    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), cred.privateKey);

    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(new Uint8Array(signature)),
        userHandle: b64url(cred.userHandle),
      },
    };
  }
}

/** Tampering helper: re-encode clientDataJSON with a patch while keeping the old signature. */
export function tamperClientData(
  r: AuthenticationResponseJSON,
  patch: Record<string, unknown>,
): AuthenticationResponseJSON {
  const cd = JSON.parse(Buffer.from(r.response.clientDataJSON, "base64url").toString("utf8"));

  return {
    ...r,
    response: {
      ...r.response,
      clientDataJSON: b64url(new TextEncoder().encode(JSON.stringify({ ...cd, ...patch }))),
    },
  };
}
