import type { ApprovalKind, ApprovalSubject, ApprovalSummary } from "@askgina/os-api";
import type {
  ApprovalId,
  Authorization,
  ConfirmationSubject,
  Envelope,
  WorkspaceId,
} from "@askgina/os-protocol";
import type { AppContext, Transaction } from "../context.ts";
import type { approvals } from "../db/schema.ts";

export type ApprovalRow = typeof approvals.$inferSelect;

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
  /** What the request is about: an intent id, a wallet id, a credential id or the workspace id. */
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
  title(ctx: AppContext, approval: ApprovalRow, detail: unknown): Promise<string>;
  /** Everything the approval page shows. */
  describe(
    ctx: AppContext,
    approval: ApprovalRow,
    detail: unknown,
  ): Promise<Extract<ApprovalSubject, { kind: K }>>;
  /**
   * What the envelope names by its hash, for the signer's confirmation page: the intent, the
   * new policy or the sweep, or `envelope-only` for kinds whose envelope carries everything.
   * The signer refuses one that does not hash to what the envelope names.
   */
  confirmationSubject(
    ctx: AppContext,
    approval: ApprovalRow,
    detail: unknown,
  ): Promise<ConfirmationSubject>;
  /**
   * Apply the effect at the signer and in our tables. Runs inside a workflow step, which the
   * runtime re-runs after a crash, so it must be safe to run twice. Throw {@link ApprovalFailure}
   * for a refusal that retrying cannot fix; any other error is retried.
   */
  execute(
    ctx: AppContext,
    approval: ApprovalRow,
    authorization: Authorization,
    detail: unknown,
  ): Promise<void>;
  /** The request ended with no effect. Undo whatever opening it set up. */
  abandon?(
    ctx: AppContext,
    approval: ApprovalRow,
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
