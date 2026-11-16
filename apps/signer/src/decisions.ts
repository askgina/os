import type { DatabaseSync } from "node:sqlite";
import { type ApprovalId, DomainTag, digestHex, type WorkspaceId } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import { transaction } from "./db.ts";

export interface DecisionInput {
  /** A workspace that exists: `appendDecision` throws for any other id. */
  workspaceId: string;
  approvalId: ApprovalId | null;
  action: string;
  outcome: SignerDecision["outcome"];
  code: string | null;
  at: number;
}

/**
 * A `decisions` row. `appendDecision` is the only statement that inserts one, and it writes
 * `approval_id` and `outcome` from a `DecisionInput`, so they have its types.
 */
type DecisionRow = {
  workspace_id: string;
  seq: number;
  at: number;
  approval_id: ApprovalId | null;
  action: string;
  outcome: SignerDecision["outcome"];
  code: string | null;
  previous_hash: string | null;
  hash: string;
};

// The hash covers every column except itself, so editing, inserting or deleting a row breaks
// the chain at that row. Intent contents are never recorded: only ids, the action and the code.
function entryHash(entry: Omit<DecisionRow, "hash">): string {
  return digestHex(DomainTag.audit, {
    kind: "signer-decision",
    workspaceId: entry.workspace_id,
    seq: entry.seq,
    at: entry.at,
    approvalId: entry.approval_id,
    action: entry.action,
    outcome: entry.outcome,
    code: entry.code,
    previousHash: entry.previous_hash,
  });
}

type Head = { decision_seq: number; decision_hash: string | null };

function readHead(db: DatabaseSync, workspaceId: string): Head | undefined {
  // SAFETY: `workspaces` is STRICT with `decision_seq INTEGER NOT NULL` and a nullable TEXT
  // `decision_hash` (db.ts, version 1), the two columns selected here; a missing row is undefined.
  return db
    .prepare("SELECT decision_seq, decision_hash FROM workspaces WHERE workspace_id = ?")
    .get(workspaceId) as Head | undefined;
}

/**
 * Append one decision and move the workspace's head to it. Call inside a transaction when it must
 * commit with the action it records; on its own it opens one, so the row and the head never
 * disagree.
 */
export function appendDecision(db: DatabaseSync, input: DecisionInput): void {
  if (!db.isTransaction) {
    transaction(db, () => appendDecision(db, input));

    return;
  }

  const head = readHead(db, input.workspaceId);

  if (!head) throw new Error("decision for a workspace that does not exist");

  const entry = {
    workspace_id: input.workspaceId,
    seq: head.decision_seq + 1,
    at: input.at,
    approval_id: input.approvalId,
    action: input.action,
    outcome: input.outcome,
    code: input.code,
    previous_hash: head.decision_hash,
  };

  const hash = entryHash(entry);
  db.prepare(
    `INSERT INTO decisions (workspace_id, seq, at, approval_id, action, outcome, code, previous_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.workspace_id,
    entry.seq,
    entry.at,
    entry.approval_id,
    entry.action,
    entry.outcome,
    entry.code,
    entry.previous_hash,
    hash,
  );
  db.prepare(
    "UPDATE workspaces SET decision_seq = ?, decision_hash = ? WHERE workspace_id = ?",
  ).run(entry.seq, hash, input.workspaceId);
}

export function listDecisions(
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  after: number,
  limit: number,
): SignerDecision[] {
  // SAFETY: `SELECT *` of the STRICT `decisions` table returns exactly DecisionRow's columns
  // (db.ts, version 1), with the types its comment derives from `appendDecision`.
  const rows = db
    .prepare("SELECT * FROM decisions WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(workspaceId, after, limit) as DecisionRow[];

  // Each row's `workspace_id` equals `workspaceId`: the query selected it by that value.
  return rows.map((row) => ({
    seq: row.seq,
    at: row.at,
    workspaceId,
    approvalId: row.approval_id,
    action: row.action,
    outcome: row.outcome,
    code: row.code,
    previousHash: row.previous_hash,
    hash: row.hash,
  }));
}

export interface DecisionLogCheck {
  ok: boolean;
  /** The first sequence number whose row does not verify or is missing; null when `ok`. */
  brokenAt: number | null;
}

/**
 * Recompute the chain and compare its end with the head kept on the workspace row. `brokenAt` is
 * the first sequence number whose row does not verify or is missing. The chain is not keyed: it
 * detects damage and partial edits, not someone with write access who rewrites the rows and the
 * head together.
 */
export function verifyDecisions(db: DatabaseSync, workspaceId: WorkspaceId): DecisionLogCheck {
  // SAFETY: `SELECT *` of the STRICT `decisions` table returns exactly DecisionRow's columns
  // (db.ts, version 1), with the types its comment derives from `appendDecision`.
  const rows = db
    .prepare("SELECT * FROM decisions WHERE workspace_id = ? ORDER BY seq")
    .all(workspaceId) as DecisionRow[];

  let previous: string | null = null;
  let expectedSeq = 1;

  for (const row of rows) {
    const { hash, ...rest } = row;

    if (row.seq !== expectedSeq || row.previous_hash !== previous || entryHash(rest) !== hash) {
      return { ok: false, brokenAt: expectedSeq };
    }

    previous = hash;
    expectedSeq += 1;
  }

  const head = readHead(db, workspaceId);
  const lastSeq = expectedSeq - 1;

  if (!head || head.decision_seq !== lastSeq || head.decision_hash !== previous) {
    // Rows past the end of the chain were removed (or the head was edited).
    return { ok: false, brokenAt: Math.min(lastSeq, head?.decision_seq ?? lastSeq) + 1 };
  }

  return { ok: true, brokenAt: null };
}
