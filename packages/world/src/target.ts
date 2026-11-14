/**
 * A ready-made World for `WORKFLOW_TARGET_WORLD=@askgina/os-world/target`, configured from the
 * environment. Use it when a framework picks the World by package name; an application that
 * builds its own Postgres pool calls `createEncryptedWorld()` directly.
 *
 * - `WORKFLOW_POSTGRES_URL` (or `DATABASE_URL`): the database.
 * - `WORLD_KEYRING_FILE`: path to the keyring JSON, kept outside the database.
 * - `WORLD_READABLE_ATTRIBUTE_KEYS`: optional, comma-separated run attribute keys whose values
 *   may be stored readable. Every other attribute's value is stored as `[withheld]`.
 * - The upstream Postgres World's own tuning variables keep their meaning.
 */
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import pg from "pg";
import { createEncryptedWorld, type EncryptedWorld } from "./index.ts";

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export function createWorld(): EncryptedWorld {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL;
  const keyringFile = process.env.WORLD_KEYRING_FILE;
  if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is not set");
  if (!keyringFile) throw new Error("WORLD_KEYRING_FILE is not set");

  const queueConcurrency = optionalNumber("WORKFLOW_POSTGRES_WORKER_CONCURRENCY") ?? 50;
  const pool = new pg.Pool({
    connectionString,
    max: optionalNumber("WORKFLOW_POSTGRES_MAX_POOL_SIZE") ?? queueConcurrency + 2,
  });
  // An idle client that loses its connection must not take the process down.
  pool.on("error", () => {});

  const readableAttributeKeys = (process.env.WORLD_READABLE_ATTRIBUTE_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  const jobPrefix = process.env.WORKFLOW_POSTGRES_JOB_PREFIX;
  const pollInterval = optionalNumber("WORKFLOW_POSTGRES_POLL_INTERVAL_MS");
  const jobLockStaleSeconds = optionalNumber("WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS");
  return createEncryptedWorld({
    postgres: {
      pool,
      queueConcurrency,
      ...(jobPrefix ? { jobPrefix } : {}),
      ...(pollInterval === undefined ? {} : { pollInterval }),
      ...(jobLockStaleSeconds === undefined ? {} : { jobLockStaleSeconds }),
    },
    dataKeys: new DataKeyStore({ pool, provider: LocalKeyring.fromFile(keyringFile) }),
    readableAttributeKeys,
  });
}

export default createWorld;
