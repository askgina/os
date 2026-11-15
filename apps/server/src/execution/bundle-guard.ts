import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

/**
 * Advisory lock class of the workflow bundle a process runs: every process that delivers runs
 * holds `(BUNDLE_LOCK_CLASS, <its bundle's id>)` shared, for as long as it delivers.
 */
export const BUNDLE_LOCK_CLASS = 18_680;
/** Serializes the check-then-lock of starting processes, so two bundles cannot both get in. */
export const BUNDLE_CHECK_CLASS = 18_681;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 30_000;

/**
 * Another process on this database delivers runs from a different workflow bundle. Runs are not
 * pinned to a bundle, so two bundles would replay the same run with different code: one of them
 * must stop first (`strategy: Recreate`, or stop every replica before upgrading).
 */
export class BundleMismatchError extends Error {
  override readonly name = "BundleMismatchError";
  readonly bundleId: number;

  constructor(bundleId: number) {
    super(
      `another server runs a different workflow bundle on this database; stop it before starting bundle ${bundleId}`,
    );
    this.bundleId = bundleId;
  }
}

export interface BundleLock {
  /** The low 31 bits of the bundle's SHA-256: the lock's second key. */
  readonly bundleId: number;
  /** Give the lock back. Idempotent. */
  release(): Promise<void>;
}

/** The bundle's id: the low 31 bits of the SHA-256 of its `flow.mjs`. */
export async function bundleIdOf(flowFile: string): Promise<number> {
  const digest = createHash("sha256")
    .update(await readFile(flowFile))
    .digest();
  return digest.readUInt32BE(28) & 0x7f_ff_ff_ff;
}

/**
 * Check, then hold for this process's life, that every process delivering runs on this
 * database runs the bundle at `flowFile`. Refuses with {@link BundleMismatchError} while a
 * process holds the lock of another bundle; processes on the same bundle share it. The lock
 * lives on one connection of `pool`, kept for it: when that connection is lost, the lock is taken
 * again, with backoff, and checked again, and `onMismatch` hears a mismatch found then (another
 * bundle started meanwhile), so the caller stops delivering.
 */
export async function holdBundleLock(
  pool: Pool,
  flowFile: string,
  onMismatch: (error: BundleMismatchError) => void,
): Promise<BundleLock> {
  const bundleId = await bundleIdOf(flowFile);
  let client: PoolClient | null = null;
  let released = false;
  let retry: NodeJS.Timeout | null = null;
  let retryMs = RETRY_FIRST_MS;

  const acquire = async (): Promise<PoolClient> => {
    const fresh = await pool.connect();
    try {
      await fresh.query("BEGIN");
      await fresh.query("SELECT pg_advisory_xact_lock($1, 0)", [BUNDLE_CHECK_CLASS]);
      const { rows } = await fresh.query<{ objid: number }>(
        `SELECT objid FROM pg_locks
         WHERE locktype = 'advisory' AND granted AND classid = $1 AND objsubid = 2 AND objid <> $2
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         LIMIT 1`,
        [BUNDLE_LOCK_CLASS, bundleId],
      );
      if (rows.length > 0) throw new BundleMismatchError(bundleId);
      // Taken inside the transaction, kept by the session after it commits.
      await fresh.query("SELECT pg_advisory_lock_shared($1, $2)", [BUNDLE_LOCK_CLASS, bundleId]);
      await fresh.query("COMMIT");
    } catch (error) {
      // The connection may be broken; destroy it rather than return it to the pool.
      fresh.release(true);
      throw error;
    }
    fresh.on("error", () => lost(fresh));
    fresh.on("end", () => lost(fresh));
    return fresh;
  };

  const reacquire = () => {
    if (released || retry !== null) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    retry = setTimeout(() => {
      retry = null;
      acquire().then(
        (fresh) => {
          if (released) {
            fresh.release(true);
            return;
          }
          client = fresh;
          retryMs = RETRY_FIRST_MS;
        },
        (error: unknown) => {
          if (error instanceof BundleMismatchError) onMismatch(error);
          else reacquire();
        },
      );
    }, delay);
    retry.unref();
  };

  function lost(which: PoolClient) {
    if (client !== which) return;
    client = null;
    which.release(true);
    reacquire();
  }

  client = await acquire();
  return {
    bundleId,
    async release() {
      released = true;
      clearTimeout(retry ?? undefined);
      retry = null;
      const held = client;
      client = null;
      // Ending the session gives the lock back.
      held?.release(true);
    },
  };
}
