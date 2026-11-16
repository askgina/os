import { randomBytes } from "node:crypto";
import type { AuditVerification } from "@askgina/os-api";
import { DomainTag, digestHex, type WorkspaceId } from "@askgina/os-protocol";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext, Executor } from "./context.ts";
import { auditEvents, workspaces } from "./db/schema.ts";
import type { JsonValue } from "./db/sealed.ts";
import { stored } from "./db/stored.ts";

/**
 * The detail of an event, as the code that records it builds it: JSON fields. A field set to
 * `undefined` is left out, as JSON leaves it out.
 */
export type AuditDetail = { [field: string]: JsonValue | undefined };

export interface AuditInput {
  workspaceId: WorkspaceId;
  actor: { type: "user" | "agent" | "system" | "signer"; id: string | null };
  /** `noun.verb`, for example `intent.proposed`, `approval.approved`, `policy.changed`. */
  action: string;
  subject?: { type: string; id: string };
  /** Stored sealed. Anything a person or agent typed belongs here, not in `action`. */
  detail?: AuditDetail;
}

/**
 * What is sealed for an event. The random salt keeps the plaintext digest in the chain from
 * confirming a guess about the sealed detail: without it, anyone who reads the database could
 * hash a candidate memo and compare.
 */
export const SealedDetail = z.strictObject({
  salt: z.string(),
  detail: z.record(z.string(), z.json()),
});

export type SealedDetail = z.infer<typeof SealedDetail>;

/** What an entry's hash covers. An exported record carries these fields, so it verifies offline. */
export interface ChainedFields {
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

export const entryHash = (fields: ChainedFields) => digestHex(DomainTag.audit, { entry: fields });

/** The digest of a sealed detail that the chain carries in `detailDigest`. */
export const sealedDetailDigest = (sealed: SealedDetail) => digestHex(DomainTag.audit, sealed);

const sealContext = (workspaceId: string, seq: number) =>
  `audit_events.detail:${workspaceId}:${seq}`;

/**
 * Append one event to a workspace's log. Each entry's hash covers the entry before it, and the
 * workspace row keeps the newest one, so removing or editing any entry, the newest included, is
 * detected. The detail is sealed; its salted digest is in the chain, so the chain can be checked
 * without the data key.
 *
 * Pass `tx` to make the event part of a transaction that also changes state.
 */
export async function appendAudit(
  ctx: Pick<AppContext, "db" | "sealer" | "now">,
  input: AuditInput,
  tx?: Executor,
): Promise<void> {
  const write = async (executor: Executor) => {
    // Locking the workspace row gives one writer per workspace at a time, so `seq` has no gaps
    // and no forks, and the head moves with the entry. The lock is the one an update of these
    // columns takes anyway. A stronger `FOR UPDATE` would also wait for every transaction that
    // inserted a row referring to the workspace (a foreign key holds `FOR KEY SHARE` on it), and
    // two such transactions appending at once would each wait for the other: a deadlock.
    const [head] = await executor
      .select({ seq: workspaces.auditSeq, hash: workspaces.auditHead })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for("no key update");

    if (!head) throw new Error("audit append for a workspace that does not exist");
    const seq = head.seq + 1;
    const at = ctx.now();

    const sealed: SealedDetail = {
      salt: randomBytes(16).toString("base64url"),
      // The detail without its `undefined` fields, in the same order. Sealing (`JSON.stringify`)
      // and the digest (canonical JSON) leave those fields out anyway: the bytes are the same.
      detail: Object.fromEntries(
        Object.entries(input.detail ?? {}).flatMap(([field, value]) =>
          value === undefined ? [] : [[field, value] as const],
        ),
      ),
    };

    const fields: ChainedFields = {
      workspaceId: input.workspaceId,
      seq,
      at,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.action,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      detailDigest: sealedDetailDigest(sealed),
      previousHash: head.hash,
    };

    const hash = entryHash(fields);
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
      detail: await ctx.sealer.seal(input.workspaceId, sealContext(input.workspaceId, seq), sealed),
      hash,
    });
    await executor
      .update(workspaces)
      .set({ auditSeq: seq, auditHead: hash })
      .where(eq(workspaces.id, input.workspaceId));
  };

  await (tx ? write(tx) : ctx.db.transaction(write));
}

/** Open one event's sealed detail with its salt, from which `detailDigest` was computed. */
export async function openAuditSealed(
  ctx: Pick<AppContext, "sealer">,
  row: { workspaceId: WorkspaceId; seq: number; detail: Buffer },
): Promise<SealedDetail> {
  const opened = await ctx.sealer.open(
    row.workspaceId,
    sealContext(row.workspaceId, row.seq),
    row.detail,
  );

  return stored(SealedDetail, opened, "audit event detail");
}

/** Open one event's sealed detail. */
export async function openAuditDetail(
  ctx: Pick<AppContext, "sealer">,
  row: { workspaceId: WorkspaceId; seq: number; detail: Buffer },
): Promise<Record<string, JsonValue>> {
  return (await openAuditSealed(ctx, row)).detail;
}

/**
 * Recompute the whole chain of a workspace and report the first entry that does not follow.
 * Missing newest entries show up against the head kept on the workspace row; `brokenAt` is then
 * the first missing sequence number.
 */
export async function verifyAudit(
  ctx: Pick<AppContext, "db">,
  workspaceId: WorkspaceId,
): Promise<AuditVerification> {
  const [workspace] = await ctx.db
    .select({ seq: workspaces.auditSeq, head: workspaces.auditHead })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

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

  const headSeq = workspace?.seq ?? 0;
  const headHash = workspace?.head ?? null;

  if (rows.length !== headSeq || previousHash !== headHash) {
    return { ok: false, checked: rows.length, brokenAt: rows.length + 1 };
  }

  return { ok: true, checked: rows.length, brokenAt: null };
}
