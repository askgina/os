import { DatabaseSync } from "node:sqlite";

/**
 * The signer's own state. Everything that decides whether to sign lives here, not in the control
 * plane's database: approvers, policies, used nonces, what was signed, and the decision log.
 * Integers are seconds since the Unix epoch; amounts are decimal strings because they can exceed
 * 64 bits.
 */
const SCHEMA = `
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

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
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
