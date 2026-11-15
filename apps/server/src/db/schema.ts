import type { ApprovalKind, MandateEndedReason } from "@askgina/os-api";
import type {
  AgentId,
  ApprovalId,
  AssertionResponse,
  Envelope,
  IntentId,
  MandateId,
  NotificationDeliveryId,
  UserId,
  WalletId,
  WalletPolicy,
  WorkspaceId,
} from "@askgina/os-protocol";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Every table the control plane owns lives in the `os` schema. The Workflow runtime keeps its own
 * schemas (`workflow`, `graphile_worker`) and the key store keeps `os_keys`.
 *
 * What is readable in these tables is deliberate: identifiers, names people gave to workspaces,
 * agents and wallets, statuses, timestamps, hashes, public chain addresses and wallet policies.
 * What a person or an agent can type about an operation (the intent itself, its memo, simulation
 * results, audit details, signed transactions) is stored only sealed, in `bytea` columns marked
 * "sealed" below, under the workspace's data key.
 */
export const os = pgSchema("os");

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => time("created_at").notNull().defaultNow();

// --- installation and people ------------------------------------------------------------------

/** Single-row facts about this installation, for example the hash of the setup token. */
export const installation = os.table("installation", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = os.table("users", {
  id: text("id").$type<UserId>().primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

/** A passkey a person signs in with. Whether it may also approve is `approver_credentials`. */
export const credentials = os.table(
  "credentials",
  {
    /** The WebAuthn credential id, base64url. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    /** COSE public key. */
    publicKey: bytea("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    deviceType: text("device_type").$type<"singleDevice" | "multiDevice">().notNull(),
    backedUp: boolean("backed_up").notNull(),
    label: text("label").notNull(),
    createdAt: createdAt(),
    lastUsedAt: time("last_used_at"),
    /** Set when the person removes the passkey: it can no longer sign in. */
    revokedAt: time("revoked_at"),
  },
  (table) => [index("credentials_user_idx").on(table.userId)],
);

export const sessions = os.table(
  "sessions",
  {
    /** SHA-256 hex of the cookie value. The cookie value itself is never stored. */
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    credentialId: text("credential_id").notNull(),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
    revokedAt: time("revoked_at"),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/** A WebAuthn registration or sign-in in progress. Single use, five minutes. */
export const ceremonies = os.table("ceremonies", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"setup" | "login" | "add-passkey" | "invite">().notNull(),
  /** base64url challenge issued to the browser. */
  challenge: text("challenge").notNull(),
  userId: text("user_id").$type<UserId>(),
  /** What the ceremony needs to finish, for example the display name or the invite. */
  context: jsonb("context").$type<Record<string, string>>().notNull().default({}),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
});

// --- workspaces -------------------------------------------------------------------------------

export const workspaces = os.table("workspaces", {
  id: text("id").$type<WorkspaceId>().primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .$type<UserId>()
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  /** Mirror of the signer's flag, for display. The signer's own value is what counts. */
  paused: boolean("paused").notNull().default(false),
  adminThreshold: integer("admin_threshold").notNull().default(1),
  /**
   * Head of the workspace's audit chain, moved in the same transaction as every append. Without
   * it, deleting the newest entries (or all of them) would leave a chain that still verifies.
   */
  auditSeq: integer("audit_seq").notNull().default(0),
  auditHead: text("audit_head"),
});

export const memberships = os.table(
  "memberships",
  {
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    role: text("role").$type<"owner" | "approver" | "viewer">().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("memberships_user_idx").on(table.userId),
  ],
);

/**
 * Mirror of the signer's approver registry, one row per passkey per workspace.
 * - `pending`: an `add-approver` request is waiting for existing approvers.
 * - `active`: the signer accepts this passkey for this workspace.
 * - `removing`: a `remove-approver` request is waiting; the signer still accepts it until then.
 */
export const approverCredentials = os.table(
  "approver_credentials",
  {
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    state: text("state").$type<"pending" | "active" | "removing">().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.credentialId] }),
    index("approver_credentials_user_idx").on(table.workspaceId, table.userId),
  ],
);

export const invites = os.table(
  "invites",
  {
    /** SHA-256 hex of the invite token. The token itself is shown once and never stored. */
    tokenHash: text("token_hash").primaryKey(),
    /** Names the invite to owners who list or revoke it; unlike the token it grants nothing. */
    id: text("id").notNull(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    role: text("role").$type<"owner" | "approver" | "viewer">().notNull(),
    createdBy: text("created_by")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
    acceptedBy: text("accepted_by").$type<UserId>(),
    acceptedAt: time("accepted_at"),
  },
  (table) => [uniqueIndex("invites_id_idx").on(table.id)],
);

// --- agents and wallets -----------------------------------------------------------------------

export const wallets = os.table(
  "wallets",
  {
    id: text("id").$type<WalletId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").$type<"agent" | "treasury">().notNull(),
    label: text("label").notNull(),
    /** Lowercase hex. */
    address: text("address").$type<`0x${string}`>().notNull(),
    /** Mirror of the policy the signer holds. Null until the first policy is approved. */
    policy: jsonb("policy").$type<WalletPolicy>(),
    policyHash: text("policy_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    index("wallets_workspace_idx").on(table.workspaceId),
    // A workspace has at most one treasury, even when two requests race to create it.
    uniqueIndex("wallets_one_treasury_idx")
      .on(table.workspaceId)
      .where(sql`${table.kind} = 'treasury'`),
  ],
);

export const agents = os.table(
  "agents",
  {
    id: text("id").$type<AgentId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    /** SHA-256 hex of the bearer token an agent presents to the MCP gateway. */
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    walletId: text("wallet_id")
      .$type<WalletId>()
      .notNull()
      .references(() => wallets.id),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    createdAt: createdAt(),
    lastSeenAt: time("last_seen_at"),
  },
  (table) => [
    uniqueIndex("agents_token_hash_idx").on(table.tokenHash),
    // A wallet belongs to at most one agent.
    uniqueIndex("agents_wallet_idx").on(table.walletId),
    index("agents_workspace_idx").on(table.workspaceId),
  ],
);

// --- approvals --------------------------------------------------------------------------------

export type ApprovalStatusColumn =
  | "pending"
  | "approved"
  | "executed"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed";

/**
 * The kinds of row in `approvals`: every request people approve with passkeys, and
 * `mandate-use`, one payment a mandate covers. A use is created already approved, has no
 * envelope, and is never shown as an approval; it exists so a mandated payment runs through the
 * same workflow, signing, crash recovery and follow-up as an approved one.
 */
export type ApprovalRowKind = ApprovalKind | "mandate-use";

/**
 * One request for people to authorize an envelope with their passkeys, or one use of a mandate.
 * Every kind goes through this table and the same workflow: collect assertions (none for a use),
 * then apply the effect.
 */
export const approvals = os.table(
  "approvals",
  {
    id: text("id").$type<ApprovalId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    /** The kinds this control plane opens, a subset of the envelope kinds the signer knows. */
    kind: text("kind").$type<ApprovalRowKind>().notNull(),
    /**
     * What the request is about: an intent id, a wallet id, a credential id, a mandate id or the
     * workspace id.
     */
    subjectId: text("subject_id").notNull(),
    status: text("status").$type<ApprovalStatusColumn>().notNull().default("pending"),
    /** Exactly what passkeys sign. Identifiers, hashes and times only. Null for a `mandate-use`. */
    envelope: jsonb("envelope").$type<Envelope>(),
    /** The mandate a `mandate-use` runs under; null for every other kind. */
    mandateId: text("mandate_id")
      .$type<MandateId>()
      .references((): AnyPgColumn => mandates.id),
    threshold: integer("threshold").notNull(),
    /** Sealed. What the kind's handler needs to apply the effect, for example a proposed policy. */
    detail: bytea("detail"),
    /**
     * Sealed. The path of the signer's confirmation page for this request, with its token, as
     * the signer returned it when it opened the confirmation. Null until it did.
     */
    confirmation: bytea("confirmation"),
    requestedByType: text("requested_by_type").$type<"agent" | "user">().notNull(),
    requestedById: text("requested_by_id").notNull(),
    createdAt: createdAt(),
    expiresAt: time("expires_at").notNull(),
    decidedAt: time("decided_at"),
    failureCode: text("failure_code"),
    /** The workflow run that waits for this request. */
    runId: text("run_id"),
    /**
     * Outbox for waking the workflow. A decision sets `needed` in the same transaction that
     * changes `status`; whoever then resumes the workflow's hook sets `done`. A sweeper retries
     * rows left at `needed`, so a crash between the two never strands an approved request.
     */
    resumeState: text("resume_state").$type<"none" | "needed" | "done">().notNull().default("none"),
  },
  (table) => [
    index("approvals_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
    index("approvals_subject_idx").on(table.kind, table.subjectId),
    index("approvals_resume_idx").on(table.resumeState),
    check(
      "approvals_use_has_no_envelope",
      sql`(${table.kind} = 'mandate-use') = (${table.envelope} IS NULL)`,
    ),
    check(
      "approvals_use_has_mandate",
      sql`(${table.kind} = 'mandate-use') = (${table.mandateId} IS NOT NULL)`,
    ),
  ],
);

export const approvalAssertions = os.table(
  "approval_assertions",
  {
    approvalId: text("approval_id")
      .$type<ApprovalId>()
      .notNull()
      .references(() => approvals.id),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    credentialId: text("credential_id").notNull(),
    /** The WebAuthn assertion: a signature over the envelope's digest. Not secret. */
    response: jsonb("response").$type<AssertionResponse>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.approvalId, table.userId] })],
);

export const approvalRejections = os.table("approval_rejections", {
  approvalId: text("approval_id")
    .$type<ApprovalId>()
    .primaryKey()
    .references(() => approvals.id),
  userId: text("user_id")
    .$type<UserId>()
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

// --- mandates ---------------------------------------------------------------------------------

/**
 * Mirror of the mandates the signer holds, written once people granted one. The signer alone
 * enforces a mandate and counts its uses; `status` is what this control plane last learned
 * (`active` while it may still sign, `ended` for good, with the first reason seen), refreshed
 * from the signer whenever a mandate is used or shown.
 */
export const mandates = os.table(
  "mandates",
  {
    id: text("id").$type<MandateId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    walletId: text("wallet_id")
      .$type<WalletId>()
      .notNull()
      .references(() => wallets.id),
    agentId: text("agent_id")
      .$type<AgentId>()
      .notNull()
      .references(() => agents.id),
    mandateHash: text("mandate_hash").notNull(),
    /** Sealed. The canonical `Mandate`, its purpose included. */
    mandate: bytea("mandate").notNull(),
    notBefore: time("not_before").notNull(),
    notAfter: time("not_after").notNull(),
    /** The `grant-mandate` request people approved it with. */
    grantApprovalId: text("grant_approval_id")
      .$type<ApprovalId>()
      .notNull()
      .references(() => approvals.id),
    status: text("status").$type<"active" | "ended">().notNull().default("active"),
    endedReason: text("ended_reason").$type<MandateEndedReason>(),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("mandates_wallet_idx").on(table.workspaceId, table.walletId, table.status),
    index("mandates_agent_idx").on(table.agentId, table.status),
    uniqueIndex("mandates_grant_idx").on(table.grantApprovalId),
    check(
      "mandates_ended_has_reason",
      sql`(${table.status} = 'ended') = (${table.endedReason} IS NOT NULL)`,
    ),
  ],
);

// --- intents and transactions -----------------------------------------------------------------

export type IntentStatusColumn =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "stuck"
  | "rejected"
  | "expired"
  | "cancelled"
  | "denied"
  | "failed";

export const intents = os.table(
  "intents",
  {
    id: text("id").$type<IntentId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .$type<AgentId>()
      .notNull()
      .references(() => agents.id),
    walletId: text("wallet_id")
      .$type<WalletId>()
      .notNull()
      .references(() => wallets.id),
    chainId: text("chain_id").notNull(),
    status: text("status").$type<IntentStatusColumn>().notNull().default("proposed"),
    intentHash: text("intent_hash").notNull(),
    /** Sealed. The canonical `Intent`. */
    payload: bytea("payload").notNull(),
    /** Sealed. `{ display: IntentDisplay, simulation: Simulation | null }`. */
    presentation: bytea("presentation").notNull(),
    /** The request that signs it: an `approve-intent`, or the `mandate-use` when a mandate covered it. */
    approvalId: text("approval_id").$type<ApprovalId>(),
    /** The mandate it was signed under, with no person asked; null when people approve it. */
    mandateId: text("mandate_id")
      .$type<MandateId>()
      .references(() => mandates.id),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("intents_workspace_idx").on(table.workspaceId, table.createdAt),
    index("intents_agent_idx").on(table.agentId, table.createdAt),
    index("intents_mandate_idx").on(table.mandateId, table.createdAt),
  ],
);

export const transactions = os.table(
  "transactions",
  {
    /** One approval signs at most one transaction. */
    approvalId: text("approval_id")
      .$type<ApprovalId>()
      .primaryKey()
      .references(() => approvals.id),
    /** The agent's intent this transaction carries out; null for a person's `sweep-wallet`. */
    intentId: text("intent_id")
      .$type<IntentId>()
      .references(() => intents.id),
    walletId: text("wallet_id")
      .$type<WalletId>()
      .notNull()
      .references(() => wallets.id),
    chainId: text("chain_id").notNull(),
    nonce: integer("nonce").notNull(),
    hash: text("hash").notNull(),
    /** Sealed. The signed raw transaction, kept so it can be rebroadcast. */
    raw: bytea("raw").notNull(),
    /** `rejected`: signed, never accepted by the chain, and no longer retried. */
    status: text("status")
      .$type<"signed" | "broadcast" | "confirmed" | "reverted" | "stuck" | "rejected">()
      .notNull()
      .default("signed"),
    blockNumber: bigint("block_number", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("transactions_wallet_chain_idx").on(table.walletId, table.chainId, table.status),
  ],
);

// --- audit ------------------------------------------------------------------------------------

/** Append-only and hash-chained per workspace. See `src/audit.ts`. */
export const auditEvents = os.table(
  "audit_events",
  {
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    at: time("at").notNull(),
    actorType: text("actor_type").$type<"user" | "agent" | "system" | "signer">().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    /** Sealed. JSON object with the details of the event. */
    detail: bytea("detail").notNull(),
    /** SHA-256 hex of the detail's canonical JSON, so the chain verifies without the data key. */
    detailDigest: text("detail_digest").notNull(),
    previousHash: text("previous_hash"),
    hash: text("hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.seq] })],
);

/**
 * The account nonce an approval was given, recorded before the signer is asked to sign. A crash
 * between the signature and the `transactions` row then cannot hand the same nonce to another
 * approval.
 */
export const nonceReservations = os.table(
  "nonce_reservations",
  {
    approvalId: text("approval_id")
      .$type<ApprovalId>()
      .primaryKey()
      .references(() => approvals.id),
    walletId: text("wallet_id")
      .$type<WalletId>()
      .notNull()
      .references(() => wallets.id),
    chainId: text("chain_id").notNull(),
    nonce: integer("nonce").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("nonce_reservations_wallet_chain_idx").on(table.walletId, table.chainId)],
);

// --- notifications ----------------------------------------------------------------------------

/**
 * What a notification reports: an approval waits (`approval.opened`), it is about to expire
 * (`approval.reminder`), or a mandate was used (`mandate.used`, for the webhook only).
 */
export type NotificationEvent = "approval.opened" | "approval.reminder" | "mandate.used";

export type NotificationState = "pending" | "sent" | "dropped" | "failed";

/**
 * Outbox of notifications: one row per event and target, written in the transaction that opens
 * the approval or records the use, and delivered at least once by the sweeper. Identifiers,
 * times and short codes only; what a notification says is built from them when it is sent.
 */
export const notificationDeliveries = os.table(
  "notification_deliveries",
  {
    id: text("id").$type<NotificationDeliveryId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    approvalId: text("approval_id")
      .$type<ApprovalId>()
      .notNull()
      .references(() => approvals.id),
    event: text("event").$type<NotificationEvent>().notNull(),
    /** `webhook`, or `push:` and a push subscription's id. */
    target: text("target").notNull(),
    /** Whose device a push target is; null for the webhook. */
    userId: text("user_id")
      .$type<UserId>()
      .references(() => users.id),
    state: text("state").$type<NotificationState>().notNull().default("pending"),
    /** Failed attempts so far. */
    attempts: integer("attempts").notNull().default(0),
    /** When the notification is meant to go out. */
    dueAt: time("due_at").notNull(),
    /** When it may next be tried; moved ahead while a sender holds it, and after a failure. */
    nextAttemptAt: time("next_attempt_at").notNull(),
    /** Why the last attempt did not deliver, for example `http_503` or `approval_ended`. */
    lastCode: text("last_code"),
    createdAt: createdAt(),
    sentAt: time("sent_at"),
  },
  (table) => [
    uniqueIndex("notification_deliveries_event_idx").on(
      table.approvalId,
      table.event,
      table.target,
    ),
    index("notification_deliveries_due_idx").on(table.state, table.nextAttemptAt),
  ],
);
