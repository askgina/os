/**
 * Web Push message encryption, RFC 8291, with the `aes128gcm` content coding of RFC 8188: one
 * record, record size 4096. Node's WebCrypto only; no dependency.
 */

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const AUTH_SECRET_LENGTH = 16;
/** An uncompressed P-256 point: 0x04, then x and y. */
const POINT_LENGTH = 65;
const PADDING_DELIMITER = 0x02;

const utf8 = (text: string) => new TextEncoder().encode(text);
const KEY_INFO = utf8("WebPush: info\0");
const CEK_INFO = utf8("Content-Encoding: aes128gcm\0");
const NONCE_INFO = utf8("Content-Encoding: nonce\0");

/** Why a message could not be encrypted for a subscription. */
export class PushEncryptionError extends Error {
  override readonly name = "PushEncryptionError";
  readonly code: "bad_key" | "bad_auth" | "too_long";

  constructor(code: PushEncryptionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface EncryptInput {
  plaintext: Uint8Array;
  /** The subscription's `p256dh`: the user agent's uncompressed P-256 public key, 65 bytes. */
  uaPublicKey: Uint8Array;
  /** The subscription's `auth` secret, 16 bytes. */
  authSecret: Uint8Array;
  /**
   * Pad the record with zero bytes after the delimiter so plaintext, delimiter and padding fill
   * exactly this many bytes, and every message has the same length (RFC 8291 §7). Without it
   * the record is the plaintext and the delimiter.
   */
  paddedLength?: number;
  /** For test vectors only: the salt, otherwise 16 random bytes. */
  salt?: Uint8Array;
  /** For test vectors only: the sender's ECDH key pair, otherwise a new one per message. */
  asKeyPair?: { publicKey: CryptoKey; privateKey: CryptoKey };
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** HKDF-SHA-256, extract and expand in one: `length` bytes of output. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt one push message for one subscription: the `aes128gcm` body of RFC 8291 §3.4, a header
 * of salt, record size and the sender's public key, then a single encrypted record. Refuses a
 * key that is not an uncompressed point on P-256 (RFC 8291 §7).
 */
export async function encryptPayload(input: EncryptInput): Promise<Uint8Array<ArrayBuffer>> {
  const { plaintext, uaPublicKey, authSecret } = input;
  if (uaPublicKey.length !== POINT_LENGTH || uaPublicKey[0] !== 0x04) {
    throw new PushEncryptionError("bad_key", "p256dh is not an uncompressed P-256 point");
  }
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new PushEncryptionError("bad_auth", "auth is not 16 bytes");
  }
  const contentLength = input.paddedLength ?? plaintext.length + 1;
  if (plaintext.length + 1 > contentLength || contentLength + TAG_LENGTH > RECORD_SIZE) {
    throw new PushEncryptionError("too_long", "the message does not fit one record");
  }

  let uaKey: CryptoKey;
  try {
    // Importing checks that the point is on the curve.
    uaKey = await crypto.subtle.importKey(
      "raw",
      concat(uaPublicKey),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
  } catch {
    throw new PushEncryptionError("bad_key", "p256dh is not a point on P-256");
  }
  const asKeyPair =
    input.asKeyPair ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]));
  const asPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeyPair.privateKey, 256),
  );

  // RFC 8291 §3.3 and §3.4.
  const ikm = await hkdf(authSecret, ecdhSecret, concat(KEY_INFO, uaPublicKey, asPublicKey), 32);
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const record = new Uint8Array(contentLength);
  record.set(plaintext);
  record[plaintext.length] = PADDING_DELIMITER;
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, recordSize, Uint8Array.of(asPublicKey.length), asPublicKey, sealed);
}
