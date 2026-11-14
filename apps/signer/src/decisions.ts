import type { DatabaseSync } from "node:sqlite";
import { DomainTag, digestHex, type WorkspaceId } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";

export interface DecisionInput {
  workspaceId: WorkspaceId;
  approvalId: string | null;
  action: string;
  outcome: "allowed" | "denied";
  code: string | null;
  at: number;
}

type DecisionRow = {
  workspace_id: string;
  seq: number;
  at: number;
  approval_id: string | null;
  action: string;
  outcome: string;
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

/** Append one decision. Call inside a transaction when it must commit with the action it records. */
export function appendDecision(db: DatabaseSync, input: DecisionInput): void {
  const last = db
    .prepare("SELECT seq, hash FROM decisions WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1")
    .get(input.workspaceId) as { seq: number; hash: string } | undefined;
  const entry = {
    workspace_id: input.workspaceId,
    seq: (last?.seq ?? 0) + 1,
    at: input.at,
    approval_id: input.approvalId,
    action: input.action,
    outcome: input.outcome,
    code: input.code,
    previous_hash: last?.hash ?? null,
  };
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
    entryHash(entry),
  );
}

export function listDecisions(
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  after: number,
  limit: number,
): SignerDecision[] {
  const rows = db
    .prepare("SELECT * FROM decisions WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(workspaceId, after, limit) as DecisionRow[];
  return rows.map((row) => ({
    seq: row.seq,
    at: row.at,
    workspaceId: row.workspace_id as WorkspaceId,
    approvalId: row.approval_id as SignerDecision["approvalId"],
    action: row.action,
    outcome: row.outcome as SignerDecision["outcome"],
    code: row.code,
    previousHash: row.previous_hash,
    hash: row.hash,
  }));
}

/** Recompute the chain. `brokenAt` is the first sequence number whose row does not verify. */
export function verifyDecisions(
  db: DatabaseSync,
  workspaceId: WorkspaceId,
): { ok: boolean; brokenAt: number | null } {
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
  return { ok: true, brokenAt: null };
}
