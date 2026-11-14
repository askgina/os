import type { AuditVerification } from "@askgina/os-api";
import { DomainTag, digestHex, type WorkspaceId } from "@askgina/os-protocol";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { AppContext, Executor } from "./context.ts";
import { auditEvents } from "./db/schema.ts";

export interface AuditInput {
  workspaceId: WorkspaceId;
  actor: { type: "user" | "agent" | "system" | "signer"; id: string | null };
  /** `noun.verb`, for example `intent.proposed`, `approval.approved`, `policy.changed`. */
  action: string;
  subject?: { type: string; id: string };
  /** Stored sealed. Anything a person or agent typed belongs here, not in `action`. */
  detail?: Record<string, unknown>;
}

interface ChainedFields {
  workspaceId: string;
  seq: number;
  at: number;
  actorType: string;
  actorId: string | null;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  detailDigest: string;
  previousHash: string | null;
}

const entryHash = (fields: ChainedFields) => digestHex(DomainTag.audit, { entry: fields });

/**
 * Append one event to a workspace's log. Each entry's hash covers the entry before it, so
 * removing or editing a past entry breaks every hash after it. The detail is sealed; its digest
 * is in the chain, so the chain can be checked without the data key.
 *
 * Pass `tx` to make the event part of a transaction that also changes state.
 */
export async function appendAudit(
  ctx: Pick<AppContext, "db" | "sealer" | "now">,
  input: AuditInput,
  tx?: Executor,
): Promise<void> {
  const write = async (executor: Executor) => {
    // One writer per workspace at a time, so `seq` has no gaps and no forks.
    await executor.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${input.workspaceId}`}, 0))`,
    );
    const [last] = await executor
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, input.workspaceId))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const at = ctx.now();
    const detail = input.detail ?? {};
    const fields: ChainedFields = {
      workspaceId: input.workspaceId,
      seq,
      at,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.action,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      detailDigest: digestHex(DomainTag.audit, { detail }),
      previousHash: last?.hash ?? null,
    };
    await executor.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      seq,
      at: new Date(at * 1000),
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.action,
      subjectType: fields.subjectType,
      subjectId: fields.subjectId,
      detailDigest: fields.detailDigest,
      previousHash: fields.previousHash,
      detail: await ctx.sealer.seal(
        input.workspaceId,
        `audit_events.detail:${input.workspaceId}:${seq}`,
        detail,
      ),
      hash: entryHash(fields),
    });
  };
  await (tx ? write(tx) : ctx.db.transaction(write));
}

/** Recompute the whole chain of a workspace and report the first entry that does not follow. */
export async function verifyAudit(
  ctx: Pick<AppContext, "db">,
  workspaceId: WorkspaceId,
): Promise<AuditVerification> {
  const rows = await ctx.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(asc(auditEvents.seq));
  let previousHash: string | null = null;
  let expectedSeq = 1;
  for (const row of rows) {
    const expected = entryHash({
      workspaceId: row.workspaceId,
      seq: row.seq,
      at: Math.floor(row.at.getTime() / 1000),
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      detailDigest: row.detailDigest,
      previousHash,
    });
    if (row.seq !== expectedSeq || row.previousHash !== previousHash || row.hash !== expected) {
      return { ok: false, checked: expectedSeq - 1, brokenAt: row.seq };
    }
    previousHash = row.hash;
    expectedSeq += 1;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
