import { DatabaseSync } from "node:sqlite";

/**
 * The signer's own state. Everything that decides whether to sign lives here, not in the control
 * plane's database: approvers, policies, used nonces, what was signed, and the decision log.
 * Integers are seconds since the Unix epoch; amounts are decimal strings because they can exceed
 * 64 bits.
 *
 * Version 1 is the v0.1 schema. Every statement in it is `IF NOT EXISTS`, so it also runs as a
 * no-op on a v0.1 file, which has these tables and `user_version` 0.
 */
const VERSION_1 = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  admin_threshold INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_request TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The newest decision-log entry, updated in the same transaction as every append, so that
  -- deleting the newest log rows is noticed: the chain alone cannot tell a short log from a cut one.
  decision_seq INTEGER NOT NULL DEFAULT 0,
  decision_hash TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS approvers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  credential_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, credential_id)
) STRICT;

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  sealed_credential BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS policies (
  wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  revision INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  policy TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, revision)
) STRICT;

-- Every envelope nonce the signer has acted on, for good.
CREATE TABLE IF NOT EXISTS used_nonces (
  nonce TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
) STRICT;

-- One row per approval id the signer has acted on or refused for good.
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  state TEXT NOT NULL CHECK (state IN ('revoked', 'signed', 'applied')),
  envelope_digest TEXT,
  at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS signatures (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  chain_id TEXT NOT NULL,
  tx_nonce INTEGER NOT NULL,
  signed_transaction TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  signed_at INTEGER NOT NULL
) STRICT;

-- What each wallet has signed for, so caps hold across any 24 hours.
CREATE TABLE IF NOT EXISTS spends (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  chain_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS spends_by_wallet ON spends (wallet_id, at);

CREATE TABLE IF NOT EXISTS decisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  approval_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  code TEXT,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
) STRICT;
`;

/**
 * Version 2: facts about this database rather than about a workspace. `fence_at` is the restore
 * fence (see `fence.ts`); `database_file` identifies the file the database was last opened from.
 */
const VERSION_2 = `
CREATE TABLE IF NOT EXISTS signer_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

/**
 * Version 3: confirmation pages (`confirmations.ts`). A confirmation keeps the envelope and the
 * subject its hash names, so the page can show exactly what a passkey approves, and only the
 * SHA-256 of the link's token. `attempts` counts submitted assertions. Assertions are kept per
 * person until the control plane collects them; the signer verifies them again when it acts.
 */
const VERSION_3 = `
CREATE TABLE IF NOT EXISTS confirmations (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  envelope_digest TEXT NOT NULL,
  envelope TEXT NOT NULL,
  subject TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  possession_proven_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS confirmation_assertions (
  approval_id TEXT NOT NULL REFERENCES confirmations(approval_id),
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  response TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (approval_id, user_id)
) STRICT;
`;

/**
 * Version 4: the possession step of an approver change (`confirmations.ts`). `nonce` belongs to
 * the one challenge the new passkey may answer: random, made when the page first asks for it,
 * and deleted when an answer uses it. The answer itself is `confirmations.possession_proven_at`
 * (version 3).
 */
const VERSION_4 = `
CREATE TABLE IF NOT EXISTS possession_challenges (
  approval_id TEXT PRIMARY KEY REFERENCES confirmations(approval_id),
  nonce TEXT NOT NULL
) STRICT;
`;

/**
 * Version 5: mandates (`mandates.ts`). A mandate is stored as its canonical JSON with the people
 * whose assertions granted it, and ends only by revocation or by its own `not_after`. Each use is
 * an `approvals` row whose `envelope_digest` is the use's `mandateUseDigest`, with its signature
 * and its spend as for an approved intent, plus one `mandate_uses` row that counts it. Nothing is
 * ever deleted from these tables, so a use counts for good. `grant_approval_id` has no foreign key
 * because the grant is applied before its approval row is recorded, in the same transaction.
 */
const VERSION_5 = `
CREATE TABLE IF NOT EXISTS mandates (
  mandate_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
  agent_id TEXT NOT NULL,
  mandate_hash TEXT NOT NULL,
  mandate TEXT NOT NULL,
  grant_approval_id TEXT NOT NULL UNIQUE,
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (revoked_reason IN ('requested', 'grantor_removed', 'operator')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS mandates_by_wallet ON mandates (wallet_id, not_after);
CREATE INDEX IF NOT EXISTS mandates_by_workspace ON mandates (workspace_id, not_after);

CREATE TABLE IF NOT EXISTS mandate_grantors (
  mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id),
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  PRIMARY KEY (mandate_id, user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS mandate_grantors_by_credential ON mandate_grantors (credential_id);

CREATE TABLE IF NOT EXISTS mandate_uses (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id),
  intent_id TEXT NOT NULL UNIQUE,
  intent_hash TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS mandate_uses_by_mandate ON mandate_uses (mandate_id, at);
`;

/** Migration `n` (from 1) takes a database from version `n - 1` to version `n`. */
const MIGRATIONS: readonly string[] = [VERSION_1, VERSION_2, VERSION_3, VERSION_4, VERSION_5];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A database written by a newer signer. Opening it with older code could lose what it records. */
export class SchemaTooNewError extends Error {
  override readonly name = "SchemaTooNewError";
}

export interface OpenedDatabase {
  db: DatabaseSync;
  /** True when this open created the schema in an empty file: the database has no history. */
  created: boolean;
}

export function openDatabase(path: string): OpenedDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    // One write transaction, so the signer and the admin CLI opening the file together migrate
    // it once.
    return { db, created: transaction(db, () => migrate(db)) };
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync): boolean {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version > SCHEMA_VERSION) {
    throw new SchemaTooNewError(
      `the database is at schema version ${version}; this signer knows ${SCHEMA_VERSION}`,
    );
  }
  const created =
    version === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspaces'").get() ===
      undefined;
  for (const sql of MIGRATIONS.slice(version)) db.exec(sql);
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return created;
}

/**
 * Run `work` in one write transaction. `work` is synchronous on purpose: nothing can interleave
 * between reading the ledger and storing the result, in this process or another one sharing the
 * file (`BEGIN IMMEDIATE` takes the write lock up front).
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
