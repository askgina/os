import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Wraps and unwraps per-run data keys under a key-encryption key (KEK) that lives outside
 * Postgres: in a keyring file ({@link LocalKeyring}) or in a key service such as OpenBao Transit
 * (`TransitKeyProvider`). Every failure throws {@link KeyProviderUnavailableError} or
 * {@link KeyProviderRefusedError}; nothing resolves to "no key", because the layers above read
 * a missing key as permission to store plaintext.
 */
export interface KeyProvider {
  /** Connect and read the active KEK. Safe to call again; a network provider re-reads it. */
  ready(): Promise<void>;
  /** KEK id that new wraps (and `rewrap`) use. */
  activeKekId(): string;
  wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Stop timers and let go of connections. */
  close(): Promise<void>;
}

/** What a failure is about. Ids and HTTP statuses only, never key material or AAD bytes. */
export interface KeyProviderFailure {
  kekId?: string;
  status?: number;
}

/**
 * The provider could not be reached or did not answer in time (network error, timeout, 429,
 * 5xx, a sealed server). Nothing was decided: the same call may succeed later.
 */
export class KeyProviderUnavailableError extends Error {
  override readonly name = "KeyProviderUnavailableError";
  readonly retryable = true;
  readonly kekId: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, failure: KeyProviderFailure = {}) {
    super(message);
    this.kekId = failure.kekId;
    this.status = failure.status;
  }
}

/**
 * The provider answered and refused: the wrapped key does not open under this KEK and AAD, the
 * KEK or its version is unknown or retired, or the credentials lack permission. Repeating the
 * call does not help.
 */
export class KeyProviderRefusedError extends Error {
  override readonly name = "KeyProviderRefusedError";
  readonly retryable = false;
  readonly kekId: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, failure: KeyProviderFailure = {}) {
    super(message);
    this.kekId = failure.kekId;
    this.status = failure.status;
  }
}

/**
 * A key provider's settings are missing or malformed. Raised while a provider is built, before
 * it is used. `setting` names the variable or option, never its value.
 */
export class KeyProviderConfigError extends Error {
  override readonly name = "KeyProviderConfigError";
  /** The variable or option at fault; boot logs print it. */
  readonly code: string;

  constructor(message: string, setting: string) {
    super(message);
    this.code = setting;
  }
}

/** On-disk keyring: `{ "active": "k2", "keys": { "k1": "<base64 32 bytes>", "k2": "..." } }`. */
export interface KeyringFile {
  active: string;
  keys: Record<string, string>;
}

/** File KEK ids; never `:` or `@`, so a file id cannot be mistaken for a `bao:` id. */
const FILE_KEK_ID = /^[A-Za-z0-9_-]+$/;

/** Check the shape of a parsed keyring file. Messages name fields, never values. */
function parseKeyringFile(value: unknown): KeyringFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("keyring: the keyring file must be a JSON object");
  }

  const { active, keys } = value as Record<string, unknown>;

  if (typeof active !== "string" || active === "") {
    throw new Error("keyring: `active` must be a non-empty string");
  }

  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new Error("keyring: `keys` must be an object of KEK id to base64 key");
  }

  const out: Record<string, string> = {};

  for (const [id, key] of Object.entries(keys)) {
    if (!FILE_KEK_ID.test(id)) {
      throw new Error("keyring: every KEK id must match [A-Za-z0-9_-]+");
    }

    if (typeof key !== "string") throw new Error(`keyring: KEK ${id} is not a base64 string`);
    out[id] = key;
  }

  return { active, keys: out };
}

const IV_BYTES = 12;

const TAG_BYTES = 16;

export class LocalKeyring implements KeyProvider {
  readonly #keys: Map<string, Buffer>;
  readonly #active: string;

  constructor(file: KeyringFile) {
    this.#keys = new Map();

    for (const [id, b64] of Object.entries(file.keys)) {
      // Buffer.from silently skips characters outside the alphabet, so a typo could still
      // decode to 32 bytes of a different key. Require canonical base64.
      const key = Buffer.from(b64, "base64");

      if (key.length !== 32 || key.toString("base64") !== b64) {
        throw new Error(`keyring: KEK ${id} is not 32 bytes of canonical base64`);
      }

      this.#keys.set(id, key);
    }

    if (!this.#keys.has(file.active)) {
      throw new Error(`keyring: active KEK ${file.active} is not in the keyring`);
    }

    this.#active = file.active;
  }

  static fromFile(path: string): LocalKeyring {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      // JSON.parse quotes the text it could not parse, which here is key material, so the
      // original message must never travel on. Only the error kind is kept.
      const kind = cause instanceof SyntaxError ? "not valid JSON" : "unreadable";
      throw new Error(`keyring: the keyring file is ${kind}`);
    }

    return new LocalKeyring(parseKeyringFile(parsed));
  }

  /** A fresh keyring file body with one random KEK. */
  static generate(kekId = "k1"): KeyringFile {
    return { active: kekId, keys: { [kekId]: randomBytes(32).toString("base64") } };
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {}

  activeKekId(): string {
    return this.#active;
  }

  #kek(kekId: string): Buffer {
    const kek = this.#keys.get(kekId);

    if (!kek) throw new KeyProviderRefusedError(`keyring: unknown KEK ${kekId}`, { kekId });

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

    if (buf.length !== IV_BYTES + 32 + TAG_BYTES) {
      throw new KeyProviderRefusedError("keyring: malformed wrapped key", { kekId });
    }

    const decipher = createDecipheriv("aes-256-gcm", this.#kek(kekId), buf.subarray(0, IV_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));

    try {
      return new Uint8Array(
        Buffer.concat([
          decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)),
          decipher.final(),
        ]),
      );
    } catch {
      throw new KeyProviderRefusedError(
        `keyring: the wrapped key does not open under KEK ${kekId} and its associated data`,
        { kekId },
      );
    }
  }
}
