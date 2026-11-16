import { readFileSync } from "node:fs";
import {
  DomainTag,
  digestHex,
  Intent,
  intentHash,
  Mandate,
  mandateHash,
  policyHash,
  WalletPolicy,
} from "@askgina/os-protocol";
import { z } from "zod";
import { entryHash, sealedDetailDigest } from "../audit.ts";

/**
 * A workspace record, as the export writes it: JSON Lines, a header, then
 * the sections below in this order, each sorted by its key, then an `end` line with the count of
 * each section. Everything in it was opened from sealed columns; nothing in it is a secret.
 */
export const RECORD_FORMAT = "askgina.os/workspace-record/v1";

export const RECORD_SECTIONS = [
  "audit",
  "intent",
  "transaction",
  "policy-revision",
  "mandate",
  "mandate-use",
  "signer-decision",
] as const;

export type RecordSection = (typeof RECORD_SECTIONS)[number];

const Id = z.string().min(1).max(128);

const Seconds = z.number().int();

const Opened = z.record(z.string(), z.unknown());

const Head = z.strictObject({ seq: z.number().int().min(0), hash: z.string().nullable() });

type Head = z.infer<typeof Head>;

export const RecordHeader = z.strictObject({
  format: z.literal(RECORD_FORMAT),
  workspaceId: Id,
  exportedAt: Seconds,
  /** The newest audit entry exported; `{ seq: 0, hash: null }` for an empty log. */
  auditHead: Head,
  /** The newest signer decision exported, likewise. */
  signerDecisionHead: Head,
});

export type RecordHeader = z.infer<typeof RecordHeader>;

/** One audit entry with its chained fields, its salt and its opened detail. */
export const AuditLine = z.strictObject({
  type: z.literal("audit"),
  seq: z.number().int().min(1),
  at: Seconds,
  actorType: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  detailDigest: z.string(),
  previousHash: z.string().nullable(),
  hash: z.string(),
  salt: z.string(),
  /** JSON, as the sealed detail it was opened from. */
  detail: z.record(z.string(), z.json()),
});

export const IntentLine = z.strictObject({
  type: z.literal("intent"),
  id: Id,
  agentId: Id,
  walletId: Id,
  chainId: z.string(),
  status: z.string(),
  intentHash: z.string(),
  /** The canonical intent the agent proposed. */
  intent: Opened,
  /** What people were shown: the display and the simulation. */
  presentation: Opened,
  approvalId: Id.nullable(),
  mandateId: Id.nullable(),
  failureCode: z.string().nullable(),
  createdAt: Seconds,
});

/** A signed transaction without its signed bytes, with every later attempt at its nonce. */
export const TransactionLine = z.strictObject({
  type: z.literal("transaction"),
  approvalId: Id,
  intentId: Id.nullable(),
  walletId: Id,
  chainId: z.string(),
  nonce: z.number().int().min(0),
  hash: z.string(),
  status: z.string(),
  blockNumber: z.number().int().nullable(),
  latestAttempt: z.number().int().min(0),
  minedAttempt: z.number().int().min(0).nullable(),
  createdAt: Seconds,
  attempts: z.array(
    z.strictObject({
      attempt: z.number().int().min(1),
      kind: z.enum(["reprice", "cancel"]),
      hash: z.string(),
      gas: z.string(),
      maxFeePerGas: z.string(),
      maxPriorityFeePerGas: z.string(),
      cancelApprovalId: Id.nullable(),
      status: z.enum(["pending", "mined", "replaced"]),
      signedAt: Seconds,
    }),
  ),
});

/** A policy people approved (an executed `set-policy` request). */
export const PolicyRevisionLine = z.strictObject({
  type: z.literal("policy-revision"),
  approvalId: Id,
  walletId: Id,
  decidedAt: Seconds.nullable(),
  policyHash: z.string(),
  policy: Opened,
});

/** A mandate as granted, with what this control plane and the signer last knew of it. */
export const MandateLine = z.strictObject({
  type: z.literal("mandate"),
  mandateId: Id,
  walletId: Id,
  agentId: Id,
  grantApprovalId: Id,
  mandateHash: z.string(),
  mandate: Opened,
  mirror: z.strictObject({ status: z.string(), endedReason: z.string().nullable() }),
  /** Null when the signer no longer answers for the wallet (its key destroyed). */
  signer: z
    .strictObject({
      status: z.string(),
      revokedAt: Seconds.nullable(),
      revokedReason: z.string().nullable(),
      usage: z.strictObject({
        uses: z.number().int().min(0),
        assets: z.array(
          z.strictObject({
            chainId: z.string(),
            asset: z.string(),
            total: z.string(),
            inWindow: z.string(),
          }),
        ),
      }),
    })
    .nullable(),
});

/** One payment a mandate covered: the `mandate-use` request that ran it. */
export const MandateUseLine = z.strictObject({
  type: z.literal("mandate-use"),
  approvalId: Id,
  mandateId: Id,
  intentId: Id,
  status: z.string(),
  createdAt: Seconds,
  decidedAt: Seconds.nullable(),
});

/** One entry of the signer's own decision log, as the signer lists it. */
export const SignerDecisionLine = z.strictObject({
  type: z.literal("signer-decision"),
  seq: z.number().int().min(1),
  at: Seconds,
  approvalId: Id.nullable(),
  action: z.string(),
  outcome: z.enum(["allowed", "denied"]),
  code: z.string().nullable(),
  previousHash: z.string().nullable(),
  hash: z.string(),
});

export const RecordLine = z.discriminatedUnion("type", [
  AuditLine,
  IntentLine,
  TransactionLine,
  PolicyRevisionLine,
  MandateLine,
  MandateUseLine,
  SignerDecisionLine,
]);

export type RecordLine = z.infer<typeof RecordLine>;

export const RecordEnd = z.strictObject({
  type: z.literal("end"),
  counts: z.strictObject({
    audit: z.number().int().min(0),
    intent: z.number().int().min(0),
    transaction: z.number().int().min(0),
    "policy-revision": z.number().int().min(0),
    mandate: z.number().int().min(0),
    "mandate-use": z.number().int().min(0),
    "signer-decision": z.number().int().min(0),
  }),
});

export type RecordEnd = z.infer<typeof RecordEnd>;

/** The order of lines within a section. */
export function recordLineKey(line: RecordLine): string | number {
  switch (line.type) {
    case "audit":
    case "signer-decision":
      return line.seq;
    case "intent":
      return line.id;
    case "mandate":
      return line.mandateId;
    default:
      return line.approvalId;
  }
}

/**
 * The hash of one signer decision, computed exactly as the signer does
 * (`apps/signer/src/decisions.ts`, `entryHash`), so the decision log verifies offline.
 */
export function signerDecisionHash(
  workspaceId: string,
  decision: Omit<z.infer<typeof SignerDecisionLine>, "type" | "hash">,
): string {
  return digestHex(DomainTag.audit, {
    kind: "signer-decision",
    workspaceId,
    seq: decision.seq,
    at: decision.at,
    approvalId: decision.approvalId,
    action: decision.action,
    outcome: decision.outcome,
    code: decision.code,
    previousHash: decision.previousHash,
  });
}

export interface RecordVerification {
  ok: boolean;
  /** The 1-based number of the first line that does not verify, or one past the last line. */
  brokenAt: number | null;
}

function parseJson<T>(schema: z.ZodType<T>, text: string | undefined): T | null {
  if (text === undefined) return null;

  try {
    const parsed = schema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whether a line's own digests hold: its detail, its intent, its policy or its mandate. */
function selfConsistent(line: RecordLine): boolean {
  try {
    switch (line.type) {
      case "audit":
        return sealedDetailDigest({ salt: line.salt, detail: line.detail }) === line.detailDigest;
      case "intent":
        return intentHash(Intent.parse(line.intent)) === line.intentHash;
      case "policy-revision":
        return policyHash(WalletPolicy.parse(line.policy)) === line.policyHash;
      case "mandate":
        return mandateHash(Mandate.parse(line.mandate)) === line.mandateHash;
      default:
        return true;
    }
  } catch {
    return false;
  }
}

/**
 * Check a record offline: every audit hash and detail digest, the audit chain and its head, every
 * intent, policy and mandate hash, the signer's decision chain and its head, the order of every
 * line, and the count of each section. Editing, deleting or reordering any line makes it fail.
 */
export function verifyRecord(lines: readonly string[]): RecordVerification {
  const broken = (index: number): RecordVerification => ({ ok: false, brokenAt: index + 1 });
  const header = parseJson(RecordHeader, lines[0]);

  if (!header) return broken(0);

  const counts: Record<RecordSection, number> = {
    audit: 0,
    intent: 0,
    transaction: 0,
    "policy-revision": 0,
    mandate: 0,
    "mandate-use": 0,
    "signer-decision": 0,
  };

  const sameHead = (head: Head, expected: Head) =>
    head.seq === expected.seq && head.hash === expected.hash;

  const audit: Head = { seq: 0, hash: null };
  const decisions: Head = { seq: 0, hash: null };
  let section = 0;
  let lastKey: string | number | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const end = parseJson(RecordEnd, lines[index]);

    if (end) {
      const complete =
        index === lines.length - 1 &&
        sameHead(audit, header.auditHead) &&
        sameHead(decisions, header.signerDecisionHead) &&
        RECORD_SECTIONS.every((name) => end.counts[name] === counts[name]);

      return complete ? { ok: true, brokenAt: null } : broken(index);
    }

    const line = parseJson(RecordLine, lines[index]);

    if (!line) return broken(index);
    const position = RECORD_SECTIONS.indexOf(line.type);

    if (position < section) return broken(index);

    if (position > section) {
      // Leaving the audit section: every entry up to the head must have been there.
      if (section === 0 && !sameHead(audit, header.auditHead)) return broken(index);
      section = position;
      lastKey = null;
    }

    const key = recordLineKey(line);

    if (lastKey !== null && !(key > lastKey)) return broken(index);
    lastKey = key;

    if (!selfConsistent(line)) return broken(index);

    if (line.type === "audit") {
      const expected = entryHash({
        workspaceId: header.workspaceId,
        seq: line.seq,
        at: line.at,
        actorType: line.actorType,
        actorId: line.actorId,
        action: line.action,
        subjectType: line.subjectType,
        subjectId: line.subjectId,
        detailDigest: line.detailDigest,
        previousHash: line.previousHash,
      });

      if (
        line.seq !== audit.seq + 1 ||
        line.previousHash !== audit.hash ||
        line.hash !== expected
      ) {
        return broken(index);
      }

      audit.seq = line.seq;
      audit.hash = line.hash;
    }

    if (line.type === "signer-decision") {
      if (
        line.seq !== decisions.seq + 1 ||
        line.previousHash !== decisions.hash ||
        line.hash !== signerDecisionHash(header.workspaceId, line)
      ) {
        return broken(index);
      }

      decisions.seq = line.seq;
      decisions.hash = line.hash;
    }

    counts[line.type] += 1;
  }

  // No `end` line: the record was cut short.
  return broken(lines.length);
}

/** The lines of a record file: one JSON document per line, a final newline allowed. */
export function recordLines(text: string): string[] {
  const lines = text.split("\n");

  if (lines.at(-1) === "") lines.pop();

  return lines;
}

/**
 * `node apps/server/src/lifecycle/verify-record.ts <file>`: prints `{ ok, brokenAt }` as one JSON
 * line; exits 0 when the record verifies, 2 when it does not, 1 when the file cannot be read.
 */
export function main(argv: readonly string[]): number {
  const [file] = argv;

  if (argv.length !== 1 || file === undefined) {
    process.stderr.write("usage: node apps/server/src/lifecycle/verify-record.ts <file>\n");

    return 1;
  }

  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "unreadable" })}\n`);

    return 1;
  }

  const result = verifyRecord(recordLines(text));
  process.stdout.write(`${JSON.stringify(result)}\n`);

  return result.ok ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
