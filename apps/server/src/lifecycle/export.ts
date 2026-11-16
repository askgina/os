import type { WorkspaceId } from "@askgina/os-protocol";
import type { MandateState } from "@askgina/os-protocol/signer";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { appendAudit, openAuditSealed } from "../audit.ts";
import type { AppContext, Session } from "../context.ts";
import {
  approvals,
  auditEvents,
  intents,
  mandates,
  transactionAttempts,
  transactions,
  wallets,
} from "../db/schema.ts";
import { SetPolicyDetail } from "../directory/kinds.ts";
import { engineOf } from "../execution/approvals.ts";
import { readIntent } from "../execution/intents.ts";
import { openMandate } from "../execution/mandates.ts";
import {
  RECORD_FORMAT,
  RECORD_SECTIONS,
  type RecordEnd,
  type RecordHeader,
  type RecordLine,
  type RecordSection,
  recordLineKey,
  type SignerDecisionLine,
  type TransactionLine,
} from "./verify-record.ts";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const byKey = (a: RecordLine, b: RecordLine) => {
  const left = recordLineKey(a);
  const right = recordLineKey(b);

  return left < right ? -1 : left > right ? 1 : 0;
};

/** Where record lines go, one JSON document at a time, in order. */
export type RecordSink = (line: string) => void | Promise<void>;

/**
 * Write a workspace's record (format {@link RECORD_FORMAT}) to `sink` as JSON Lines: a header,
 * the opened audit log with its chained fields and salts, intents, transactions without their
 * signed bytes, policy revisions, mandates with what the signer counts of them and their uses
 * (D11), the signer's decision log, and an `end` line. `workspace.exported` is appended first,
 * so the record includes its own export. No token, session, sealed value, confirmation link,
 * push endpoint or signed transaction is written.
 */
export async function writeRecord(
  ctx: AppContext,
  session: Session,
  workspaceId: WorkspaceId,
  sink: RecordSink,
): Promise<{ lines: number }> {
  const exportedAt = ctx.now();
  await appendAudit(ctx, {
    workspaceId,
    actor: { type: "user", id: session.user.id },
    action: "workspace.exported",
    subject: { type: "workspace", id: workspaceId },
    detail: { format: RECORD_FORMAT },
  });

  // One snapshot of the control plane's rows, so the sections agree with each other.
  const rows = await ctx.db.transaction(
    async (tx) => ({
      audit: await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId))
        .orderBy(asc(auditEvents.seq)),
      intents: await tx.select().from(intents).where(eq(intents.workspaceId, workspaceId)),
      transactions: await tx
        .select({ transaction: transactions })
        .from(transactions)
        .innerJoin(wallets, eq(wallets.id, transactions.walletId))
        .where(eq(wallets.workspaceId, workspaceId)),
      attempts: await tx
        .select({ attempt: transactionAttempts })
        .from(transactionAttempts)
        .innerJoin(transactions, eq(transactions.approvalId, transactionAttempts.approvalId))
        .innerJoin(wallets, eq(wallets.id, transactions.walletId))
        .where(eq(wallets.workspaceId, workspaceId))
        .orderBy(asc(transactionAttempts.attempt)),
      policies: await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.workspaceId, workspaceId),
            eq(approvals.kind, "set-policy"),
            eq(approvals.status, "executed"),
          ),
        ),
      mandates: await tx.select().from(mandates).where(eq(mandates.workspaceId, workspaceId)),
      uses: await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.kind, "mandate-use"))),
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  const decisions: z.infer<typeof SignerDecisionLine>[] = [];

  for (let after = 0; ; ) {
    const page = await ctx.signer.listDecisions(workspaceId, { after });
    const last = page.decisions.at(-1);

    if (!last) break;

    for (const { workspaceId: _, ...decision } of page.decisions) {
      decisions.push({ type: "signer-decision", ...decision });
    }

    after = last.seq;
  }

  // What the signer counts of each mandate. A wallet whose key is gone no longer answers.
  const signerMandates = new Map<string, MandateState>();

  for (const walletId of new Set(rows.mandates.map((row) => row.walletId))) {
    try {
      for (const state of (await ctx.signer.listMandates(walletId)).mandates) {
        signerMandates.set(state.mandate.id, state);
      }
    } catch {
      // Recorded as `signer: null` below.
    }
  }

  const engine = engineOf(ctx);
  const attemptsOf = new Map<string, z.infer<typeof TransactionLine>["attempts"]>();

  for (const { attempt } of rows.attempts) {
    const list = attemptsOf.get(attempt.approvalId) ?? [];
    list.push({
      attempt: attempt.attempt,
      kind: attempt.kind,
      hash: attempt.hash,
      gas: attempt.gas,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      cancelApprovalId: attempt.cancelApprovalId,
      status: attempt.status,
      signedAt: seconds(attempt.signedAt),
    });
    attemptsOf.set(attempt.approvalId, list);
  }

  const sections: Record<RecordSection, RecordLine[]> = {
    audit: [],
    intent: [],
    transaction: [],
    "policy-revision": [],
    mandate: [],
    "mandate-use": [],
    "signer-decision": decisions,
  };

  for (const row of rows.audit) {
    const sealed = await openAuditSealed(ctx, row);
    sections.audit.push({
      type: "audit",
      seq: row.seq,
      at: seconds(row.at),
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      detailDigest: row.detailDigest,
      previousHash: row.previousHash,
      hash: row.hash,
      salt: sealed.salt,
      detail: sealed.detail,
    });
  }

  for (const row of rows.intents) {
    const { intent, presentation } = await readIntent(ctx, row);
    sections.intent.push({
      type: "intent",
      id: row.id,
      agentId: row.agentId,
      walletId: row.walletId,
      chainId: row.chainId,
      status: row.status,
      intentHash: row.intentHash,
      intent,
      presentation: { ...presentation },
      approvalId: row.approvalId,
      mandateId: row.mandateId,
      failureCode: row.failureCode,
      createdAt: seconds(row.createdAt),
    });
  }

  for (const { transaction } of rows.transactions) {
    sections.transaction.push({
      type: "transaction",
      approvalId: transaction.approvalId,
      intentId: transaction.intentId,
      walletId: transaction.walletId,
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      hash: transaction.hash,
      status: transaction.status,
      blockNumber: transaction.blockNumber,
      latestAttempt: transaction.latestAttempt,
      minedAttempt: transaction.minedAttempt,
      createdAt: seconds(transaction.createdAt),
      attempts: attemptsOf.get(transaction.approvalId) ?? [],
    });
  }

  for (const row of rows.policies) {
    if (row.envelope?.type !== "set-policy") continue;
    const { policy } = SetPolicyDetail.parse(await engine.openDetail(row));
    sections["policy-revision"].push({
      type: "policy-revision",
      approvalId: row.id,
      walletId: row.subjectId,
      decidedAt: row.decidedAt === null ? null : seconds(row.decidedAt),
      // The hash people's passkeys signed, not one computed here: the verifier compares them.
      policyHash: row.envelope.policyHash,
      policy,
    });
  }

  for (const row of rows.mandates) {
    const state = signerMandates.get(row.id);
    sections.mandate.push({
      type: "mandate",
      mandateId: row.id,
      walletId: row.walletId,
      agentId: row.agentId,
      grantApprovalId: row.grantApprovalId,
      mandateHash: row.mandateHash,
      mandate: await openMandate(ctx, row),
      mirror: { status: row.status, endedReason: row.endedReason },
      signer: state
        ? {
            status: state.status,
            revokedAt: state.revokedAt,
            revokedReason: state.revokedReason,
            usage: state.usage,
          }
        : null,
    });
  }

  for (const row of rows.uses) {
    if (row.mandateId === null) continue;
    sections["mandate-use"].push({
      type: "mandate-use",
      approvalId: row.id,
      mandateId: row.mandateId,
      intentId: row.subjectId,
      status: row.status,
      createdAt: seconds(row.createdAt),
      decidedAt: row.decidedAt === null ? null : seconds(row.decidedAt),
    });
  }

  const lastAudit = rows.audit.at(-1);
  const lastDecision = decisions.at(-1);

  const header: RecordHeader = {
    format: RECORD_FORMAT,
    workspaceId,
    exportedAt,
    auditHead: { seq: lastAudit?.seq ?? 0, hash: lastAudit?.hash ?? null },
    signerDecisionHead: { seq: lastDecision?.seq ?? 0, hash: lastDecision?.hash ?? null },
  };

  await sink(JSON.stringify(header));

  for (const name of RECORD_SECTIONS) {
    for (const line of sections[name].sort(byKey)) await sink(JSON.stringify(line));
  }

  const end: RecordEnd = {
    type: "end",
    counts: {
      audit: sections.audit.length,
      intent: sections.intent.length,
      transaction: sections.transaction.length,
      "policy-revision": sections["policy-revision"].length,
      mandate: sections.mandate.length,
      "mandate-use": sections["mandate-use"].length,
      "signer-decision": sections["signer-decision"].length,
    },
  };

  await sink(JSON.stringify(end));

  return { lines: 2 + RECORD_SECTIONS.reduce((sum, name) => sum + sections[name].length, 0) };
}
