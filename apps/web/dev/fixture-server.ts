/**
 * A development stand-in for the control plane: it serves the `@askgina/os-api` contract from
 * memory, with the same Content-Security-Policy header the real server sends. The UI itself comes
 * from the Vite dev server, which proxies `/api` here. Every response is parsed with the
 * contract's own schema before it is sent, so the fixture cannot drift from the contract without
 * failing loudly. Nothing under `dev/` is part of the built UI.
 *
 * It is not a security boundary and not shipped: passkey responses are checked only for the
 * right challenge and a known credential, never cryptographically. Run it with
 * `bun run fixture` (port 55731) and the UI with `bun run dev`, or let Playwright start it.
 *
 * Besides the contract it has three development endpoints under `/__fixture/`: one lets a test
 * act as an agent and propose a payment (the real server takes those over MCP), one puts a sent
 * payment into a chain outcome (stuck, or rejected by the chain), and one resets state.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type ApprovalDetail,
  type ApprovalSubject,
  type ApprovalSummary,
  type AuditEvent,
  type ChainInfo,
  CONTENT_SECURITY_POLICY,
  type IntentDetail,
  type InviteSummary,
  type Member,
  type PasskeySummary,
  type PolicyDraft,
  type Role,
  type RouteName,
  routes,
  type SessionInfo,
  type WalletSummary,
  type WorkspaceDetail,
} from "@askgina/os-api";
import {
  type Envelope,
  envelopeChallenge,
  type Intent,
  intentHash,
  newId,
  normalizePolicy,
  policyHash,
  type SignerDecision,
  type Sweep,
  sweepHash,
  type WalletPolicy,
} from "@askgina/os-protocol";

const PORT = Number(process.env.OS_WEB_FIXTURE_PORT ?? 55731);
const SETUP_TOKEN = process.env.OS_WEB_FIXTURE_SETUP_TOKEN ?? "fixture-setup-token-0123456789";
const RP_NAME = "Agent Workspaces";
/**
 * Where the signer's confirmation page would be. Nothing serves it here: the journey checks the
 * link the approval page shows, and approves with the control plane's own passkey prompt.
 */
const CONFIRM_ORIGIN = process.env.OS_WEB_FIXTURE_CONFIRM_ORIGIN ?? "http://localhost:55732";

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

type RefusalCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
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
  members: Member[];
  agents: WorkspaceDetail["agents"];
  wallets: WalletSummary[];
  audit: AuditEvent[];
  decisions: SignerDecision[];
}
interface Approval {
  summary: ApprovalSummary;
  envelope: Envelope;
  challenge: string;
  approvedBy: { id: string; displayName: string }[];
  rejectedBy: { id: string; displayName: string } | null;
  subject: ApprovalSubject;
  /** The token of the request's confirmation link, as the signer would issue it. */
  confirmToken: string;
  /** The effect applied when enough people approve. */
  apply: () => void;
}
interface State {
  setupDone: boolean;
  users: Map<string, string>;
  credentials: Map<string, Credential>;
  sessions: Map<string, string>;
  ceremonies: Map<string, { challenge: string; kind: string; data: Record<string, string> }>;
  workspaces: Map<string, Workspace>;
  approvals: Map<string, Approval>;
  intents: Map<string, IntentDetail & { workspaceId: string }>;
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
  /** When each intent's transaction was broadcast, to "mine" it shortly after. */
  sentAt: Map<string, number>;
}

function freshState(): State {
  return {
    setupDone: false,
    users: new Map(),
    credentials: new Map(),
    sessions: new Map(),
    ceremonies: new Map(),
    workspaces: new Map(),
    approvals: new Map(),
    intents: new Map(),
    tokens: new Map(),
    invites: new Map(),
    spent: new Map(),
    sentAt: new Map(),
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

function advanceTransactions(): void {
  // A broadcast transaction is "mined" two seconds later, so the UI's follow-through shows.
  for (const intent of state.intents.values()) {
    if (intent.status === "broadcast" && intent.transaction) {
      if (now() - (state.sentAt.get(intent.id) ?? 0) >= 2) {
        intent.status = "confirmed";
        intent.transaction = { ...intent.transaction, status: "confirmed", blockNumber: 1042 };
      }
    }
  }
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
    confirmToken: randomToken(16),
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
            ? { userId, credentialId, publicKey: randomToken(32) }
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

function approvalDetail(approval: Approval, userId: string): ApprovalDetail {
  const workspace = workspaceOf(approval.summary.workspaceId);
  const member = workspace.members.find((item) => item.user.id === userId);
  const subject = approval.subject;
  const liveSubject: ApprovalSubject =
    subject.kind === "approve-intent"
      ? { ...subject, intent: stripIntent(state.intents.get(subject.intent.id) ?? subject.intent) }
      : subject;
  return {
    ...approval.summary,
    envelope: approval.envelope,
    challenge: approval.challenge,
    approvedBy: approval.approvedBy.map((user) => userSummary(user.id)),
    rejectedBy: approval.rejectedBy ? userSummary(approval.rejectedBy.id) : null,
    canDecide:
      approval.summary.status === "pending" &&
      member !== undefined &&
      member.role !== "viewer" &&
      member.approver === "active" &&
      !approval.approvedBy.some((user) => user.id === userId),
    subject: liveSubject,
    confirmUrl:
      approval.summary.status === "pending"
        ? `${CONFIRM_ORIGIN}/a/${approval.summary.id}#${approval.confirmToken}`
        : null,
  };
}

function stripIntent(intent: IntentDetail & { workspaceId?: string }): IntentDetail {
  const { workspaceId: _workspace, ...rest } = intent;
  return rest;
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
    adminThreshold: workspace.adminThreshold,
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

function clientChallenge(response: { response: { clientDataJSON: string } }): string {
  const clientData = JSON.parse(
    Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"),
  ) as {
    challenge?: string;
  };
  return clientData.challenge ?? "";
}

function finishCeremony(
  ceremonyId: string,
  kind: string,
  response: { response: { clientDataJSON: string } },
) {
  const ceremony = state.ceremonies.get(ceremonyId);
  state.ceremonies.delete(ceremonyId);
  if (!ceremony || ceremony.kind !== kind || clientChallenge(response) !== ceremony.challenge) {
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
  res.setHeader("set-cookie", `fixture_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
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
    throw new Refusal("forbidden", "This agent is disabled.");
  if (!wallet.policy || !wallet.policyHash)
    throw new Refusal("policy_denied", "This wallet has no policy yet.", "policy_missing");
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
  const intent: Intent = {
    v: 1,
    id: newId("int"),
    workspaceId: workspace.id as Intent["workspaceId"],
    agentId: agent.id,
    walletId: wallet.id,
    chainId: chainId as Intent["chainId"],
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
    display: {
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
  state.intents.set(intent.id, detail);
  audit(workspace, { type: "agent", id: agent.id, name: agent.name }, "intent.proposed", {
    type: "intent",
    id: intent.id,
  });
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
      const hash = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const chain = CHAINS.find((item) => item.chainId === chainId);
      live.status = "broadcast";
      live.transactionHash = hash;
      live.transaction = {
        hash,
        status: "broadcast",
        blockNumber: null,
        explorerUrl: chain?.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : null,
      };
      state.sentAt.set(live.id, now());
      decide(workspace, approval?.summary.id ?? null, "sign_transaction", null);
    },
  });
  detail.approvalId = approval.summary.id;
  if (approval.subject.kind === "approve-intent")
    approval.subject.intent.approvalId = approval.summary.id;
  return stripIntent(detail);
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
  } as WalletPolicy);
}

// --- handlers ---------------------------------------------------------------------------------

type Handler = (input: {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  userId: string | null;
  res: ServerResponse;
  origin: string;
}) => unknown;

function signedIn(userId: string | null): string {
  if (!userId) throw new Refusal("unauthenticated", "Sign in first.");
  return userId;
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
          const { id: wsId, name, role, paused, pendingApprovals } = workspaceDetail(workspace, id);
          return { id: wsId, name, role, paused, pendingApprovals };
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
    return {
      ...wallet,
      balances: [
        {
          chainId: "eip155:31337",
          asset: "native",
          symbol: "ETH",
          decimals: 18,
          amount: "1250000000000000000",
        },
        {
          chainId: "eip155:31337",
          asset: TEST_USDC,
          symbol: "USDC",
          decimals: 6,
          amount: "420000000",
        },
      ],
      spent: [...state.spent]
        .filter(([key]) => key.startsWith(`${wallet.id}|`))
        .map(([key, amount]) => {
          const [, chainId, asset] = key.split("|");
          return { chainId, asset, amount: amount.toString() };
        }),
      pendingPolicyApprovalId: pending?.summary.id ?? null,
    };
  },
  requestPolicy: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    requireOwner(workspace, id);
    const wallet = workspace.wallets.find((item) => item.id === params.walletId);
    if (!wallet) throw new Refusal("not_found", "This wallet does not exist.");
    const draft = body.draft as PolicyDraft;
    // Mirrors the server: more approvals per payment than for admin changes would be undone by
    // anyone who can change the limits.
    if (draft.approvals.threshold > workspace.adminThreshold) {
      throw new Refusal(
        "invalid_request",
        `Approvals needed per payment can be at most ${workspace.adminThreshold}, the number needed for admin changes.`,
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
        subject.transaction = {
          hash: `0x${randomBytes(32).toString("hex")}`,
          status: "confirmed",
          blockNumber: 1043,
          explorerUrl: null,
        };
        decide(workspace, approval.summary.id, "sweep", null);
      },
    });
    return approval.summary;
  },
  listApprovals: ({ params, query, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const items = [...state.approvals.values()]
      .filter((item) => item.summary.workspaceId === workspace.id)
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
    return approvalDetail(approval, id);
  },
  // No confirmation page runs here, so there is never anything to collect.
  collectApproval: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    memberOf(workspaceOf(approval.summary.workspaceId), id);
    return approvalDetail(approval, id);
  },
  startApproval: ({ params, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    if (!approvalDetail(approval, id).canDecide)
      throw new Refusal("forbidden", "You cannot approve this request.");
    const allowCredentials = [...state.credentials]
      .filter(([, credential]) => credential.userId === id)
      .map(([credentialId]) => ({ id: credentialId, type: "public-key" }));
    return {
      options: {
        challenge: approval.challenge,
        rpId: "localhost",
        allowCredentials,
        userVerification: "required",
        timeout: 60_000,
      },
    };
  },
  approve: ({ params, body, userId }) => {
    const id = signedIn(userId);
    const approval = state.approvals.get(params.approvalId ?? "");
    if (!approval) throw new Refusal("not_found", "This request does not exist.");
    if (!approvalDetail(approval, id).canDecide)
      throw new Refusal("forbidden", "You cannot approve this request.");
    const response = body.response as { id: string; response: { clientDataJSON: string } };
    if (clientChallenge(response) !== approval.challenge) {
      throw new Refusal("invalid_request", "The passkey signed a different request.");
    }
    if (state.credentials.get(response.id)?.userId !== id)
      throw new Refusal("forbidden", "This passkey is not yours.");
    approval.approvedBy.push(userSummary(id));
    approval.summary.approvals = approval.approvedBy.length;
    const workspace = workspaceOf(approval.summary.workspaceId);
    audit(workspace, userActor(id), "approval.approved", {
      type: "approval",
      id: approval.summary.id,
    });
    if (approval.summary.approvals >= approval.summary.threshold) {
      approval.summary.status = "executed";
      approval.apply();
    }
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
  listIntents: ({ params, userId }) => {
    const id = signedIn(userId);
    const workspace = workspaceOf(params.workspaceId ?? "");
    memberOf(workspace, id);
    const items = [...state.intents.values()]
      .filter((item) => item.workspaceId === workspace.id)
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
};

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
    // Lets a test put a sent payment into a chain outcome the fixture never reaches by itself.
    if (url.pathname === "/__fixture/settle" && req.method === "POST") {
      const input = (await readBody(req)) as { intentId?: string; status?: string };
      const intent = state.intents.get(input.intentId ?? "");
      if (!intent?.transaction)
        throw new Refusal("not_found", "No sent transaction for this intent.");
      if (input.status === "stuck") {
        intent.status = "stuck";
        intent.transaction = { ...intent.transaction, status: "stuck" };
      } else if (input.status === "rejected") {
        intent.status = "failed";
        intent.failureCode = "rejected";
        intent.transaction = { ...intent.transaction, status: "rejected" };
      } else {
        throw new Refusal("invalid_request", "status must be stuck or rejected.");
      }
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
    if (match.route.auth === "session" && !userId)
      throw new Refusal("unauthenticated", "Sign in first.");
    const output = await handlers[match.name]({ params, query, body, userId, res, origin });
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

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ event: "fixture.listening", port: PORT })}\n`);
});
