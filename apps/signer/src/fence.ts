import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { appendDecision } from "./decisions.ts";
import { revokeMandatesOnFence } from "./mandates.ts";

/**
 * The restore fence. A database restored from a backup has forgotten every approval it acted on
 * after the backup was taken, so an approval paid after the backup would look unused and could
 * be signed again until its envelope expired. The fence is a time: the signer refuses every
 * envelope issued before it (plus the clock skew the verifier allows), whatever the control
 * plane says. Approvals still waiting when the backup was taken must be proposed again.
 *
 * It is set two ways, both on the signer host and neither by the control plane:
 * - the operator runs `node src/admin.ts fence` as part of every restore;
 * - the signer sets it itself when it opens a database file that is not the file it last
 *   recorded (copied, extracted from an archive, or moved to another host).
 *
 * Mandates carry no envelope to fence, and a restored database has forgotten the uses counted
 * after its backup, so every move of the fence also revokes every live mandate, with reason
 * `operator`, in the same transaction.
 */

/** Decision-log actions, one entry per workspace each time the fence moves. */
export const FENCE_BY_OPERATOR = "fence-set-by-operator";

export const FENCE_ON_NEW_FILE = "fence-set-on-new-database-file";

const FENCE_KEY = "fence_at";

const FILE_KEY = "database_file";

function readMeta(db: DatabaseSync, key: string): string | null {
  // SAFETY: `signer_meta` is STRICT with `value TEXT NOT NULL` (db.ts, version 2), the one column
  // selected; no row for the key is undefined.
  const row = db.prepare("SELECT value FROM signer_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO signer_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** The fence in seconds since the Unix epoch, or null when this database was never fenced. */
export function readFence(db: DatabaseSync): number | null {
  const value = readMeta(db, FENCE_KEY);

  return value === null ? null : Number(value);
}

/**
 * Move the fence to `at` unless it is already there or later, record the move in every
 * workspace's decision log, and revoke every live mandate. Call inside a transaction. Returns the
 * fence now in force.
 */
export function raiseFence(db: DatabaseSync, at: number, action: string): number {
  const current = readFence(db);

  if (current !== null && current >= at) return current;
  writeMeta(db, FENCE_KEY, String(at));

  // SAFETY: `workspace_id`, the one column selected, is TEXT in the STRICT `workspaces` table
  // (db.ts, version 1), and its only INSERT (`createWorkspace`) writes the request's WorkspaceId.
  const workspaces = db
    .prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id")
    .all() as { workspace_id: string }[];

  for (const { workspace_id } of workspaces) {
    appendDecision(db, {
      workspaceId: workspace_id,
      approvalId: null,
      action,
      outcome: "allowed",
      code: null,
      at,
    });
  }

  revokeMandatesOnFence(db, at);

  return at;
}

/**
 * What tells this database file apart from a copy of it: its inode and its creation time. SQLite
 * writes in place and never replaces its main file, so both stay the same for as long as the file
 * lives. A copy, an archive extracted to a new file, or a move to another host gets a new
 * creation time even where the filesystem reuses the inode number. Null for an in-memory database.
 */
export function databaseFileIdentity(path: string): string | null {
  if (path === ":memory:" || path === "") return null;
  const stat = statSync(path, { bigint: true });

  return `${stat.ino}:${stat.birthtimeNs}`;
}

/**
 * Compare the database file with the one last recorded. A database created by this open has no
 * history to forget, so its file is only recorded. Any other database whose file is not the
 * recorded one (including one recorded by no signer yet, such as a v0.1 file) is fenced at `now`.
 * Call inside a transaction. Returns the new fence, or null when nothing moved.
 */
export function fenceReplacedDatabase(
  db: DatabaseSync,
  path: string,
  created: boolean,
  now: number,
): number | null {
  const identity = databaseFileIdentity(path);

  if (identity === null) return null;
  const recorded = readMeta(db, FILE_KEY);

  if (recorded === identity) return null;
  writeMeta(db, FILE_KEY, identity);

  if (created) return null;
  const before = readFence(db);
  const after = raiseFence(db, now, FENCE_ON_NEW_FILE);

  return after === before ? null : after;
}
