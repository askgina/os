import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { KeyProvider } from "./keyring.ts";

export const KEYS_SCHEMA = "os_keys";
const TABLE = `${KEYS_SCHEMA}.data_keys`;
/** Arbitrary constant; serializes concurrent migrations. */
const MIGRATION_LOCK = 0x05_0a_77_01;

/**
 * What a data key protects. `run` keys encrypt one workflow run's payloads; `workspace` keys seal
 * the application's own columns for one workspace.
 */
export type KeyScope = "run" | "workspace";

/**
 * Create the key table. Idempotent, and confined to its own schema, so it can run before or
 * after any other migration.
 */
export async function migrateKeys(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${KEYS_SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      scope        text NOT NULL,
      key_id       text NOT NULL,
      tenant_id    text,
      kek_id       text,
      wrapped_key  bytea,
      created_at   timestamptz NOT NULL DEFAULT now(),
      rewrapped_at timestamptz,
      shredded_at  timestamptz,
      PRIMARY KEY (scope, key_id),
      CHECK ((shredded_at IS NULL) = (wrapped_key IS NOT NULL AND kek_id IS NOT NULL))
    )`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/** Binds a wrapped key to its scope, id, tenant and KEK, so rows cannot be swapped. */
function wrapAad(scope: KeyScope, keyId: string, tenantId: string | null, kekId: string) {
  return new TextEncoder().encode(
    JSON.stringify(["askgina.os/data-key/v1", scope, keyId, tenantId, kekId]),
  );
}

/** The key was destroyed on purpose, or never existed. Its data cannot be read again. */
export class DataKeyUnavailableError extends Error {
  override readonly name = "DataKeyUnavailableError";

  constructor(scope: KeyScope, keyId: string) {
    super(`no data key for ${scope} ${keyId}: it was never created, or it was shredded`);
  }
}

export interface DataKeyStoreOptions {
  pool: Pool;
  provider: KeyProvider;
  /** How long unwrapped keys stay in process memory. 0 disables the cache. Default one minute. */
  cacheTtlMs?: number;
  /** Counts store operations, for measurement. */
  onEvent?: (event: "cache-hit" | "db-read" | "created" | "unwrap") => void;
}

interface KeyRow {
  kek_id: string | null;
  tenant_id: string | null;
  wrapped_key: Buffer | null;
}

/**
 * One random 32-byte data key per (scope, id), stored wrapped under a key-encryption key that
 * lives outside the database. Every failure throws: a caller never gets "no key" as a value,
 * because the layers above would treat that as permission to store plaintext.
 */
export class DataKeyStore {
  readonly #pool: Pool;
  readonly #provider: KeyProvider;
  readonly #ttl: number;
  readonly #cache = new Map<string, { key: Uint8Array; expires: number }>();
  readonly #onEvent: DataKeyStoreOptions["onEvent"];
  #migrated: Promise<void> | undefined;

  constructor(options: DataKeyStoreOptions) {
    this.#pool = options.pool;
    this.#provider = options.provider;
    this.#ttl = options.cacheTtlMs ?? 60_000;
    this.#onEvent = options.onEvent;
  }

  ensureMigrated(): Promise<void> {
    this.#migrated ??= migrateKeys(this.#pool).catch((error) => {
      this.#migrated = undefined;
      throw error;
    });
    return this.#migrated;
  }

  /**
   * The key for (scope, id), created on first use. Concurrent first uses, in this process or
   * another, converge on one key. `tenantId` is recorded when the key is created and bound into
   * its wrapping; later calls may omit it.
   */
  async getOrCreate(
    scope: KeyScope,
    keyId: string,
    tenantId: string | null = null,
  ): Promise<Uint8Array> {
    const cacheKey = `${scope}\n${keyId}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.#onEvent?.("cache-hit");
      return cached.key;
    }
    await this.ensureMigrated();
    let row = await this.#read(scope, keyId);
    if (!row) {
      const kekId = this.#provider.activeKekId();
      const fresh = randomBytes(32);
      const wrapped = await this.#provider.wrap(
        kekId,
        fresh,
        wrapAad(scope, keyId, tenantId, kekId),
      );
      fresh.fill(0);
      await this.#pool.query(
        `INSERT INTO ${TABLE} (scope, key_id, tenant_id, kek_id, wrapped_key)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scope, key_id) DO NOTHING`,
        [scope, keyId, tenantId, kekId, Buffer.from(wrapped)],
      );
      this.#onEvent?.("created");
      row = await this.#read(scope, keyId);
      if (!row) throw new DataKeyUnavailableError(scope, keyId);
    }
    const key = await this.#unwrap(scope, keyId, row);
    if (this.#ttl > 0) this.#cache.set(cacheKey, { key, expires: Date.now() + this.#ttl });
    return key;
  }

  /** The existing key for (scope, id). Never creates one. */
  async get(scope: KeyScope, keyId: string): Promise<Uint8Array> {
    await this.ensureMigrated();
    const row = await this.#read(scope, keyId);
    if (!row) throw new DataKeyUnavailableError(scope, keyId);
    return this.#unwrap(scope, keyId, row);
  }

  async #read(scope: KeyScope, keyId: string): Promise<KeyRow | undefined> {
    this.#onEvent?.("db-read");
    const { rows } = await this.#pool.query<KeyRow>(
      `SELECT kek_id, tenant_id, wrapped_key FROM ${TABLE} WHERE scope = $1 AND key_id = $2`,
      [scope, keyId],
    );
    return rows[0];
  }

  async #unwrap(scope: KeyScope, keyId: string, row: KeyRow): Promise<Uint8Array> {
    // A row without a wrapped key is a tombstone: the key was shredded. Never mint a replacement.
    if (!row.wrapped_key || !row.kek_id) throw new DataKeyUnavailableError(scope, keyId);
    this.#onEvent?.("unwrap");
    const key = await this.#provider.unwrap(
      row.kek_id,
      row.wrapped_key,
      wrapAad(scope, keyId, row.tenant_id, row.kek_id),
    );
    if (key.length !== 32) throw new Error(`data key for ${scope} ${keyId} is not 32 bytes`);
    return key;
  }

  /**
   * Re-wrap every live key that is not under the active KEK. Each row is updated only if it
   * still holds the bytes that were read, so a concurrent shred or rewrap is never undone. A row
   * that cannot be unwrapped (tampered with, or its KEK is gone) is reported, not fatal, so one
   * bad row cannot block a rotation.
   */
  async rewrap(batchSize = 500): Promise<{ rewrapped: number; failed: string[] }> {
    await this.ensureMigrated();
    const active = this.#provider.activeKekId();
    let rewrapped = 0;
    const failed: string[] = [];
    let after: [string, string] = ["", ""];
    for (;;) {
      const { rows } = await this.#pool.query<{
        scope: KeyScope;
        key_id: string;
        tenant_id: string | null;
        kek_id: string;
        wrapped_key: Buffer;
      }>(
        `SELECT scope, key_id, tenant_id, kek_id, wrapped_key FROM ${TABLE}
         WHERE shredded_at IS NULL AND kek_id <> $1 AND (scope, key_id) > ($2, $3)
         ORDER BY scope, key_id LIMIT $4`,
        [active, after[0], after[1], batchSize],
      );
      const last = rows.at(-1);
      if (!last) return { rewrapped, failed };
      after = [last.scope, last.key_id];
      for (const row of rows) {
        let key: Uint8Array;
        try {
          key = await this.#provider.unwrap(
            row.kek_id,
            row.wrapped_key,
            wrapAad(row.scope, row.key_id, row.tenant_id, row.kek_id),
          );
        } catch {
          failed.push(`${row.scope}:${row.key_id}`);
          continue;
        }
        const wrapped = await this.#provider.wrap(
          active,
          key,
          wrapAad(row.scope, row.key_id, row.tenant_id, active),
        );
        key.fill(0);
        const result = await this.#pool.query(
          `UPDATE ${TABLE} SET kek_id = $3, wrapped_key = $4, rewrapped_at = now()
           WHERE scope = $1 AND key_id = $2 AND kek_id = $5 AND wrapped_key = $6`,
          [row.scope, row.key_id, active, Buffer.from(wrapped), row.kek_id, row.wrapped_key],
        );
        rewrapped += result.rowCount ?? 0;
      }
    }
  }

  /**
   * Destroy the key for (scope, id) and leave a tombstone, so a later request fails instead of
   * minting a new key. Everything that was encrypted under it becomes unreadable. Other
   * processes may keep serving the key from their cache until their TTL runs out.
   * Returns whether a live key was destroyed.
   */
  async shred(scope: KeyScope, keyId: string): Promise<boolean> {
    await this.ensureMigrated();
    this.#cache.delete(`${scope}\n${keyId}`);
    const result = await this.#pool.query<{ existed: boolean }>(
      `INSERT INTO ${TABLE} (scope, key_id, shredded_at) VALUES ($1, $2, now())
       ON CONFLICT (scope, key_id) DO UPDATE SET kek_id = NULL, wrapped_key = NULL, shredded_at = now()
       WHERE ${TABLE}.shredded_at IS NULL
       RETURNING (xmax <> 0) AS existed`,
      [scope, keyId],
    );
    return result.rows[0]?.existed === true;
  }

  /** Drop unwrapped keys from this process's memory. */
  evict(): void {
    this.#cache.clear();
  }
}
