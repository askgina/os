import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypt a value with a 32-byte data key (AES-256-GCM). `context` is authenticated but not
 * stored: pass where the value lives, for example `intents.payload:int_…`, so a sealed value
 * copied into another row or column fails to open.
 *
 * Layout: `version(1) || iv(12) || ciphertext || tag(16)`.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]);
}

/** Reverse {@link seal}. Throws when the key, the context or the bytes do not match. */
export function open(key: Uint8Array, sealed: Uint8Array, context: string): Buffer {
  const buffer = Buffer.from(sealed);
  if (buffer.length < 1 + IV_BYTES + TAG_BYTES || buffer[0] !== VERSION) {
    throw new Error("sealed value is malformed or has an unknown version");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(1, 1 + IV_BYTES));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(buffer.subarray(1 + IV_BYTES, buffer.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

export function sealJson(key: Uint8Array, value: unknown, context: string): Buffer {
  return seal(key, Buffer.from(JSON.stringify(value), "utf8"), context);
}

export function openJson(key: Uint8Array, sealed: Uint8Array, context: string): unknown {
  return JSON.parse(open(key, sealed, context).toString("utf8"));
}
