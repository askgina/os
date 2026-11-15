import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { type KeyProvider, KeyProviderRefusedError } from "./keyring.ts";

export const KEYS_SCHEMA = "os_keys";
const TABLE = `${KEYS_SCHEMA}.data_keys`;
/** Arbitrary constant; serializes concurrent migrations. */
const MIGRATION_LOCK = 0x05_0a_77_01;
/**
 * Every shred announces each key it destroyed here, in the transaction that destroys it, with
 * the payload `<scope>:<keyId>`; stores started with `listen` evict that key at once.
 */
export const SHRED_CHANNEL = "os_keys_shred";
/** Delays before the listening connection is opened again after it was lost, doubling. */
const LISTEN_RETRY_FIRST_MS = 100;
const LISTEN_RETRY_MAX_MS = 30_000;

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
    // Serves shredTenant: the live keys of one tenant in one scope.
    await client.query(`CREATE INDEX IF NOT EXISTS data_keys_tenant_idx
      ON ${TABLE} (scope, tenant_id) WHERE shredded_at IS NULL`);
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

/**
 * A caller named a tenant that is not the one the key was created for. Serving the key anyway
 * would let one tenant's code path read another tenant's data, so this is a refusal.
 */
export class DataKeyTenantMismatchError extends Error {
  override readonly name = "DataKeyTenantMismatchError";

  constructor(scope: KeyScope, keyId: string) {
    super(`data key for ${scope} ${keyId} belongs to a different tenant`);
  }
}

export interface DataKeyStoreOptions {
  pool: Pool;
  provider: KeyProvider;
  /** How long unwrapped keys stay in process memory. 0 disables the cache. Default one minute. */
  cacheTtlMs?: number;
  /**
   * Hear the shreds of every process on this database: after {@link DataKeyStore.start}, one
   * connection of the pool stays on `LISTEN os_keys_shred` and each key named there leaves the
   * cache at once. While that connection is down, nothing is cached or served from the cache,
   * and it is opened again with backoff. Without this, another process's shred reaches this
   * cache only when the TTL runs out.
   */
  listen?: boolean;
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
  readonly #cache = new Map<
    string,
    { key: Uint8Array; tenantId: string | null; expires: number }
  >();
  readonly #onEvent: DataKeyStoreOptions["onEvent"];
  readonly #listen: boolean;
  #table: Promise<void> | undefined;
  #migrated: Promise<void> | undefined;
  /** The connection on `LISTEN`, while it is up. */
  #listener: PoolClient | null = null;
  #connecting: Promise<void> | null = null;
  #retry: NodeJS.Timeout | null = null;
  #retryMs = LISTEN_RETRY_FIRST_MS;
  #closed = false;
  /**
   * Counts evictions. A key read before an eviction is not cached after it, so a shred heard
   * while a read was in flight cannot leave the destroyed key in the cache.
   */
  #evictions = 0;

  constructor(options: DataKeyStoreOptions) {
    this.#pool = options.pool;
    this.#provider = options.provider;
    this.#ttl = options.cacheTtlMs ?? 60_000;
    this.#onEvent = options.onEvent;
    this.#listen = options.listen ?? false;
  }

  /**
   * With `listen`, open the listening connection; resolves once it listens and rejects when the
   * first attempt fails. Later losses are retried by the store itself. Without `listen`, does
   * nothing.
   */
  async start(): Promise<void> {
    if (!this.#listen || this.#closed || this.#listener !== null) return;
    await this.#connect();
  }

  /** Let go of the listening connection and forget every cached key. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retry ?? undefined);
    this.#retry = null;
    await this.#connecting?.catch(() => {});
    const client = this.#listener;
    this.#listener = null;
    // Destroyed rather than returned, so no pooled connection keeps listening.
    client?.release(true);
    this.evict();
  }

  #connect(): Promise<void> {
    this.#connecting ??= (async () => {
      const client = await this.#pool.connect();
      const lost = () => this.#lost(client);
      client.on("error", lost);
      client.on("end", lost);
      client.on("notification", (message) => {
        if (message.channel !== SHRED_CHANNEL || !message.payload) return;
        const separator = message.payload.indexOf(":");
        if (separator < 0) return;
        const scope = message.payload.slice(0, separator);
        this.#cache.delete(`${scope}\n${message.payload.slice(separator + 1)}`);
        this.#evictions += 1;
      });
      try {
        await client.query(`LISTEN ${SHRED_CHANNEL}`);
      } catch (error) {
        client.removeAllListeners("notification");
        client.release(true);
        throw error;
      }
      if (this.#closed) {
        client.release(true);
        return;
      }
      // Whatever was cached before listening may have missed a shred.
      this.evict();
      this.#listener = client;
      this.#retryMs = LISTEN_RETRY_FIRST_MS;
    })().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #lost(client: PoolClient): void {
    if (this.#listener !== client) return;
    this.#listener = null;
    // Shreds made while nobody listens are never heard: forget everything, cache nothing.
    this.evict();
    client.removeAllListeners("notification");
    client.release(true);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry !== null) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, LISTEN_RETRY_MAX_MS);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
    this.#retry.unref();
  }

  /** Create the key table and wait for the key provider to be ready. Retried after a failure. */
  ensureMigrated(): Promise<void> {
    this.#migrated ??= Promise.all([this.#ensureTable(), this.#provider.ready()]).then(
      () => {},
      (error: unknown) => {
        this.#migrated = undefined;
        throw error;
      },
    );
    return this.#migrated;
  }

  /** The table alone: a shred needs no key provider, so it works while the provider is down. */
  #ensureTable(): Promise<void> {
    this.#table ??= migrateKeys(this.#pool).catch((error) => {
      this.#table = undefined;
      throw error;
    });
    return this.#table;
  }

  /**
   * The key for (scope, id), created on first use. Concurrent first uses, in this process or
   * another, converge on one key. `tenantId` is recorded when the key is created and bound into
   * its wrapping; later calls may omit it, but a later call that names a different tenant is
   * refused with {@link DataKeyTenantMismatchError}.
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
      if (tenantId !== null && cached.tenantId !== tenantId) {
        throw new DataKeyTenantMismatchError(scope, keyId);
      }
      return cached.key;
    }
    await this.ensureMigrated();
    const evictions = this.#evictions;
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
    // Checked after unwrapping, so a tombstone still reports "unavailable" rather than this.
    if (tenantId !== null && row.tenant_id !== tenantId) {
      throw new DataKeyTenantMismatchError(scope, keyId);
    }
    // Never kept while a listening store is not listening, or after an eviction during the read.
    const listening = !this.#listen || this.#listener !== null;
    if (this.#ttl > 0 && listening && this.#evictions === evictions) {
      this.#cache.set(cacheKey, {
        key,
        tenantId: row.tenant_id,
        expires: Date.now() + this.#ttl,
      });
    }
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
   * the provider refuses to unwrap (tampered with, or its KEK is gone) is reported, not fatal, so
   * one bad row cannot block a rotation. A provider that cannot be reached stops the run with
   * its error; rows already moved stay moved, and a second run continues.
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
        } catch (error) {
          if (!(error instanceof KeyProviderRefusedError)) throw error;
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
   * minting a new key. Everything that was encrypted under it becomes unreadable. The shred is
   * announced on {@link SHRED_CHANNEL} in the same transaction: listening stores drop the key at
   * once, others keep serving it from their cache until their TTL runs out.
   * Returns whether a live key was destroyed.
   */
  async shred(scope: KeyScope, keyId: string): Promise<boolean> {
    await this.#ensureTable();
    this.#cache.delete(`${scope}\n${keyId}`);
    this.#evictions += 1;
    // Announced even when the key was gone already: announcing again costs nothing.
    const result = await this.#pool.query<{ existed: boolean | null }>(
      `WITH shredded AS (
         INSERT INTO ${TABLE} (scope, key_id, shredded_at) VALUES ($1, $2, now())
         ON CONFLICT (scope, key_id) DO UPDATE SET kek_id = NULL, wrapped_key = NULL, shredded_at = now()
         WHERE ${TABLE}.shredded_at IS NULL
         RETURNING (xmax <> 0) AS existed
       )
       SELECT (SELECT existed FROM shredded) AS existed,
              pg_notify('${SHRED_CHANNEL}', $1 || ':' || $2) AS notified`,
      [scope, keyId],
    );
    return result.rows[0]?.existed === true;
  }

  /**
   * Destroy every live key of one tenant in one scope, for example every run key of a workspace
   * that is being deleted, leaving each as a tombstone the way {@link shred} does. Only keys
   * created with that `tenantId` are found; a key created without a tenant is not. Each key is
   * announced on {@link SHRED_CHANNEL} as {@link shred} announces one; stores that do not listen
   * may keep serving these keys from their cache until their TTL runs out. Returns how many live
   * keys were destroyed; a repeat finds none and returns 0.
   */
  async shredTenant(scope: KeyScope, tenantId: string): Promise<{ shredded: number }> {
    await this.#ensureTable();
    this.#evictions += 1;
    const { rows } = await this.#pool.query<{ key_id: string }>(
      `WITH shredded AS (
         UPDATE ${TABLE} SET kek_id = NULL, wrapped_key = NULL, shredded_at = now()
         WHERE scope = $1 AND tenant_id = $2 AND shredded_at IS NULL
         RETURNING key_id
       )
       SELECT key_id, pg_notify('${SHRED_CHANNEL}', $1 || ':' || key_id) AS notified
       FROM shredded`,
      [scope, tenantId],
    );
    for (const row of rows) this.#cache.delete(`${scope}\n${row.key_id}`);
    // A key this process cached under the tenant is gone from the database either way.
    for (const [cacheKey, entry] of this.#cache) {
      if (entry.tenantId === tenantId && cacheKey.startsWith(`${scope}\n`)) {
        this.#cache.delete(cacheKey);
      }
    }
    return { shredded: rows.length };
  }

  /** Drop unwrapped keys from this process's memory. */
  evict(): void {
    this.#cache.clear();
    this.#evictions += 1;
  }
}
