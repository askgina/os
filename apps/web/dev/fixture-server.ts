/**
 * A development stand-in for the control plane: it serves the `@askgina/os-api` contract from
 * memory, with the same Content-Security-Policy header the real server sends. The UI itself comes
 * from the Vite dev server, which proxies `/api` here. Every response is parsed with the
 * contract's own schema before it is sent, so the fixture cannot drift from the contract without
 * failing loudly. Nothing under `dev/` is part of the built UI.
 *
 * It is not a security boundary and not shipped: passkey responses are checked only for the
 * right challenge, origin and a known credential, never cryptographically. Run it with
 * `bun run fixture` (port 55731) and the UI with `bun run dev`, or let Playwright start it.
 *
 * Approvals are made only on the signer's confirmation page, on its own origin. The fixture
 * stands in for that page too, on a second port (55732, so `http://localhost:55732`): it shows
 * the request, asks the passkey there, and holds the approval as the signer would, until reading
 * the request counts it here (`collect`). The page itself is `dev/confirm/`. It is a fixture, not
 * the real page, which is `apps/approve/public/`. As on the real page, an approver change first
 * waits for the person it adds to answer there with the new passkey ("This passkey is mine"),
 * which shows them its fingerprint; until then nobody can approve it.
 *
 * Besides the contract it has six development endpoints under `/__fixture/`: one lets a test
 * act as an agent and propose a payment (the real server takes those over MCP), one puts a sent
 * payment into a chain outcome (stuck, or rejected by the chain), one turns Web Push off or on
 * as an operator would with `WEB_PUSH_ENABLED`, one makes a retirement or deletion due (`due`,
 * below), one dates every sign-in back past the 300 seconds the record and erasure need
 * (`stale-sign-in`), and one resets state.
 *
 * Like the server, downloading a workspace's record and erasing oneself need a passkey sign-in
 * from the last 300 seconds, else `forbidden` with the detail `sign_in_again`.
 *
 * Approvals in advance (mandates) are held and counted here as the signer holds them: a proposed
 * transfer that one of the agent's live mandates covers is sent with no request, checked against
 * the wallet's limits too and counted for good; anything else opens a request as usual.
 *
 * An agent can also propose an order on Hyperliquid testnet (`kind: "order"`), checked against
 * the wallet's venue rules. No mandate ever covers one. Once approved, an immediate-or-cancel
 * order fills at its limit price at once; any other rests on the stand-in venue's book until
 * `cancelOrder` cancels it, with no passkey.
 *
 * Retiring a wallet and deleting a workspace wait out the signer's shortest delay (7 days) like
 * the real ones, and can be cancelled until then. `/__fixture/due` makes one due at once, as if
 * its delay had passed; the next request then finishes it as the server's sweeper would, unless
 * a sent transaction is not mined yet: the key goes, and a deleted workspace is gone for its
 * members.
 *
 * Notification settings are kept as the server keeps them. Web Push reports itself on, with a
 * P-256 key made at start (`OS_WEB_FIXTURE_WEB_PUSH=0` starts it off, and a reset goes back to
 * that); the fixture stores subscriptions but never pushes anything.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type ApprovalDetail,
  type ApprovalSubject,
  type ApprovalSummary,
  type AssetBalance,
  type AuditEvent,
  type ChainInfo,
  type CloneOptions,
  type CloneResult,
  CONTENT_SECURITY_POLICY,
  type IntentDetail,
  type InviteSummary,
  type MandateAssetView,
  type MandateDraft,
  type MandateEndedReason,
  type MandateStatus,
  type MandateSummary,
  type Member,
  type NotificationDetail,
  type NotificationPreferences,
  type PasskeySummary,
  type PolicyDraft,
  type PushSubscriptionSummary,
  type QuietHours,
  type Role,
  type RouteName,
  routes,
  type SessionInfo,
  type TransactionInfo,
  type VenueAccount,
  type WalletSummary,
  type WorkspaceDetail,
  type WorkspaceTemplate,
} from "@askgina/os-api";
import {
  AssertionResponse,
  checkMandateAgainstPolicy,
  type Envelope,
  type EvmIntent,
  envelopeChallenge,
  evaluateMandate,
  type HyperliquidOrderOperation,
  HyperliquidTimeInForce,
  intentHash,
  keyFingerprint,
  type Mandate,
  type MandateUsage,
  mandateHash,
  mandateTimeState,
  mandateWorstCase,
  newId,
  normalizeMandate,
  normalizePolicy,
  orderNotionalUsd6,
  policyHash,
  type SignerDecision,
  type Sweep,
  sweepHash,
  type VenueIntent,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { z } from "zod";

const PORT = Number(process.env.OS_WEB_FIXTURE_PORT ?? 55731);
const SETUP_TOKEN = process.env.OS_WEB_FIXTURE_SETUP_TOKEN ?? "fixture-setup-token-0123456789";
const RP_NAME = "Agent Workspaces";
/** The stand-in confirmation page's port. `localhost`, so the passkeys made for the UI work there. */
const CONFIRM_PORT = Number(process.env.OS_WEB_FIXTURE_CONFIRM_PORT ?? 55732);
const CONFIRM_ORIGIN = `http://localhost:${CONFIRM_PORT}`;
/** Where the confirmation page sends the person back to: the UI on the Vite dev server. */
const RETURN_ORIGIN = process.env.OS_WEB_FIXTURE_RETURN_ORIGIN ?? "http://localhost:55730";

const CHAINS: ChainInfo[] = [
  { chainId: "eip155:31337", name: "Local test chain", nativeSymbol: "ETH", explorerUrl: null },
  {
    chainId: "eip155:8453",
    name: "Base",
    nativeSymbol: "ETH",
    explorerUrl: "https://basescan.org",
  },
];
const TEST_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/** The push services a subscription's endpoint must be under, as the server's default. */
const PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];
/** The application server key browsers subscribe with, while Web Push is on. */
const PUSH_KEY = (() => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "jwk",
  });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]).toString("base64url");
})();
const WEB_PUSH_AT_START = process.env.OS_WEB_FIXTURE_WEB_PUSH !== "0";

type RefusalCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "possession_unproven"
  | "policy_denied";

class Refusal extends Error {
  readonly code: RefusalCode;
  readonly detail: string | undefined;
  constructor(code: RefusalCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const status: Record<RefusalCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  possession_unproven: 409,
  policy_denied: 422,
};

// --- state ------------------------------------------------------------------------------------

interface Credential {
  userId: string;
  /** Stands in for the COSE public key; the fixture never verifies a signature. */
  publicKey: string;
  summary: PasskeySummary;
}
interface Workspace {
  id: string;
  name: string;
  paused: boolean;
  adminThreshold: number;
  notificationDetail: NotificationDetail;
  members: Member[];
  agents: WorkspaceDetail["agents"];
  wallets: WalletSummary[];
  audit: AuditEvent[];
  decisions: SignerDecision[];
  lifecycle: WorkspaceDetail["lifecycle"];
  /** While it is being deleted: each wallet's state before, which a cancel restores. */
  beforeDelete: Map<string, "active" | "held">;
}
interface Approval {
  summary: ApprovalSummary;
  envelope: Envelope;
  /** The envelope's digest, base64url: the challenge the confirmation page asks a passkey for. */
  challenge: string;
  approvedBy: { id: string; displayName: string }[];
  rejectedBy: { id: string; displayName: string } | null;
  subject: ApprovalSubject;
  /**
   * The token of the request's confirmation link, issued when the request is first read, as the
   * signer issues it. Null until then, and while the signer refuses to open it.
   */
  confirmToken: string | null;
  /** The people whose approval the confirmation page holds, counted here by `collect`. */
  atSigner: string[];
  /** The challenge of an approver change's possession step, kept until an answer uses it. */
  possessionChallenge: string | null;
  /** Whether the person an approver change adds answered there with the new passkey. */
  possessionProven: boolean;
  /** The effect applied when enough people approve. */
  apply: () => void;
}
interface State {
  setupDone: boolean;
  users: Map<string, string>;
  credentials: Map<string, Credential>;
  sessions: Map<string, string>;
  /** When each session's passkey sign-in happened, by session token. */
  signedInAt: Map<string, number>;
  ceremonies: Map<string, { challenge: string; kind: string; data: Record<string, string> }>;
  workspaces: Map<string, Workspace>;
  approvals: Map<string, Approval>;
  intents: Map<string, IntentDetail & { workspaceId: string }>;
  /** Granted mandates, as the signer holds and counts them. */
  mandates: Map<string, FixtureMandate>;
  tokens: Map<string, string>;
  invites: Map<
    string,
    {
      id: string;
      workspaceId: string;
      role: Role;
      invitedBy: string;
      createdAt: number;
      expiresAt: number;
    }
  >;
  spent: Map<string, bigint>;
  /**
   * When each intent's newest attempt was offered to the chain, to "mine" it shortly after. A
   * transaction put into `stuck` has none until a speed-up or a cancel adds an attempt.
   */
  sentAt: Map<string, number>;
  /** The approval id a mandate's use signed under, per intent; such an intent shows none. */
  useIds: Map<string, string>;
  /** Push subscriptions by id, with their person and endpoint. */
  pushSubscriptions: Map<
    string,
    { userId: string; endpoint: string; summary: PushSubscriptionSummary }
  >;
  /** Each person's switches per workspace, keyed `userId workspaceId`; absent means both on. */
  notificationSwitches: Map<string, { webPush: boolean; reminders: boolean }>;
  quietHours: Map<string, QuietHours>;
  /** Whether the "operator" turned Web Push on (`/__fixture/web-push`). */
  webPush: boolean;
}

function freshState(): State {
  return {
    setupDone: false,
    users: new Map(),
    credentials: new Map(),
    sessions: new Map(),
    signedInAt: new Map(),
    ceremonies: new Map(),
    workspaces: new Map(),
    approvals: new Map(),
    intents: new Map(),
    mandates: new Map(),
    tokens: new Map(),
    invites: new Map(),
    spent: new Map(),
    sentAt: new Map(),
    useIds: new Map(),
    pushSubscriptions: new Map(),
    notificationSwitches: new Map(),
    quietHours: new Map(),
    webPush: WEB_PUSH_AT_START,
  };
}

let state = freshState();
const now = () => Math.floor(Date.now() / 1000);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const randomToken = (bytes = 24) => b64url(randomBytes(bytes));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function workspaceOf(id: string): Workspace {
  const workspace = state.workspaces.get(id);
  if (!workspace) throw new Refusal("not_found", "This workspace does not exist.");
  return workspace;
}

function memberOf(workspace: Workspace, userId: string): Member {
  const member = workspace.members.find((item) => item.user.id === userId);
  if (!member) throw new Refusal("not_found", "This workspace does not exist.");
  return member;
}

function requireOwner(workspace: Workspace, userId: string): void {
  if (memberOf(workspace, userId).role !== "owner") {
    throw new Refusal("forbidden", "Only an owner can do this.");
  }
}

function audit(
  workspace: Workspace,
  actor: AuditEvent["actor"],
  action: string,
  subject: AuditEvent["subject"],
) {
  const previousHash = workspace.audit.at(-1)?.hash ?? null;
  const entry = {
    seq: workspace.audit.length + 1,
    at: now(),
    actor,
    action,
    subject,
    detail: {},
    previousHash,
  };
  workspace.audit.push({ ...entry, hash: sha256(JSON.stringify(entry)) });
}

function decide(
  workspace: Workspace,
  approvalId: string | null,
  action: string,
  code: string | null,
) {
  const previousHash = workspace.decisions.at(-1)?.hash ?? null;
  const entry = {
    seq: workspace.decisions.length + 1,
    at: now(),
    workspaceId: workspace.id as SignerDecision["workspaceId"],
    approvalId: approvalId as SignerDecision["approvalId"],
    action,
    outcome: code === null ? ("allowed" as const) : ("denied" as const),
    code,
    previousHash,
  };
  workspace.decisions.push({ ...entry, hash: sha256(JSON.stringify(entry)) });
}

const userSummary = (id: string) => ({
  id: id as Member["user"]["id"],
  displayName: state.users.get(id) ?? "",
});
const userActor = (id: string): AuditEvent["actor"] => ({
  type: "user",
  id,
  name: state.users.get(id) ?? null,
});

function refreshApprover(workspace: Workspace, userId: string): void {
  // The fixture treats a member as an approver when any of their passkeys was approved.
  const member = memberOf(workspace, userId);
  if (member.role === "viewer") member.approver = "none";
}

function expireApprovals(): void {
  for (const approval of state.approvals.values()) {
    if (approval.summary.status === "pending" && approval.summary.expiresAt <= now()) {
      approval.summary.status = "expired";
      if (approval.subject.kind === "approve-intent") {
        const intent = state.intents.get(approval.subject.intent.id);
        if (intent) intent.status = "expired";
      }
    }
  }
}

const GWEI = 1_000_000_000n;
const randomHash = () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
const isSent = (transaction: TransactionInfo) =>
  transaction.status === "broadcast" || transaction.status === "stuck";

function explorerOf(chainId: string, hash: string): string | null {
  const chain = CHAINS.find((item) => item.chainId === chainId);
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : null;
}

/** A transaction just signed and offered to the chain: its first attempt, nothing final yet. */
function sentTransaction(chainId: string): TransactionInfo {
  const hash = randomHash();
  return {
    hash,
    status: "broadcast",
    blockNumber: null,
    explorerUrl: explorerOf(chainId, hash),
    attempts: [
      {
        attempt: 0,
        kind: "original",
        hash,
        gas: "21000",
        maxFeePerGas: (2n * GWEI).toString(),
        maxPriorityFeePerGas: GWEI.toString(),
        signedAt: now(),
        cancelApprovalId: null,
        status: "pending",
        explorerUrl: explorerOf(chainId, hash),
      },
    ],
    minedAttempt: null,
    stuckReason: null,
    canSpeedUp: true,
    canCancel: true,
    pendingCancelApprovalId: null,
  };
}

/**
 * One more attempt with both fees 12% higher, at the same nonce: a reprice, or a cancel (a
 * transfer of nothing to the wallet itself). Once a cancel exists every later attempt is one.
 */
function withAttempt(
  transaction: TransactionInfo,
  chainId: string,
  kind: "reprice" | "cancel",
  cancelApprovalId: string | null,
): TransactionInfo {
  const latest = transaction.attempts[transaction.attempts.length - 1];
  if (!latest) throw new Error("a transaction without its first attempt");
  const raised = (value: string) => ((BigInt(value) * 112n + 99n) / 100n).toString();
  const cancel = kind === "cancel" || latest.kind === "cancel";
  const hash = randomHash();
  return {
    ...transaction,
    hash,
    explorerUrl: explorerOf(chainId, hash),
    stuckReason: null,
    attempts: [
      ...transaction.attempts,
      {
        attempt: latest.attempt + 1,
        kind: cancel ? "cancel" : "reprice",
        hash,
        gas: cancel ? "21000" : latest.gas,
        maxFeePerGas: raised(latest.maxFeePerGas),
        maxPriorityFeePerGas: raised(latest.maxPriorityFeePerGas),
        signedAt: now(),
        cancelApprovalId: (kind === "cancel"
          ? cancelApprovalId
          : latest.cancelApprovalId) as TransactionInfo["pendingCancelApprovalId"],
        status: "pending",
        explorerUrl: explorerOf(chainId, hash),
      },
    ],
  };
}

/** The newest attempt mined: `cancelled` when it is a cancel, otherwise `confirmed`. */
function minedTransaction(transaction: TransactionInfo): TransactionInfo {
  const newest = transaction.attempts[transaction.attempts.length - 1];
  if (!newest) throw new Error("a transaction without its first attempt");
  return {
    ...transaction,
    status: newest.kind === "cancel" ? "cancelled" : "confirmed",
    blockNumber: 1042,
    minedAttempt: newest.attempt,
    stuckReason: null,
    attempts: transaction.attempts.map((attempt) => ({
      ...attempt,
      status: attempt.attempt === newest.attempt ? "mined" : "not_mined",
    })),
  };
}

/** The approval whose transaction an intent sent: its request's, or its mandate use's. */
function targetOf(intent: { id: string; approvalId: string | null }): string | null {
  return intent.approvalId ?? state.useIds.get(intent.id) ?? null;
}

function waitingCancel(targetApprovalId: string | null): Approval | undefined {
  return [...state.approvals.values()].find(
    (approval) =>
      approval.summary.status === "pending" &&
      approval.envelope.type === "cancel-transaction" &&
      approval.envelope.targetApprovalId === targetApprovalId,
  );
}

/**
 * What a person may do with a transaction now, worked out when it is read, as the server does.
 * While the workspace is paused nothing is repriced, so that is the reason a fee would not help.
 */
function liveTransaction(
  transaction: TransactionInfo,
  targetApprovalId: string | null,
  payment: boolean,
  paused: boolean,
): TransactionInfo {
  const sent = isSent(transaction);
  const waiting = waitingCancel(targetApprovalId);
  const curable = transaction.stuckReason === null || transaction.stuckReason === "fee_too_low";
  const reason = paused && curable ? "workspace_paused" : transaction.stuckReason;
  return {
    ...transaction,
    stuckReason: sent ? reason : null,
    canSpeedUp: sent && payment && (reason === null || reason === "fee_too_low"),
    canCancel: sent && waiting === undefined && reason !== "attempts_exhausted",
    pendingCancelApprovalId: (waiting?.summary.id ??
      null) as TransactionInfo["pendingCancelApprovalId"],
  };
}

function advanceTransactions(): void {
  // The newest attempt of a sent transaction is "mined" two seconds after it was offered, so the
  // UI's follow-through shows. Whichever attempt is mined decides: a cancel voids the payment.
  for (const intent of state.intents.values()) {
    const sentAt = state.sentAt.get(intent.id);
    if (!intent.transaction || !isSent(intent.transaction) || sentAt === undefined) continue;
    if (now() - sentAt < 2) continue;
    const cancelSigned = intent.transaction.attempts.some((attempt) => attempt.kind === "cancel");
    intent.transaction = minedTransaction(intent.transaction);
    intent.transactionHash = intent.transaction.hash;
    if (intent.transaction.status === "cancelled") {
      intent.status = "voided";
      intent.failureCode = "transaction_cancelled";
    } else {
      intent.status = "confirmed";
      if (cancelSigned) intent.failureCode = "cancel_too_late";
    }
    // Nothing is left to cancel: a cancel request still waiting ends.
    const waiting = waitingCancel(targetOf(intent));
    if (waiting) waiting.summary.status = "cancelled";
  }
}

/**
 * Open a `cancel-transaction` request for a sent transaction, as the server does: at the wallet
 * policy's threshold and lifetime, with its fee cap as ceiling; asking again while one waits
 * answers that one. Applied, it adds a cancel attempt, or fails when the transaction is final.
 */
function openCancel(
  workspace: Workspace,
  userId: string,
  input: {
    target: string;
    walletId: string;
    chainId: string;
    title: string;
    intent: (IntentDetail & { workspaceId: string }) | null;
    transaction: () => TransactionInfo | null;
    update: (transaction: TransactionInfo) => void;
  },
): ApprovalSummary {
  const waiting = waitingCancel(input.target);
  if (waiting) return waiting.summary;
  const wallet = workspace.wallets.find((item) => item.id === input.walletId);
  if (!wallet?.policy)
    throw new Refusal("policy_denied", "This wallet has no approved policy.", "policy_missing");
  const current = input.transaction();
  if (!current) throw new Refusal("conflict", "Nothing was sent yet.", "not_sent");
  if (current.stuckReason === "attempts_exhausted") {
    throw new Refusal(
      "conflict",
      "The signer allows no more attempts for this transaction.",
      "attempts_exhausted",
    );
  }
  const maxFeeWei = wallet.policy.fees.maxPerTxWei;
  const approval: Approval = openApproval({
    workspace,
    kind: "cancel-transaction",
    title: `${input.intent ? "Cancel payment" : "Cancel sweep"}: ${input.title}`,
    requestedBy: {
      type: "user",
      id: userId as Member["user"]["id"],
      name: state.users.get(userId) ?? "",
    },
    threshold: wallet.policy.approvals.threshold,
    ttl: wallet.policy.approvals.ttlSeconds,
    envelope: {
      targetApprovalId: input.target,
      walletId: wallet.id,
      chainId: input.chainId,
      txNonce: 0,
      maxFeeWei,
    },
    subject: {
      kind: "cancel-transaction",
      wallet: { ...wallet },
      intent: input.intent ? stripIntent(input.intent) : null,
      sweep: input.intent
        ? null
        : { approvalId: input.target as ApprovalSummary["id"], title: input.title },
      transaction: current,
      txNonce: 0,
      maxFeeWei,
    },
    apply: () => {
      const live = input.transaction();
      if (!live || !isSent(live)) {
        approval.summary.status = "failed";
        approval.summary.failureCode = "transaction_final";
        return;
      }
      input.update(withAttempt(live, input.chainId, "cancel", approval.summary.id));
      decide(workspace, approval.summary.id, "cancel-transaction", null);
    },
  });
  audit(workspace, userActor(userId), "transaction.cancel_requested", {
    type: "approval",
    id: input.target,
  });
  return approval.summary;
}

/** A cancel request's subject as it is now: the payment or sweep, and its transaction. */
function liveCancelSubject(
  subject: Extract<ApprovalSubject, { kind: "cancel-transaction" }>,
  paused: boolean,
): ApprovalSubject {
  if (subject.intent) {
    const intent = stripIntent(state.intents.get(subject.intent.id) ?? subject.intent);
    return { ...subject, intent, transaction: intent.transaction ?? subject.transaction };
  }
  const sweep = state.approvals.get(subject.sweep?.approvalId ?? "")?.subject;
  return sweep?.kind === "sweep-wallet" && sweep.transaction && subject.sweep
    ? {
        ...subject,
        transaction: liveTransaction(sweep.transaction, subject.sweep.approvalId, false, paused),
      }
    : subject;
}

function openApproval(input: {
  workspace: Workspace;
  kind: ApprovalSummary["kind"];
  title: string;
  requestedBy: ApprovalSummary["requestedBy"];
  threshold: number;
  ttl: number;
  envelope: Record<string, unknown>;
  subject: ApprovalSubject;
  apply: () => void;
}): Approval {
  const id = newId("apr");
  const issuedAt = now();
  const envelope = {
    v: 1,
    approvalId: id,
    workspaceId: input.workspace.id,
    nonce: randomToken(16),
    issuedAt,
    expiresAt: issuedAt + input.ttl,
    type: input.kind,
    ...input.envelope,
  } as Envelope;
  const approval: Approval = {
    summary: {
      id,
      workspaceId: input.workspace.id as ApprovalSummary["workspaceId"],
      kind: input.kind,
      status: "pending",
      title: input.title,
      requestedBy: input.requestedBy,
      createdAt: issuedAt,
      expiresAt: issuedAt + input.ttl,
      threshold: input.threshold,
      approvals: 0,
      failureCode: null,
    },
    envelope,
    challenge: b64url(envelopeChallenge(envelope)),
    approvedBy: [],
    rejectedBy: null,
    subject: input.subject,
    confirmToken: null,
    atSigner: [],
    possessionChallenge: null,
    possessionProven: false,
    apply: input.apply,
  };
  state.approvals.set(id, approval);
  audit(
    input.workspace,
    input.requestedBy.type === "agent"
      ? { type: "agent", id: input.requestedBy.id, name: input.requestedBy.name }
      : userActor(input.requestedBy.id),
    "approval.requested",
    { type: "approval", id },
  );
  return approval;
}

function approverApprovals(
  workspace: Workspace,
  userId: string,
  kind: "add-approver" | "remove-approver",
  requester: string,
): ApprovalSummary[] {
  const opened: ApprovalSummary[] = [];
  for (const [credentialId, credential] of state.credentials) {
    if (credential.userId !== userId) continue;
    opened.push(
      openApproval({
        workspace,
        kind,
        title: `${kind === "add-approver" ? "Let" : "Stop"} ${state.users.get(userId)}'s passkey "${credential.summary.label}" ${kind === "add-approver" ? "approve" : "approving"}`,
        requestedBy: {
          type: "user",
          id: requester as Member["user"]["id"],
          name: state.users.get(requester) ?? "",
        },
        threshold: workspace.adminThreshold,
        ttl: 3600,
        envelope:
          kind === "add-approver"
            ? { userId, credentialId, publicKey: credential.publicKey }
            : { userId, credentialId },
        subject: {
          kind,
          user: userSummary(userId),
          credentialId,
          passkeyLabel: credential.summary.label,
        },
        apply: () => {
          const member = workspace.members.find((item) => item.user.id === userId);
          if (member) member.approver = kind === "add-approver" ? "active" : "none";
        },
      }).summary,
    );
  }
  return opened;
}

/**
 * Mirrors the signer's refusal to open a confirmation: a request made under limits that have
 * changed since can never be signed, so it gets no page to approve it on.
 */
function signerRefuses(approval: Approval): boolean {
  const envelope = approval.envelope;
  const wallet = workspaceOf(approval.summary.workspaceId).wallets.find(
    (item) => "walletId" in envelope && item.id === envelope.walletId,
  );
  // A grant the wallet's current limits would refuse shows as superseded at the signer.
  if (approval.subject.kind === "grant-mandate") {
    return (
      !wallet?.policy ||
      checkMandateAgainstPolicy(approval.subject.mandate, wallet.policy, {
        now: now(),
        maxSeconds: MANDATE_LONGEST_SECONDS,
      }) !== null
    );
  }
  if (envelope.type !== "approve-intent" && envelope.type !== "set-policy") return false;
  const current = wallet?.policyHash ?? null;
  return envelope.type === "approve-intent"
    ? envelope.policyHash !== current
    : envelope.previousPolicyHash !== current;
}

/**
 * The link to the confirmation page, opened the first time a pending request is read, as the
 * control plane asks the signer to. A refused request is asked about again on the next read.
 */
function confirmUrl(approval: Approval): string | null {
  if (approval.summary.status !== "pending") return null;
  if (approval.confirmToken === null) {
    if (signerRefuses(approval)) return null;
    approval.confirmToken = randomToken(16);
  }
  return `${CONFIRM_ORIGIN}/a/${approval.summary.id}#${approval.confirmToken}`;
}

/**
 * Counts the approvals the confirmation page holds, as the control plane does when a pending
 * request is read: each person once, and the request is applied when enough are in.
 */
function collect(approval: Approval): void {
  if (approval.summary.status !== "pending") return;
  const workspace = workspaceOf(approval.summary.workspaceId);
  for (const userId of approval.atSigner) {
    if (approval.approvedBy.some((user) => user.id === userId)) continue;
    approval.approvedBy.push(userSummary(userId));
    approval.summary.approvals = approval.approvedBy.length;
    audit(workspace, userActor(userId), "approval.assertion_added", {
      type: "approval",
      id: approval.summary.id,
    });
    if (approval.summary.approvals >= approval.summary.threshold) {
      audit(workspace, userActor(userId), "approval.approved", {
        type: "approval",
        id: approval.summary.id,
      });
      approval.summary.status = "executed";
      approval.apply();
      return;
    }
  }
}

function approvalDetail(approval: Approval, userId: string): ApprovalDetail {
  const workspace = workspaceOf(approval.summary.workspaceId);
  const member = workspace.members.find((item) => item.user.id === userId);
  const subject = approval.subject;
  const granted =
    subject.kind === "grant-mandate" ? state.mandates.get(subject.mandate.id) : undefined;
  const liveSubject: ApprovalSubject =
    subject.kind === "approve-intent"
      ? { ...subject, intent: stripIntent(state.intents.get(subject.intent.id) ?? subject.intent) }
      : subject.kind === "cancel-transaction"
        ? liveCancelSubject(subject, workspace.paused)
        : subject.kind === "sweep-wallet"
          ? {
              ...subject,
              transaction: subject.transaction
                ? liveTransaction(subject.transaction, approval.summary.id, false, workspace.paused)
                : null,
            }
          : subject.kind === "grant-mandate"
            ? {
                ...subject,
                assets: mandateAssets(
                  subject.mandate,
                  workspace.wallets.find((item) => item.id === subject.wallet.id)?.policy ?? null,
                ),
                usage: granted ? mandateSummary(granted).usage : null,
              }
            : subject;
  return {
    ...approval.summary,
    envelope: approval.envelope,
    approvedBy: approval.approvedBy.map((user) => userSummary(user.id)),
    rejectedBy: approval.rejectedBy ? userSummary(approval.rejectedBy.id) : null,
    canDecide:
      approval.summary.status === "pending" &&
      member !== undefined &&
      member.role !== "viewer" &&
      member.approver === "active" &&
      !approval.approvedBy.some((user) => user.id === userId),
    subject: liveSubject,
    confirmUrl: confirmUrl(approval),
  };
}

function stripIntent(intent: IntentDetail & { workspaceId?: string }): IntentDetail {
  const { workspaceId, ...rest } = intent;
  const paused = state.workspaces.get(workspaceId ?? "")?.paused ?? false;
  return {
    ...rest,
    transaction: rest.transaction
      ? liveTransaction(rest.transaction, targetOf(rest), true, paused)
      : null,
  };
}

function workspaceDetail(workspace: Workspace, userId: string): WorkspaceDetail {
  const pending = [...state.approvals.values()].filter(
    (item) => item.summary.workspaceId === workspace.id && item.summary.status === "pending",
  ).length;
  const viewerIsOwner = memberOf(workspace, userId).role === "owner";
  return {
    id: workspace.id as WorkspaceDetail["id"],
    name: workspace.name,
    role: memberOf(workspace, userId).role,
    paused: workspace.paused,
    pendingApprovals: pending,
    lifecycle: workspace.lifecycle,
    adminThreshold: workspace.adminThreshold,
    notificationDetail: workspace.notificationDetail,
    // The server's default SIGNER_ADMIN_COMMAND, shown to owners only, as the server does.
    ...(viewerIsOwner
      ? { signerAdminCommand: "docker compose exec signer node src/admin.ts" }
      : {}),
    members: workspace.members.map((member) => ({
      ...member,
      // Owners see the passkeys that wait to approve, so an operator can enroll them by hand.
      pendingPasskeys:
        viewerIsOwner && member.approver === "pending"
          ? [...state.credentials.entries()]
              .filter(([, credential]) => credential.userId === member.user.id)
              .map(([credentialId, credential]) => ({
                credentialId,
                publicKey: credential.publicKey,
                label: credential.summary.label,
              }))
          : [],
    })),
    agents: workspace.agents,
    wallets: workspace.wallets,
    chains: CHAINS,
  };
}

function fakeAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

/** What the browser wrote into a passkey response: the fields the fixture compares. */
const ClientData = z.object({
  type: z.string().optional(),
  challenge: z.string().optional(),
  origin: z.string().optional(),
  crossOrigin: z.boolean().optional(),
});

function clientData(response: { response: { clientDataJSON: string } }) {
  return ClientData.parse(
    JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")),
  );
}

function finishCeremony(
  ceremonyId: string,
  kind: string,
  response: { response: { clientDataJSON: string } },
) {
  const ceremony = state.ceremonies.get(ceremonyId);
  state.ceremonies.delete(ceremonyId);
  if (
    !ceremony ||
    ceremony.kind !== kind ||
    clientData(response).challenge !== ceremony.challenge
  ) {
    throw new Refusal("invalid_request", "This sign-in attempt is no longer valid. Start again.");
  }
  return ceremony;
}

function registrationOptions(userId: string, name: string) {
  const challenge = randomToken(32);
  return {
    challenge,
    options: {
      challenge,
      rp: { name: RP_NAME, id: "localhost" },
      user: { id: b64url(Buffer.from(userId)), name, displayName: name },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" },
      ],
      timeout: 60_000,
      attestation: "none",
      excludeCredentials: [],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    },
  };
}

function registerCredential(
  userId: string,
  response: { id: string },
  label: string,
): PasskeySummary {
  const summary: PasskeySummary = {
    credentialId: response.id,
    label,
    createdAt: now(),
    lastUsedAt: null,
    deviceType: "singleDevice",
    backedUp: false,
  };
  state.credentials.set(response.id, { userId, publicKey: randomToken(32), summary });
  return summary;
}

function startSession(res: ServerResponse, userId: string): void {
  const token = randomToken();
  state.sessions.set(token, userId);
  state.signedInAt.set(token, now());
  res.setHeader("set-cookie", `fixture_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
}

/** As the server asks before the record and erasure: a passkey sign-in at most 300 s old. */
function requireRecentSignIn(signedInAt: number | null): void {
  if (signedInAt === null || now() - signedInAt > 300) {
    throw new Refusal(
      "forbidden",
      "Sign in again with your passkey first: this needs a sign-in from the last 5 minutes.",
      "sign_in_again",
    );
  }
}

function sessionInfo(userId: string | null): SessionInfo {
  return {
    setupRequired: !state.setupDone,
    user: userId ? userSummary(userId) : null,
    relyingParty: { id: "localhost", name: RP_NAME },
  };
}

// --- intents (what an agent proposes over MCP on the real server) ------------------------------

function propose(agentToken: string, body: Record<string, string>): IntentDetail {
  const agentId = state.tokens.get(agentToken);
  if (!agentId) throw new Refusal("unauthenticated", "Unknown agent token.");
  const workspace = [...state.workspaces.values()].find((item) =>
    item.agents.some((agent) => agent.id === agentId),
  );
  if (!workspace) throw new Refusal("unauthenticated", "Unknown agent token.");
  const agent = workspace.agents.find((item) => item.id === agentId);
  const wallet = workspace.wallets.find((item) => item.agentId === agentId);
  if (!agent || !wallet || agent.status !== "active")
    throw new Refusal("forbidden", "This agent was removed.");
  // Mirrors the gateway and the signer: nothing is proposed from a workspace being deleted or a
  // wallet that is retiring, stopped or destroyed.
  if (workspace.lifecycle.state !== "active" || wallet.lifecycle.state !== "active")
    throw new Refusal("forbidden", "This wallet is retired or its workspace is being deleted.");
  if (!wallet.policy || !wallet.policyHash)
    throw new Refusal("policy_denied", "This wallet has no policy yet.", "policy_missing");
  if (body.kind === "order") return proposeOrder(workspace, agent, wallet, body);
  const chainId = wallet.policy.chains[0] ?? "eip155:31337";
  const to = (body.to ?? fakeAddress()) as `0x${string}`;
  const amount = body.amount ?? "15000000000000000";
  const kind = body.kind ?? "transfer";
  const operation =
    kind === "erc20"
      ? { type: "evm.erc20.transfer" as const, token: TEST_USDC as `0x${string}`, to, amount }
      : kind === "call"
        ? {
            type: "evm.call" as const,
            to,
            valueWei: "0",
            data: "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111" as `0x${string}`,
          }
        : { type: "evm.transfer" as const, to, valueWei: amount };
  const intent: EvmIntent = {
    v: 1,
    id: newId("int"),
    workspaceId: workspace.id as EvmIntent["workspaceId"],
    agentId: agent.id,
    walletId: wallet.id,
    chainId: chainId as EvmIntent["chainId"],
    operation,
    maxFeeWei: "300000000000000",
    memo: body.memo ?? "",
    createdAt: now(),
  };
  const decimals = kind === "erc20" ? 6 : 18;
  const symbol = kind === "erc20" ? "USDC" : "ETH";
  const asset = kind === "erc20" ? TEST_USDC : "native";
  const moved = kind === "call" ? "0" : amount;
  const formatted = formatAmount(moved, decimals);
  const limit = wallet.policy.assets.find(
    (item) => item.asset === asset && item.chainId === chainId,
  );
  const spentKey = `${wallet.id}|${chainId}|${asset}`;
  const detail: IntentDetail & { workspaceId: string } = {
    id: intent.id,
    workspaceId: workspace.id,
    agent: { id: agent.id, name: agent.name },
    walletId: wallet.id,
    chainId: intent.chainId,
    status: "pending_approval",
    mandateId: null,
    display: {
      kind: "transfer",
      title: kind === "call" ? `Call contract ${short(to)}` : `Send ${formatted} ${symbol}`,
      assetSymbol: symbol,
      assetDecimals: decimals,
      amount: moved,
      amountFormatted: formatted,
      to,
      token: kind === "erc20" ? (TEST_USDC as `0x${string}`) : null,
      rawCall: kind === "call",
    },
    memo: intent.memo,
    createdAt: intent.createdAt,
    approvalId: null,
    transactionHash: null,
    failureCode: null,
    order: null,
    intent,
    intentHash: intentHash(intent),
    simulation: {
      ok: body.simulate !== "fail",
      blockNumber: 1041,
      gasEstimate: "21000",
      error: body.simulate === "fail" ? "ERC20: transfer amount exceeds balance" : null,
    },
    transaction: null,
  };
  // A covering mandate signs it with no person asked, as the server routes it to the signer.
  const covering = coveringMandate(workspace, agent.id, wallet.id, intent, body.mandateId);
  state.intents.set(intent.id, detail);
  audit(workspace, { type: "agent", id: agent.id, name: agent.name }, "intent.proposed", {
    type: "intent",
    id: intent.id,
  });
  if (covering) {
    detail.mandateId = covering.mandate.id;
    const useId = newId("apr");
    // The signer checks the wallet's policy too, and its pause; a refusal counts nothing.
    const refused = workspace.paused
      ? "workspace_paused"
      : policyRefusal(wallet.policy, intent, asset, BigInt(moved), state.spent.get(spentKey) ?? 0n);
    if (refused !== null) {
      detail.status = "denied";
      detail.failureCode = refused;
      decide(workspace, useId, "sign-under-mandate", refused);
      return stripIntent(detail);
    }
    covering.uses.push({ at: now(), chainId, asset, amount: BigInt(moved) });
    state.spent.set(spentKey, (state.spent.get(spentKey) ?? 0n) + BigInt(moved));
    detail.status = "broadcast";
    detail.transaction = sentTransaction(chainId);
    detail.transactionHash = detail.transaction.hash;
    state.useIds.set(intent.id, useId);
    state.sentAt.set(intent.id, now());
    decide(workspace, useId, "sign-under-mandate", null);
    return stripIntent(detail);
  }
  const policyAtProposal = wallet.policyHash;
  const approval = openApproval({
    workspace,
    kind: "approve-intent",
    title:
      kind === "call"
        ? `Call contract ${short(to)}`
        : `Send ${formatted} ${symbol} to ${short(to)}`,
    requestedBy: { type: "agent", id: agent.id, name: agent.name },
    threshold: wallet.policy.approvals.threshold,
    ttl: wallet.policy.approvals.ttlSeconds,
    envelope: {
      intentHash: detail.intentHash,
      walletId: wallet.id,
      agentId: agent.id,
      chainId,
      policyHash: wallet.policyHash,
    },
    subject: {
      kind: "approve-intent",
      intent: stripIntent(detail),
      wallet,
      limits: limit
        ? {
            maxPerTx: limit.maxPerTx,
            maxPerDay: limit.maxPerDay,
            spentToday: (state.spent.get(spentKey) ?? 0n).toString(),
          }
        : null,
      venue: null,
    },
    apply: () => {
      const live = state.intents.get(intent.id);
      if (!live) return;
      const approval = state.approvals.get(live.approvalId ?? "");
      const fail = (code: string) => {
        live.status = "failed";
        live.failureCode = code;
        if (approval) {
          approval.summary.status = "failed";
          approval.summary.failureCode = code;
        }
        decide(workspace, approval?.summary.id ?? null, "sign_transaction", code);
      };
      if (workspace.paused) return fail("workspace_paused");
      if (wallet.policyHash !== policyAtProposal) return fail("policy_changed");
      state.spent.set(spentKey, (state.spent.get(spentKey) ?? 0n) + BigInt(moved));
      live.status = "broadcast";
      live.transaction = sentTransaction(chainId);
      live.transactionHash = live.transaction.hash;
      state.sentAt.set(live.id, now());
      decide(workspace, approval?.summary.id ?? null, "sign_transaction", null);
    },
  });
  detail.approvalId = approval.summary.id;
  if (approval.subject.kind === "approve-intent")
    approval.subject.intent.approvalId = approval.summary.id;
  return stripIntent(detail);
}

/** What the stand-in venue reports an account holds, in USD: the bound on what can be lost. */
const VENUE_ACCOUNT_VALUE_USD = "250";

/** The stand-in venue's next order id. */
let nextVenueOrderId = 9_000_001;

/**
 * An order at Hyperliquid testnet, as `propose_order` opens it on the real server: the coin is
 * named through the wallet's venue rules, which bind it to the index that is signed; the caps
 * are checked first; and people approve every order (no mandate covers one).
 */
function proposeOrder(
  workspace: Workspace,
  agent: { id: EvmIntent["agentId"]; name: string },
  wallet: WalletSummary,
  body: Record<string, string>,
): IntentDetail {
  const policy = wallet.policy;
  const rules = policy?.venues?.hyperliquid;
  if (!policy || !wallet.policyHash || !rules) {
    throw new Refusal(
      "policy_denied",
      "This wallet's limits have no rules for Hyperliquid.",
      "venue_not_allowed",
    );
  }
  const coin = body.coin ?? "BTC";
  const market = rules.markets.find((item) => item.coin === coin);
  if (!market) {
    throw new Refusal(
      "policy_denied",
      `The wallet's limits do not list ${coin}.`,
      "market_not_allowed",
    );
  }
  const tif = HyperliquidTimeInForce.parse(body.timeInForce ?? "Ioc");
  if (!rules.timeInForce.includes(tif)) {
    throw new Refusal(
      "policy_denied",
      "The wallet's limits do not allow this time in force.",
      "order_type_not_allowed",
    );
  }
  const operation: HyperliquidOrderOperation = {
    type: "hyperliquid.order",
    asset: market.asset,
    isBuy: body.side !== "sell",
    size: body.size ?? "0.01",
    limitPx: body.limitPrice ?? "65000",
    tif,
    reduceOnly: body.reduceOnly === "true",
  };
  const notional = orderNotionalUsd6(operation.size, operation.limitPx);
  const spentKey = `${wallet.id}|${rules.network}|usd6`;
  const spent = state.spent.get(spentKey) ?? 0n;
  if (notional > BigInt(market.maxNotionalPerOrderUsd6)) {
    throw new Refusal("policy_denied", "The order is over its market's cap.", "over_per_tx_cap");
  }
  if (!operation.reduceOnly && spent + notional > BigInt(rules.maxNotionalPerDayUsd6)) {
    throw new Refusal("policy_denied", "The order is over the daily cap.", "over_daily_cap");
  }
  const intent: VenueIntent = {
    v: 1,
    id: newId("int"),
    workspaceId: workspace.id as VenueIntent["workspaceId"],
    agentId: agent.id,
    walletId: wallet.id,
    chainId: rules.network,
    operation,
    memo: body.memo ?? "",
    createdAt: now(),
  };
  const side = operation.isBuy ? "buy" : "sell";
  const title = `${operation.isBuy ? "Buy" : "Sell"} ${operation.size} ${coin} at ${operation.limitPx}`;
  const detail: IntentDetail & { workspaceId: string } = {
    id: intent.id,
    workspaceId: workspace.id,
    agent: { id: agent.id, name: agent.name },
    walletId: wallet.id,
    chainId: intent.chainId,
    status: "pending_approval",
    mandateId: null,
    display: {
      kind: "order",
      title,
      network: rules.network,
      coin,
      asset: market.asset,
      side,
      size: operation.size,
      limitPrice: operation.limitPx,
      notionalUsd: formatAmount(notional.toString(), 6),
      timeInForce: tif,
      reduceOnly: operation.reduceOnly,
      cancellableByAgent: true,
    },
    memo: intent.memo,
    createdAt: intent.createdAt,
    approvalId: null,
    transactionHash: null,
    failureCode: null,
    order: null,
    intent,
    intentHash: intentHash(intent),
    simulation: null,
    transaction: null,
  };
  state.intents.set(intent.id, detail);
  audit(workspace, { type: "agent", id: agent.id, name: agent.name }, "intent.proposed", {
    type: "intent",
    id: intent.id,
  });
  const policyAtProposal = wallet.policyHash;
  const approval = openApproval({
    workspace,
    kind: "approve-intent",
    title,
    requestedBy: { type: "agent", id: agent.id, name: agent.name },
    threshold: policy.approvals.threshold,
    ttl: policy.approvals.ttlSeconds,
    envelope: {
      intentHash: detail.intentHash,
      walletId: wallet.id,
      agentId: agent.id,
      chainId: rules.network,
      policyHash: wallet.policyHash,
    },
    subject: {
      kind: "approve-intent",
      intent: stripIntent(detail),
      wallet,
      limits: null,
      venue: {
        network: rules.network,
        maxPerOrderUsd6: market.maxNotionalPerOrderUsd6,
        maxNotionalPerDayUsd6: rules.maxNotionalPerDayUsd6,
        spentTodayUsd6: spent.toString(),
        submitWindowSeconds: rules.submitWindowSeconds,
        withdrawals: rules.withdrawals,
        accountValueUsd: VENUE_ACCOUNT_VALUE_USD,
      },
    },
    apply: () => {
      const live = state.intents.get(intent.id);
      if (!live) return;
      const current = state.approvals.get(live.approvalId ?? "");
      const fail = (code: string) => {
        live.status = "failed";
        live.failureCode = code;
        if (current) {
          current.summary.status = "failed";
          current.summary.failureCode = code;
        }
        decide(workspace, current?.summary.id ?? null, "sign-venue", code);
      };
      if (workspace.paused) return fail("workspace_paused");
      if (wallet.policyHash !== policyAtProposal) return fail("policy_changed");
      if (!operation.reduceOnly) {
        state.spent.set(spentKey, (state.spent.get(spentKey) ?? 0n) + notional);
      }
      const signedAt = now();
      const rests = tif !== "Ioc";
      live.order = {
        cloid: `0x${randomBytes(16).toString("hex")}`,
        venueOrderId: nextVenueOrderId++,
        filledSize: rests ? "0" : operation.size,
        averagePrice: rests ? null : operation.limitPx,
        submitBy: signedAt + rules.submitWindowSeconds,
        venueError: null,
        canCancel: rests,
      };
      live.status = rests ? "placed" : "filled";
      decide(workspace, current?.summary.id ?? null, "sign-venue", null);
    },
  });
  detail.approvalId = approval.summary.id;
  if (approval.subject.kind === "approve-intent")
    approval.subject.intent.approvalId = approval.summary.id;
  return stripIntent(detail);
}

/** A venue decimal ("0.01") in units of 10^-8, as the venue keeps sizes. */
function toE8(text: string): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(8, "0").slice(0, 8));
}

/**
 * The wallet's account at Hyperliquid testnet for the wallet page, as the server gives it when a
 * policy has venue rules or the wallet has ordered there: the signer's 24-hour count against the
 * daily cap, and what the stand-in venue reports: the account value the order card names, one
 * position per coin from the filled orders (entered at the latest fill's price, no unrealised
 * profit) and the orders resting on its book.
 */
function venueAccountOf(wallet: WalletSummary): VenueAccount | null {
  const rules = wallet.policy?.venues?.hyperliquid;
  const orders = [...state.intents.values()].filter(
    (intent) => intent.walletId === wallet.id && intent.display.kind === "order",
  );
  if (rules === undefined && orders.length === 0) return null;
  const network = rules?.network ?? "hyperliquid:testnet";
  const held = new Map<string, { size: bigint; entryPrice: string }>();
  const openOrders: NonNullable<VenueAccount["reported"]>["openOrders"] = [];
  for (const intent of orders) {
    const { display, order } = intent;
    if (display.kind !== "order" || order === null) continue;
    const filled = toE8(order.filledSize ?? "0");
    if (filled > 0n) {
      const position = held.get(display.coin) ?? { size: 0n, entryPrice: display.limitPrice };
      position.size += display.side === "buy" ? filled : -filled;
      position.entryPrice = order.averagePrice ?? display.limitPrice;
      held.set(display.coin, position);
    }
    if (intent.status === "placed" && order.canCancel) {
      openOrders.push({
        coin: display.coin,
        side: display.side,
        size: formatAmount((toE8(display.size) - filled).toString(), 8),
        limitPrice: display.limitPrice,
        venueOrderId: order.venueOrderId ?? 0,
        cloid: null,
      });
    }
  }
  return {
    network,
    spentTodayUsd6: (state.spent.get(`${wallet.id}|${network}|usd6`) ?? 0n).toString(),
    maxNotionalPerDayUsd6: rules?.network === network ? rules.maxNotionalPerDayUsd6 : null,
    reported: {
      accountValueUsd: VENUE_ACCOUNT_VALUE_USD,
      withdrawableUsd: VENUE_ACCOUNT_VALUE_USD,
      positions: [...held]
        .filter(([, position]) => position.size !== 0n)
        .map(([coin, position]) => ({
          coin,
          side: position.size > 0n ? "long" : "short",
          size: formatAmount((position.size > 0n ? position.size : -position.size).toString(), 8),
          entryPrice: position.entryPrice,
          unrealizedPnlUsd: "0",
        })),
      openOrders,
    },
  };
}

function formatAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? (value / base).toString() : `${value / base}.${fraction}`;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function policyFromDraft(
  workspace: Workspace,
  wallet: WalletSummary,
  draft: PolicyDraft,
): WalletPolicy {
  return normalizePolicy({
    v: 1,
    workspaceId: workspace.id as WalletPolicy["workspaceId"],
    walletId: wallet.id,
    revision: (wallet.policy?.revision ?? 0) + 1,
    previousHash: wallet.policyHash,
    chains: draft.chains,
    requesters: draft.requesters,
    assets: draft.assets,
    recipients: draft.recipients,
    contractCalls: draft.contractCalls,
    fees: draft.fees,
    approvals: draft.approvals,
    ...(draft.venues ? { venues: draft.venues } : {}),
  } as WalletPolicy);
}

// --- mandates (as the signer holds and counts them; the server mirrors them) -------------------

/** The signer's defaults: `SIGNER_MAX_MANDATE_SECONDS`, `SIGNER_MAX_LIVE_MANDATES_PER_WALLET`. */
const MANDATE_LONGEST_SECONDS = 604_800;
const LIVE_MANDATES_PER_WALLET = 16;

interface FixtureMandate {
  workspaceId: string;
  agent: { id: Mandate["agentId"]; name: string };
  mandate: Mandate;
  grantApprovalId: string;
  grantedAt: number;
  grantedBy: string[];
  revokedAt: number | null;
  /** The reason it was first seen ending, kept as the server's mirror keeps it. */
  endedReason: MandateEndedReason | null;
  /** Every payment signed under it, counted for good: nothing is ever given back. */
  uses: { at: number; chainId: string; asset: string; amount: bigint }[];
}

function knownAsset(asset: string): { symbol: string | null; decimals: number | null } {
  if (asset === "native") return { symbol: "ETH", decimals: 18 };
  if (asset === TEST_USDC) return { symbol: "USDC", decimals: 6 };
  return { symbol: null, decimals: null };
}

/** Each asset as a person reads it, next to the wallet's current limits for it. */
function mandateAssets(mandate: Mandate, policy: WalletPolicy | null): MandateAssetView[] {
  return mandateWorstCase(mandate).map((entry) => {
    const limit = policy?.assets.find(
      (item) => item.chainId === entry.chainId && item.asset === entry.asset,
    );
    return {
      chainId: entry.chainId,
      asset: entry.asset,
      ...knownAsset(entry.asset),
      worstCase: entry.amount.toString(),
      policy: limit ? { maxPerTx: limit.maxPerTx, maxPerDay: limit.maxPerDay } : null,
    };
  });
}

/** The signer's count, as `evaluateMandate` reads it: all-time, and in the last window. */
function mandateUsage(record: FixtureMandate): MandateUsage {
  const sum = (chainId: string, asset: string, since: number) =>
    record.uses
      .filter((use) => use.chainId === chainId && use.asset === asset && use.at > since)
      .reduce((total, use) => total + use.amount, 0n);
  return {
    uses: record.uses.length,
    total: (chainId, asset) => sum(chainId, asset, Number.NEGATIVE_INFINITY),
    inWindow: (chainId, asset) => sum(chainId, asset, now() - record.mandate.windowSeconds),
  };
}

function mandateStatus(record: FixtureMandate): MandateStatus {
  if (record.revokedAt !== null) return "revoked";
  const time = mandateTimeState(record.mandate, now());
  if (time !== "live") return time;
  const usage = mandateUsage(record);
  const spent =
    usage.uses >= record.mandate.maxUses ||
    record.mandate.assets.every(
      (limit) => usage.total(limit.chainId, limit.asset) >= BigInt(limit.maxTotal),
    );
  return spent ? "exhausted" : "active";
}

/** The mandate as the server reports it; reading it records why it ended, the first time. */
function mandateSummary(record: FixtureMandate): MandateSummary {
  const status = mandateStatus(record);
  if (record.endedReason === null && (status === "expired" || status === "exhausted")) {
    record.endedReason = status;
  }
  const { mandate } = record;
  const wallet = workspaceOf(record.workspaceId).wallets.find(
    (item) => item.id === mandate.walletId,
  );
  const usage = mandateUsage(record);
  return {
    id: mandate.id,
    workspaceId: mandate.workspaceId,
    walletId: mandate.walletId,
    agent: record.agent,
    mandate,
    mandateHash: mandateHash(mandate),
    status,
    endedReason: record.endedReason,
    grantApprovalId: record.grantApprovalId as MandateSummary["grantApprovalId"],
    grantedAt: record.grantedAt,
    grantedBy: record.grantedBy.map(userSummary),
    revokedAt: record.revokedAt,
    assets: mandateAssets(mandate, wallet?.policy ?? null),
    usage: {
      uses: usage.uses,
      usesLeft: Math.max(0, mandate.maxUses - usage.uses),
      assets: mandate.assets.map((limit) => ({
        chainId: limit.chainId,
        asset: limit.asset,
        usedTotal: usage.total(limit.chainId, limit.asset).toString(),
        usedInWindow: usage.inWindow(limit.chainId, limit.asset).toString(),
      })),
    },
  };
}

/** Ends a mandate at the "signer" for good. Ending an ended one changes nothing. */
function endMandate(record: FixtureMandate, reason: "revoked" | "agent_disabled"): void {
  if (record.revokedAt !== null) return;
  mandateSummary(record);
  record.revokedAt = now();
  record.endedReason ??= reason;
  decide(workspaceOf(record.workspaceId), record.grantApprovalId, "revoke-mandate", null);
}

/** Why this mandate does not cover the intent now, with the signer's code, or null. */
function mandateRefusal(record: FixtureMandate, intent: EvmIntent): string | null {
  const status = mandateStatus(record);
  if (status === "revoked") return "mandate_revoked";
  if (status === "not_yet_valid") return "mandate_not_yet_valid";
  if (status === "expired") return "mandate_expired";
  if (record.grantedBy.length < workspaceOf(record.workspaceId).adminThreshold) {
    return "mandate_grant_below_threshold";
  }
  const decision = evaluateMandate(record.mandate, intent, mandateUsage(record));
  return decision.allowed ? null : decision.code;
}

/**
 * The mandate that covers an agent's intent, as the server picks it: the agent's live mandates on
 * the wallet by `notAfter`, then id, first that covers wins. A named one that does not cover is
 * refused with its reason. No contract call is ever signed under a mandate.
 */
function coveringMandate(
  workspace: Workspace,
  agentId: string,
  walletId: string,
  intent: EvmIntent,
  pinned: string | undefined,
): FixtureMandate | null {
  if (pinned === undefined && intent.operation.type === "evm.call") return null;
  const candidates = [...state.mandates.values()]
    .filter(
      (record) =>
        record.workspaceId === workspace.id &&
        record.agent.id === agentId &&
        (pinned === undefined
          ? record.mandate.walletId === walletId && record.endedReason === null
          : record.mandate.id === pinned),
    )
    .sort(
      (a, b) => a.mandate.notAfter - b.mandate.notAfter || (a.mandate.id < b.mandate.id ? -1 : 1),
    );
  if (pinned !== undefined && candidates.length === 0) {
    throw new Refusal("not_found", "No such mandate.");
  }
  for (const record of candidates) {
    const refusal = mandateRefusal(record, intent);
    if (refusal === null) return record;
    if (pinned !== undefined) {
      throw new Refusal("policy_denied", "The mandate you named does not cover this.", refusal);
    }
  }
  return null;
}

/** The wallet policy's own verdict on a payment, which the signer applies under a mandate too. */
function policyRefusal(
  policy: WalletPolicy,
  intent: EvmIntent,
  asset: string,
  amount: bigint,
  spentToday: bigint,
): string | null {
  const limit = policy.assets.find(
    (item) => item.chainId === intent.chainId && item.asset === asset,
  );
  if (!limit) return "asset_not_allowed";
  const to = intent.operation.to;
  if (policy.recipients.mode === "allowlist" && !policy.recipients.addresses.includes(to)) {
    return "recipient_not_allowed";
  }
  if (amount > BigInt(limit.maxPerTx)) return "over_per_tx_cap";
  if (spentToday + amount > BigInt(limit.maxPerDay)) return "over_daily_cap";
  if (BigInt(intent.maxFeeWei) > BigInt(policy.fees.maxPerTxWei)) return "fee_cap_exceeded";
  return null;
}

// --- retiring and deleting --------------------------------------------------------------------

/** The signer's default range for the delay before keys are destroyed: 7 to 90 days. */
const MIN_DESTROY_DELAY_SECONDS = 604_800;
const MAX_DESTROY_DELAY_SECONDS = 7_776_000;

/** What `getWallet` and the deletion preflight read in every wallet. */
const BALANCES: AssetBalance[] = [
  {
    chainId: "eip155:31337",
    asset: "native",
    symbol: "ETH",
    decimals: 18,
    amount: "1250000000000000000",
  },
  { chainId: "eip155:31337", asset: TEST_USDC, symbol: "USDC", decimals: 6, amount: "420000000" },
];

const systemActor: AuditEvent["actor"] = { type: "system", id: null, name: null };

/** Mirrors the signer: the delay from now, the request's `issuedAt`, must be in its range. */
function checkDestroyAfter(destroyAfter: number): void {
  const delay = destroyAfter - now();
  if (delay < MIN_DESTROY_DELAY_SECONDS || delay > MAX_DESTROY_DELAY_SECONDS) {
    throw new Refusal(
      "invalid_request",
      "The delay before keys are destroyed is outside what the signer allows.",
      "destroy_delay_out_of_range",
    );
  }
}

/** Whether a sent transaction of the workspace, or of one wallet, is not mined yet (D7). */
function unmined(workspace: Workspace, walletId?: string): boolean {
  return [...state.intents.values()].some(
    (intent) =>
      intent.workspaceId === workspace.id &&
      (walletId === undefined || intent.walletId === walletId) &&
      intent.transaction !== null &&
      isSent(intent.transaction),
  );
}

/** Withdraws a waiting request, and the payment it asked for. */
function cancelApproval(approval: Approval): void {
  approval.summary.status = "cancelled";
  if (approval.subject.kind === "approve-intent") {
    const intent = state.intents.get(approval.subject.intent.id);
    if (intent) intent.status = "cancelled";
  }
}

/**
 * What applying a deletion (`walletId` null) or a retirement ends at once, as the server does:
 * waiting requests, except cancels of sent transactions, and live mandates. A retirement ends only
 * the wallet's waiting grants and sweeps, and its mandates.
 */
function endAuthority(workspace: Workspace, walletId: string | null, keep: string): void {
  for (const approval of state.approvals.values()) {
    const { summary, envelope } = approval;
    if (summary.workspaceId !== workspace.id || summary.status !== "pending") continue;
    if (summary.id === keep || envelope.type === "cancel-transaction") continue;
    const ofWallet =
      (envelope.type === "grant-mandate" || envelope.type === "sweep-wallet") &&
      envelope.walletId === walletId;
    if (walletId === null || ofWallet) cancelApproval(approval);
  }
  for (const record of state.mandates.values()) {
    if (
      record.workspaceId === workspace.id &&
      (walletId === null || record.mandate.walletId === walletId)
    ) {
      endMandate(record, "revoked");
    }
  }
}

/** The waiting request to retire `walletId`, or to delete the workspace when it is null. */
function waitingLifecycle(workspace: Workspace, walletId: string | null): Approval | undefined {
  return [...state.approvals.values()].find(
    ({ summary, envelope }) =>
      summary.workspaceId === workspace.id &&
      summary.status === "pending" &&
      (walletId === null
        ? envelope.type === "delete-workspace"
        : envelope.type === "retire-wallet" && envelope.wallet.walletId === walletId),
  );
}

/**
 * Finishes what is due, as the server's sweeper does: destroys the key of each retiring wallet
 * whose time came, and makes each workspace being deleted a tombstone, unless a sent transaction
 * of it is not mined yet (D7). The tombstone keeps ids and the logs; its members, invites and
 * agent tokens are gone, so it is gone for its members.
 */
function finalizeDue(): void {
  for (const workspace of state.workspaces.values()) {
    const { lifecycle } = workspace;
    if (lifecycle.state === "deleting" && lifecycle.destroyAfter !== null) {
      if (lifecycle.destroyAfter > now() || unmined(workspace)) continue;
      for (const approval of state.approvals.values()) {
        if (approval.summary.workspaceId === workspace.id && approval.summary.status === "pending")
          cancelApproval(approval);
      }
      for (const wallet of workspace.wallets) {
        if (wallet.lifecycle.state === "destroyed") continue;
        wallet.lifecycle = { state: "destroyed", destroyAfter: lifecycle.destroyAfter };
        decide(workspace, null, "destroy-wallet", null);
      }
      const agentIds = new Set<string>(workspace.agents.map((agent) => agent.id));
      for (const [token, agentId] of state.tokens)
        if (agentIds.has(agentId)) state.tokens.delete(token);
      for (const [token, invite] of state.invites) {
        if (invite.workspaceId === workspace.id) state.invites.delete(token);
      }
      workspace.agents = workspace.agents.map((agent) => ({
        ...agent,
        status: "disabled",
        name: "Removed agent",
      }));
      audit(workspace, systemActor, "workspace.deleted", { type: "workspace", id: workspace.id });
      decide(workspace, null, "delete-workspace", null);
      workspace.name = "Deleted workspace";
      workspace.members = [];
      workspace.beforeDelete.clear();
      workspace.lifecycle = {
        state: "deleted",
        destroyAfter: lifecycle.destroyAfter,
        deletedAt: now(),
      };
      continue;
    }
    for (const wallet of workspace.wallets) {
      const due = wallet.lifecycle.destroyAfter;
      if (wallet.lifecycle.state !== "retiring" || due === null || due > now()) continue;
      if (unmined(workspace, wallet.id)) continue;
      wallet.lifecycle = { state: "destroyed", destroyAfter: due };
      audit(workspace, systemActor, "wallet.destroyed", { type: "wallet", id: wallet.id });
      decide(workspace, null, "destroy-wallet", null);
    }
  }
}

/**
 * Mirrors the server: while a workspace is being deleted it refuses every change but pausing,
 * cancelling, deciding on what still waits and notification settings. Reads stay open.
 */
const ALLOWED_WHILE_DELETING: Partial<Record<RouteName, true>> = {
  pauseWorkspace: true,
  cancelDeleteWorkspace: true,
  cancelRetireWallet: true,
  requestCancel: true,
  requestSweepCancel: true,
  collectApproval: true,
  reject: true,
  setNotificationDetail: true,
};

// --- handlers ---------------------------------------------------------------------------------

type Handler = (input: {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  userId: string | null;
  /** When the session's passkey sign-in happened; null without a session. */
  signedInAt: number | null;
  res: ServerResponse;
  origin: string;
}) => unknown;

function signedIn(userId: string | null): string {
  if (!userId) throw new Refusal("unauthenticated", "Sign in first.");
  return userId;
}

function notificationPreferences(userId: string): NotificationPreferences {
  return {
    workspaces: [...state.workspaces.values()]
      .filter((workspace) => workspace.members.some((member) => member.user.id === userId))
      .map((workspace) => ({
        workspaceId: workspace.id as WorkspaceDetail["id"],
        ...(state.notificationSwitches.get(`${userId} ${workspace.id}`) ?? {
          webPush: true,
          reminders: true,
        }),
      })),
    quietHours: state.quietHours.get(userId) ?? null,
  };
}

function pushEndpointAllowed(endpoint: string): boolean {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  return (
    url.username === "" &&
    url.password === "" &&
    PUSH_ENDPOINT_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  );
}

const handlers: Record<RouteName, Handler> = {
  getSession: ({ userId }) => sessionInfo(userId),
  startSetup: ({ body }) => {
    if (state.setupDone) throw new Refusal("conflict", "This server is already set up.");
    if (body.setupToken !== SETUP_TOKEN)
      throw new Refusal("forbidden", "The setup token is not correct.");
    const userId = newId("usr");
    const { challenge, options } = registrationOptions(userId, String(body.displayName));
    const ceremonyId = randomToken();
    state.ceremonies.set(ceremonyId, {
      challenge,
      kind: "setup",
      data: { userId, displayName: String(body.displayName) },
    });
    return { ceremonyId, options };
  },
  finishSetup: ({ body, res }) => {
    const response = body.response as { id: string; response: { clientDataJSON: string } };
    const ceremony = finishCeremony(String(body.ceremonyId), "setup", response);
    const userId = ceremony.data.userId ?? "";
    state.users.set(userId, ceremony.data.displayName ?? "");
    registerCredential(userId, response, "First passkey");
    state.setupDone = true;
    startSession(res, userId);
    return sessionInfo(userId);
  },
  startLogin: () => {
    const challenge = randomToken(32);
    const ceremonyId = randomToken();
    state.ceremonies.set(ceremonyId, { challenge, kind: "login", data: {} });
    return {
      ceremonyId,
      options: {
        challenge,
        rpId: "localhost",
        allowCredentials: [],
        userVerification: "required",
        timeout: 60_000,
      },
    };
  },
  finishLogin: ({ body, res }) => {
    const response = body.response as { id: string; response: { clientDataJSON: string } };
    finishCeremony(String(body.ceremonyId), "login", response);
    const credential = state.credentials.get(response.id);
    if (!credential) throw new Refusal("unauthenticated", "This passkey is not registered here.");
    credential.summary.lastUsedAt = now();
    startSession(res, credential.userId);
    return sessionInfo(credential.userId);
  },
  logout: ({ res }) => {
    res.setHeader("set-cookie", "fixture_session=; Path=/; Max-Age=0");
    return {};
  },
  eraseMe: ({ userId, signedInAt, res }) => {
    const id = signedIn(userId);
    requireRecentSignIn(signedInAt);
    const theirs = [...state.workspaces.values()].filter(
      (workspace) =>
        workspace.lifecycle.state !== "deleted" &&
        workspace.members.some((member) => member.user.id === id),
    );
    for (const workspace of theirs) {
      const owners = workspace.members.filter((member) => member.role === "owner");
      if (owners.length === 1 && owners[0]?.user.id === id) {
        throw new Refusal(
          "conflict",
          `You are the only owner of ${workspace.name}. Make someone else an owner, or delete it, first.`,
          "last_owner",
        );
      }
    }
    // While their passkeys still approve somewhere, the signer must stop accepting them first.
    const approving = theirs.filter((workspace) => memberOf(workspace, id).approver === "active");
    if (approving.length > 0) {
      for (const workspace of approving) {
        if (workspace.lifecycle.state === "deleting") {
          throw new Refusal(
            "conflict",
            `${workspace.name} is being deleted. Wait until the deletion finishes, or cancel it.`,
            "workspace_deleting",
          );
        }
        const others = workspace.members.filter(
          (member) => member.user.id !== id && member.approver === "active",
        ).length;
        if (others < workspace.adminThreshold) {
          throw new Refusal(
            "conflict",
            `Without your passkeys ${workspace.name} would have too few approvers. Add another approver first.`,
            "last_approver",
          );
        }
      }
      const approvals = approving.flatMap((workspace) => {
        const waiting = [...state.approvals.values()]
          .filter(
            ({ summary, subject }) =>
              summary.workspaceId === workspace.id &&
              summary.status === "pending" &&
              subject.kind === "remove-approver" &&
              subject.user.id === id,
          )
          .map((approval) => approval.summary);
        return waiting.length > 0
          ? waiting
          : approverApprovals(workspace, id, "remove-approver", id);
      });
      return { status: "waiting", approvals };
    }
    for (const workspace of theirs) {
      workspace.members = workspace.members.filter((member) => member.user.id !== id);
      audit(workspace, userActor(id), "member.erased", { type: "user", id });
    }
    for (const [credentialId, credential] of state.credentials) {
      if (credential.userId === id) state.credentials.delete(credentialId);
    }
    for (const [token, owner] of state.sessions) {
      if (owner !== id) continue;
      state.sessions.delete(token);
      state.signedInAt.delete(token);
    }
    for (const [subscriptionId, subscription] of state.pushSubscriptions) {
      if (subscription.userId === id) state.pushSubscriptions.delete(subscriptionId);
    }
    for (const key of state.notificationSwitches.keys()) {
      if (key.startsWith(`${id} `)) state.notificationSwitches.delete(key);
    }
    state.quietHours.delete(id);
    state.users.set(id, "Erased person");
    res.setHeader("set-cookie", "fixture_session=; Path=/; Max-Age=0");
    return { status: "erased", approvals: [] };
  },
  listPasskeys: ({ userId }) => {
    const id = signedIn(userId);
    return {
      items: [...state.credentials.values()]
        .filter((item) => item.userId === id)
        .map((item) => item.summary),
    };
  },
  startAddPasskey: ({ userId }) => {
    const id = signedIn(userId);
    const { challenge, options } = registrationOptions(id, state.users.get(id) ?? "");
    const ceremonyId = randomToken();
    state.ceremonies.set(ceremonyId, { challenge, kind: "add", data: {} });
    return { ceremonyId, options };
  },
  finishAddPasskey: ({ body, userId }) => {
    const id = signedIn(userId);
    const response = body.response as { id: string; response: { clientDataJSON: string } };
    finishCeremony(String(body.ceremonyId), "add", response);
    const passkey = registerCredential(id, response, String(body.label));
    const approvals: ApprovalSummary[] = [];
    for (const workspace of state.workspaces.values()) {
      const member = workspace.members.find((item) => item.user.id === id);
      if (member?.approver !== "active") continue;
      approvals.push(
        openApproval({
          workspace,
          kind: "add-approver",
          title: `Let ${state.users.get(id)}'s passkey "${passkey.label}" approve`,
          requestedBy: {
            type: "user",
            id: id as Member["user"]["id"],
            name: state.users.get(id) ?? "",
          },
          threshold: workspace.adminThreshold,
          ttl: 3600,
          envelope: {
            userId: id,
            credentialId: passkey.credentialId,
            publicKey: state.credentials.get(passkey.credentialId)?.publicKey ?? "",
          },
          subject: {
            kind: "add-approver",
            user: userSummary(id),
            credentialId: passkey.credentialId,
            passkeyLabel: passkey.label,
          },
          apply: () => undefined,
        }).summary,
      );
    }
    return { passkey, approvals };
  },
  removePasskey: ({ params, userId }) => {
    const id = signedIn(userId);
    const credential = state.credentials.get(params.credentialId ?? "");
    if (!credential || credential.userId !== id)
      throw new Refusal("not_found", "This passkey does not exist.");
    state.credentials.delete(params.credentialId ?? "");
    return { approvals: [] };
  },
  listWorkspaces: ({ userId }) => {
    const id = signedIn(userId);
    return {
      items: [...state.workspaces.values()]
        .filter((workspace) => workspace.members.some((member) => member.user.id === id))
        .map((workspace) => {
          const {
            id: wsId,
            name,
            role,
            paused,
            pendingApprovals,
            lifecycle,
          } = workspaceDetail(workspace, id);
          return { id: wsId, name, role, paused, pendingApprovals, lifecycle };
        }),
    };
  },
  createWorkspace: ({ body, userId }) => {
    const id = signedIn(userId);
    const workspace: Workspace = {
      id: newId("ws"),
      name: String(body.name).trim(),
      paused: false,
      adminThreshold: 1,
      notificationDetail: "count",
      lifecycle: { state: "active", destroyAfter: null, deletedAt: null },
      beforeDelete: new Map(),
      members: [
        {
          user: userSummary(id),
          role: "owner",
          approver: "active",
          joinedAt: now(),
          pendingPasskeys: [],
        },
      ],
      agents: [],
      wallets: [],
      audit: [],
      decisions: [],
    };
    state.workspaces.set(workspace.id, workspace);
    audit(workspace, userActor(id), "workspace.created", { type: "workspace", id: workspace.id });
    decide(workspace, null, "bootstrap_workspace", null);
    return workspaceDetail(workspace, id);
  },
  getWorkspace: ({ params, userId }) =>
    workspaceDetail(workspaceOf(params.workspaceId ?? ""), signedIn(userId)),
  pauseWorkspace: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    if (memberOf(workspace, id).role === "viewer")
      throw new Refusal("forbidden", "Viewers cannot pause.");
    workspace.paused = true;
    audit(workspace, userActor(id), "workspace.paused", { type: "workspace", id: workspace.id });
    decide(workspace, null, "pause_workspace", null);
    return workspaceDetail(workspace, id);
  },
  requestResume: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    if (!workspace.paused) throw new Refusal("conflict", "This workspace is not paused.");
    return openApproval({
      workspace,
      kind: "resume-workspace",
      title: `Resume ${workspace.name}`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: {},
      subject: { kind: "resume-workspace" },
      apply: () => {
        workspace.paused = false;
      },
    }).summary;
  },
  requestAdminThreshold: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const proposed = Number(body.adminThreshold);
    // Mirrors the signer: the admin threshold may not drop below a wallet's own threshold.
    if (workspace.wallets.some((wallet) => (wallet.policy?.approvals.threshold ?? 1) > proposed)) {
      throw new Refusal(
        "invalid_request",
        "A wallet needs more approvals per payment than this. Lower that wallet's number first.",
      );
    }
    return openApproval({
      workspace,
      kind: "set-admin-threshold",
      title: `Require ${proposed} approvals for admin changes`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: { adminThreshold: proposed },
      subject: { kind: "set-admin-threshold", current: workspace.adminThreshold, proposed },
      apply: () => {
        workspace.adminThreshold = proposed;
      },
    }).summary;
  },
  getDeletionPreflight: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallets = workspace.wallets.filter((wallet) => wallet.lifecycle.state !== "destroyed");
    const pending = [...state.approvals.values()].some(
      ({ summary }) => summary.workspaceId === workspace.id && summary.status === "pending",
    );
    return {
      workspaceId: workspace.id,
      source: "control-plane",
      wallets: wallets.map((wallet) => ({ wallet, balances: BALANCES })),
      blockers: [
        ...(pending ? ["pending_approvals"] : []),
        ...(unmined(workspace) ? ["unmined_transactions"] : []),
        ...(wallets.length > 0 ? ["nonzero_balance"] : []),
      ],
      minDestroyDelaySeconds: MIN_DESTROY_DELAY_SECONDS,
      earliestDestroyAfter: now() + MIN_DESTROY_DELAY_SECONDS,
    };
  },
  requestDeleteWorkspace: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    if (!workspace.paused) {
      throw new Refusal("conflict", "Pause the workspace first: it is deleted only while paused.");
    }
    if (waitingLifecycle(workspace, null)) {
      throw new Refusal("conflict", "A request to delete this workspace already waits.");
    }
    const destroyAfter = Number(body.destroyAfter);
    checkDestroyAfter(destroyAfter);
    // The envelope names every wallet whose key the signer holds, sorted by id.
    const wallets = workspace.wallets
      .filter((wallet) => wallet.lifecycle.state !== "destroyed")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const approval = openApproval({
      workspace,
      kind: "delete-workspace",
      title:
        wallets.length === 1
          ? "Delete this workspace and destroy 1 wallet key"
          : `Delete this workspace and destroy ${wallets.length} wallet keys`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: {
        wallets: wallets.map((wallet) => ({ walletId: wallet.id, address: wallet.address })),
        destroyAfter,
      },
      subject: {
        kind: "delete-workspace",
        wallets: wallets.map((wallet) => ({ ...wallet })),
        destroyAfter,
      },
      apply: () => {
        // Mirrors the signer: every listed wallet retires with the workspace, and a cancel puts
        // back what each was (one already retiring on its own comes back stopped).
        for (const wallet of wallets) {
          workspace.beforeDelete.set(
            wallet.id,
            wallet.lifecycle.state === "active" ? "active" : "held",
          );
          wallet.lifecycle = { state: "retiring", destroyAfter };
        }
        workspace.lifecycle = { state: "deleting", destroyAfter, deletedAt: null };
        endAuthority(workspace, null, approval.summary.id);
        audit(workspace, userActor(id), "workspace.deleting", {
          type: "workspace",
          id: workspace.id,
        });
        decide(workspace, approval.summary.id, "delete-workspace", null);
      },
    });
    return approval.summary;
  },
  cancelDeleteWorkspace: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const waiting = waitingLifecycle(workspace, null);
    if (waiting) {
      cancelApproval(waiting);
    } else if (workspace.lifecycle.state === "deleting") {
      // The keys stay; the workspace stays paused; ended mandates stay ended.
      for (const wallet of workspace.wallets) {
        const before = workspace.beforeDelete.get(wallet.id);
        if (before === undefined || wallet.lifecycle.state !== "retiring") continue;
        wallet.lifecycle = { state: before, destroyAfter: null };
      }
      workspace.beforeDelete.clear();
      workspace.lifecycle = { state: "active", destroyAfter: null, deletedAt: null };
      audit(workspace, userActor(id), "workspace.delete_cancelled", {
        type: "workspace",
        id: workspace.id,
      });
      decide(workspace, null, "cancel-delete-workspace", null);
    } else {
      throw new Refusal("conflict", "Nothing is waiting to delete this workspace.");
    }
    return workspaceDetail(workspace, id);
  },
  createInvite: ({ params, body, userId, origin }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const token = randomToken();
    const expiresAt = now() + 7 * 86_400;
    const inviteId = `inv_${randomToken(12)}`;
    state.invites.set(token, {
      id: inviteId,
      workspaceId: workspace.id,
      role: body.role as Role,
      invitedBy: id,
      createdAt: now(),
      expiresAt,
    });
    return { id: inviteId, url: `${origin}/join/${token}`, expiresAt };
  },
  listInvites: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const items: InviteSummary[] = [...state.invites.values()]
      .filter((invite) => invite.workspaceId === workspace.id && invite.expiresAt > now())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((invite) => ({
        id: invite.id,
        role: invite.role,
        createdBy: userSummary(invite.invitedBy),
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      }));
    return { items };
  },
  revokeInvite: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const entry = [...state.invites].find(
      ([, invite]) => invite.id === params.inviteId && invite.workspaceId === workspace.id,
    );
    if (!entry) throw new Refusal("not_found", "This invite does not exist.");
    state.invites.delete(entry[0]);
    audit(workspace, userActor(id), "invite.revoked", { type: "workspace", id: workspace.id });
    return {};
  },
  getInvite: ({ params }) => {
    const invite = state.invites.get(params.token ?? "");
    if (!invite) throw new Refusal("not_found", "This invite link is not valid.");
    return {
      workspaceName: workspaceOf(invite.workspaceId).name,
      role: invite.role,
      invitedBy: state.users.get(invite.invitedBy) ?? "",
    };
  },
  startInviteRegistration: ({ params, body }) => {
    if (!state.invites.has(params.token ?? ""))
      throw new Refusal("not_found", "This invite link is not valid.");
    const userId = newId("usr");
    const { challenge, options } = registrationOptions(userId, String(body.displayName));
    const ceremonyId = randomToken();
    state.ceremonies.set(ceremonyId, {
      challenge,
      kind: "invite",
      data: { userId, displayName: String(body.displayName) },
    });
    return { ceremonyId, options };
  },
  finishInviteRegistration: ({ params, body, res }) => {
    const invite = state.invites.get(params.token ?? "");
    if (!invite) throw new Refusal("not_found", "This invite link is not valid.");
    const response = body.response as { id: string; response: { clientDataJSON: string } };
    const ceremony = finishCeremony(String(body.ceremonyId), "invite", response);
    const userId = ceremony.data.userId ?? "";
    state.users.set(userId, ceremony.data.displayName ?? "");
    registerCredential(userId, response, "First passkey");
    joinWorkspace(params.token ?? "", userId);
    startSession(res, userId);
    return sessionInfo(userId);
  },
  acceptInvite: ({ params, userId }) => ({
    workspaceId: joinWorkspace(params.token ?? "", signedIn(userId)),
  }),
  setMemberRole: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const member = memberOf(workspace, params.userId ?? "");
    const role = body.role as Role;
    const wasApprover = member.approver !== "none";
    member.role = role;
    let approvals: ApprovalSummary[] = [];
    if (role === "viewer" && wasApprover)
      approvals = approverApprovals(workspace, member.user.id, "remove-approver", id);
    if (role !== "viewer" && !wasApprover) {
      member.approver = "pending";
      approvals = approverApprovals(workspace, member.user.id, "add-approver", id);
    }
    refreshApprover(workspace, member.user.id);
    return { member, approvals };
  },
  removeMember: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const member = memberOf(workspace, params.userId ?? "");
    const approvals =
      member.approver === "active"
        ? approverApprovals(workspace, member.user.id, "remove-approver", id)
        : [];
    workspace.members = workspace.members.filter((item) => item !== member);
    return { approvals };
  },
  createAgent: ({ params, body, userId, origin }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const agentId = newId("agt");
    const wallet: WalletSummary = {
      id: newId("wal"),
      kind: "agent",
      label: `${String(body.name).trim()}'s wallet`,
      address: fakeAddress(),
      agentId,
      policy: null,
      policyHash: null,
      lifecycle: { state: "active", destroyAfter: null },
    };
    const token = `osa_${randomToken(32)}`;
    const agent = {
      id: agentId,
      name: String(body.name).trim(),
      status: "active" as const,
      walletId: wallet.id,
      tokenPrefix: token.slice(0, 10),
      createdAt: now(),
      lastSeenAt: null,
    };
    workspace.agents.push(agent);
    workspace.wallets.push(wallet);
    state.tokens.set(token, agentId);
    audit(workspace, userActor(id), "agent.created", { type: "agent", id: agentId });
    decide(workspace, null, "create_wallet", null);
    return { agent, wallet, token, mcpUrl: `${origin}/mcp` };
  },
  rotateAgentToken: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const agent = workspace.agents.find((item) => item.id === params.agentId);
    if (!agent) throw new Refusal("not_found", "This agent does not exist.");
    for (const [token, owner] of state.tokens) if (owner === agent.id) state.tokens.delete(token);
    const token = `osa_${randomToken(32)}`;
    state.tokens.set(token, agent.id);
    agent.tokenPrefix = token.slice(0, 10);
    return { token };
  },
  disableAgent: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const agent = workspace.agents.find((item) => item.id === params.agentId);
    if (!agent) throw new Refusal("not_found", "This agent does not exist.");
    agent.status = "disabled";
    // Mirrors the server: removing an agent cancels its waiting grants and payment requests, and
    // revokes its mandates.
    for (const approval of state.approvals.values()) {
      const { summary, envelope, subject } = approval;
      if (summary.status !== "pending") continue;
      if (
        (envelope.type === "grant-mandate" && envelope.agentId === agent.id) ||
        (subject.kind === "approve-intent" && subject.intent.agent.id === agent.id)
      ) {
        cancelApproval(approval);
      }
    }
    for (const record of state.mandates.values()) {
      if (record.agent.id === agent.id) endMandate(record, "agent_disabled");
    }
    return agent;
  },
  createTreasury: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    if (workspace.wallets.some((item) => item.kind === "treasury"))
      throw new Refusal("conflict", "This workspace already has a treasury.");
    const wallet: WalletSummary = {
      id: newId("wal"),
      kind: "treasury",
      label: String(body.label).trim(),
      address: fakeAddress(),
      agentId: null,
      policy: null,
      policyHash: null,
      lifecycle: { state: "active", destroyAfter: null },
    };
    workspace.wallets.push(wallet);
    return wallet;
  },
  getWallet: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    const pending = [...state.approvals.values()].find(
      (item) =>
        item.summary.status === "pending" &&
        item.subject.kind === "set-policy" &&
        item.subject.wallet.id === wallet.id,
    );
    const venue = venueAccountOf(wallet);
    return {
      ...wallet,
      balances: BALANCES,
      // EVM only, as the signer's `spent`: a venue's count is in `venue`.
      spent: [...state.spent]
        .filter(([key]) => key.startsWith(`${wallet.id}|eip155:`))
        .map(([key, amount]) => {
          const [, chainId, asset] = key.split("|");
          return { chainId, asset, amount: amount.toString() };
        }),
      pendingPolicyApprovalId: pending?.summary.id ?? null,
      ...(venue === null ? {} : { venue }),
    };
  },
  requestPolicy: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    if (wallet.lifecycle.state === "retiring" || wallet.lifecycle.state === "destroyed") {
      throw new Refusal("conflict", "This wallet is retired: its limits cannot change.");
    }
    const draft = body.draft as PolicyDraft;
    // Mirrors the server: more approvals per payment than for admin changes would be undone by
    // anyone who can change the limits.
    if (draft.approvals.threshold > workspace.adminThreshold) {
      throw new Refusal(
        "invalid_request",
        `Approvals needed per payment can be at most ${workspace.adminThreshold}, the number needed for admin changes.`,
      );
    }
    // Mirrors the server: mainnet venue support waits on its owner's decision.
    if (draft.venues?.hyperliquid?.network === "hyperliquid:mainnet") {
      throw new Refusal(
        "invalid_request",
        "Hyperliquid mainnet is not allowed on this server.",
        "venue_not_allowed",
      );
    }
    let proposed: WalletPolicy;
    try {
      proposed = policyFromDraft(workspace, wallet, draft);
    } catch {
      throw new Refusal("invalid_request", "These limits are not valid.");
    }
    const hash = policyHash(proposed);
    return openApproval({
      workspace,
      kind: "set-policy",
      title: `Change the limits of ${wallet.label}`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: { walletId: wallet.id, policyHash: hash, previousPolicyHash: wallet.policyHash },
      subject: { kind: "set-policy", wallet: { ...wallet }, current: wallet.policy, proposed },
      apply: () => {
        wallet.policy = proposed;
        wallet.policyHash = hash;
        // Mirrors the signer: new limits let a wallet stopped after a cancelled retirement sign.
        if (wallet.lifecycle.state === "held") {
          wallet.lifecycle = { state: "active", destroyAfter: null };
        }
        decide(workspace, null, "set_policy", null);
      },
    }).summary;
  },
  requestSweep: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    const asset = body.asset as Sweep["asset"];
    const to = body.to as Sweep["to"];
    // Mirrors the server, with the balances `getWallet` reports: all of a token, or the native
    // coin less the fee ceiling.
    const maxFeeWei = 1_000_000_000_000_000n;
    const native = asset === "native";
    const amount = native ? 1_250_000_000_000_000_000n - maxFeeWei : 420_000_000n;
    const sweep: Sweep = {
      v: 1,
      workspaceId: workspace.id as Sweep["workspaceId"],
      walletId: wallet.id,
      chainId: body.chainId as Sweep["chainId"],
      asset,
      amount: amount.toString(),
      to,
      maxFeeWei: maxFeeWei.toString(),
    };
    const hash = sweepHash(sweep);
    const recipients = wallet.policy?.recipients;
    const destination =
      recipients?.mode === "allowlist" && recipients.addresses.includes(to)
        ? ("allowlist" as const)
        : workspace.wallets.some(
              (item) => item.kind === "treasury" && item.id !== wallet.id && item.address === to,
            )
          ? ("treasury" as const)
          : null;
    const subject: Extract<ApprovalSubject, { kind: "sweep-wallet" }> = {
      kind: "sweep-wallet",
      wallet: { ...wallet },
      sweep,
      sweepHash: hash,
      assetSymbol: native ? "ETH" : "USDC",
      assetDecimals: native ? 18 : 6,
      destination,
      transaction: null,
    };
    const approval = openApproval({
      workspace,
      kind: "sweep-wallet",
      title: `Empty ${formatAmount(sweep.amount, subject.assetDecimals)} ${subject.assetSymbol} from the wallet to ${short(to)}`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: { walletId: wallet.id, chainId: sweep.chainId, sweepHash: hash },
      subject,
      apply: () => {
        // Mirrors the signer: it sends a sweep only to the treasury or an allowed recipient.
        if (destination === null) {
          approval.summary.status = "failed";
          approval.summary.failureCode = "sweep_destination_not_allowed";
          decide(workspace, approval.summary.id, "sweep", "sweep_destination_not_allowed");
          return;
        }
        // A sweep is mined at once here; it can be cancelled, never sped up.
        subject.transaction = minedTransaction(sentTransaction(sweep.chainId));
        decide(workspace, approval.summary.id, "sweep", null);
      },
    });
    return approval.summary;
  },
  requestRetireWallet: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    if (wallet.lifecycle.state === "retiring" || wallet.lifecycle.state === "destroyed") {
      throw new Refusal("conflict", "This wallet is already being retired or retired.");
    }
    if (waitingLifecycle(workspace, wallet.id)) {
      throw new Refusal("conflict", "A request to retire this wallet already waits.");
    }
    const destroyAfter = Number(body.destroyAfter);
    checkDestroyAfter(destroyAfter);
    const approval = openApproval({
      workspace,
      kind: "retire-wallet",
      title: `Retire ${wallet.label} and destroy its key`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: { wallet: { walletId: wallet.id, address: wallet.address }, destroyAfter },
      subject: { kind: "retire-wallet", wallet: { ...wallet }, destroyAfter },
      apply: () => {
        wallet.lifecycle = { state: "retiring", destroyAfter };
        endAuthority(workspace, wallet.id, approval.summary.id);
        audit(workspace, userActor(id), "wallet.retiring", { type: "wallet", id: wallet.id });
        decide(workspace, approval.summary.id, "retire-wallet", null);
      },
    });
    return approval.summary;
  },
  cancelRetireWallet: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Viewers cannot cancel a retirement.");
    }
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    if (workspace.lifecycle.state !== "active") {
      throw new Refusal("conflict", "The workspace is being deleted: cancel that instead.");
    }
    const waiting = waitingLifecycle(workspace, wallet.id);
    if (waiting) {
      cancelApproval(waiting);
    } else if (wallet.lifecycle.state === "retiring") {
      // The key stays; the wallet signs nothing until new limits are approved.
      wallet.lifecycle = { state: "held", destroyAfter: null };
      audit(workspace, userActor(id), "wallet.retire_cancelled", { type: "wallet", id: wallet.id });
      decide(workspace, null, "cancel-retire-wallet", null);
    } else {
      throw new Refusal("conflict", "Nothing is waiting to retire this wallet.");
    }
    return wallet;
  },
  proposeMandate: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    const draft = body as MandateDraft;
    const agent = workspace.agents.find((item) => item.id === draft.agentId);
    if (!agent) throw new Refusal("invalid_request", "agentId: not an agent of this workspace");
    if (agent.status !== "active") throw new Refusal("conflict", "This agent is disabled.");
    if (wallet.id !== agent.walletId && wallet.kind !== "treasury") {
      throw new Refusal("invalid_request", "agentId: this agent cannot propose from this wallet");
    }
    if (!wallet.policy) {
      throw new Refusal(
        "policy_denied",
        "This wallet has no approved policy yet.",
        "policy_missing",
      );
    }
    let mandate: Mandate;
    try {
      mandate = normalizeMandate({
        ...draft,
        v: 1,
        id: newId("mnd"),
        workspaceId: workspace.id as Mandate["workspaceId"],
        walletId: wallet.id,
        notBefore: now(),
      });
    } catch {
      throw new Refusal("invalid_request", "This mandate is not valid.");
    }
    // Mirrors the server: checked against the policy and the longest life (7 days) first.
    const refusal = checkMandateAgainstPolicy(mandate, wallet.policy, {
      now: now(),
      maxSeconds: MANDATE_LONGEST_SECONDS,
    });
    if (refusal !== null) {
      throw new Refusal(
        "invalid_request",
        "The wallet's policy or the longest mandate life refuses this mandate.",
        refusal,
      );
    }
    const hash = mandateHash(mandate);
    const payments = mandate.maxUses === 1 ? "1 payment" : `${mandate.maxUses} payments`;
    const approval = openApproval({
      workspace,
      kind: "grant-mandate",
      title: `Let ${agent.name} make up to ${payments} from ${wallet.label} without asking`,
      requestedBy: {
        type: "user",
        id: id as Member["user"]["id"],
        name: state.users.get(id) ?? "",
      },
      threshold: workspace.adminThreshold,
      ttl: 3600,
      envelope: {
        mandateId: mandate.id,
        walletId: wallet.id,
        agentId: agent.id,
        mandateHash: hash,
      },
      subject: {
        kind: "grant-mandate",
        wallet: { ...wallet },
        agent: { id: agent.id, name: agent.name },
        mandate,
        mandateHash: hash,
        assets: mandateAssets(mandate, wallet.policy),
        usage: null,
      },
      apply: () => {
        // Mirrors the signer, which decides again with its own policy, clock and records.
        const fail = (code: string) => {
          approval.summary.status = "failed";
          approval.summary.failureCode = code;
          decide(workspace, approval.summary.id, "grant-mandate", code);
        };
        if (agent.status !== "active") return fail("agent_disabled");
        if (workspace.paused) return fail("workspace_paused");
        const policy = wallet.policy;
        if (!policy) return fail("policy_missing");
        const refused = checkMandateAgainstPolicy(mandate, policy, {
          now: now(),
          maxSeconds: MANDATE_LONGEST_SECONDS,
        });
        if (refused !== null) return fail(refused);
        const live = [...state.mandates.values()].filter((record) => {
          if (record.mandate.walletId !== wallet.id) return false;
          const status = mandateStatus(record);
          return status === "active" || status === "not_yet_valid";
        });
        if (live.length >= LIVE_MANDATES_PER_WALLET) return fail("too_many_live_mandates");
        state.mandates.set(mandate.id, {
          workspaceId: workspace.id,
          agent: { id: agent.id, name: agent.name },
          mandate,
          grantApprovalId: approval.summary.id,
          grantedAt: now(),
          grantedBy: approval.approvedBy.map((user) => user.id),
          revokedAt: null,
          endedReason: null,
          uses: [],
        });
        decide(workspace, approval.summary.id, "grant-mandate", null);
        audit(workspace, { type: "system", id: null, name: null }, "mandate.granted", {
          type: "mandate",
          id: mandate.id,
        });
      },
    });
    return approval.summary;
  },
  listMandates: ({ params, query, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const items = [...state.mandates.values()]
      .filter((record) => record.workspaceId === workspace.id)
      .map(mandateSummary)
      .filter(
        (item) =>
          (query.walletId === undefined || item.walletId === query.walletId) &&
          (query.agentId === undefined || item.agent.id === query.agentId) &&
          (query.status === undefined ||
            (query.status === "active") === (item.endedReason === null)),
      )
      .sort((a, b) => b.grantedAt - a.grantedAt || (a.id < b.id ? 1 : -1));
    return { items, nextCursor: null };
  },
  getMandate: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const record = state.mandates.get(params.mandateId ?? "");
    if (!record || record.workspaceId !== workspace.id) {
      throw new Refusal("not_found", "This mandate does not exist.");
    }
    const intents = [...state.intents.values()]
      .filter((item) => item.mandateId === record.mandate.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => {
        const {
          intent: _intent,
          intentHash: _hash,
          simulation: _sim,
          transaction: _tx,
          ...summary
        } = stripIntent(item);
        return summary;
      });
    return { ...mandateSummary(record), intents, intentsCursor: null };
  },
  revokeMandate: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Only an owner or an approver can do this.");
    }
    const record = state.mandates.get(params.mandateId ?? "");
    if (!record || record.workspaceId !== workspace.id) {
      throw new Refusal("not_found", "This mandate does not exist.");
    }
    if (record.revokedAt === null) {
      endMandate(record, "revoked");
      audit(workspace, userActor(id), "mandate.revoked", {
        type: "mandate",
        id: record.mandate.id,
      });
    }
    return mandateSummary(record);
  },
  listApprovals: ({ params, query, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const listed = [...state.approvals.values()].filter(
      (item) => item.summary.workspaceId === workspace.id,
    );
    for (const item of listed) collect(item);
    const items = listed
      .filter((item) => query.status !== "pending" || item.summary.status === "pending")
      .map((item) => item.summary)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return { items, nextCursor: null };
  },
  getApproval: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    memberOf(workspaceOf(approval.summary.workspaceId), id);
    collect(approval);
    return approvalDetail(approval, id);
  },
  collectApproval: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    memberOf(workspaceOf(approval.summary.workspaceId), id);
    collect(approval);
    return approvalDetail(approval, id);
  },
  reject: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    if (!approvalDetail(approval, id).canDecide)
      throw new Refusal("forbidden", "You cannot reject this request.");
    approval.summary.status = "rejected";
    approval.rejectedBy = userSummary(id);
    if (approval.subject.kind === "approve-intent") {
      const intent = state.intents.get(approval.subject.intent.id);
      if (intent) intent.status = "rejected";
    }
    audit(workspaceOf(approval.summary.workspaceId), userActor(id), "approval.rejected", {
      type: "approval",
      id: approval.summary.id,
    });
    return approvalDetail(approval, id);
  },
  listIntents: ({ params, query, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const items = [...state.intents.values()]
      .filter(
        (item) =>
          item.workspaceId === workspace.id &&
          (query.mandateId === undefined || item.mandateId === query.mandateId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => {
        const {
          intent: _intent,
          intentHash: _hash,
          simulation: _sim,
          transaction: _tx,
          ...summary
        } = stripIntent(item);
        return summary;
      });
    return { items, nextCursor: null };
  },
  getIntent: ({ params, userId }) => {
    signedIn(userId);
    const intent = state.intents.get(params.intentId ?? "");
    if (!intent) throw new Refusal("not_found", "This request does not exist.");
    return stripIntent(intent);
  },
  speedUp: ({ params, userId }) => {
    const id = signedIn(userId);
    const intent = state.intents.get(params.intentId ?? "");
    if (!intent) throw new Refusal("not_found", "This request does not exist.");
    const workspace = workspaceOf(intent.workspaceId);
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Only an owner or an approver can do this.");
    }
    const transaction = intent.transaction;
    if (!transaction || !isSent(transaction)) {
      throw new Refusal(
        "conflict",
        "Only a payment that was sent and is not mined yet can be sped up.",
        "not_repriceable",
      );
    }
    if (workspace.paused) {
      throw new Refusal(
        "conflict",
        "This workspace is paused; a cancel still works.",
        "workspace_paused",
      );
    }
    const reason = transaction.stuckReason;
    if (reason !== null && reason !== "fee_too_low") {
      throw new Refusal("conflict", "A higher fee cannot help this transaction now.", reason);
    }
    // Within 15 seconds of the newest attempt nothing is added: two clicks make one attempt.
    const latest = transaction.attempts[transaction.attempts.length - 1];
    if (latest && now() - latest.signedAt >= 15) {
      intent.transaction = withAttempt(transaction, intent.chainId, "reprice", null);
      intent.transactionHash = intent.transaction.hash;
      state.sentAt.set(intent.id, now());
      audit(workspace, userActor(id), "transaction.repriced", {
        type: "approval",
        id: targetOf(intent) ?? intent.id,
      });
    }
    return stripIntent(intent);
  },
  requestCancel: ({ params, userId }) => {
    const id = signedIn(userId);
    const intent = state.intents.get(params.intentId ?? "");
    if (!intent) throw new Refusal("not_found", "This request does not exist.");
    const workspace = workspaceOf(intent.workspaceId);
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Only an owner or an approver can do this.");
    }
    const target = targetOf(intent);
    if (!intent.transaction || target === null || intent.transaction.status === "signed") {
      throw new Refusal(
        "conflict",
        "Nothing was sent yet, so there is nothing to cancel.",
        "not_sent",
      );
    }
    if (!isSent(intent.transaction)) {
      throw new Refusal(
        "conflict",
        "The transaction is already mined or replaced.",
        "transaction_final",
      );
    }
    return openCancel(workspace, id, {
      target,
      walletId: intent.walletId,
      chainId: intent.chainId,
      title:
        intent.display.kind === "transfer"
          ? `${intent.display.title} to ${short(intent.display.to)}`
          : intent.display.title,
      intent,
      transaction: () => intent.transaction,
      update: (transaction) => {
        intent.transaction = transaction;
        intent.transactionHash = transaction.hash;
        state.sentAt.set(intent.id, now());
      },
    });
  },
  cancelOrder: ({ params, userId }) => {
    const id = signedIn(userId);
    const intent = state.intents.get(params.intentId ?? "");
    if (!intent) throw new Refusal("not_found", "This request does not exist.");
    const workspace = workspaceOf(intent.workspaceId);
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Only an owner or an approver can do this.");
    }
    const order = intent.order;
    if (!order?.canCancel) {
      throw new Refusal(
        "conflict",
        "This order is not resting at the venue, so there is nothing to cancel.",
        "not_cancellable",
      );
    }
    // Approving the order included the right to cancel it: no passkey, also while paused (D4).
    const filled = order.filledSize !== null && order.filledSize !== "0";
    intent.order = { ...order, canCancel: false };
    intent.status = filled ? "partially_filled" : "cancelled";
    decide(workspace, intent.approvalId, "cancel-venue-order", null);
    audit(workspace, userActor(id), "order.cancelled", { type: "intent", id: intent.id });
    return stripIntent(intent);
  },
  requestSweepCancel: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    const workspace = workspaceOf(approval.summary.workspaceId);
    if (memberOf(workspace, id).role === "viewer") {
      throw new Refusal("forbidden", "Only an owner or an approver can do this.");
    }
    const subject = approval.subject;
    if (subject.kind !== "sweep-wallet") throw new Refusal("not_found", "No such sweep.");
    if (!subject.transaction || subject.transaction.status === "signed") {
      throw new Refusal(
        "conflict",
        "Nothing was sent yet, so there is nothing to cancel.",
        "not_sent",
      );
    }
    if (!isSent(subject.transaction)) {
      throw new Refusal(
        "conflict",
        "The transaction is already mined or replaced.",
        "transaction_final",
      );
    }
    return openCancel(workspace, id, {
      target: approval.summary.id,
      walletId: subject.sweep.walletId,
      chainId: subject.sweep.chainId,
      title: approval.summary.title,
      intent: null,
      transaction: () => subject.transaction,
      update: (transaction) => {
        subject.transaction = transaction;
      },
    });
  },
  listAudit: ({ params, query, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    // Newest first, 20 per page; the cursor is the next sequence number to show.
    const start = query.cursor ? Number(query.cursor) : workspace.audit.length;
    const items = workspace.audit.slice(Math.max(0, start - 20), start).reverse();
    const next = start - 20;
    return { items, nextCursor: next > 0 ? String(next) : null };
  },
  verifyAudit: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    let previous: string | null = null;
    for (const event of workspace.audit) {
      const { hash, ...entry } = event;
      if (entry.previousHash !== previous || sha256(JSON.stringify(entry)) !== hash) {
        return { ok: false, checked: event.seq, brokenAt: event.seq };
      }
      previous = hash;
    }
    return { ok: true, checked: workspace.audit.length, brokenAt: null };
  },
  listSignerDecisions: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    return { items: workspace.decisions };
  },
  getPushConfig: () => ({
    enabled: state.webPush,
    applicationServerKey: state.webPush ? PUSH_KEY : null,
  }),
  listPushSubscriptions: ({ userId }) => {
    const id = signedIn(userId);
    return {
      items: [...state.pushSubscriptions.values()]
        .filter((item) => item.userId === id)
        .map((item) => item.summary),
    };
  },
  addPushSubscription: async ({ body, userId }) => {
    const id = signedIn(userId);
    if (!state.webPush)
      throw new Refusal("conflict", "Notifications on devices are off on this server.", "push_off");
    const endpoint = String(body.endpoint);
    if (!pushEndpointAllowed(endpoint))
      throw new Refusal(
        "invalid_request",
        "This push service is not one this server sends to.",
        "endpoint_refused",
      );
    // As the server does: the browser's key must be a point on P-256.
    const keys = body.keys as { p256dh: string };
    const p256dh = new Uint8Array(Buffer.from(keys.p256dh.replace(/=+$/, ""), "base64url"));
    try {
      await crypto.subtle.importKey(
        "raw",
        p256dh,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
    } catch {
      throw new Refusal(
        "invalid_request",
        "The subscription's key is not a P-256 public key.",
        "bad_subscription",
      );
    }
    const label = typeof body.label === "string" ? body.label : null;
    for (const [subscriptionId, item] of state.pushSubscriptions) {
      if (item.endpoint !== endpoint) continue;
      // The same browser again keeps its id; someone else's browser moves to this person.
      if (item.userId === id) {
        item.summary.label = label ?? item.summary.label;
        return item.summary;
      }
      state.pushSubscriptions.delete(subscriptionId);
    }
    const summary: PushSubscriptionSummary = {
      id: newId("psb"),
      label,
      createdAt: now(),
      lastSuccessAt: null,
    };
    state.pushSubscriptions.set(summary.id, { userId: id, endpoint, summary });
    return summary;
  },
  removePushSubscription: ({ params, userId }) => {
    const id = signedIn(userId);
    const item = state.pushSubscriptions.get(params.subscriptionId ?? "");
    if (!item || item.userId !== id) throw new Refusal("not_found", "No such device.");
    state.pushSubscriptions.delete(params.subscriptionId ?? "");
    return {};
  },
  getNotificationPreferences: ({ userId }) => notificationPreferences(signedIn(userId)),
  setNotificationPreferences: ({ body, userId }) => {
    const id = signedIn(userId);
    const input = body as NotificationPreferences;
    for (const item of input.workspaces) memberOf(workspaceOf(item.workspaceId), id);
    for (const item of input.workspaces) {
      state.notificationSwitches.set(`${id} ${item.workspaceId}`, {
        webPush: item.webPush,
        reminders: item.reminders,
      });
    }
    if (input.quietHours === null) state.quietHours.delete(id);
    else state.quietHours.set(id, input.quietHours);
    return notificationPreferences(id);
  },
  setNotificationDetail: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const detail = body.detail as NotificationDetail;
    if (workspace.notificationDetail !== detail) {
      workspace.notificationDetail = detail;
      audit(workspace, userActor(id), "workspace.notification_detail_set", {
        type: "workspace",
        id: workspace.id,
      });
    }
    return workspaceDetail(workspace, id);
  },
  exportTemplate: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    return toTemplate(workspace);
  },
  exportRecord: ({ params, userId, signedInAt }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    requireRecentSignIn(signedInAt);
    audit(workspace, userActor(id), "workspace.exported", { type: "workspace", id: workspace.id });
    const head = (log: { seq: number; hash: string }[]) => {
      const last = log.at(-1);
      return { seq: last?.seq ?? 0, hash: last?.hash ?? null };
    };
    const lines = [
      {
        format: "askgina.os/workspace-record/v1",
        workspaceId: workspace.id,
        exportedAt: now(),
        auditHead: head(workspace.audit),
        signerDecisionHead: head(workspace.decisions),
      },
      ...workspace.audit.map((entry) => ({ type: "audit", ...entry })),
      ...workspace.decisions.map((entry) => ({ type: "signer-decision", ...entry })),
      {
        type: "end",
        counts: {
          audit: workspace.audit.length,
          intent: 0,
          transaction: 0,
          "policy-revision": 0,
          mandate: 0,
          "mandate-use": 0,
          "signer-decision": workspace.decisions.length,
        },
      },
    ];
    return { record: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` };
  },
  cloneWorkspace: (input) => {
    const id = signedIn(input.userId);
    const source = workspaceOf(input.params.workspaceId ?? "");
    requireOwner(source, id);
    return instantiate(toTemplate(source), input.body as CloneOptions, input);
  },
  importTemplate: (input) => {
    signedIn(input.userId);
    const { template, ...options } = input.body as CloneOptions & { template: WorkspaceTemplate };
    const unknown = template.wallets
      .flatMap((wallet) => wallet.policy?.chains ?? [])
      .find((chainId) => !CHAINS.some((chain) => chain.chainId === chainId));
    if (unknown) {
      throw new Refusal("invalid_request", `The network ${unknown} is not configured here.`);
    }
    return instantiate(template, options, input);
  },
};

// --- export and clone -------------------------------------------------------------------------

/**
 * The workspace's configuration as the server exports it: each wallet that is not retiring or
 * destroyed, and not the wallet of a disabled agent, by ref, with its agent's name and its
 * policy, whose requesters point at the kept agents' wallets by ref.
 */
function toTemplate(workspace: Workspace): WorkspaceTemplate {
  const kept = workspace.wallets.filter(
    (wallet) =>
      wallet.lifecycle.state !== "retiring" &&
      wallet.lifecycle.state !== "destroyed" &&
      (wallet.kind === "treasury" ||
        workspace.agents.some((agent) => agent.id === wallet.agentId && agent.status === "active")),
  );
  const refs = new Map<string, string>(kept.map((wallet, index) => [wallet.id, `w${index + 1}`]));
  return {
    format: "askgina.os/workspace-template/v1",
    name: workspace.name,
    adminThreshold: workspace.adminThreshold,
    notificationDetail: workspace.notificationDetail,
    wallets: kept.map((wallet) => {
      const agent = workspace.agents.find((item) => item.id === wallet.agentId);
      const { policy } = wallet;
      return {
        ref: refs.get(wallet.id) ?? "",
        kind: wallet.kind,
        label: wallet.label,
        agent: agent ? { name: agent.name } : null,
        policy: policy
          ? {
              chains: policy.chains,
              requesters: policy.requesters.flatMap((agentId) => {
                const walletId = workspace.agents.find((item) => item.id === agentId)?.walletId;
                return refs.get(walletId ?? "") ?? [];
              }),
              assets: policy.assets,
              recipients: policy.recipients,
              contractCalls: policy.contractCalls,
              fees: policy.fees,
              approvals: policy.approvals,
            }
          : null,
      };
    }),
    members: workspace.members.map((member) => ({ userId: member.user.id, role: member.role })),
  };
}

/**
 * A new workspace from a template, through the same steps a person takes: the person is its only
 * member, every wallet is new, and each policy waits in a `set-policy` request.
 */
function instantiate(
  template: WorkspaceTemplate,
  options: CloneOptions,
  input: Parameters<Handler>[0],
): CloneResult {
  const id = signedIn(input.userId);
  const call = (name: RouteName, params: Record<string, string>, body: Record<string, unknown>) =>
    handlers[name]({ ...input, params, query: {}, body });
  const workspace = call("createWorkspace", {}, { name: options.name }) as WorkspaceDetail;
  const created = workspaceOf(workspace.id);
  created.notificationDetail = template.notificationDetail;
  const agents: CloneResult["agents"] = [];
  const walletOfRef = new Map<string, WalletSummary>();
  const agentOfRef = new Map<string, string>();
  for (const item of template.wallets) {
    if (item.agent !== null) {
      if (!options.includeAgents) continue;
      const made = call(
        "createAgent",
        { workspaceId: workspace.id },
        { name: item.agent.name },
      ) as {
        agent: { id: string };
        wallet: WalletSummary;
        token: string;
        mcpUrl: string;
      };
      agents.push({
        agentId: made.agent.id as CloneResult["agents"][number]["agentId"],
        walletId: made.wallet.id,
        token: made.token,
        mcpUrl: made.mcpUrl,
      });
      agentOfRef.set(item.ref, made.agent.id);
      walletOfRef.set(item.ref, made.wallet);
    } else {
      walletOfRef.set(
        item.ref,
        call(
          "createTreasury",
          { workspaceId: workspace.id },
          { label: item.label },
        ) as WalletSummary,
      );
    }
    const wallet = walletOfRef.get(item.ref);
    if (wallet) wallet.label = item.label;
  }
  const approvals = template.wallets.flatMap((item) => {
    const wallet = walletOfRef.get(item.ref);
    if (!wallet || !item.policy) return [];
    const draft = {
      ...item.policy,
      requesters: item.policy.requesters.flatMap((ref) => agentOfRef.get(ref) ?? []),
      // A new workspace has one approver, so nothing may need more approvals than that yet.
      approvals: { ...item.policy.approvals, threshold: 1 },
    };
    return [
      call(
        "requestPolicy",
        { workspaceId: workspace.id, walletId: wallet.id },
        { draft },
      ) as ApprovalSummary,
    ];
  });
  const invites = options.includeMembers
    ? template.members.flatMap((member) => {
        if (member.userId === id || !state.users.has(member.userId)) return [];
        const invite = call(
          "createInvite",
          { workspaceId: workspace.id },
          { role: member.role },
        ) as { url: string; expiresAt: number };
        return [
          {
            userId: member.userId,
            displayName: state.users.get(member.userId) ?? "",
            role: member.role,
            url: invite.url,
            expiresAt: invite.expiresAt,
          },
        ];
      })
    : [];
  audit(created, userActor(id), "workspace.cloned", { type: "workspace", id: created.id });
  return {
    workspace: workspaceDetail(created, id),
    approvals,
    agents,
    invites,
    templateAdminThreshold: template.adminThreshold,
  };
}

function joinWorkspace(token: string, userId: string): string {
  const invite = state.invites.get(token);
  if (!invite || invite.expiresAt < now())
    throw new Refusal("not_found", "This invite link is not valid.");
  state.invites.delete(token);
  const workspace = workspaceOf(invite.workspaceId);
  if (!workspace.members.some((member) => member.user.id === userId)) {
    workspace.members.push({
      user: userSummary(userId),
      role: invite.role,
      approver: invite.role === "viewer" ? "none" : "pending",
      joinedAt: now(),
      pendingPasskeys: [],
    });
    if (invite.role !== "viewer")
      approverApprovals(workspace, userId, "add-approver", invite.invitedBy);
  }
  return workspace.id;
}

// --- HTTP -------------------------------------------------------------------------------------

const compiled = Object.entries(routes).map(([name, route]) => {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${route.path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}$`,
  );
  return { name: name as RouteName, route, pattern, keys };
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

function send(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`;
  try {
    if (url.pathname === "/__fixture/reset" && req.method === "POST") {
      state = freshState();
      return send(res, 200, { ok: true, setupToken: SETUP_TOKEN });
    }
    // Lets a test turn Web Push off or on, as the operator does with `WEB_PUSH_ENABLED`.
    if (url.pathname === "/__fixture/web-push" && req.method === "POST") {
      const input = (await readBody(req)) as { enabled?: unknown };
      if (typeof input.enabled !== "boolean")
        throw new Refusal("invalid_request", "enabled must be true or false.");
      state.webPush = input.enabled;
      return send(res, 200, { ok: true });
    }
    // Lets a test put a sent payment into a chain outcome the fixture never reaches by itself.
    if (url.pathname === "/__fixture/settle" && req.method === "POST") {
      const input = (await readBody(req)) as { intentId?: string; status?: string };
      const intent = state.intents.get(input.intentId ?? "");
      if (!intent?.transaction)
        throw new Refusal("not_found", "No sent transaction for this intent.");
      if (input.status === "stuck") {
        // Stuck means it waited a while: its attempts are dated back by the server's default
        // `REPRICE_AFTER_SECONDS` (180), so a speed-up adds an attempt at once, and nothing of
        // it is mined, whatever the fixture had settled before.
        const attempts = intent.transaction.attempts.map((attempt) => ({
          ...attempt,
          status: "pending" as const,
          signedAt: attempt.signedAt - 180,
        }));
        const newest = attempts[attempts.length - 1];
        if (!newest) throw new Error("a transaction without its first attempt");
        intent.status = "stuck";
        intent.failureCode = null;
        intent.transactionHash = newest.hash;
        intent.transaction = {
          ...intent.transaction,
          status: "stuck",
          stuckReason: "fee_too_low",
          hash: newest.hash,
          explorerUrl: newest.explorerUrl,
          blockNumber: null,
          minedAttempt: null,
          attempts,
        };
        // Stays unmined until a speed-up or a cancel offers another attempt.
        state.sentAt.delete(intent.id);
      } else if (input.status === "rejected") {
        intent.status = "failed";
        intent.failureCode = "rejected";
        intent.transaction = { ...intent.transaction, status: "rejected" };
      } else {
        throw new Refusal("invalid_request", "status must be stuck or rejected.");
      }
      return send(res, 200, { ok: true });
    }
    // Lets a test skip a retirement's or deletion's delay: it is due now, and the next request
    // finishes it.
    if (url.pathname === "/__fixture/due" && req.method === "POST") {
      const input = (await readBody(req)) as { workspaceId?: string; walletId?: string };
      const workspace = workspaceOf(input.workspaceId ?? "");
      const wallet = workspace.wallets.find((item) => item.id === input.walletId);
      if (input.walletId === undefined && workspace.lifecycle.state === "deleting") {
        workspace.lifecycle = { ...workspace.lifecycle, destroyAfter: now() };
      } else if (wallet?.lifecycle.state === "retiring") {
        wallet.lifecycle = { state: "retiring", destroyAfter: now() };
      } else {
        throw new Refusal("conflict", "Nothing of this is being retired or deleted.");
      }
      return send(res, 200, { ok: true });
    }
    // Lets a test make every sign-in older than the 300 seconds the record and erasure need.
    if (url.pathname === "/__fixture/stale-sign-in" && req.method === "POST") {
      for (const [token, at] of state.signedInAt) state.signedInAt.set(token, at - 301);
      return send(res, 200, { ok: true });
    }
    const proposeMatch = /^\/__fixture\/propose$/.exec(url.pathname);
    if (proposeMatch && req.method === "POST") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      return send(res, 200, propose(token, (await readBody(req)) as Record<string, string>));
    }
    if (!url.pathname.startsWith("/api/"))
      throw new Refusal(
        "not_found",
        "The fixture serves only the API; the UI comes from the Vite dev server.",
      );

    expireApprovals();
    advanceTransactions();
    finalizeDue();
    const match = compiled.find(
      (item) => item.route.method === req.method && item.pattern.test(url.pathname),
    );
    if (!match) throw new Refusal("not_found", "No such endpoint.");
    const values = match.pattern.exec(url.pathname)?.slice(1) ?? [];
    const params = Object.fromEntries(
      match.keys.map((key, index) => [key, decodeURIComponent(values[index] ?? "")]),
    );
    const query = Object.fromEntries(url.searchParams);
    let body: Record<string, unknown> = {};
    if (match.route.body) {
      const parsed = match.route.body.safeParse(await readBody(req));
      if (!parsed.success)
        throw new Refusal(
          "invalid_request",
          "The request is not valid.",
          parsed.error.issues[0]?.message,
        );
      body = parsed.data as Record<string, unknown>;
    }
    const cookie = /fixture_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const userId = cookie ? (state.sessions.get(cookie) ?? null) : null;
    const signedInAt = cookie ? (state.signedInAt.get(cookie) ?? null) : null;
    if (match.route.auth === "session" && !userId)
      throw new Refusal("unauthenticated", "Sign in first.");
    const deleting = state.workspaces.get(params.workspaceId ?? "")?.lifecycle.state === "deleting";
    if (deleting && match.route.method !== "GET" && !ALLOWED_WHILE_DELETING[match.name]) {
      throw new Refusal("conflict", "This workspace is being deleted. Cancel the deletion first.");
    }
    const output = await handlers[match.name]({
      params,
      query,
      body,
      userId,
      signedInAt,
      res,
      origin,
    });
    // Fails loudly (500) when the fixture drifts from the contract.
    send(res, 200, match.route.response.parse(output));
  } catch (error) {
    if (error instanceof Refusal) {
      return send(res, status[error.code], {
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
        },
      });
    }
    process.stderr.write(
      `${JSON.stringify({ event: "fixture.error", path: url.pathname, error: String(error) })}\n`,
    );
    send(res, 500, { error: { code: "internal", message: "The fixture failed; see its log." } });
  }
});

// --- the stand-in confirmation page, on its own origin -----------------------------------------

const confirmFiles: Record<string, { type: string; body: Buffer }> = {
  "/confirm.js": {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(new URL("./confirm/confirm.js", import.meta.url)),
  },
  "/confirm.css": {
    type: "text/css; charset=utf-8",
    body: readFileSync(new URL("./confirm/confirm.css", import.meta.url)),
  },
  "/favicon.svg": {
    type: "image/svg+xml",
    body: readFileSync(new URL("../public/favicon.svg", import.meta.url)),
  },
};
const confirmHtml = readFileSync(new URL("./confirm/index.html", import.meta.url));

/** Like the real page's: nothing inline, nothing from elsewhere, no framing. */
const CONFIRM_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The request in words, from the fixture's own records, as the signer's view would show it. */
function confirmationLines(approval: Approval): { label: string; value: string }[] {
  const subject = approval.subject;
  switch (subject.kind) {
    case "approve-intent": {
      const { display, chainId } = subject.intent;
      if (display.kind === "order") {
        const venue = subject.venue;
        const tif = {
          Alo: "add liquidity only",
          Gtc: "good till cancelled",
          Ioc: "immediate or cancel",
        };
        return [
          { label: "Market", value: `${display.coin} perpetual, as named in the wallet's policy` },
          { label: "Market index", value: String(display.asset) },
          { label: "Side", value: display.side },
          { label: "Size", value: `${display.size} ${display.coin}` },
          { label: "Limit price", value: `${display.limitPrice} USD` },
          { label: "Notional at the limit price", value: `${display.notionalUsd} USD` },
          { label: "Time in force", value: tif[display.timeInForce] },
          {
            label: "Reduce-only",
            value: display.reduceOnly ? "yes: it can only make a position smaller" : "no",
          },
          { label: "Cancelling", value: "the agent may cancel this order without asking again" },
          {
            label: "Submit window",
            value: `must reach the venue within ${venue?.submitWindowSeconds ?? 0} seconds of signing`,
          },
          {
            label: "Funds at the venue",
            value: "held by Hyperliquid; these caps limit new orders, not losses",
          },
          { label: "Network", value: `Hyperliquid testnet (${chainId})` },
          { label: "From wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
          { label: "Agent", value: subject.intent.agent.name },
          { label: "The agent's note", value: subject.intent.memo || "(none)" },
        ];
      }
      return [
        { label: "Amount", value: `${display.amountFormatted} ${display.assetSymbol}` },
        { label: display.rawCall ? "Contract" : "Recipient", value: display.to },
        { label: "From wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
        {
          label: "Network",
          value: CHAINS.find((chain) => chain.chainId === chainId)?.name ?? chainId,
        },
        { label: "Agent", value: subject.intent.agent.name },
        { label: "The agent's note", value: subject.intent.memo || "(none)" },
      ];
    }
    case "sweep-wallet":
      return [
        {
          label: "Amount",
          value: `${formatAmount(subject.sweep.amount, subject.assetDecimals)} ${subject.assetSymbol}`,
        },
        { label: "Recipient", value: subject.sweep.to },
        { label: "From wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
        {
          label: "Network",
          value:
            CHAINS.find((chain) => chain.chainId === subject.sweep.chainId)?.name ??
            subject.sweep.chainId,
        },
      ];
    case "set-policy": {
      const rules = subject.proposed.venues?.hyperliquid;
      return [
        { label: "Wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
        { label: "Policy revision", value: String(subject.proposed.revision) },
        { label: "Approvals per payment", value: String(subject.proposed.approvals.threshold) },
        ...(rules
          ? [
              ...rules.markets.map((market) => ({
                label: "Market allowed",
                value: `${market.coin} (index ${market.asset}): up to ${formatAmount(market.maxNotionalPerOrderUsd6, 6)} USD per order`,
              })),
              {
                label: "Hyperliquid notional per 24 hours",
                value: `${formatAmount(rules.maxNotionalPerDayUsd6, 6)} USD`,
              },
              {
                label: "Funds at the venue",
                value: "held by Hyperliquid; these caps limit new orders, not losses",
              },
            ]
          : []),
      ];
    }
    case "add-approver": {
      const envelope = approval.envelope;
      return [
        { label: "Person", value: subject.user.displayName },
        { label: "Passkey", value: subject.passkeyLabel },
        {
          label: "Key fingerprint",
          value: envelope.type === "add-approver" ? keyFingerprint(envelope.publicKey) : "",
        },
        {
          label: "The new person proved they hold this passkey",
          value: approval.possessionProven ? "yes" : "no",
        },
      ];
    }
    case "remove-approver":
      return [
        { label: "Person", value: subject.user.displayName },
        { label: "Passkey", value: subject.passkeyLabel },
      ];
    case "set-admin-threshold":
      return [
        { label: "Approvals needed now", value: String(subject.current) },
        { label: "After", value: String(subject.proposed) },
      ];
    case "resume-workspace":
      return [{ label: "Workspace", value: workspaceOf(approval.summary.workspaceId).name }];
    case "cancel-transaction": {
      const display = subject.intent?.display;
      const stops =
        display?.kind === "transfer"
          ? `${display.amountFormatted} ${display.assetSymbol} to ${display.to}`
          : (display?.title ?? subject.sweep?.title ?? "");
      return [
        { label: "Stop this transaction", value: stops },
        { label: "From wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
        { label: "Account nonce", value: String(subject.txNonce) },
        { label: "Attempts so far", value: String(subject.transaction.attempts.length) },
        { label: "Most it may cost in fees", value: `${formatAmount(subject.maxFeeWei, 18)} ETH` },
      ];
    }
    case "grant-mandate": {
      const { mandate } = subject;
      const hours = mandate.windowSeconds / 3600;
      const caps = mandate.assets.flatMap((limit) => {
        const { symbol, decimals } = knownAsset(limit.asset);
        const amount = (value: string) =>
          decimals === null ? `${value} base units` : `${formatAmount(value, decimals)} ${symbol}`;
        const worst = mandateWorstCase({ ...mandate, assets: [limit] })[0]?.amount ?? 0n;
        return [
          { label: "Asset", value: `${symbol ?? limit.asset} on ${limit.chainId}` },
          { label: "Most per payment", value: amount(limit.maxPerAction) },
          { label: `Most in any ${hours} hours`, value: amount(limit.maxPerWindow) },
          { label: "Most in total", value: amount(limit.maxTotal) },
          { label: "Most that can leave the wallet", value: amount(worst.toString()) },
        ];
      });
      return [
        { label: "Agent that may pay", value: subject.agent.name },
        { label: "From wallet", value: `${subject.wallet.label} ${subject.wallet.address}` },
        ...caps,
        ...mandate.recipients.map((to) => ({ label: "May pay", value: to })),
        { label: "Payments at most", value: String(mandate.maxUses) },
        {
          label: "Network fee ceiling per payment",
          value: `${formatAmount(mandate.maxFeePerActionWei, 18)} of the native coin`,
        },
        { label: "Starts", value: new Date(mandate.notBefore * 1000).toISOString() },
        { label: "Ends", value: new Date(mandate.notAfter * 1000).toISOString() },
        { label: "Their purpose", value: mandate.purpose || "(none)" },
      ];
    }
    case "retire-wallet":
    case "delete-workspace": {
      const wallets = subject.kind === "retire-wallet" ? [subject.wallet] : subject.wallets;
      const after = new Date(subject.destroyAfter * 1000).toISOString();
      return [
        ...(subject.kind === "delete-workspace"
          ? [{ label: "Wallets", value: String(wallets.length) }]
          : []),
        ...wallets.flatMap((wallet) => [
          { label: "Wallet address", value: wallet.address },
          { label: "Wallet name (not checked)", value: wallet.label },
        ]),
        {
          label: subject.kind === "retire-wallet" ? "Key destroyed after" : "Keys destroyed after",
          value: after,
        },
        {
          label: "Time to cancel",
          value: `${Math.round((subject.destroyAfter - approval.summary.createdAt) / 86_400)} days from the request`,
        },
      ];
    }
  }
}

/**
 * The signer's own title for a request: its words, not the control plane's. The fixture keeps
 * the control plane's title except where the signer's view names the request itself.
 */
function confirmationTitle(approval: Approval): string {
  switch (approval.subject.kind) {
    case "retire-wallet":
      return "Retire a wallet";
    case "delete-workspace":
      return "Delete this workspace";
    default:
      return approval.summary.title;
  }
}

/** The warnings the signer's page shows first, in its words (`apps/approve`'s `WARNING_TEXT`). */
function confirmationWarnings(approval: Approval): string[] {
  const subject = approval.subject;
  const destroys =
    subject.kind === "retire-wallet" ||
    (subject.kind === "delete-workspace" && subject.wallets.length > 0);
  return destroys
    ? [
        "After the time below the signer destroys the keys of the wallets listed. Whatever is still in them then is lost for good, and nobody can get it back.",
        "The signer cannot see balances: nothing on this page shows whether these wallets are empty. Check them where you were asked to approve, and empty them first.",
      ]
    : [];
}

/** Whose passkeys may approve here: the workspace's active approvers. */
function approverOf(approval: Approval, credentialUserId: string): boolean {
  return workspaceOf(approval.summary.workspaceId).members.some(
    (member) =>
      member.user.id === credentialUserId &&
      member.role !== "viewer" &&
      member.approver === "active",
  );
}

function confirmationView(approval: Approval) {
  const { id, workspaceId, status, threshold } = approval.summary;
  return {
    approvalId: id,
    title: confirmationTitle(approval),
    warnings: confirmationWarnings(approval),
    lines: confirmationLines(approval),
    state:
      status !== "pending" ? "closed" : approval.atSigner.length >= threshold ? "complete" : "open",
    approvals: { collected: approval.atSigner.length, required: threshold },
    possession:
      approval.envelope.type !== "add-approver"
        ? "none"
        : approval.possessionProven
          ? "proven"
          : "unproven",
    webauthn: {
      challenge: approval.challenge,
      rpId: "localhost",
      allowCredentials: [...state.credentials]
        .filter(([, credential]) => approverOf(approval, credential.userId))
        .map(([credentialId]) => credentialId),
      userVerification: "required",
      timeoutMs: 60_000,
    },
    returnUrl: `${RETURN_ORIGIN}/w/${workspaceId}/approvals/${id}`,
  };
}

/** The request behind a confirmation link; a wrong or missing token finds nothing. */
function confirmationFor(approvalId: string, token: string | string[] | undefined): Approval {
  const approval = state.approvals.get(approvalId);
  if (!approval || approval.confirmToken === null || token !== approval.confirmToken) {
    throw new Refusal("not_found", "This confirmation link is not valid.");
  }
  return approval;
}

/** Whether a passkey answer was made on this page, top level, for `challenge`. */
function madeHere(response: AssertionResponse, challenge: string | null): boolean {
  const data = clientData(response);
  return (
    challenge !== null &&
    data.type === "webauthn.get" &&
    data.challenge === challenge &&
    data.origin === CONFIRM_ORIGIN &&
    data.crossOrigin !== true
  );
}

function passkeyAnswer(body: unknown): AssertionResponse {
  const parsed = z.strictObject({ response: AssertionResponse }).safeParse(body);
  if (!parsed.success) throw new Refusal("invalid_request", "The passkey response is not valid.");
  return parsed.data.response;
}

/** The approver change behind a possession step, while it still waits for approval. */
function possessionOf(approval: Approval) {
  const envelope = approval.envelope;
  if (envelope.type !== "add-approver") {
    throw new Refusal("not_found", "Only an approver change has this step.");
  }
  if (approval.summary.status !== "pending") {
    throw new Refusal("conflict", "This request no longer waits for approval.");
  }
  return envelope;
}

/**
 * The possession step's challenge, which only the new passkey may answer: one per request, kept
 * until an answer uses it, as the signer keeps it.
 */
function possessionRequest(approval: Approval) {
  const envelope = possessionOf(approval);
  approval.possessionChallenge ??= randomToken(32);
  return {
    rpId: "localhost",
    challenge: approval.possessionChallenge,
    allowCredentials: [envelope.credentialId],
    userVerification: "required",
    timeoutMs: 60_000,
  };
}

/**
 * Records that the person being added holds the new passkey: an answer made on this page, top
 * level, to the step's challenge, by the envelope's own credential. The fixture checks no
 * signature. Returns the key's fingerprint for that person to read out.
 */
function provePossession(approval: Approval, body: unknown) {
  const envelope = possessionOf(approval);
  const response = passkeyAnswer(body);
  if (!madeHere(response, approval.possessionChallenge) || response.id !== envelope.credentialId) {
    throw new Refusal(
      "invalid_request",
      "This answer was not made on this page with the new passkey.",
    );
  }
  approval.possessionChallenge = null;
  approval.possessionProven = true;
  return { fingerprint: keyFingerprint(envelope.publicKey) };
}

/**
 * Holds one person's approval, as the signer does: made on this origin, top level, for this
 * request's challenge, with a passkey of an active approver who has not approved it yet. An
 * approver change also waits for its possession step.
 */
function holdApproval(approval: Approval, body: unknown) {
  const response = passkeyAnswer(body);
  const { threshold } = approval.summary;
  if (approval.summary.status !== "pending" || approval.atSigner.length >= threshold) {
    throw new Refusal("conflict", "This request no longer waits for approval.");
  }
  if (approval.envelope.type === "add-approver" && !approval.possessionProven) {
    throw new Refusal(
      "possession_unproven",
      "The person being added has not yet proven on this page that the new passkey is theirs.",
    );
  }
  if (!madeHere(response, approval.challenge)) {
    throw new Refusal(
      "invalid_request",
      "This approval was not made on this page for this request.",
    );
  }
  const userId = state.credentials.get(response.id)?.userId;
  if (!userId || !approverOf(approval, userId)) {
    throw new Refusal("forbidden", "This passkey does not approve for this workspace.");
  }
  if (approval.atSigner.includes(userId)) {
    throw new Refusal("conflict", "You approved this request already.");
  }
  approval.atSigner.push(userId);
  return {
    collected: approval.atSigner.length,
    required: threshold,
    returnUrl: confirmationView(approval).returnUrl,
  };
}

const confirmServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", CONFIRM_ORIGIN);
  const reply = (code: number, type: string, body: string | Buffer) => {
    res.writeHead(code, {
      "content-type": type,
      "cache-control": "no-store",
      "content-security-policy": CONFIRM_CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    res.end(body);
  };
  const json = "application/json";
  try {
    expireApprovals();
    const file = confirmFiles[url.pathname];
    if (req.method === "GET" && file) return reply(200, file.type, file.body);
    if (req.method === "GET" && /^\/a\/apr_[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return reply(200, "text/html; charset=utf-8", confirmHtml);
    }
    const match = /^\/api\/approvals\/([^/]+)(\/assertions|\/possession)?$/.exec(url.pathname);
    if (match) {
      const approval = confirmationFor(
        decodeURIComponent(match[1] ?? ""),
        req.headers["x-confirm-token"],
      );
      if (req.method === "GET" && !match[2]) {
        return reply(200, json, JSON.stringify(confirmationView(approval)));
      }
      if (req.method === "POST" && match[2] === "/assertions") {
        return reply(200, json, JSON.stringify(holdApproval(approval, await readBody(req))));
      }
      if (req.method === "GET" && match[2] === "/possession") {
        return reply(200, json, JSON.stringify(possessionRequest(approval)));
      }
      if (req.method === "POST" && match[2] === "/possession") {
        return reply(200, json, JSON.stringify(provePossession(approval, await readBody(req))));
      }
    }
    throw new Refusal("not_found", "Nothing is here.");
  } catch (error) {
    if (error instanceof Refusal) {
      return reply(
        status[error.code],
        json,
        JSON.stringify({ error: { code: error.code, message: error.message } }),
      );
    }
    process.stderr.write(
      `${JSON.stringify({ event: "fixture.confirm.error", path: url.pathname, error: String(error) })}\n`,
    );
    reply(
      500,
      json,
      JSON.stringify({ error: { code: "internal", message: "The fixture failed." } }),
    );
  }
});

// The confirmation page listens first: once the API answers, both are up.
confirmServer.listen(CONFIRM_PORT, "127.0.0.1", () => {
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(
      `${JSON.stringify({ event: "fixture.listening", port: PORT, confirmPort: CONFIRM_PORT })}\n`,
    );
  });
});
