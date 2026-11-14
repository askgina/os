import type {
  AgentId,
  ApprovalId,
  AssertionResponse,
  Envelope,
  IntentId,
  UserId,
  WalletId,
  WalletPolicy,
  WorkspaceId,
} from "@askgina/os-protocol";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
 * One request for people to authorize an envelope with their passkeys. Every kind of envelope
 * goes through this table and the same workflow: collect assertions, then apply the effect.
 */
export const approvals = os.table(
  "approvals",
  {
    id: text("id").$type<ApprovalId>().primaryKey(),
    workspaceId: text("workspace_id")
      .$type<WorkspaceId>()
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").$type<Envelope["type"]>().notNull(),
    /** What the request is about: an intent id, a wallet id, a credential id or the workspace id. */
    subjectId: text("subject_id").notNull(),
    status: text("status").$type<ApprovalStatusColumn>().notNull().default("pending"),
    /** Exactly what passkeys sign. Identifiers, hashes and times only. */
    envelope: jsonb("envelope").$type<Envelope>().notNull(),
    threshold: integer("threshold").notNull(),
    /** Sealed. What the kind's handler needs to apply the effect, for example a proposed policy. */
    detail: bytea("detail"),
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
    approvalId: text("approval_id").$type<ApprovalId>(),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("intents_workspace_idx").on(table.workspaceId, table.createdAt),
    index("intents_agent_idx").on(table.agentId, table.createdAt),
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
    intentId: text("intent_id")
      .$type<IntentId>()
      .notNull()
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
