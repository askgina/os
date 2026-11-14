import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Wraps and unwraps per-run data keys under a key-encryption key (KEK) that
 * lives outside Postgres. A KMS-backed provider implements the same shape.
 */
export interface KeyProvider {
  /** KEK id that new wraps (and `rewrap`) use. */
  activeKekId(): string;
  /** Whether this provider can unwrap under `kekId`. */
  hasKek(kekId: string): boolean;
  wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

/** On-disk keyring: `{ "active": "k2", "keys": { "k1": "<base64 32 bytes>", "k2": "..." } }`. */
export interface KeyringFile {
  active: string;
  keys: Record<string, string>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class LocalKeyring implements KeyProvider {
  readonly #keys: Map<string, Buffer>;
  readonly #active: string;

  constructor(file: KeyringFile) {
    this.#keys = new Map();
    for (const [id, b64] of Object.entries(file.keys)) {
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new Error(`keyring: KEK ${id} is not 32 bytes`);
      this.#keys.set(id, key);
    }
    if (!this.#keys.has(file.active)) {
      throw new Error(`keyring: active KEK ${file.active} is not in the keyring`);
    }
    this.#active = file.active;
  }

  static fromFile(path: string): LocalKeyring {
    return new LocalKeyring(JSON.parse(readFileSync(path, "utf8")) as KeyringFile);
  }

  /** A fresh keyring file body with one random KEK. */
  static generate(kekId = "k1"): KeyringFile {
    return { active: kekId, keys: { [kekId]: randomBytes(32).toString("base64") } };
  }

  activeKekId(): string {
    return this.#active;
  }

  hasKek(kekId: string): boolean {
    return this.#keys.has(kekId);
  }

  #kek(kekId: string): Buffer {
    const kek = this.#keys.get(kekId);
    if (!kek) throw new Error(`keyring: unknown KEK ${kekId}`);
    return kek;
  }

  async wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#kek(kekId), iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  async unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const buf = Buffer.from(wrapped);
    if (buf.length !== IV_BYTES + 32 + TAG_BYTES) throw new Error("keyring: malformed wrapped key");
    const decipher = createDecipheriv("aes-256-gcm", this.#kek(kekId), buf.subarray(0, IV_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    return new Uint8Array(
      Buffer.concat([
        decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)),
        decipher.final(),
      ]),
    );
  }
}
