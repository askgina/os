import type { ApprovalKind, ApprovalSubject, ApprovalSummary } from "@askgina/os-api";
import type {
  AgentId,
  ApprovalId,
  Authorization,
  ConfirmationSubject,
  Envelope,
  MandateId,
  WorkspaceId,
} from "@askgina/os-protocol";
import type { AppContext, Transaction } from "../context.ts";
import type { approvals } from "../db/schema.ts";

/** Any row of `approvals`: a request people decide on, or one use of a mandate. */
export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * A request people decide on with their passkeys: every kind but `mandate-use`, always with its
 * envelope (the table's checks hold the two together).
 */
export type RequestRow = ApprovalRow & { kind: ApprovalKind; envelope: Envelope };

/** Whether a row is a request people decide on, rather than one use of a mandate. */
export function isRequest(row: ApprovalRow): row is RequestRow {
  return row.kind !== "mandate-use" && row.envelope !== null;
}

type EnvelopeOf<K extends ApprovalKind> = Extract<Envelope, { type: K }>;
type HeaderField = "v" | "type" | "approvalId" | "workspaceId" | "nonce" | "issuedAt" | "expiresAt";

/**
 * What a module passes to open an approval request. The engine mints the approval id, the nonce
 * and the validity window, builds the envelope, seals `detail`, starts the workflow that waits
 * for the decision, records the audit event and notifies.
 */
export interface OpenApproval<K extends ApprovalKind = ApprovalKind> {
  workspaceId: WorkspaceId;
  kind: K;
  /**
   * What the request is about: an intent id, a wallet id, a credential id, a mandate id or the
   * workspace id.
   */
  subjectId: string;
  /** The envelope's fields beyond the common header. */
  envelope: Omit<EnvelopeOf<K>, HeaderField>;
  /** How many different people must approve. */
  threshold: number;
  ttlSeconds: number;
  /** Whatever the kind's handler needs later. Stored sealed. */
  detail: unknown;
  requestedBy: { type: "agent" | "user"; id: string };
  /**
   * Runs in the transaction that inserts the request, for rows that must exist together with
   * it, for example the intent that points at its approval.
   */
  alongside?: (tx: Transaction, approvalId: ApprovalId) => Promise<void>;
}

/**
 * What the intents module passes to record one use of a mandate: a row of kind `mandate-use`,
 * already approved, with no envelope and no person, that runs through the same workflow as an
 * approved request. The signer, not this row, decides whether the mandate covers it.
 */
export interface OpenUse {
  workspaceId: WorkspaceId;
  mandateId: MandateId;
  /** The intent the use signs. */
  subjectId: string;
  /** Whatever the use's handler needs later. Stored sealed. */
  detail: unknown;
  requestedBy: { type: "agent"; id: AgentId };
  /** Runs in the transaction that inserts the row, for the intent that points at it. */
  alongside?: (tx: Transaction, approvalId: ApprovalId) => Promise<void>;
}

/** A permanent refusal while applying an approved request. Ends the request as `failed`. */
export class ApprovalFailure extends Error {
  override readonly name = "ApprovalFailure";
  /** A stable code people and agents can act on, for example a signer error code. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * What one kind of approval means. The engine is the same for every kind; a handler supplies how
 * to show a request and what happens once enough people approved it.
 */
export interface ApprovalKindHandler<K extends ApprovalKind = ApprovalKind> {
  kind: K;
  /** One line a person can act on, for the inbox. */
  title(ctx: AppContext, approval: RequestRow, detail: unknown): Promise<string>;
  /** Everything the approval page shows. */
  describe(
    ctx: AppContext,
    approval: RequestRow,
    detail: unknown,
  ): Promise<Extract<ApprovalSubject, { kind: K }>>;
  /**
   * What the envelope names by its hash, for the signer's confirmation page: the intent, the
   * new policy or the sweep, or `envelope-only` for kinds whose envelope carries everything.
   * The signer refuses one that does not hash to what the envelope names.
   */
  confirmationSubject(
    ctx: AppContext,
    approval: RequestRow,
    detail: unknown,
  ): Promise<ConfirmationSubject>;
  /**
   * Apply the effect at the signer and in our tables. Runs inside a workflow step, which the
   * runtime re-runs after a crash, so it must be safe to run twice. Throw {@link ApprovalFailure}
   * for a refusal that retrying cannot fix; any other error is retried.
   */
  execute(
    ctx: AppContext,
    approval: RequestRow,
    authorization: Authorization,
    detail: unknown,
  ): Promise<void>;
  /** The request ended with no effect. Undo whatever opening it set up. */
  abandon?(
    ctx: AppContext,
    approval: RequestRow,
    status: "rejected" | "expired" | "cancelled" | "failed",
    detail: unknown,
  ): Promise<void>;
}

/**
 * What one use of a mandate does. A use has no envelope, no assertions and nothing a person is
 * shown; like a request's handler, `execute` runs in a workflow step and must be safe to run
 * twice, and throws {@link ApprovalFailure} for a refusal retrying cannot fix.
 */
export interface MandateUseHandler {
  kind: "mandate-use";
  execute(ctx: AppContext, use: ApprovalRow, detail: unknown): Promise<void>;
  /** The use ended without a signature: undo what recording it set up. */
  abandon(
    ctx: AppContext,
    use: ApprovalRow,
    status: "rejected" | "expired" | "cancelled" | "failed",
    detail: unknown,
  ): Promise<void>;
}

/** Owned by the execution module (`src/execution/approvals.ts`). */
export interface ApprovalEngine {
  /** Called once per kind at boot. */
  register<K extends ApprovalKind>(handler: ApprovalKindHandler<K>): void;
  open<K extends ApprovalKind>(input: OpenApproval<K>): Promise<ApprovalSummary>;
  /**
   * End a pending request with no effect. Resolves to whether it did: `false` means the request
   * was no longer pending (already approved, rejected, expired or cancelled), and the caller
   * must not treat its subject as cancelled.
   */
  cancel(approvalId: ApprovalId): Promise<boolean>;
}
