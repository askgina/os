import { randomBytes } from "node:crypto";
import type {
  ApprovalDetail,
  ApprovalKind,
  ApprovalStatus,
  ApprovalSummary,
  Requester,
} from "@askgina/os-api";
import {
  type ApprovalId,
  type ApproverCredential,
  type Assertion,
  type AssertionResponse,
  Envelope,
  newId,
  PROTOCOL_VERSION,
  type UserId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { verifyAuthorization } from "@askgina/os-protocol/webauthn";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  type ApprovalEngine,
  ApprovalFailure,
  type ApprovalKindHandler,
  type ApprovalRow,
  isRequest,
  type MandateUseHandler,
  type OpenApproval,
  type OpenUse,
  type RequestRow,
} from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext, Executor, Session, Transaction } from "../context.ts";
import {
  type ApprovalRowKind,
  agents,
  approvalAssertions,
  approvalRejections,
  approvals,
  approverCredentials,
  credentials,
  memberships,
  users,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { enqueueApprovalNotifications, enqueueMandateUseNotification } from "../notify/outbox.ts";
import type { SettledStatus, StepImplementations } from "./steps.ts";
import type { WorkflowRuntime } from "./workflow-runtime.ts";

/** Work after an approval's effect (for intents: broadcast and confirm). */
export type FollowUp = (
  ctx: AppContext,
  approval: ApprovalRow,
) => Promise<{ done: boolean; waitSeconds: number }>;

const PAGE_SIZE = 50;
const ENDED: readonly SettledStatus[] = ["rejected", "expired", "cancelled", "failed"];

const detailLocation = (id: string) => `approvals.detail:${id}`;
const confirmationLocation = (id: string) => `approvals.confirmation:${id}`;

/** Why an assertion does not count, with the code the signer would give for it. */
type Verdict = { ok: true; credentialId: string } | { ok: false; code: string };

/** A list position: the last row's creation time and id, so equal timestamps still page. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.getTime()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const time = Number(at);
  if (!id || !Number.isSafeInteger(time)) throw new HttpError("invalid_request", "bad cursor");
  return { at: new Date(time), id };
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * The one engine behind every approval request. Kinds plug in through handlers; the engine owns
 * the request's lifecycle: the envelope and its nonce, the assertions, the decision, the
 * workflow that applies the effect, and the audit trail.
 */
export class Engine implements ApprovalEngine {
  readonly #ctx: AppContext;
  readonly #handlers = new Map<ApprovalKind, ApprovalKindHandler>();
  #useHandler: MandateUseHandler | null = null;
  readonly #followUps = new Map<ApprovalRowKind, FollowUp>();
  /**
   * Set by `startBackground` once the World runs. Until then requests are recorded without a
   * workflow, and the sweeper starts their workflows when the runtime is up.
   */
  #runtime: WorkflowRuntime | null = null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  register<K extends ApprovalKind>(handler: ApprovalKindHandler<K>): void {
    this.#handlers.set(handler.kind, handler as unknown as ApprovalKindHandler);
  }

  /** Called once at boot by the intents module, which signs each use. */
  registerUse(handler: MandateUseHandler): void {
    this.#useHandler = handler;
  }

  attachRuntime(runtime: WorkflowRuntime | null): void {
    this.#runtime = runtime;
  }

  registerFollowUp(kind: ApprovalRowKind, followUp: FollowUp): void {
    this.#followUps.set(kind, followUp);
  }

  handler(kind: ApprovalKind): ApprovalKindHandler {
    const handler = this.#handlers.get(kind);
    if (!handler) throw new Error(`no handler registered for approval kind ${kind}`);
    return handler;
  }

  #use(): MandateUseHandler {
    if (this.#useHandler === null) throw new Error("no handler registered for mandate uses");
    return this.#useHandler;
  }

  async open<K extends ApprovalKind>(input: OpenApproval<K>): Promise<ApprovalSummary> {
    const ctx = this.#ctx;
    this.handler(input.kind);
    const id = newId("apr");
    const issuedAt = ctx.now();
    const expiresAt = issuedAt + input.ttlSeconds;
    const envelope = Envelope.parse({
      ...input.envelope,
      v: PROTOCOL_VERSION,
      type: input.kind,
      approvalId: id,
      workspaceId: input.workspaceId,
      nonce: randomBytes(16).toString("base64url"),
      issuedAt,
      expiresAt,
    });
    await ctx.db.transaction(async (tx) => {
      await tx.insert(approvals).values({
        id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        subjectId: input.subjectId,
        envelope,
        threshold: input.threshold,
        detail: await ctx.sealer.seal(input.workspaceId, detailLocation(id), input.detail ?? null),
        requestedByType: input.requestedBy.type,
        requestedById: input.requestedBy.id,
        createdAt: new Date(issuedAt * 1000),
        expiresAt: new Date(expiresAt * 1000),
      });
      await input.alongside?.(tx, id);
      await appendAudit(
        ctx,
        {
          workspaceId: input.workspaceId,
          actor: { type: input.requestedBy.type, id: input.requestedBy.id },
          action: "approval.opened",
          subject: { type: "approval", id },
          detail: { kind: input.kind, subjectId: input.subjectId, threshold: input.threshold },
        },
        tx,
      );
      await enqueueApprovalNotifications(ctx, tx, {
        id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        createdAt: issuedAt,
        expiresAt,
      });
    });
    await this.startRun(id, input.workspaceId, expiresAt);
    const row = await this.request(id);
    // The confirmation page is ready before anyone looks. The request is already recorded, so a
    // failure here does not fail it: the first view of the request tries again.
    await this.ensureConfirmation(row).catch((error: unknown) => {
      ctx.log.warn("opening a confirmation failed", {
        approvalId: id,
        code: "internal",
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    return this.summary(row);
  }

  /**
   * Record one use of a mandate: a `mandate-use` row, already approved, with no envelope and no
   * person, and start the workflow that signs it under the mandate, exactly as it would sign an
   * approved request. The row's outbox entry is `needed`, so a run that is lost before it first
   * looks is started again by the sweeper. Not shown in any list of approvals.
   */
  async openUse(input: OpenUse): Promise<ApprovalRow> {
    const ctx = this.#ctx;
    this.#use();
    const id = newId("apr");
    const at = new Date(ctx.now() * 1000);
    await ctx.db.transaction(async (tx) => {
      await tx.insert(approvals).values({
        id,
        workspaceId: input.workspaceId,
        kind: "mandate-use",
        subjectId: input.subjectId,
        status: "approved",
        envelope: null,
        mandateId: input.mandateId,
        // Nobody approves a use: the mandate's grant was approved at the admin threshold.
        threshold: 0,
        detail: await ctx.sealer.seal(input.workspaceId, detailLocation(id), input.detail ?? null),
        requestedByType: input.requestedBy.type,
        requestedById: input.requestedBy.id,
        createdAt: at,
        // Decided when it is created, so it never waits and never expires.
        expiresAt: at,
        decidedAt: at,
        resumeState: "needed",
      });
      await input.alongside?.(tx, id);
      await appendAudit(
        ctx,
        {
          workspaceId: input.workspaceId,
          actor: { type: input.requestedBy.type, id: input.requestedBy.id },
          action: "mandate.used",
          subject: { type: "approval", id },
          detail: { mandateId: input.mandateId, subjectId: input.subjectId },
        },
        tx,
      );
      await enqueueMandateUseNotification(ctx, tx, {
        id,
        workspaceId: input.workspaceId,
        createdAt: seconds(at),
      });
    });
    await this.startRun(id, input.workspaceId, seconds(at));
    return this.row(id);
  }

  /**
   * End a pending request with no effect. True only when this call cancelled it; `alongside`
   * runs in the same transaction, so a subject is marked cancelled exactly when its request is.
   */
  async cancel(
    approvalId: ApprovalId,
    alongside?: (tx: Transaction) => Promise<unknown>,
  ): Promise<boolean> {
    const ctx = this.#ctx;
    const ended = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(approvals)
        .set({ status: "cancelled", decidedAt: new Date(ctx.now() * 1000), resumeState: "needed" })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .returning();
      if (!row) return false;
      await alongside?.(tx);
      await appendAudit(
        ctx,
        {
          workspaceId: row.workspaceId,
          actor: { type: "system", id: null },
          action: "approval.cancelled",
          subject: { type: "approval", id: approvalId },
        },
        tx,
      );
      return true;
    });
    if (ended) await this.wake(approvalId);
    return ended;
  }

  /**
   * Start the waiting workflow. A failure is left to the sweeper, which starts it later.
   *
   * Starts for one request are serialized under an advisory lock, and a start happens only
   * while no run is recorded, so there is normally one run per request. A crash between
   * starting a run and recording it can still leave two. That is safe: the first run recorded
   * owns the request, each run waits on a hook of its own, and the other run ends as
   * `superseded` the first time it looks.
   */
  async startRun(id: ApprovalId, workspaceId: WorkspaceId, expiresAt: number): Promise<void> {
    const ctx = this.#ctx;
    const runtime = this.#runtime;
    if (runtime === null) return;
    try {
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run:${id}`}, 0))`);
        const [row] = await tx
          .select({ runId: approvals.runId })
          .from(approvals)
          .where(eq(approvals.id, id));
        if (!row || row.runId !== null) return;
        const runId = await runtime.startRun({ approvalId: id, workspaceId, expiresAt });
        await tx
          .update(approvals)
          .set({ runId })
          .where(and(eq(approvals.id, id), isNull(approvals.runId)));
      });
    } catch (error) {
      ctx.log.warn("approval workflow start failed", {
        approvalId: id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** Resume the workflow so it reads the decision; marks the outbox done when it worked. */
  async wake(id: ApprovalId): Promise<boolean> {
    const ctx = this.#ctx;
    if (this.#runtime === null) return false;
    // Wake the run that owns the request. With none recorded yet there is nothing to wake: a
    // run reads the decision when it first looks, and the sweeper tries again meanwhile.
    const [owner] = await ctx.db
      .select({ runId: approvals.runId })
      .from(approvals)
      .where(eq(approvals.id, id));
    if (!owner || owner.runId === null) return false;
    const woken = await this.#runtime.wake(id, owner.runId);
    if (woken) {
      await ctx.db
        .update(approvals)
        .set({ resumeState: "done" })
        .where(and(eq(approvals.id, id), eq(approvals.resumeState, "needed")));
    }
    return woken;
  }

  async row(id: string, executor: Executor = this.#ctx.db): Promise<ApprovalRow> {
    const [row] = await executor
      .select()
      .from(approvals)
      .where(eq(approvals.id, id as ApprovalId));
    if (!row) throw new HttpError("not_found", "no such approval");
    return row;
  }

  /**
   * A request people decide on. A use of a mandate is no such request and answers `not_found`
   * like an id that does not exist: it is never shown, approved or rejected.
   */
  async request(id: string, executor: Executor = this.#ctx.db): Promise<RequestRow> {
    const row = await this.row(id, executor);
    if (!isRequest(row)) throw new HttpError("not_found", "no such approval");
    return row;
  }

  async openDetail(row: ApprovalRow): Promise<unknown> {
    if (row.detail === null) return null;
    return this.#ctx.sealer.open(row.workspaceId, detailLocation(row.id), row.detail);
  }

  /** The status a person should see: a pending request past its expiry is already expired. */
  shownStatus(row: ApprovalRow): ApprovalStatus {
    if (row.status === "pending" && seconds(row.expiresAt) <= this.#ctx.now()) return "expired";
    return row.status;
  }

  async summary(row: RequestRow): Promise<ApprovalSummary> {
    const ctx = this.#ctx;
    const detail = await this.openDetail(row);
    const [count] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalAssertions)
      .where(eq(approvalAssertions.approvalId, row.id));
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      status: this.shownStatus(row),
      title: await this.handler(row.kind).title(ctx, row, detail),
      requestedBy: await this.#requester(row),
      createdAt: seconds(row.createdAt),
      expiresAt: seconds(row.expiresAt),
      threshold: row.threshold,
      approvals: count?.n ?? 0,
      failureCode: row.failureCode,
    };
  }

  async detail(row: RequestRow, session: Session): Promise<ApprovalDetail> {
    const ctx = this.#ctx;
    const detail = await this.openDetail(row);
    const approvedBy = await ctx.db
      .select({ id: users.id, displayName: users.displayName })
      .from(approvalAssertions)
      .innerJoin(users, eq(users.id, approvalAssertions.userId))
      .where(eq(approvalAssertions.approvalId, row.id))
      .orderBy(asc(approvalAssertions.createdAt));
    const [rejectedBy] = await ctx.db
      .select({ id: users.id, displayName: users.displayName })
      .from(approvalRejections)
      .innerJoin(users, eq(users.id, approvalRejections.userId))
      .where(eq(approvalRejections.approvalId, row.id));
    const decided = approvedBy.some((user) => user.id === session.user.id);
    // The rule the reject route and collecting apply: the approver role and a passkey the signer
    // accepts.
    const [membership] = await ctx.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, session.user.id)),
      );
    const canDecide =
      this.shownStatus(row) === "pending" &&
      !decided &&
      (membership?.role === "approver" || membership?.role === "owner") &&
      (await this.activeApproverCredentials(row.workspaceId, session.user.id)).length > 0;
    return {
      ...(await this.summary(row)),
      envelope: row.envelope,
      approvedBy,
      rejectedBy: rejectedBy ?? null,
      canDecide,
      subject: await this.handler(row.kind).describe(ctx, row, detail),
      confirmUrl: await this.ensureConfirmation(row),
    };
  }

  /**
   * The link to the signer's confirmation page for a pending request, opening the confirmation
   * at the signer the first time. The path the signer returned is kept sealed and handed out on
   * every later view: each opening issues a new token and ends the link a person may already
   * have open, so a request is opened once. Null when the request no longer waits, and while
   * the signer refuses to open it or cannot be reached; a later view tries again.
   */
  async ensureConfirmation(row: RequestRow): Promise<string | null> {
    const ctx = this.#ctx;
    if (this.shownStatus(row) !== "pending") return null;
    const link = async (sealed: Uint8Array) => {
      const path = await ctx.sealer.open(row.workspaceId, confirmationLocation(row.id), sealed);
      if (typeof path !== "string") throw new Error("a stored confirmation link is not a path");
      return `${ctx.config.approveOrigin}${path}`;
    };
    if (row.confirmation !== null) return link(row.confirmation);
    // Read before the lock: a view waiting for the lock holds a connection, so the holder must
    // not need another one from the pool.
    const subject = await this.handler(row.kind).confirmationSubject(
      ctx,
      row,
      await this.openDetail(row),
    );
    return ctx.db.transaction(async (tx) => {
      // Views of one request that arrive together open it once.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`confirm:${row.id}`}, 0))`,
      );
      const [current] = await tx
        .select({ confirmation: approvals.confirmation })
        .from(approvals)
        .where(eq(approvals.id, row.id));
      if (current?.confirmation) return link(current.confirmation);
      let path: string;
      try {
        ({ path } = await ctx.signer.openConfirmation(row.id, { envelope: row.envelope, subject }));
      } catch (error) {
        // A refusal (the request was superseded, fenced or revoked) shows no link at all.
        ctx.log.warn("opening a confirmation failed", {
          approvalId: row.id,
          code: error instanceof SignerError ? error.code : "unreachable",
        });
        return null;
      }
      const sealed = await ctx.sealer.seal(row.workspaceId, confirmationLocation(row.id), path);
      await tx.update(approvals).set({ confirmation: sealed }).where(eq(approvals.id, row.id));
      return `${ctx.config.approveOrigin}${path}`;
    });
  }

  /**
   * Count the approvals people made on the signer's confirmation page, the only place an approval
   * is made. The signer lists the assertions it accepted; each is checked here again, as one made
   * top-level at the confirmation page's origin by a passkey our records list as that person's
   * approver, before it is stored and counted. Safe to repeat. An unreachable signer is logged
   * and asked again on the next call.
   */
  async collect(row: RequestRow): Promise<void> {
    const ctx = this.#ctx;
    if (this.shownStatus(row) !== "pending" || row.confirmation === null) return;
    let listed: Assertion[];
    try {
      ({ assertions: listed } = await ctx.signer.listConfirmationAssertions(row.id));
    } catch (error) {
      ctx.log.warn("collecting approvals failed", {
        approvalId: row.id,
        code: error instanceof SignerError ? error.code : "unreachable",
      });
      return;
    }
    if (listed.length === 0) return;
    const recorded = await ctx.db
      .select({ userId: approvalAssertions.userId })
      .from(approvalAssertions)
      .where(eq(approvalAssertions.approvalId, row.id));
    const counted = new Set<string>(recorded.map((entry) => entry.userId));
    let decided = false;
    for (const assertion of listed) {
      if (counted.has(assertion.userId)) continue;
      const verdict = await this.#verify(row, assertion.userId, assertion.response);
      if (!verdict.ok) {
        ctx.log.warn("a collected approval was not counted", {
          approvalId: row.id,
          code: verdict.code,
        });
        continue;
      }
      const outcome = await this.#record(
        row,
        assertion.userId,
        verdict.credentialId,
        assertion.response,
      );
      if (outcome === "closed") break;
      counted.add(assertion.userId);
      if (outcome === "decided") decided = true;
    }
    if (decided) await this.wake(row.id);
  }

  async list(
    workspaceId: WorkspaceId,
    filter: { status?: "pending" | "all" | undefined; cursor?: string | undefined },
  ): Promise<{ items: ApprovalSummary[]; nextCursor: string | null }> {
    const ctx = this.#ctx;
    // Uses of mandates are not approvals people make: no list or count ever shows one.
    const conditions = [eq(approvals.workspaceId, workspaceId), ne(approvals.kind, "mandate-use")];
    if (filter.status !== "all") {
      conditions.push(eq(approvals.status, "pending"));
      conditions.push(sql`${approvals.expiresAt} > ${new Date(ctx.now() * 1000)}`);
    }
    if (filter.cursor !== undefined) {
      const { at, id } = decodeCursor(filter.cursor);
      const before = or(
        lt(approvals.createdAt, at),
        and(eq(approvals.createdAt, at), lt(approvals.id, id as ApprovalId)),
      );
      if (before) conditions.push(before);
    }
    const rows = await ctx.db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    // Approvals made on the confirmation page count as soon as someone looks at the inbox.
    const current: RequestRow[] = [];
    for (const row of page.filter(isRequest)) {
      if (row.confirmation === null || this.shownStatus(row) !== "pending") {
        current.push(row);
        continue;
      }
      await this.collect(row);
      current.push(await this.request(row.id));
    }
    return {
      items: await Promise.all(current.map((row) => this.summary(row))),
      nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last) : null,
    };
  }

  /**
   * The passkeys the signer accepts for this person in this workspace, as our mirror has them.
   * A passkey being removed still counts: the signer accepts it until the removal is applied.
   */
  async activeApproverCredentials(
    workspaceId: WorkspaceId,
    userId?: UserId,
  ): Promise<ApproverCredential[]> {
    const conditions = [
      eq(approverCredentials.workspaceId, workspaceId),
      inArray(approverCredentials.state, ["active", "removing"]),
      isNull(credentials.revokedAt),
    ];
    if (userId !== undefined) conditions.push(eq(approverCredentials.userId, userId));
    const rows = await this.#ctx.db
      .select({
        userId: approverCredentials.userId,
        credentialId: approverCredentials.credentialId,
        publicKey: credentials.publicKey,
      })
      .from(approverCredentials)
      .innerJoin(credentials, eq(credentials.id, approverCredentials.credentialId))
      .where(and(...conditions));
    return rows.map((row) => ({
      userId: row.userId,
      credentialId: row.credentialId,
      publicKey: Buffer.from(row.publicKey).toString("base64url"),
    }));
  }

  /**
   * Whether `response` is `userId`'s approval of this request: made by a passkey our records
   * list as that person's approver here, while they hold the approver or owner role, over the
   * envelope's digest, top-level at the confirmation page's origin. The signer checks again with
   * its own registry when it acts; this refuses garbage before it is stored or counted.
   */
  async #verify(row: RequestRow, userId: UserId, response: AssertionResponse): Promise<Verdict> {
    const ctx = this.#ctx;
    const [membership] = await ctx.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, userId)));
    if (membership?.role !== "approver" && membership?.role !== "owner") {
      return { ok: false, code: "approver_unknown" };
    }
    const mine = await this.activeApproverCredentials(row.workspaceId, userId);
    const credential = mine.find((candidate) => candidate.credentialId === response.id);
    if (!credential) return { ok: false, code: "approver_unknown" };
    const assertion: Assertion = { userId, credentialId: credential.credentialId, response };
    const verdict = await verifyAuthorization({
      authorization: { envelope: row.envelope, assertions: [assertion] },
      approvers: mine,
      relyingParty: { id: ctx.config.relyingParty.id, origins: [ctx.config.approveOrigin] },
      threshold: 1,
      maxTtlSeconds: row.envelope.expiresAt - row.envelope.issuedAt,
      now: ctx.now(),
    });
    return verdict.ok
      ? { ok: true, credentialId: credential.credentialId }
      : { ok: false, code: verdict.code };
  }

  /**
   * Store one person's verified approval and decide the request once enough people approved.
   * The request is locked, so the threshold is counted once against concurrent approvals.
   * `closed`: the request no longer waits; `duplicate`: this person's approval is already in.
   */
  async #record(
    row: RequestRow,
    userId: UserId,
    credentialId: string,
    response: AssertionResponse,
  ): Promise<"recorded" | "decided" | "duplicate" | "closed"> {
    const ctx = this.#ctx;
    return ctx.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, row.id))
        .for("update");
      if (locked?.status !== "pending" || seconds(locked.expiresAt) <= ctx.now()) return "closed";
      const inserted = await tx
        .insert(approvalAssertions)
        .values({
          approvalId: row.id,
          userId,
          credentialId,
          response,
          createdAt: new Date(ctx.now() * 1000),
        })
        .onConflictDoNothing()
        .returning({ userId: approvalAssertions.userId });
      if (inserted.length === 0) return "duplicate";
      await appendAudit(
        ctx,
        {
          workspaceId: row.workspaceId,
          actor: { type: "user", id: userId },
          action: "approval.assertion_added",
          subject: { type: "approval", id: row.id },
          detail: { credentialId },
        },
        tx,
      );
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(approvalAssertions)
        .where(eq(approvalAssertions.approvalId, row.id));
      if ((count?.n ?? 0) < locked.threshold) return "recorded";
      await tx
        .update(approvals)
        .set({ status: "approved", decidedAt: new Date(ctx.now() * 1000), resumeState: "needed" })
        .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")));
      await appendAudit(
        ctx,
        {
          workspaceId: row.workspaceId,
          actor: { type: "user", id: userId },
          action: "approval.approved",
          subject: { type: "approval", id: row.id },
        },
        tx,
      );
      return "decided";
    });
  }

  async reject(row: RequestRow, session: Session): Promise<void> {
    const ctx = this.#ctx;
    const mine = await this.activeApproverCredentials(row.workspaceId, session.user.id);
    if (mine.length === 0) {
      throw new HttpError("forbidden", "you have no passkey that approves for this workspace");
    }
    await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({ status: "rejected", decidedAt: new Date(ctx.now() * 1000), resumeState: "needed" })
        .where(
          and(
            eq(approvals.id, row.id),
            eq(approvals.status, "pending"),
            sql`${approvals.expiresAt} > ${new Date(ctx.now() * 1000)}`,
          ),
        )
        .returning({ id: approvals.id });
      if (!updated)
        throw new HttpError("conflict", "this request is no longer waiting for approval");
      await tx.insert(approvalRejections).values({
        approvalId: row.id,
        userId: session.user.id,
        createdAt: new Date(ctx.now() * 1000),
      });
      await appendAudit(
        ctx,
        {
          workspaceId: row.workspaceId,
          actor: { type: "user", id: session.user.id },
          action: "approval.rejected",
          subject: { type: "approval", id: row.id },
        },
        tx,
      );
    });
    // From here on the signer refuses this approval id for good, whatever happens to our rows.
    await ctx.signer.revokeApproval(row.id, row.workspaceId).catch((error: unknown) => {
      ctx.log.warn("revoking a rejected approval failed", {
        approvalId: row.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    await this.wake(row.id);
  }

  /** What the bundled workflow's steps call. Each is safe to run more than once. */
  steps(): StepImplementations {
    const ctx = this.#ctx;
    return {
      settle: async (approvalId, runId) => {
        const id = approvalId as ApprovalId;
        await ctx.db
          .update(approvals)
          .set({ runId })
          .where(and(eq(approvals.id, id), isNull(approvals.runId)));
        const row = await this.row(id);
        if (row.runId !== runId) return "superseded";
        if (row.status === "pending") {
          if (seconds(row.expiresAt) > ctx.now()) return "pending";
          const expired = await ctx.db.transaction(async (tx) => {
            const [updated] = await tx
              .update(approvals)
              .set({ status: "expired", resumeState: "done" })
              .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
              .returning({ id: approvals.id });
            if (!updated) return false;
            await appendAudit(
              ctx,
              {
                workspaceId: row.workspaceId,
                actor: { type: "system", id: null },
                action: "approval.expired",
                subject: { type: "approval", id },
              },
              tx,
            );
            return true;
          });
          return expired ? "expired" : (await this.row(id)).status;
        }
        // The run has seen the decision, so nothing is left for the outbox to deliver.
        await ctx.db
          .update(approvals)
          .set({ resumeState: "done" })
          .where(and(eq(approvals.id, id), eq(approvals.resumeState, "needed")));
        return row.status;
      },

      execute: async (approvalId) => {
        const row = await this.row(approvalId);
        if (row.status === "executed") return { ok: true };
        if (row.status !== "approved") return { ok: false, code: `not_approved_${row.status}` };
        try {
          if (isRequest(row)) {
            const assertions = await ctx.db
              .select()
              .from(approvalAssertions)
              .where(eq(approvalAssertions.approvalId, row.id))
              .orderBy(asc(approvalAssertions.createdAt));
            const authorization = {
              envelope: row.envelope,
              assertions: assertions.map((assertion) => ({
                userId: assertion.userId,
                credentialId: assertion.credentialId,
                response: assertion.response,
              })),
            };
            await this.handler(row.kind).execute(
              ctx,
              row,
              authorization,
              await this.openDetail(row),
            );
          } else {
            await this.#use().execute(ctx, row, await this.openDetail(row));
          }
        } catch (error) {
          if (error instanceof ApprovalFailure) return { ok: false, code: error.code };
          throw error;
        }
        await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(approvals)
            .set({ status: "executed" })
            .where(and(eq(approvals.id, row.id), eq(approvals.status, "approved")))
            .returning({ id: approvals.id });
          if (!updated) return;
          await appendAudit(
            ctx,
            {
              workspaceId: row.workspaceId,
              actor: { type: "system", id: null },
              action: "approval.executed",
              subject: { type: "approval", id: row.id },
            },
            tx,
          );
        });
        return { ok: true };
      },

      fail: async (approvalId, code) => {
        const row = await this.row(approvalId);
        await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(approvals)
            .set({ status: "failed", failureCode: code })
            .where(
              and(eq(approvals.id, row.id), inArray(approvals.status, ["approved", "pending"])),
            )
            .returning({ id: approvals.id });
          if (!updated) return;
          await appendAudit(
            ctx,
            {
              workspaceId: row.workspaceId,
              actor: { type: "system", id: null },
              action: "approval.failed",
              subject: { type: "approval", id: row.id },
              detail: { code },
            },
            tx,
          );
        });
        await this.#end(await this.row(approvalId), "failed");
      },

      abandon: async (approvalId, status) => {
        if (!ENDED.includes(status)) return;
        await this.#end(await this.row(approvalId), status as "rejected");
      },

      followUp: async (approvalId) => {
        const row = await this.row(approvalId);
        const followUp = this.#followUps.get(row.kind);
        return followUp ? followUp(ctx, row) : { done: true, waitSeconds: 0 };
      },
    };
  }

  /**
   * A request ended without its effect: undo what opening it set up, then make sure the signer
   * never acts on it. The undo comes first so a signer problem cannot leave the subject hanging.
   * The signer's `conflict` (it already applied the request) and an unreachable signer do not
   * fail the cleanup: the first is final, and an unreachable signer cannot be sent the request
   * by anyone either, since only this request's own run would.
   */
  async #end(
    row: ApprovalRow,
    status: "rejected" | "expired" | "cancelled" | "failed",
  ): Promise<void> {
    const ctx = this.#ctx;
    const detail = await this.openDetail(row);
    if (isRequest(row)) await this.handler(row.kind).abandon?.(ctx, row, status, detail);
    else await this.#use().abandon(ctx, row, status, detail);
    try {
      await ctx.signer.revokeApproval(row.id, row.workspaceId);
    } catch (error) {
      if (error instanceof SignerError && error.code !== "conflict") throw error;
      ctx.log.warn("revoking an ended approval failed", {
        approvalId: row.id,
        error: error instanceof SignerError ? error.code : "unreachable",
      });
    }
  }

  /**
   * A request decided before any workflow run was recorded for it (the process died between
   * the two). A pending or approved one gets a run; an ended one is abandoned here, since no
   * run will. Returns what it did, for the sweeper's counts.
   */
  async recoverOrphan(row: ApprovalRow): Promise<"started" | "abandoned" | "none"> {
    const ctx = this.#ctx;
    if (row.runId !== null) return "none";
    if (row.status === "pending" || row.status === "approved") {
      await this.startRun(row.id, row.workspaceId, seconds(row.expiresAt));
      return "started";
    }
    if (row.status === "rejected" || row.status === "expired" || row.status === "cancelled") {
      await this.#end(row, row.status);
      await ctx.db
        .update(approvals)
        .set({ resumeState: "done" })
        .where(and(eq(approvals.id, row.id), eq(approvals.resumeState, "needed")));
      return "abandoned";
    }
    return "none";
  }

  async #requester(row: ApprovalRow): Promise<Requester> {
    const ctx = this.#ctx;
    if (row.requestedByType === "agent") {
      const [agent] = await ctx.db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, row.requestedById as never));
      return { type: "agent", id: row.requestedById as never, name: agent?.name ?? "" };
    }
    const [user] = await ctx.db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, row.requestedById as never));
    return { type: "user", id: row.requestedById as never, name: user?.name ?? "" };
  }
}

export function createApprovalEngine(ctx: AppContext): Engine {
  return new Engine(ctx);
}

/** The context's engine with the parts only execution uses. */
export function engineOf(ctx: Pick<AppContext, "approvals">): Engine {
  if (!(ctx.approvals instanceof Engine)) {
    throw new Error("the context's approval engine was not created by createApprovalEngine()");
  }
  return ctx.approvals;
}
