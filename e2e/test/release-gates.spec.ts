/**
 * The release gates, against the real stack: real Postgres, the real signer with the real OWS
 * vault, the real Workflow runtime, a local chain, and the reverse proxies in between. People
 * are driven through the public API with a software passkey; the last gate goes through the
 * browser.
 *
 * The tests run in order and share state, because they describe one installation's life.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentSummary,
  ApiError,
  type AuditEvent,
  type IntentDetail,
  type MandateDraft,
  type PolicyDraft,
  type TransactionAttemptView,
  type TransactionInfo,
  type WalletSummary,
  type WorkspaceDetail,
} from "@askgina/os-api";
import { keyFingerprint } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import { b64url, coseEc2, SoftAuthenticator } from "@askgina/os-protocol/testing";
import { scanForMarkers } from "@askgina/os-testkit";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { type Address, formatEther, isAddressEqual, parseEther, type Transaction } from "viem";
import { z } from "zod";
import { type AgentConnection, connectAgent, type Proposal, ToolRefused } from "../src/agent.ts";
import { chain, chainAdmin, receiptOf, withMiningHeld } from "../src/chain.ts";
import { JsonObject, JsonValue } from "../src/json.ts";
import { ConfirmationRefused, Person } from "../src/person.ts";
import {
  backUpInto,
  compose,
  composeArgs,
  databaseUrl,
  ExecFailure,
  exec,
  fromAgentsNetwork,
  restoreFrom,
  setupToken,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import {
  acknowledged,
  bodyOf,
  expectSignedDelivery,
  failFirstAttempts,
  receivedRequests,
  signatureVerifies,
  webhookDeliveries,
  webhookSecret,
} from "../src/webhook.ts";

test.describe.configure({ mode: "serial" });

const CHAIN = "eip155:31337";

const RECIPIENT = "0x00000000000000000000000000000000000a11ce";

/** A contract address the wallet is later allowed to call. Nothing is deployed there. */
const CALL_TARGET = "0x000000000000000000000000000000000000c0de";

const run = Date.now().toString(36);

/** Text an agent types. None of it may be readable in the database. */
const MEMO_MARKER = `MEMOMARK${run} pay the hosting invoice`;

const CALLDATA_MARKER = `0x12345678${Buffer.from(`CALLMARK${run}`).toString("hex")}`;

/** A name a person types, which is readable on purpose: it proves the scanner can see. */
const WORKSPACE_NAME = `Treasury ${run}`;

/** Exactly the tools an agent gets: none signs, approves, administers, speeds up or cancels. */
const AGENT_TOOLS = [
  "cancel_intent",
  "get_balances",
  "get_candles",
  "get_intent",
  "get_markets",
  "get_order_book",
  "get_prices",
  "get_venue_account",
  "get_venue_fills",
  "list_intents",
  "preview_order",
  "propose_contract_call",
  "propose_order",
  "propose_transfer",
  "whoami",
];

const ada = new Person(stack.origin, "Ada");

let workspace: WorkspaceDetail;

let wallet: WalletSummary;

let agentId: PolicyDraft["requesters"][number];

let agentToken: string;

let agent: AgentConnection;

/** The approval of the first confirmed payment, used later to show it cannot be used again. */
let spentApprovalId: string;

function policy(extra: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    chains: [CHAIN],
    requesters: [agentId],
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerTx: parseEther("0.05").toString(),
        maxPerDay: parseEther("0.08").toString(),
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: parseEther("0.01").toString() },
    approvals: { threshold: 1, ttlSeconds: 3600 },
    ...extra,
  };
}

/** Ask for a new policy and approve it on the signer's confirmation page. */
async function setPolicy(draft: PolicyDraft, walletId: string = wallet.id): Promise<void> {
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId },
    body: { draft },
  });

  expect(request.kind).toBe("set-policy");
  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
}

function approvalIdOf(result: JsonObject): string {
  return String(result.approvalUrl).split("/").at(-1) ?? "";
}

async function propose(amount: string, memo: string) {
  const result = await agent.call("propose_transfer", {
    chainId: CHAIN,
    to: RECIPIENT,
    amount,
    memo,
  });

  return { intentId: String(result.intentId), approvalId: approvalIdOf(result) };
}

/** The code the confirmation page refused `attempt` with; fails when it was not refused. */
async function refusalCode(attempt: Promise<unknown>): Promise<string> {
  const outcome = await attempt.then(
    () => null,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ConfirmationRefused)) {
    throw new Error(`expected the confirmation page to refuse, got ${String(outcome)}`);
  }

  return outcome.code;
}

async function intentStatus(intentId: string): Promise<string> {
  return (await ada.api.call("getIntent", { params: { intentId } })).status;
}

async function intentSettles(intentId: string, timeoutMs = 120_000): Promise<string> {
  const pending = ["proposed", "pending_approval", "approved", "signed", "broadcast"];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = await intentStatus(intentId);

    if (!pending.includes(status)) return status;

    if (Date.now() > deadline) throw new Error(`intent ${intentId} is still ${status}`);
    await delay(250);
  }
}

/**
 * Kill the server as a crash would, and return only once its container has stopped. `kill`
 * returns before that, and an `up --wait` that still sees the container running then fails
 * when it exits.
 */
async function killServer(): Promise<void> {
  await compose("kill", "server");
  await compose("stop", "--timeout", "0", "server");
}

/** The workspace's whole signer decision log, read to its end: a page holds the oldest 100. */
async function signerDecisions(): Promise<SignerDecision[]> {
  const decisions: SignerDecision[] = [];

  for (let after = 0; ; ) {
    const page = await ada.api.call("listSignerDecisions", {
      params: { workspaceId: workspace.id },
      query: { after: String(after) },
    });

    decisions.push(...page.items);
    const last = page.items.at(-1);

    if (!last || page.items.length < 100) return decisions;
    after = last.seq;
  }
}

test.beforeAll(async () => {
  await waitUntilHealthy();
});

test("a fresh installation is claimed once, with the setup token", async () => {
  expect((await ada.api.call("getSession")).setupRequired).toBe(true);
  await expect(
    new Person(stack.origin, "Mallory").setUp("not-the-setup-token-at-all"),
  ).rejects.toThrow();

  const token = await setupToken();
  const session = await ada.setUp(token);
  expect(session.user?.displayName).toBe("Ada");
  expect(session.setupRequired).toBe(false);

  await expect(new Person(stack.origin, "Mallory").setUp(token)).rejects.toThrow();
  // The token came from the operator's command; the logs a deployment ships never held it.
  expect(await compose("logs", "--no-color")).not.toContain(token);
});

test("a workspace, an agent with its own wallet, and limits approved with a passkey", async () => {
  workspace = await ada.api.call("createWorkspace", { body: { name: WORKSPACE_NAME } });

  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Payer" },
  });

  agentId = created.agent.id;
  agentToken = created.token;
  wallet = created.wallet;
  expect(wallet.policy).toBeNull();
  expect(agentToken.startsWith("osa_")).toBe(true);

  await setPolicy(policy());

  const detail = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
  });

  expect(detail.policy?.revision).toBe(1);

  await chainAdmin.setBalance({ address: wallet.address, value: parseEther("1") });
  agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
});

test("an agent can propose and read, and nothing else", async () => {
  expect(await agent.tools()).toEqual(AGENT_TOOLS);

  const unauthenticated = await fetch(`${stack.origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  expect(unauthenticated.status).toBe(401);
});

test("a proposal becomes one transaction after a passkey approval", async () => {
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });

  const { intentId, approvalId } = await propose("0.01", MEMO_MARKER);
  expect(await intentStatus(intentId)).toBe("pending_approval");
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(before);

  const approval = await ada.api.call("getApproval", { params: { approvalId } });
  expect(approval.canDecide).toBe(true);
  expect(approval.subject.kind).toBe("approve-intent");

  await ada.confirm(approvalId);
  expect(await intentSettles(intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);

  // The approval is spent: the request no longer links to the confirmation page.
  expect(await ada.api.call("getApproval", { params: { approvalId } })).toMatchObject({
    status: "executed",
    confirmUrl: null,
  });
  spentApprovalId = approvalId;
});

test("a payment approved on the confirmation page becomes one transaction", async () => {
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });
  const { intentId, approvalId } = await propose("0.002", "approved on the signer's page");

  // The approval page links to the signer's page on its own origin; the token is only in the
  // fragment, so no server or proxy log sees it.
  const link = await ada.confirmationLink(approvalId);
  expect(link.origin).toBe(stack.approveOrigin);
  expect(link.origin).not.toBe(stack.origin);
  const page = await fetch(`${link.origin}/a/${approvalId}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("trusted-types 'none'");
  expect(page.headers.get("server")).toBeNull();
  expect(page.headers.get("set-cookie")).toBeNull();

  // The page shows the payment as the signer holds it, not as the control plane describes it.
  const view = await ada.readConfirmation(link);
  const detail = await ada.api.call("getApproval", { params: { approvalId } });
  expect(view).toMatchObject({ approvalId, kind: "approve-intent", state: "open" });
  expect(view.envelope).toEqual(detail.envelope);
  expect(view.title).toBe("Send 0.002 ETH");
  const shown = view.lines.map((line) => line.value).join("\n");
  expect(shown).toContain(RECIPIENT);
  expect(shown).toContain(CHAIN);
  expect(view.lines).toContainEqual(
    expect.objectContaining({ value: "approved on the signer's page", kind: "unchecked" }),
  );

  // A wrong token reaches nothing.
  expect(await refusalCode(ada.readConfirmation({ ...link, token: "A".repeat(22) }))).toBe(
    "not_found",
  );

  // Approved there, counted by the control plane when it collects, signed once.
  const recorded = await ada.approveOnConfirmationPage(link, view);
  expect(recorded).toMatchObject({ collected: 1, required: 1 });
  expect(recorded.returnUrl).toBe(`${stack.origin}/w/${workspace.id}/approvals/${approvalId}`);
  const collected = await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
  expect(collected.approvedBy.map((person) => person.displayName)).toEqual(["Ada"]);
  expect(await intentSettles(intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.002");
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);

  // The page now says so, and takes no further approval.
  expect((await ada.readConfirmation(link)).state).toBe("used");
  expect(await refusalCode(ada.approveOnConfirmationPage(link, view))).toBe("confirmation_closed");
  expect((await ada.api.call("getApproval", { params: { approvalId } })).confirmUrl).toBeNull();
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);
});

test("an approval made on the control plane's page is refused", async () => {
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });
  const payment = await propose("0.003", "approved on the wrong page");
  // An approver change, the kind one misled tap would use to take a workspace over for good.
  const grace = new Person(stack.origin, "Grace");

  const invite = await ada.api.call("createInvite", {
    params: { workspaceId: workspace.id },
    body: { role: "approver" },
  });

  await grace.join(invite.url);

  const pending = await ada.api.call("listApprovals", {
    params: { workspaceId: workspace.id },
    query: { status: "pending" },
  });

  const addGrace = pending.items.find((item) => item.kind === "add-approver");

  if (!addGrace) throw new Error("joining as an approver opened no approver change");
  // Grace proves on the confirmation page that the new passkey is hers, so what is refused below
  // is only where Ada's approval was made.
  await grace.provePossession(addGrace.id);

  // Ada's passkey signs each request's exact digest, but on the control plane's own page, as a
  // script there (or a compromised control plane) could make it do. The browser writes that
  // page's origin into the assertion, and the confirmation page refuses it.
  for (const approvalId of [payment.approvalId, addGrace.id]) {
    const link = await ada.confirmationLink(approvalId);
    const view = await ada.readConfirmation(link);
    const onControlPlane = ada.assertion(view.webauthn.challenge, stack.origin);
    expect(await refusalCode(ada.approveOnConfirmationPage(link, view, onControlPlane))).toBe(
      "assertion_invalid",
    );
    expect((await ada.readConfirmation(link)).approvals.collected).toBe(0);
    const detail = await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
    expect(detail).toMatchObject({ status: "pending", approvals: 0 });
  }

  // A control plane that stores such an approval itself and sends it to the signer through its
  // own execution path, as a compromised one would, gets nothing signed: the request ends failed.
  const { user } = await ada.api.call("getSession");

  if (!user || ada.credentialId === undefined) throw new Error("Ada is not signed in");
  const view = await ada.readConfirmation(await ada.confirmationLink(payment.approvalId));
  const onControlPlane = ada.assertion(view.webauthn.challenge, stack.origin);
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    await db.query(
      "INSERT INTO os.approval_assertions (approval_id, user_id, credential_id, response) VALUES ($1, $2, $3, $4)",
      [payment.approvalId, user.id, ada.credentialId, JSON.stringify(onControlPlane)],
    );
    // Decided a minute ago, so the sweeper wakes the request's workflow at once.
    await db.query(
      "UPDATE os.approvals SET status = 'approved', decided_at = now() - interval '1 minute', resume_state = 'needed' WHERE id = $1 AND status = 'pending'",
      [payment.approvalId],
    );
  } finally {
    await db.end();
  }

  expect(await ada.settled(payment.approvalId)).toMatchObject({
    status: "failed",
    failureCode: "assertion_invalid",
  });
  expect(await intentSettles(payment.intentId)).toBe("failed");
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore);

  // Grace stays a member who cannot approve.
  await ada.reject(addGrace.id);
  const members = await ada.api.call("getWorkspace", { params: { workspaceId: workspace.id } });
  expect(members.members.find((member) => member.user.displayName === "Grace")?.approver).not.toBe(
    "active",
  );
});

test("an approver change whose key the new person does not hold cannot be approved", async () => {
  // Heidi joins as a viewer, so no approver change is opened yet.
  const heidi = new Person(stack.origin, "Heidi");

  const invite = await ada.api.call("createInvite", {
    params: { workspaceId: workspace.id },
    body: { role: "viewer" },
  });

  const { user } = await heidi.join(invite.url);

  if (!user || heidi.credentialId === undefined) throw new Error("Heidi did not join");

  // A compromised control plane puts a key of its own choosing into her approver change, under
  // her passkey's id. Here the key is one this test made; the database row the change is built
  // from is rewritten the way such a control plane would.
  const chosen = new SoftAuthenticator().register({
    rpId: new URL(stack.origin).hostname,
    challenge: "chosen-key",
  });

  const chosenKey = Buffer.from(coseEc2(chosen.credential.publicKey));
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();
  let change: { id: string } | undefined;

  try {
    const { rows } = await db.query<{ public_key: Buffer }>(
      "SELECT public_key FROM os.credentials WHERE id = $1",
      [heidi.credentialId],
    );

    const original = rows[0]?.public_key;

    if (!original) throw new Error("Heidi's passkey is not in the database");
    await db.query("UPDATE os.credentials SET public_key = $1 WHERE id = $2", [
      chosenKey,
      heidi.credentialId,
    ]);

    try {
      const promoted = await ada.api.call("setMemberRole", {
        params: { workspaceId: workspace.id, userId: user.id },
        body: { role: "approver" },
      });

      change = promoted.approvals.find((item) => item.kind === "add-approver");
    } finally {
      await db.query("UPDATE os.credentials SET public_key = $1 WHERE id = $2", [
        original,
        heidi.credentialId,
      ]);
    }
  } finally {
    await db.end();
  }

  if (!change) throw new Error("making Heidi an approver opened no approver change");
  const approvalId = change.id;

  // The page names Heidi's passkey but shows the fingerprint of the key the change carries.
  const link = await heidi.confirmationLink(approvalId);
  const view = await heidi.readConfirmation(link);
  expect(view).toMatchObject({ kind: "add-approver", state: "open" });
  expect(view.warnings).toContain("possession_unproven");
  const fingerprint = view.lines.find((line) => line.label === "Key fingerprint")?.value;
  expect(fingerprint).toBe(keyFingerprint(b64url(chosenKey)));

  // Heidi's real passkey fails the possession step: it is not the key in the request.
  const options = await heidi.readPossession(link);
  expect(options.allowCredentials).toEqual([heidi.credentialId]);
  expect(await refusalCode(heidi.proveOnConfirmationPage(link, options))).toBe("assertion_invalid");

  // Ada's approval is refused until someone proves it, so nothing is counted or applied.
  const adaLink = await ada.confirmationLink(approvalId);
  expect(
    await refusalCode(ada.approveOnConfirmationPage(adaLink, await ada.readConfirmation(adaLink))),
  ).toBe("possession_unproven");
  expect(await ada.api.call("collectApproval", { params: { approvalId }, body: {} })).toMatchObject(
    { status: "pending", approvals: 0 },
  );
  await ada.reject(approvalId);
  const members = await ada.api.call("getWorkspace", { params: { workspaceId: workspace.id } });
  expect(members.members.find((member) => member.user.id === user.id)?.approver).not.toBe("active");
});

test("the confirmation service reaches the signer and nothing else", async () => {
  const script = `
    const dns = require("node:dns/promises");
    (async () => {
      const resolved = {};
      for (const host of ["signer", "caddy", "server", "postgres", "anvil", "agent-gateway"]) {
        resolved[host] = await dns.lookup(host).then(() => true, () => false);
      }
      const internet = await fetch("https://example.com/", { signal: AbortSignal.timeout(4000) })
        .then((r) => r.status, () => "unreachable");
      process.stdout.write(JSON.stringify({ resolved, internet }) + "\\n");
    })();`;

  const seen = JSON.parse(
    (await exec("approve", "node", "-e", script)).trim().split("\n").at(-1) ?? "{}",
  );

  // Caddy is the only way in, the signer the only way on.
  expect(seen).toEqual({
    resolved: {
      signer: true,
      caddy: true,
      server: false,
      postgres: false,
      anvil: false,
      "agent-gateway": false,
    },
    internet: "unreachable",
  });
});

test("a proposal over the wallet's limit is refused before anyone is asked", async () => {
  const refusal = await propose("1", "far too much").then(
    () => null,
    (cause: unknown) => cause,
  );

  expect(refusal).toBeInstanceOf(ToolRefused);
  expect(String(refusal)).toContain("over_per_tx_cap");
});

test("a rejected proposal moves nothing", async () => {
  const before = await chain.getBalance({ address: RECIPIENT });
  const { intentId, approvalId } = await propose("0.01", "rejected on purpose");
  await ada.reject(approvalId);
  expect(await intentSettles(intentId)).toBe("rejected");
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(before);
});

test("two approved proposals that together exceed the daily limit produce one transaction", async () => {
  // 0.01 is already spent today; the limit is 0.08. Each 0.04 fits alone, both do not.
  const before = await chain.getBalance({ address: RECIPIENT });
  const first = await propose("0.04", "first of two");
  const second = await propose("0.04", "second of two");
  await Promise.all([ada.confirm(first.approvalId), ada.confirm(second.approvalId)]);

  const outcomes = [await intentSettles(first.intentId), await intentSettles(second.intentId)];
  expect(outcomes.filter((status) => status === "confirmed")).toHaveLength(1);
  expect(outcomes.filter((status) => status === "denied" || status === "failed")).toHaveLength(1);
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.04");
});

test("limits change only with a passkey, and a raw contract call stays a proposal until approved", async () => {
  await expect(
    agent.call("propose_contract_call", {
      chainId: CHAIN,
      to: CALL_TARGET,
      data: CALLDATA_MARKER,
      memo: "not allowed yet",
    }),
  ).rejects.toThrow(/contract_call_not_allowed/);

  await setPolicy(policy({ contractCalls: { mode: "allowlist", targets: [CALL_TARGET] } }));

  const detail = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
  });

  expect(detail.policy?.revision).toBe(2);

  const result = await agent.call("propose_contract_call", {
    chainId: CHAIN,
    to: CALL_TARGET,
    data: CALLDATA_MARKER,
    memo: "a call with marked calldata",
  });

  const approval = await ada.api.call("getApproval", {
    params: { approvalId: approvalIdOf(result) },
  });

  expect(approval.status).toBe("pending");
  await ada.reject(approval.id);
  expect(await intentSettles(String(result.intentId))).toBe("rejected");
});

test("the workflow delivery routes answer 404 from outside", async () => {
  for (const path of ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/webhook/x"]) {
    const response = await fetch(`${stack.origin}${path}`, { method: "POST", body: "{}" });
    expect(response.status, path).toBe(404);
  }
});

test("a container on the agents network reaches the MCP gateway and nothing else", async () => {
  const script = `
    const dns = require("node:dns/promises");
    const tryFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(4000) }).then((r) => r.status, () => "unreachable");
    (async () => {
      const resolved = {};
      for (const host of ["server", "postgres", "signer", "approve", "anvil", "caddy"]) {
        resolved[host] = await dns.lookup(host).then(() => true, () => false);
      }
      console.log(JSON.stringify({
        resolved,
        mcp: await tryFetch("http://agent-gateway/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        api: await tryFetch("http://agent-gateway/api/v1/session"),
        pairing: await tryFetch("http://agent-gateway/agent-pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientName: "Probe" }) }),
        ui: await tryFetch("http://agent-gateway/"),
        workflow: await tryFetch("http://agent-gateway/.well-known/workflow/v1/flow", { method: "POST", body: "{}" }),
        internet: await tryFetch("https://example.com/"),
      }));
    })();`;

  const { output } = await fromAgentsNetwork(script);
  const seen = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  expect(seen.resolved).toEqual({
    server: false,
    postgres: false,
    signer: false,
    approve: false,
    anvil: false,
    caddy: false,
  });
  expect(seen.mcp).toBe(401);
  expect(seen.api).toBe(404);
  expect(seen.pairing).toBe(404);
  expect(seen.ui).toBe(404);
  expect(seen.workflow).toBe(404);
  expect(seen.internet).toBe("unreachable");
});

/** What `POST /agent-pairing` answers. */
const StartedPairing = z.strictObject({
  pairingId: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  pollSecret: z.string(),
  expiresAt: z.number(),
  interval: z.number(),
});

/** What a poll answers once an owner has allowed the pairing, and after. */
const PolledPairing = z.object({
  status: z.string(),
  token: z.string().optional(),
  mcpUrl: z.string().optional(),
  walletId: z.string().optional(),
});

test("an agent pairs through the public proxy: an owner allows it, its token arrives once, and its new wallet has no limits", async () => {
  const post = (path: string, body: JsonObject) =>
    fetch(`${stack.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const started = await post("/agent-pairing", { clientName: "Paired" });
  expect(started.status).toBe(201);
  const pairing = StartedPairing.parse(await started.json());
  expect(pairing.verificationUrl).toBe(`${stack.origin}/pair/${pairing.pairingId}`);

  const poll = async () =>
    PolledPairing.parse(
      await (
        await post("/agent-pairing/poll", {
          pairingId: pairing.pairingId,
          pollSecret: pairing.pollSecret,
        })
      ).json(),
    );

  expect(await poll()).toEqual({ status: "pending" });

  const seen = await ada.api.call("getPairing", { params: { pairingId: pairing.pairingId } });
  expect(seen.userCode).toBe(pairing.userCode);

  const allowed = await ada.api.call("approvePairing", {
    params: { pairingId: pairing.pairingId },
    body: { workspaceId: workspace.id, name: "Paired" },
  });

  const first = await poll();
  expect(first).toMatchObject({
    status: "approved",
    mcpUrl: `${stack.origin}/mcp`,
    walletId: allowed.walletId,
  });
  expect(await poll()).toEqual({ status: "claimed" });

  // The token works at the gateway as this new agent, whose wallet no owner has set limits on.
  const paired = await connectAgent(`${stack.origin}/mcp`, first.token ?? "");

  try {
    expect(await paired.tools()).toEqual(AGENT_TOOLS);
    expect(await paired.call("whoami")).toMatchObject({ agent: { id: allowed.agentId } });
  } finally {
    await paired.close();
  }

  const detail = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId: allowed.walletId },
  });

  expect(detail.policy).toBeNull();
  // The logs a deployment ships hold neither the token nor the poll secret.
  const logs = await compose("logs", "--no-color");
  expect(logs).not.toContain(first.token ?? "");
  expect(logs).not.toContain(pairing.pollSecret);
});

test("the example agent, in a container on the agents network, gets its payment approved", async () => {
  const container = spawn(
    "docker",
    composeArgs(
      "run",
      "--rm",
      "-e",
      `AGENT_TOKEN=${agentToken}`,
      "-e",
      `TRANSFER_TO=${RECIPIENT}`,
      "-e",
      "MEMO=from the example agent",
      "scripted-agent",
    ),
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  container.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  container.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = Promise.withResolvers<number | null>();
  container.once("exit", exited.resolve);

  // The agent prints the approval link once it has proposed.
  await expect
    .poll(() => /approvals\/(apr_[0-9a-z]+)/.exec(output)?.[1] ?? null, { timeout: 120_000 })
    .not.toBeNull();
  const approvalId = /approvals\/(apr_[0-9a-z]+)/.exec(output)?.[1] ?? "";
  await ada.confirm(approvalId);

  expect(await exited.promise, output).toBe(0);
  expect(output).toContain("status: confirmed");
});

test("what an agent typed is in no column of the database in the clear", async () => {
  const url = await databaseUrl();

  const scan = await scanForMarkers(url, [
    MEMO_MARKER,
    CALLDATA_MARKER,
    CALLDATA_MARKER.slice(2),
    RECIPIENT,
    RECIPIENT.slice(2),
  ]);

  expect(scan.hits).toEqual([]);
  expect(scan.tables.length).toBeGreaterThan(20);

  // The control: a name a person typed is readable on purpose. If the scanner cannot find
  // even that, it is blind and the assertion above means nothing.
  const control = await scanForMarkers(url, [WORKSPACE_NAME]);
  expect(control.hits.length).toBeGreaterThan(0);
});

test("a crash after the approval and before the broadcast still ends in exactly one transaction", async () => {
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });
  const { intentId, approvalId } = await propose("0.01", "survives a crash");

  // With the chain frozen, the approved request cannot get past its broadcast. The approval is
  // sent without waiting for its answer, because the answer may itself wait on the chain.
  await compose("pause", "anvil");
  const approving = ada.confirm(approvalId).catch(() => undefined);
  await delay(4_000);
  await killServer();
  await approving;
  await compose("unpause", "anvil");
  await compose("up", "-d", "--wait", "--wait-timeout", "300", "server");
  await waitUntilHealthy();

  expect(await intentSettles(intentId, 200_000)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);
  agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
});

test("the audit log is complete and its chain verifies", async () => {
  const verification = await ada.api.call("verifyAudit", { params: { workspaceId: workspace.id } });
  expect(verification.ok).toBe(true);
  expect(verification.checked).toBeGreaterThan(10);

  const log = await ada.api.call("listAudit", { params: { workspaceId: workspace.id } });
  expect(log.items.map((event) => event.action)).toEqual(
    expect.arrayContaining(["approval.opened"]),
  );

  const decisions = await ada.api.call("listSignerDecisions", {
    params: { workspaceId: workspace.id },
  });

  expect(decisions.items.some((decision) => decision.outcome === "denied")).toBe(true);
  expect(decisions.items.some((decision) => decision.outcome === "allowed")).toBe(true);
});

test("a person empties a disabled agent's wallet to the treasury while paused, and the signer refuses any other destination", async () => {
  const treasury = await ada.api.call("createTreasury", {
    params: { workspaceId: workspace.id },
    body: { label: "Reserve" },
  });

  const retired = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Retired" },
  });

  await chainAdmin.setBalance({ address: retired.wallet.address, value: parseEther("0.5") });
  await ada.api.call("disableAgent", {
    params: { workspaceId: workspace.id, agentId: retired.agent.id },
    body: {},
  });
  await ada.api.call("pauseWorkspace", { params: { workspaceId: workspace.id }, body: {} });

  const sweep = (to: Address) =>
    ada.api.call("requestSweep", {
      params: { workspaceId: workspace.id, walletId: retired.wallet.id },
      body: { chainId: CHAIN, asset: "native", to },
    });

  // A destination the approvers never allowed: approved with a passkey, refused by the signer.
  const nonceBefore = await chain.getTransactionCount({ address: retired.wallet.address });
  const elsewhere = await sweep(RECIPIENT);
  await ada.confirm(elsewhere.id);
  expect(await ada.settled(elsewhere.id)).toMatchObject({
    status: "failed",
    failureCode: "sweep_destination_not_allowed",
  });
  expect(await chain.getTransactionCount({ address: retired.wallet.address })).toBe(nonceBefore);

  // The treasury: one transaction, the approved amount, also while the workspace is paused.
  const treasuryBefore = await chain.getBalance({ address: treasury.address });
  const toTreasury = await sweep(treasury.address);
  await ada.confirm(toTreasury.id);
  expect((await ada.settled(toTreasury.id)).status).toBe("executed");
  let approved = await ada.api.call("getApproval", { params: { approvalId: toTreasury.id } });

  for (let i = 0; i < 240; i += 1) {
    if (
      approved.subject.kind === "sweep-wallet" &&
      approved.subject.transaction?.status === "confirmed"
    )
      break;
    await delay(500);
    approved = await ada.api.call("getApproval", { params: { approvalId: toTreasury.id } });
  }

  if (approved.subject.kind !== "sweep-wallet") throw new Error("not a sweep");
  expect(approved.subject.transaction?.status).toBe("confirmed");
  expect((await chain.getBalance({ address: treasury.address })) - treasuryBefore).toBe(
    BigInt(approved.subject.sweep.amount),
  );
  expect(await chain.getTransactionCount({ address: retired.wallet.address })).toBe(
    nonceBefore + 1,
  );
  expect(await chain.getBalance({ address: retired.wallet.address })).toBeLessThan(
    BigInt(approved.subject.sweep.maxFeeWei),
  );

  // Resume for the gates that follow; resuming needs the passkey, as always.
  const resume = await ada.api.call("requestResume", {
    params: { workspaceId: workspace.id },
    body: {},
  });

  await ada.confirm(resume.id);
  expect((await ada.settled(resume.id)).status).toBe("executed");
});

test("a restored and fenced backup keeps wallets, refuses an approval used after the backup and every approval issued before the restore, and signs a new proposal", async () => {
  // Two proposals waiting when the backup is taken. One is paid after the backup, so the
  // backup is older than the last payment: the case where a restore could pay twice.
  const waiting = await propose("0.005", "still waiting at the restore");
  const paidAfterBackup = await propose("0.006", "paid after the backup");
  await agent.close();
  const restoreProject = `${stack.project}-restore`;
  await backUpInto(restoreProject);

  const paidBefore = await chain.getBalance({ address: RECIPIENT });
  await ada.confirm(paidAfterBackup.approvalId);
  expect(await intentSettles(paidAfterBackup.intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - paidBefore)).toBe("0.006");

  const fenceAt = await restoreFrom(restoreProject);

  // The same person, the same passkey, the same wallet.
  await ada.signIn();

  const restored = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
  });

  expect(restored.address).toBe(wallet.address);
  expect(restored.policy?.revision).toBe(2);
  expect((await ada.api.call("verifyAudit", { params: { workspaceId: workspace.id } })).ok).toBe(
    true,
  );

  // An approval that was used before the backup is still used.
  expect(
    await ada.api.call("getApproval", { params: { approvalId: spentApprovalId } }),
  ).toMatchObject({ status: "executed", confirmUrl: null });

  // The chain is not part of a backup: the restored stack has a fresh local one. Whatever the
  // signer signed now would land on it.
  await chainAdmin.setBalance({ address: wallet.address, value: parseEther("1") });
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });

  // The restored control plane shows the payment made after the backup as waiting again. The
  // signer's confirmation page says it will never act on it, nor on the one that waited at the
  // backup, and refuses an approval for either.
  const shown = await ada.api.call("getApproval", {
    params: { approvalId: paidAfterBackup.approvalId },
  });

  expect(shown.status).toBe("pending");

  for (const proposal of [paidAfterBackup, waiting]) {
    const link = await ada.confirmationLink(proposal.approvalId);
    const view = await ada.readConfirmation(link);
    expect(view.state).toBe("superseded");
    expect(await refusalCode(ada.approveOnConfirmationPage(link, view))).toBe(
      "confirmation_closed",
    );
    await ada.reject(proposal.approvalId);
    expect(await intentSettles(proposal.intentId, 200_000)).toBe("rejected");
  }

  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore);
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(before);
  // The restored file is a new file, so the signer may already have fenced it when the operator's
  // command opened it; within the same second the operator's fence then changes nothing.
  const actions = (await signerDecisions()).map((decision) => decision.action);
  expect(
    actions.some((action) =>
      ["fence-set-by-operator", "fence-set-on-new-database-file"].includes(action),
    ),
  ).toBe(true);

  // A proposal made after the fence and the clock skew it allows is signed as usual.
  const skewEnds = (fenceAt + 31) * 1000;

  if (Date.now() < skewEnds) await delay(skewEnds - Date.now());
  agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
  const fresh = await propose("0.001", "after the restore");
  await ada.confirm(fresh.approvalId);
  expect(await intentSettles(fresh.intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.001");
});

// --- mandates ---------------------------------------------------------------------------------
// These run on the restored stack, after every gate above. Each grants the mandates it needs; the
// first five share one, which the fifth revokes.

/** The one address the mandates below may pay. */
const PAYEE = "0x000000000000000000000000000000000000b0b0";

/** A person's reason for a mandate. It is sealed: none of it may be readable in the database. */
const PURPOSE_MARKER = `PURPOSEMARK${run} pay the hosting invoices`;

const wei = (amount: string) => parseEther(amount).toString();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The agent the mandates below are for, with its own wallet. */
let payerId: AgentSummary["id"];

let payerToken: string;

let payerWallet: WalletSummary;

let payer: AgentConnection;

/** The mandate the first gates grant and use, until one of them revokes it. */
let mandateId: string;

/**
 * A wallet policy for `requester` with room for every mandate below and any recipient, so that
 * only a mandate's own list limits where it pays.
 */
function payerPolicy(requester: AgentSummary["id"]): PolicyDraft {
  return policy({
    requesters: [requester],
    assets: [{ chainId: CHAIN, asset: "native", maxPerTx: wei("0.05"), maxPerDay: wei("0.5") }],
  });
}

/**
 * Let `agent` pay PAYEE up to 0.01 ETH at a time, 0.03 ETH in any hour and 0.05 ETH in all, ten
 * times at most, for a day. Every cap is below the policy's, so the mandate refuses first.
 */
function mandateDraft(agent: AgentSummary["id"], extra: Partial<MandateDraft> = {}): MandateDraft {
  return {
    agentId: agent,
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerAction: wei("0.01"),
        maxPerWindow: wei("0.03"),
        maxTotal: wei("0.05"),
      },
    ],
    windowSeconds: 3600,
    recipients: [PAYEE],
    maxUses: 10,
    maxFeePerActionWei: wei("0.01"),
    notAfter: nowSeconds() + 86_400,
    purpose: "pay the hosting invoices this week",
    ...extra,
  };
}

/**
 * Ada asks for `draft` on `walletId`, and `approver` approves it on the signer's confirmation
 * page, which at the admin threshold of 1 grants it.
 */
async function grantMandate(
  walletId: string,
  draft: MandateDraft,
  approver: Person = ada,
): Promise<{ mandateId: string; grantId: string }> {
  const grant = await ada.proposeMandate(workspace.id, walletId, draft);
  expect(grant).toMatchObject({ kind: "grant-mandate", status: "pending" });
  await approver.confirm(grant.id);
  const granted = await ada.settled(grant.id);
  expect(granted.status).toBe("executed");

  if (granted.subject.kind !== "grant-mandate") throw new Error(`${grant.id} grants no mandate`);

  return { mandateId: granted.subject.mandate.id, grantId: grant.id };
}

function getMandate(id: string) {
  return ada.api.call("getMandate", { params: { workspaceId: workspace.id, mandateId: id } });
}

/** The ids of the live mandates `whoami` shows the payer. */
async function payerMandates(): Promise<string[]> {
  const { mandates } = await payer.call("whoami");

  return MandateIds.parse(mandates).map((mandate) => mandate.mandateId);
}

/** The part of `whoami`'s `mandates` a gate reads. */
const MandateIds = z.array(z.object({ mandateId: z.string() }));

/** How many proposals the payer has made, as it lists them. */
async function payerIntentCount(): Promise<number> {
  const { intents } = await payer.call("list_intents", { limit: 50 });

  return z.array(JsonValue).parse(intents).length;
}

/** The code and reason a tool refused `attempt` with; fails when it was not refused. */
async function toolRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string | null; detail: string | null }> {
  const outcome = await attempt.then(
    () => null,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ToolRefused)) {
    throw new Error(`expected the tool to refuse, got ${String(outcome)}`);
  }

  return { code: outcome.code, detail: outcome.detail };
}

/** The code and reason the API refused `attempt` with; fails when it was not refused. */
async function apiRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string; detail: string | undefined }> {
  const outcome = await attempt.then(
    () => null,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ApiError)) {
    throw new Error(`expected the API to refuse, got ${String(outcome)}`);
  }

  return { code: outcome.code, detail: outcome.detail };
}

/** A proposal no mandate covered waits for a person. Ada rejects it, so nothing moves. */
async function rejectWaiting(proposal: Proposal): Promise<void> {
  expect(proposal).toMatchObject({
    authorizedBy: "person",
    mandateId: null,
    status: "pending_approval",
  });
  const approvalId = approvalIdOf(proposal);
  const approval = await ada.api.call("getApproval", { params: { approvalId } });
  expect(approval.subject.kind).toBe("approve-intent");
  await ada.reject(approvalId);
  expect(await intentSettles(proposal.intentId)).toBe("rejected");
}

/**
 * `person` joins the workspace as an approver, proves on the confirmation page that the passkey
 * is theirs, and Ada approves the change. Returns their user id.
 */
async function joinAsApprover(person: Person): Promise<string> {
  const invite = await ada.api.call("createInvite", {
    params: { workspaceId: workspace.id },
    body: { role: "approver" },
  });

  const { user } = await person.join(invite.url);

  if (!user) throw new Error(`${person.name} did not join`);

  const pending = await ada.api.call("listApprovals", {
    params: { workspaceId: workspace.id },
    query: { status: "pending" },
  });

  let change: string | undefined;

  for (const item of pending.items.filter((candidate) => candidate.kind === "add-approver")) {
    const detail = await ada.api.call("getApproval", { params: { approvalId: item.id } });

    if (detail.subject.kind === "add-approver" && detail.subject.user.id === user.id) {
      change = item.id;
    }
  }

  if (!change) throw new Error("joining as an approver opened no approver change");
  await person.provePossession(change);
  await ada.confirm(change);
  expect((await ada.settled(change)).status).toBe("executed");

  return user.id;
}

/** Run one of the signer's operator commands on its host, as the deploy guide does. */
async function signerAdmin(...args: string[]): Promise<JsonObject> {
  const output = await exec("signer", "node", "src/admin.ts", ...args);

  return JsonObject.parse(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
}

/** Run the example agent once, in a container on the agents network, to its end. */
async function runExampleAgent(
  env: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  const variables = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

  try {
    return { exitCode: 0, output: await compose("run", "--rm", ...variables, "scripted-agent") };
  } catch (error) {
    const failure = ExecFailure.parse(error);

    return { exitCode: failure.code ?? 1, output: `${failure.stdout}${failure.stderr}` };
  }
}

test("a mandate approved on the confirmation page at the admin threshold lets its agent pay a listed recipient with no person asked", async () => {
  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Invoice payer" },
  });

  payerId = created.agent.id;
  payerToken = created.token;
  payerWallet = created.wallet;
  await setPolicy(payerPolicy(payerId), payerWallet.id);
  await chainAdmin.setBalance({ address: payerWallet.address, value: parseEther("1") });
  payer = await connectAgent(`${stack.origin}/mcp`, payerToken);

  // Compose sets the longest life to seven days: a longer mandate is refused before anyone is
  // asked.
  expect(
    await apiRefusal(
      ada.proposeMandate(
        workspace.id,
        payerWallet.id,
        mandateDraft(payerId, { notAfter: nowSeconds() + 8 * 86_400 }),
      ),
    ),
  ).toEqual({ code: "invalid_request", detail: "lifetime_too_long" });

  const { adminThreshold } = await ada.api.call("getWorkspace", {
    params: { workspaceId: workspace.id },
  });

  const grant = await ada.proposeMandate(
    workspace.id,
    payerWallet.id,
    mandateDraft(payerId, { purpose: PURPOSE_MARKER }),
  );

  expect(grant).toMatchObject({
    kind: "grant-mandate",
    status: "pending",
    threshold: adminThreshold,
  });
  const detail = await ada.api.call("getApproval", { params: { approvalId: grant.id } });

  if (detail.subject.kind !== "grant-mandate") throw new Error("the request grants no mandate");
  mandateId = detail.subject.mandate.id;

  // The confirmation page shows the mandate as the signer holds it: the most that can leave the
  // wallet, the agent, the one recipient, and the purpose as text nobody checked.
  const link = await ada.confirmationLink(grant.id);
  const view = await ada.readConfirmation(link);
  expect(view).toMatchObject({ approvalId: grant.id, kind: "grant-mandate", state: "open" });
  expect(view.envelope).toEqual(detail.envelope);
  expect(view.title).toBe("Let an agent pay up to 0.05 ETH without asking");
  const shown = view.lines.map((line) => line.value).join("\n");
  expect(shown).toContain(PAYEE);
  expect(shown).toContain(payerId);
  expect(shown).toContain(mandateId);
  expect(view.lines).toContainEqual(
    expect.objectContaining({ value: PURPOSE_MARKER, kind: "unchecked" }),
  );
  expect(await ada.approveOnConfirmationPage(link, view)).toMatchObject({
    collected: 1,
    required: adminThreshold,
  });
  await ada.api.call("collectApproval", { params: { approvalId: grant.id }, body: {} });
  expect((await ada.settled(grant.id)).status).toBe("executed");
  const granted = await getMandate(mandateId);
  expect(granted).toMatchObject({
    status: "active",
    endedReason: null,
    grantApprovalId: grant.id,
    walletId: payerWallet.id,
    agent: { id: payerId, name: "Invoice payer" },
    usage: { uses: 0, usesLeft: 10 },
    intents: [],
  });
  expect(granted.grantedBy.map((person) => person.displayName)).toEqual(["Ada"]);
  expect(await payerMandates()).toEqual([mandateId]);

  // Covered: signed and sent with no person asked, and nothing waits in the inbox.
  const { pendingApprovals } = await ada.api.call("getWorkspace", {
    params: { workspaceId: workspace.id },
  });

  const before = await chain.getBalance({ address: PAYEE });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });

  const paid = await payer.proposeTransfer({
    chainId: CHAIN,
    to: PAYEE,
    amount: "0.01",
    memo: "hosting invoice 1",
  });

  expect(paid).toMatchObject({
    authorizedBy: "mandate",
    mandateId,
    approvalUrl: null,
    expiresAt: null,
  });
  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: PAYEE })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  expect(await ada.api.call("getIntent", { params: { intentId: paid.intentId } })).toMatchObject({
    approvalId: null,
    mandateId,
    transaction: { status: "confirmed" },
  });

  // The example agent is covered the same way, and says so.
  const example = await runExampleAgent({
    AGENT_TOKEN: payerToken,
    TRANSFER_TO: PAYEE,
    AMOUNT: "0.005",
    MEMO: "hosting invoice 2, from the example agent",
  });

  expect(example.exitCode, example.output).toBe(0);
  expect(example.output).toContain(`covered by mandate ${mandateId}`);
  expect(example.output).toContain("status: confirmed");
  expect(example.output).not.toMatch(/approvals\/apr_/);
  expect(formatEther((await chain.getBalance({ address: PAYEE })) - before)).toBe("0.015");
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 2);
  expect(
    (await ada.api.call("getWorkspace", { params: { workspaceId: workspace.id } }))
      .pendingApprovals,
  ).toBe(pendingApprovals);

  const used = await getMandate(mandateId);
  expect(used.usage).toMatchObject({
    uses: 2,
    usesLeft: 8,
    assets: [{ usedTotal: wei("0.015"), usedInWindow: wei("0.015") }],
  });
  expect(used.intents.map((intent) => intent.id)).toContain(paid.intentId);
  expect(used.intents).toHaveLength(2);
  const decisions = await signerDecisions();
  expect(decisions).toContainEqual(
    expect.objectContaining({ action: "grant-mandate", approvalId: grant.id, outcome: "allowed" }),
  );
  expect(
    decisions.some(
      (decision) => decision.action === "sign-under-mandate" && decision.outcome === "allowed",
    ),
  ).toBe(true);
});

test("a mandate's purpose is in no column of the database in the clear, and in no log line", async () => {
  // Stored, and readable to the workspace through the API: the scan looks for something there.
  expect((await getMandate(mandateId)).mandate.purpose).toBe(PURPOSE_MARKER);
  const url = await databaseUrl();
  const scan = await scanForMarkers(url, [PURPOSE_MARKER, `PURPOSEMARK${run}`]);
  expect(scan.hits).toEqual([]);
  // The control: if the scanner cannot find a name a person typed, it is blind.
  const control = await scanForMarkers(url, [WORKSPACE_NAME]);
  expect(control.hits.length).toBeGreaterThan(0);

  const logs = await compose("logs", "--no-color", "server", "signer", "approve");
  expect(logs).not.toContain(`PURPOSEMARK${run}`);
  // The operator's listing on the signer host names no purpose either.
  const listed = await signerAdmin("list-mandates", "--workspace", workspace.id);
  expect(listed.mandates).toContainEqual(
    expect.objectContaining({ mandateId, status: "active", uses: 2, maxUses: 10 }),
  );
  expect(JSON.stringify(listed)).not.toContain(`PURPOSEMARK${run}`);
});

test("a payment over the mandate's per-payment cap, or to a recipient it does not list, waits for a person", async () => {
  const before = await chain.getBalance({ address: PAYEE });
  const elsewhere = await chain.getBalance({ address: RECIPIENT });
  // The wallet's policy allows both: 0.02 is under its 0.05 per transaction, and it allows any
  // recipient. The mandate covers neither.
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: PAYEE,
      amount: "0.02",
      memo: "over the mandate's per-payment cap",
    }),
  );
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: RECIPIENT,
      amount: "0.005",
      memo: "to an address the mandate does not list",
    }),
  );

  // Named, the mandate refuses each with its reason, and nothing is recorded.
  const count = await payerIntentCount();
  expect(
    await toolRefusal(
      payer.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.02",
        memo: "over the cap, under the mandate",
        mandateId,
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "mandate_over_per_action_cap" });
  expect(
    await toolRefusal(
      payer.proposeTransfer({
        chainId: CHAIN,
        to: RECIPIENT,
        amount: "0.005",
        memo: "unlisted, under the mandate",
        mandateId,
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "mandate_recipient_not_allowed" });
  expect(await payerIntentCount()).toBe(count);

  expect(await chain.getBalance({ address: PAYEE })).toBe(before);
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(elsewhere);
  expect((await getMandate(mandateId)).usage).toMatchObject({ uses: 2 });
});

test("a server killed right after a payment under a mandate still ends in exactly one transaction, and the mandate keeps its counts", async () => {
  const before = await chain.getBalance({ address: PAYEE });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });

  // Named by the agent this time.
  const paid = await payer.proposeTransfer({
    chainId: CHAIN,
    to: PAYEE,
    amount: "0.005",
    memo: "survives a restart",
    mandateId,
  });

  expect(paid).toMatchObject({ authorizedBy: "mandate", mandateId });
  await killServer();
  await compose("up", "-d", "--wait", "--wait-timeout", "300", "server");
  await waitUntilHealthy();

  expect(await intentSettles(paid.intentId, 200_000)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: PAYEE })) - before)).toBe("0.005");
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  // The counts live in the signer, which kept running: every payment counted once.
  expect(await getMandate(mandateId)).toMatchObject({
    status: "active",
    endedReason: null,
    usage: {
      uses: 3,
      usesLeft: 7,
      assets: [{ usedTotal: wei("0.02"), usedInWindow: wei("0.02") }],
    },
  });
  payer = await connectAgent(`${stack.origin}/mcp`, payerToken);
  const { mandates } = await payer.call("whoami");
  expect(mandates).toEqual([
    expect.objectContaining({
      mandateId,
      usesLeft: 7,
      assets: [expect.objectContaining({ usedInWindow: wei("0.02"), usedTotal: wei("0.02") })],
    }),
  ]);
});

test("concurrent payments under one mandate never exceed its window cap, and the next is refused with mandate_over_window_cap", async () => {
  // 0.02 of the 0.03 the mandate allows in any hour is used. Each payment fits alone; both do not.
  const before = await chain.getBalance({ address: PAYEE });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });

  const racing = await Promise.all(
    ["first", "second"].map((which) =>
      payer.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.01",
        memo: `racing for the window, ${which}`,
      }),
    ),
  );

  const outcomes: { authorizedBy: string; status: string; failureCode: string | null }[] = [];

  for (const proposal of racing) {
    // A proposal checked after the other was signed no longer fits, so it waits for a person.
    if (proposal.authorizedBy === "person") await rejectWaiting(proposal);
    else await intentSettles(proposal.intentId);

    const { status, failureCode } = await ada.api.call("getIntent", {
      params: { intentId: proposal.intentId },
    });

    outcomes.push({ authorizedBy: proposal.authorizedBy, status, failureCode });
  }

  // One is signed. When both were routed to the mandate, the signer refuses the other with the
  // window's code.
  const confirmed = outcomes.filter((outcome) => outcome.status === "confirmed");
  expect(confirmed).toEqual([expect.objectContaining({ authorizedBy: "mandate" })]);
  const other = outcomes.find((outcome) => outcome.status !== "confirmed");

  if (other?.authorizedBy === "mandate") {
    expect(other).toMatchObject({ status: "denied", failureCode: "mandate_over_window_cap" });
  } else {
    expect(other).toMatchObject({ authorizedBy: "person", status: "rejected" });
  }

  expect(formatEther((await chain.getBalance({ address: PAYEE })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  expect((await getMandate(mandateId)).usage).toMatchObject({
    uses: 4,
    usesLeft: 6,
    assets: [{ usedInWindow: wei("0.03") }],
  });

  // The window is full. Named, the next payment is refused with the window's code and nothing
  // is recorded; unnamed, it waits for a person.
  const count = await payerIntentCount();
  expect(
    await toolRefusal(
      payer.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.01",
        memo: "over the window, under the mandate",
        mandateId,
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "mandate_over_window_cap" });
  expect(await payerIntentCount()).toBe(count);
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: PAYEE,
      amount: "0.01",
      memo: "over the window",
    }),
  );
});

test("a revoked mandate signs nothing, and the next payment waits for a person", async () => {
  const revoked = await ada.revokeMandate(workspace.id, mandateId);
  expect(revoked).toMatchObject({ id: mandateId, status: "revoked", endedReason: "revoked" });
  expect(revoked.revokedAt).not.toBeNull();
  // What it counted stays counted: nothing is given back.
  expect(revoked.usage).toMatchObject({ uses: 4 });
  // Revoking twice changes nothing.
  expect(await ada.revokeMandate(workspace.id, mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "revoked",
    revokedAt: revoked.revokedAt,
  });

  expect(await payerMandates()).toEqual([]);
  expect(
    await toolRefusal(
      payer.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.001",
        memo: "under a revoked mandate",
        mandateId,
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "mandate_revoked" });
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: PAYEE,
      amount: "0.001",
      memo: "after the revocation",
    }),
  );
  expect(await signerDecisions()).toContainEqual(
    expect.objectContaining({
      action: "revoke-mandate",
      approvalId: revoked.grantApprovalId,
      outcome: "allowed",
    }),
  );

  const ended = await ada.api.call("listMandates", {
    params: { workspaceId: workspace.id },
    query: { agentId: payerId, status: "ended" },
  });

  expect(ended.items.map((item) => item.id)).toContain(mandateId);
});

test("removing the approver who granted a mandate ends that mandate and no other", async () => {
  // Lin joins as an approver, proves her passkey is hers, and Ada approves the change.
  const lin = new Person(stack.origin, "Lin");
  const linId = await joinAsApprover(lin);

  // Lin grants one mandate, Ada another, for the same agent and wallet.
  const byLin = await grantMandate(payerWallet.id, mandateDraft(payerId), lin);
  const byAda = await grantMandate(payerWallet.id, mandateDraft(payerId));
  expect((await getMandate(byLin.mandateId)).grantedBy.map((person) => person.displayName)).toEqual(
    ["Lin"],
  );

  // Lin stops approving: the signer removes her passkey and, in the same transaction, revokes
  // what it granted.
  const demoted = await ada.api.call("setMemberRole", {
    params: { workspaceId: workspace.id, userId: linId },
    body: { role: "viewer" },
  });

  const removal = demoted.approvals.find((item) => item.kind === "remove-approver");

  if (!removal) throw new Error("demoting Lin opened no approver removal");
  await ada.confirm(removal.id);
  expect((await ada.settled(removal.id)).status).toBe("executed");

  expect(await getMandate(byLin.mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "grantor_removed",
  });
  expect(await getMandate(byAda.mandateId)).toMatchObject({ status: "active", endedReason: null });
  expect(await signerDecisions()).toContainEqual(
    expect.objectContaining({
      action: "revoke-mandate-on-grantor-removal",
      approvalId: byLin.grantId,
      outcome: "allowed",
    }),
  );
  expect(
    await toolRefusal(
      payer.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.001",
        memo: "under the mandate Lin granted",
        mandateId: byLin.mandateId,
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "mandate_revoked" });

  const paid = await payer.proposeTransfer({
    chainId: CHAIN,
    to: PAYEE,
    amount: "0.001",
    memo: "under the mandate Ada granted",
  });

  expect(paid).toMatchObject({ authorizedBy: "mandate", mandateId: byAda.mandateId });
  expect(await intentSettles(paid.intentId)).toBe("confirmed");

  // Nothing stays live for the gates that follow.
  await ada.revokeMandate(workspace.id, byAda.mandateId);
});

test("disabling an agent revokes its mandates at the signer and cancels its waiting grants", async () => {
  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Contractor" },
  });

  await setPolicy(payerPolicy(created.agent.id), created.wallet.id);
  const granted = await grantMandate(created.wallet.id, mandateDraft(created.agent.id));

  const waiting = await ada.proposeMandate(
    workspace.id,
    created.wallet.id,
    mandateDraft(created.agent.id),
  );

  await ada.api.call("disableAgent", {
    params: { workspaceId: workspace.id, agentId: created.agent.id },
    body: {},
  });
  expect(await getMandate(granted.mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "agent_disabled",
  });
  expect((await ada.api.call("getApproval", { params: { approvalId: waiting.id } })).status).toBe(
    "cancelled",
  );
  // The signer itself holds it revoked, as its operator's listing on its host shows.
  const listed = await signerAdmin("list-mandates", "--workspace", workspace.id);
  expect(listed.mandates).toContainEqual(
    expect.objectContaining({
      mandateId: granted.mandateId,
      status: "revoked",
      revokedReason: "requested",
    }),
  );

  // The agent's token no longer opens the gateway.
  const refused = await fetch(`${stack.origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  expect(refused.status).toBe(403);
});

test("the operator's revoke-mandate --all on the signer host ends every live mandate of the workspace", async () => {
  const granted = await grantMandate(payerWallet.id, mandateDraft(payerId));
  expect(await payerMandates()).toEqual([granted.mandateId]);

  const revoked = await signerAdmin("revoke-mandate", "--all", "--workspace", workspace.id);
  expect(revoked).toMatchObject({
    ok: true,
    action: "revoke-mandate-by-operator",
    workspaceId: workspace.id,
  });
  expect(revoked.revoked).toContain(granted.mandateId);
  // The control plane was not told; it follows the signer the next time it looks.
  expect(await payerMandates()).toEqual([]);
  expect(await getMandate(granted.mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "operator",
  });
  expect(await signerDecisions()).toContainEqual(
    expect.objectContaining({
      action: "revoke-mandate-by-operator",
      approvalId: granted.grantId,
      outcome: "allowed",
    }),
  );
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: PAYEE,
      amount: "0.001",
      memo: "after the operator revoked it",
    }),
  );
  // Once more changes nothing.
  expect(await signerAdmin("revoke-mandate", "--mandate", granted.mandateId)).toMatchObject({
    ok: true,
    revoked: [],
  });
});

// --- notifications ---------------------------------------------------------------------------
// The e2e overlay points NOTIFY_WEBHOOK_URL at a receiver next to the stack
// (`e2e/src/webhook-receiver.mts`). It has answered 200 to every notification of the gates
// above; these two look at what it received. They run before the fence gate, which stays last,
// and leave no mandate live for it.

/** What the payer types into the proposal below. None of it may reach the webhook. */
const NOTICE_MEMO = `NOTICEMARK${run} pay the notified invoice`;

/** An address no other gate pays, and an amount no other gate sends. */
const NOTICE_RECIPIENT = "0x0000000000000000000000000000000000dec0de";

const NOTICE_AMOUNT = "0.004321";

/** The keys of each event's body, sorted as canonical JSON sorts them (deploy/README.md). */
const APPROVAL_EVENT_KEYS = [
  "approvalId",
  "deliveryId",
  "event",
  "expiresAt",
  "kind",
  "link",
  "v",
  "workspaceId",
];

const MANDATE_EVENT_KEYS = [
  "approvalId",
  "deliveryId",
  "event",
  "link",
  "mandateId",
  "v",
  "workspaceId",
];

test("an approval is announced once, signed, with no sealed content, even after a failed delivery", async () => {
  const secret = await webhookSecret();
  expect(secret.length).toBeGreaterThanOrEqual(32);

  // Whatever reached the receiver so far was a notification of a gate above, signed and accepted.
  for (const request of await receivedRequests()) {
    expect(request.status).toBe(200);
    expect(signatureVerifies(secret, request)).toBe(true);
  }

  await failFirstAttempts(true);

  try {
    const proposal = await payer.proposeTransfer({
      chainId: CHAIN,
      to: NOTICE_RECIPIENT,
      amount: NOTICE_AMOUNT,
      memo: NOTICE_MEMO,
    });

    expect(proposal).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
    const approvalId = approvalIdOf(proposal);

    const requests = await acknowledged(
      (body) => body.approvalId === approvalId && body.event === "approval.opened",
    );

    // One delivery, tried twice: the receiver failed the first attempt and accepted the second,
    // which carried the same delivery id and the same body, signed again.
    expect(requests.map((request) => request.status)).toEqual([503, 200]);
    const [first, second] = requests;

    if (!first || !second) throw new Error("expected two attempts");
    const deliveryId = first.headers["x-os-delivery"];
    expect(deliveryId).toMatch(/^ndl_[0-9a-z]+$/);
    expect(second.headers["x-os-delivery"]).toBe(deliveryId);
    expect(second.body).toBe(first.body);
    expect(Number(second.headers["x-os-timestamp"])).toBeGreaterThanOrEqual(
      Number(first.headers["x-os-timestamp"]),
    );

    const hidden = [
      NOTICE_MEMO,
      `NOTICEMARK${run}`,
      NOTICE_RECIPIENT,
      NOTICE_RECIPIENT.slice(2),
      NOTICE_AMOUNT,
      wei(NOTICE_AMOUNT),
    ];

    for (const request of requests) {
      expect(expectSignedDelivery(secret, request, APPROVAL_EVENT_KEYS, hidden)).toEqual({
        v: 1,
        deliveryId,
        event: "approval.opened",
        approvalId,
        workspaceId: workspace.id,
        kind: "approve-intent",
        expiresAt: proposal.expiresAt,
        // The approval page on the control plane's own origin, with no token in it.
        link: `${stack.origin}/w/${workspace.id}/approvals/${approvalId}`,
      });
    }

    // The server's outbox holds that one delivery, sent after one failed attempt. A sent row is
    // never sent again, so the receiver keeps exactly these two requests about the proposal.
    await expect
      .poll(() => webhookDeliveries(approvalId, "approval.opened"), { timeout: 60_000 })
      .toEqual([{ id: deliveryId, state: "sent", attempts: 1 }]);
    expect(
      (await receivedRequests()).filter((request) => bodyOf(request).approvalId === approvalId),
    ).toHaveLength(2);

    await rejectWaiting(proposal);
  } finally {
    await failFirstAttempts(false);
  }
});

test("a payment under a mandate is announced to the webhook as mandate.used, signed, with no sealed content", async () => {
  const secret = await webhookSecret();
  const { mandateId: granted } = await grantMandate(payerWallet.id, mandateDraft(payerId));
  const memo = `${NOTICE_MEMO}, under a mandate`;
  const paid = await payer.proposeTransfer({ chainId: CHAIN, to: PAYEE, amount: "0.002", memo });
  expect(paid).toMatchObject({ authorizedBy: "mandate", mandateId: granted, approvalUrl: null });

  const requests = await acknowledged(
    (body) => body.event === "mandate.used" && body.mandateId === granted,
  );

  expect(requests).toHaveLength(1);
  const [request] = requests;

  if (!request) throw new Error("expected one delivery");
  const deliveryId = request.headers["x-os-delivery"];

  const body = expectSignedDelivery(secret, request, MANDATE_EVENT_KEYS, [
    memo,
    `NOTICEMARK${run}`,
    PAYEE,
    PAYEE.slice(2),
    "0.002",
    wei("0.002"),
  ]);

  expect(body).toMatchObject({
    event: "mandate.used",
    workspaceId: workspace.id,
    mandateId: granted,
    // The mandate's page, where its uses are listed.
    link: `${stack.origin}/w/${workspace.id}/mandates/${granted}`,
  });

  // `approvalId` names the use's own row: the payment's use of this mandate, which no person
  // decides on and no list of approvals shows.
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    const { rows } = await db.query(
      "SELECT kind, mandate_id, subject_id FROM os.approvals WHERE id = $1",
      [body.approvalId],
    );

    expect(rows).toEqual([{ kind: "mandate-use", mandate_id: granted, subject_id: paid.intentId }]);
  } finally {
    await db.end();
  }

  await expect
    .poll(() => webhookDeliveries(String(body.approvalId), "mandate.used"), { timeout: 60_000 })
    .toEqual([{ id: deliveryId, state: "sent", attempts: 0 }]);
  expect(
    (await receivedRequests()).filter((recorded) => bodyOf(recorded).mandateId === granted),
  ).toHaveLength(1);

  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  // Nothing stays live for the fence gate.
  await ada.revokeMandate(workspace.id, granted);
  expect(await payerMandates()).toEqual([]);
});

// --- stuck transactions -----------------------------------------------------------------------
// A payment that is signed and sent but not mined keeps its account nonce; the server signs it
// again with higher fees by itself, people may speed it up or cancel it, agents may only watch.
// Each gate holds the chain's mining for its own payment and gives it back before it ends
// (`withMiningHeld`), so no gate before or after depends on mining in that window. The e2e
// overlay sets REPRICE_AFTER_SECONDS to 45: the automatic reprice then comes well after a
// person's speed-up may (15 seconds after the newest attempt), so each attempt below has one
// known cause. They pay from the payer's wallet with no mandate live (the gate above revoked its
// last one), so each payment waits for a person, and they leave none live for the fence gate.

/** An address no other gate pays: its balance moves only by the payments below. */
const STUCK_RECIPIENT = "0x0000000000000000000000000000000000057001";

/** Kai, an approver who is not an owner: the one who speeds up and asks for the cancel. */
const kai = new Person(stack.origin, "Kai");

let kaiId: string;

/** `value`, in wei, raised by the stack's REPRICE_BUMP_PERCENT of 12, rounded up. */
const bumped = (value: string) => (BigInt(value) * 112n + 99n) / 100n;

/** Read the intent until its transaction satisfies `ready`, and return both. */
async function transactionOnceSent(
  intentId: string,
  ready: (transaction: TransactionInfo) => boolean,
  timeoutMs = 60_000,
): Promise<{ intent: IntentDetail; transaction: TransactionInfo }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const intent = await ada.api.call("getIntent", { params: { intentId } });
    const { transaction } = intent;

    if (transaction !== null && ready(transaction)) return { intent, transaction };

    if (Date.now() > deadline) {
      throw new Error(
        `intent ${intentId} is ${intent.status}, its transaction ${transaction?.status ?? "not signed"} with ${transaction?.attempts.length ?? 0} attempts`,
      );
    }

    await delay(250);
  }
}

/** The intent's transaction as people see it now. */
async function transactionOf(intentId: string): Promise<TransactionInfo> {
  const { transaction } = await ada.api.call("getIntent", { params: { intentId } });

  if (transaction === null) throw new Error(`intent ${intentId} has no transaction`);

  return transaction;
}

/** What the signer counts as signed from `walletId` in the last 24 hours, in wei of the native coin. */
async function spentNative(walletId: WalletSummary["id"]): Promise<bigint> {
  const { spent } = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId },
  });

  const native = spent.find((entry) => entry.chainId === CHAIN && entry.asset === "native");

  return BigInt(native?.amount ?? "0");
}

/** The newest audit event's number. */
async function auditHead(): Promise<number> {
  const page = await ada.api.call("listAudit", { params: { workspaceId: workspace.id } });

  return page.items[0]?.seq ?? 0;
}

/** The workspace's audit events after `seq`, oldest first, read across pages. */
async function auditAfter(seq: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  for (let cursor: string | undefined; ; ) {
    const page = await ada.api.call("listAudit", {
      params: { workspaceId: workspace.id },
      query: cursor === undefined ? {} : { cursor },
    });

    for (const event of page.items) {
      if (event.seq <= seq) return events.reverse();
      events.push(event);
    }

    if (page.nextCursor === null) return events.reverse();
    cursor = page.nextCursor;
  }
}

/**
 * How many assertions `person`'s passkeys have made: each approval, sign-in and possession proof
 * adds one, so an action that leaves it unchanged asked for no passkey.
 */
function passkeyUses(person: Person): number {
  let uses = 0;

  for (const credential of person.authenticator.credentials.values()) uses += credential.signCount;

  return uses;
}

/** Everything an attempt may not change: all but the two fee fields, as the node reports it. */
function fixedFields(transaction: Transaction) {
  return {
    from: transaction.from.toLowerCase(),
    to: transaction.to?.toLowerCase() ?? null,
    value: transaction.value,
    input: transaction.input,
    nonce: transaction.nonce,
    gas: transaction.gas,
    chainId: transaction.chainId,
    type: transaction.type,
  };
}

/** The attempt the node holds now, checked against what the control plane says it signed. */
async function offered(attempt: TransactionAttemptView): Promise<Transaction> {
  const transaction = await chain.getTransaction({ hash: attempt.hash });
  expect(transaction.blockNumber).toBeNull();
  expect(transaction).toMatchObject({
    gas: BigInt(attempt.gas),
    maxFeePerGas: BigInt(attempt.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(attempt.maxPriorityFeePerGas),
  });

  return transaction;
}

/** Both fees of `next` are at least the bump above `previous`'s. */
function expectRaised(previous: TransactionAttemptView, next: TransactionAttemptView): void {
  expect(BigInt(next.maxFeePerGas)).toBeGreaterThanOrEqual(bumped(previous.maxFeePerGas));
  expect(BigInt(next.maxPriorityFeePerGas)).toBeGreaterThanOrEqual(
    bumped(previous.maxPriorityFeePerGas),
  );
}

/** After the chain mined `mined`, no other attempt of the transaction has a receipt. */
async function expectMinedOnce(
  attempts: TransactionAttemptView[],
  mined: TransactionAttemptView,
): Promise<void> {
  expect((await receiptOf(mined.hash))?.status).toBe("success");

  for (const attempt of attempts) {
    if (attempt.attempt === mined.attempt) continue;
    expect(await receiptOf(attempt.hash), `attempt ${attempt.attempt}`).toBeNull();
  }
}

test("a payment the chain does not mine is signed again with a higher fee by itself, differs only in its fees, and is mined exactly once", async () => {
  const amount = "0.003";
  const before = await chain.getBalance({ address: STUCK_RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });
  const spentBefore = await spentNative(payerWallet.id);
  const auditFrom = await auditHead();
  let intentId = "";
  let approvalId = "";
  let first: Transaction | undefined;

  await withMiningHeld(async (mining) => {
    const proposal = await payer.proposeTransfer({
      chainId: CHAIN,
      to: STUCK_RECIPIENT,
      amount,
      memo: "repriced by the server",
    });

    expect(proposal).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
    intentId = proposal.intentId;
    approvalId = approvalIdOf(proposal);
    await ada.confirm(approvalId);

    // Signed once and offered to the chain, which holds it in its pool.
    const sent = await transactionOnceSent(intentId, (tx) => tx.status === "broadcast");
    expect(sent.transaction.attempts).toHaveLength(1);
    const [original] = sent.transaction.attempts;

    if (!original) throw new Error("no first attempt");
    expect(original).toMatchObject({
      attempt: 0,
      kind: "original",
      status: "pending",
      cancelApprovalId: null,
    });
    first = await offered(original);
    expect(first).toMatchObject({ nonce: nonceBefore, value: parseEther(amount) });
    expect(first.to !== null && isAddressEqual(first.to, STUCK_RECIPIENT)).toBe(true);
    // The signer counted the payment once, when it signed it.
    expect(await spentNative(payerWallet.id)).toBe(spentBefore + parseEther(amount));

    // The node drops it and the chain goes on without it: a block is mined, the payment is not
    // in it, and the wallet's nonce has not moved. Only the server can bring it back.
    const height = await chain.getBlockNumber();
    await chainAdmin.dropTransaction({ hash: original.hash });
    await chainAdmin.mine({ blocks: 1 });
    expect(await chain.getBlockNumber()).toBe(height + 1n);
    expect(await receiptOf(original.hash)).toBeNull();
    expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore);
    // Nothing was repriced yet: the next attempt is due 45 seconds after this one was signed.
    expect((await transactionOf(intentId)).attempts).toHaveLength(1);

    // While it is not mined, people are told why, and that they may act.
    await expect
      .poll(async () => (await transactionOf(intentId)).stuckReason, { timeout: 30_000 })
      .toBe("fee_too_low");
    expect(await transactionOf(intentId)).toMatchObject({
      status: "broadcast",
      minedAttempt: null,
      canSpeedUp: true,
      canCancel: true,
      pendingCancelApprovalId: null,
    });

    // With nobody asking, the server has the signer sign it again with higher fees.
    const { intent, transaction } = await transactionOnceSent(
      intentId,
      (tx) => tx.attempts.length >= 2,
      120_000,
    );

    const [, raised] = transaction.attempts;

    if (!raised) throw new Error("no second attempt");
    expect(raised).toMatchObject({
      attempt: 1,
      kind: "reprice",
      gas: original.gas,
      status: "pending",
      cancelApprovalId: null,
    });
    expect(raised.hash).not.toBe(original.hash);
    expectRaised(original, raised);

    // Every attempt stays inside the ceiling the person approved and the policy's fee cap.
    if (!("maxFeeWei" in intent.intent)) throw new Error("a payment is an EVM intent");
    const ceiling = BigInt(intent.intent.maxFeeWei);
    expect(ceiling).toBeLessThanOrEqual(BigInt(wei("0.01")));

    for (const attempt of transaction.attempts) {
      expect(BigInt(attempt.gas) * BigInt(attempt.maxFeePerGas)).toBeLessThanOrEqual(ceiling);
    }

    // The node holds the new attempt: the first signature's sender, recipient, amount, data,
    // nonce, gas and chain, with only the two fees higher.
    expect(fixedFields(await offered(raised))).toEqual(fixedFields(first));
    // A reprice counts nothing again.
    expect(await spentNative(payerWallet.id)).toBe(spentBefore + parseEther(amount));
    // Recorded as the server's own doing, and allowed by the signer under the payment's approval.
    expect(await auditAfter(auditFrom)).toContainEqual(
      expect.objectContaining({
        action: "transaction.repriced",
        actor: expect.objectContaining({ type: "system" }),
        subject: { type: "approval", id: approvalId },
        detail: expect.objectContaining({
          trigger: "automatic",
          attempt: 1,
          kind: "reprice",
          transactionHash: raised.hash,
        }),
      }),
    );
    expect(await signerDecisions()).toContainEqual(
      expect.objectContaining({ action: "reprice", approvalId, outcome: "allowed" }),
    );

    await mining.resume();
  });

  // Mining resumed: whichever attempt the pool held is mined, once.
  expect(await intentSettles(intentId)).toBe("confirmed");
  const settled = await transactionOf(intentId);
  const mined = settled.attempts.at(-1);

  if (!mined || !first) throw new Error("nothing was mined");
  expect(settled).toMatchObject({
    status: "confirmed",
    minedAttempt: mined.attempt,
    hash: mined.hash,
    stuckReason: null,
    canSpeedUp: false,
    canCancel: false,
  });
  expect(mined.attempt).toBeGreaterThanOrEqual(1);
  expect(settled.attempts.map((attempt) => attempt.status)).toEqual(
    settled.attempts.map((attempt) => (attempt === mined ? "mined" : "not_mined")),
  );
  await expectMinedOnce(settled.attempts, mined);
  expect(fixedFields(await chain.getTransaction({ hash: mined.hash }))).toEqual(fixedFields(first));
  expect(formatEther((await chain.getBalance({ address: STUCK_RECIPIENT })) - before)).toBe(amount);
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  expect(await spentNative(payerWallet.id)).toBe(spentBefore + parseEther(amount));
});

/** The code of an API refusal, when the answer is one; anything else reads as no code. */
const RefusalBody = z
  .object({ error: z.object({ code: z.string().optional() }).optional() })
  .catch({});

test("an approver speeds up a stuck payment with no passkey, and the agent that proposed it sees every attempt but can neither speed it up nor cancel it", async () => {
  kaiId = await joinAsApprover(kai);
  const amount = "0.002";
  const before = await chain.getBalance({ address: STUCK_RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });
  const auditFrom = await auditHead();
  let intentId = "";

  await withMiningHeld(async (mining) => {
    const proposal = await payer.proposeTransfer({
      chainId: CHAIN,
      to: STUCK_RECIPIENT,
      amount,
      memo: "sped up by a person",
    });

    intentId = proposal.intentId;
    await ada.confirm(approvalIdOf(proposal));
    const { transaction } = await transactionOnceSent(intentId, (tx) => tx.status === "broadcast");
    const [original] = transaction.attempts;

    if (!original) throw new Error("no first attempt");
    const first = await offered(original);

    // A click within 15 seconds of the newest attempt adds none: it answers the payment as is.
    expect(nowSeconds()).toBeLessThan(original.signedAt + 15);
    const early = await kai.api.call("speedUp", { params: { intentId }, body: {} });
    expect(early.transaction?.attempts.map((attempt) => attempt.hash)).toEqual([original.hash]);

    // The agent: its tools, none of which acts on a sent payment. Withdrawing it changes
    // nothing once people approved it.
    expect(await payer.tools()).toEqual(AGENT_TOOLS);
    expect(await payer.call("cancel_intent", { intentId })).toEqual({
      intentId,
      status: "broadcast",
    });

    // Its token opens none of the people's routes: from the public origin it is no session...
    for (const action of ["speed-up", "cancel-transaction"]) {
      const response = await fetch(`${stack.origin}/api/v1/intents/${intentId}/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${payerToken}`,
          origin: stack.origin,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "manual",
      });

      const refusal = RefusalBody.parse(await response.json());
      expect({ status: response.status, code: refusal.error?.code }, action).toEqual({
        status: 401,
        code: "unauthenticated",
      });
    }

    // ...and from where an agent runs, the routes are not there at all.
    const script = `
      const post = (path) => fetch("http://agent-gateway" + path, {
        method: "POST",
        headers: { authorization: "Bearer ${payerToken}", "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(4000),
      }).then((r) => r.status, () => "unreachable");
      (async () => {
        console.log(JSON.stringify({
          speedUp: await post("/api/v1/intents/${intentId}/speed-up"),
          cancel: await post("/api/v1/intents/${intentId}/cancel-transaction"),
        }));
      })();`;

    const { output } = await fromAgentsNetwork(script);
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
      speedUp: 404,
      cancel: 404,
    });
    // What the agent can do is watch: get_intent shows the attempt and why it is not mined.
    await expect
      .poll(async () => (await payer.call("get_intent", { intentId })).stuckReason, {
        timeout: 30_000,
      })
      .toBe("fee_too_low");
    expect(await payer.call("get_intent", { intentId })).toMatchObject({
      status: "broadcast",
      transactionHash: original.hash,
      attempts: [
        {
          attempt: 0,
          kind: "original",
          hash: original.hash,
          maxFeePerGas: original.maxFeePerGas,
          maxPriorityFeePerGas: original.maxPriorityFeePerGas,
          status: "pending",
        },
      ],
    });
    // None of that added an attempt or opened a cancel.
    expect(await transactionOf(intentId)).toMatchObject({
      attempts: [expect.objectContaining({ hash: original.hash })],
      pendingCancelApprovalId: null,
    });

    // Fifteen seconds after the first signature Kai's click adds an attempt, and asks for no
    // passkey. The server's own reprice is not due until 45 seconds, so this one is Kai's.
    const spacing = (original.signedAt + 16) * 1000 - Date.now();

    if (spacing > 0) await delay(spacing);
    const uses = passkeyUses(kai);
    const sped = await kai.api.call("speedUp", { params: { intentId }, body: {} });
    expect(passkeyUses(kai)).toBe(uses);
    const attempts = sped.transaction?.attempts ?? [];
    expect(attempts).toHaveLength(2);
    const [, raised] = attempts;

    if (!raised) throw new Error("no second attempt");
    expect(raised).toMatchObject({ attempt: 1, kind: "reprice", gas: original.gas });
    expectRaised(original, raised);
    expect(fixedFields(await offered(raised))).toEqual(fixedFields(first));
    // A second click right after adds nothing.
    const again = await kai.api.call("speedUp", { params: { intentId }, body: {} });
    expect(again.transaction?.attempts.map((attempt) => attempt.hash)).toEqual(
      attempts.map((attempt) => attempt.hash),
    );
    expect(await auditAfter(auditFrom)).toContainEqual(
      expect.objectContaining({
        action: "transaction.repriced",
        actor: expect.objectContaining({ type: "user", id: kaiId }),
        detail: expect.objectContaining({
          trigger: "speed_up",
          attempt: 1,
          transactionHash: raised.hash,
        }),
      }),
    );

    // The agent sees both attempts at the one nonce, and the newest as the hash to follow.
    expect(await payer.call("get_intent", { intentId })).toMatchObject({
      status: "broadcast",
      transactionHash: raised.hash,
      attempts: [
        { attempt: 0, kind: "original", hash: original.hash, status: "pending" },
        { attempt: 1, kind: "reprice", hash: raised.hash, status: "pending" },
      ],
    });

    await mining.resume();
  });

  expect(await intentSettles(intentId)).toBe("confirmed");
  const settled = await transactionOf(intentId);
  const [original, raised] = settled.attempts;

  if (!original || !raised) throw new Error("the attempts are gone");
  expect(settled).toMatchObject({ status: "confirmed", minedAttempt: 1, hash: raised.hash });
  expect(settled.attempts.map((attempt) => attempt.status)).toEqual(["not_mined", "mined"]);
  await expectMinedOnce(settled.attempts, raised);
  expect(formatEther((await chain.getBalance({ address: STUCK_RECIPIENT })) - before)).toBe(amount);
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  expect(await payer.call("get_intent", { intentId })).toMatchObject({
    status: "confirmed",
    transactionHash: raised.hash,
    stuckReason: null,
    attempts: [
      { attempt: 0, status: "not_mined" },
      { attempt: 1, status: "mined" },
    ],
  });
  // Mined, it cannot be sped up any more.
  expect(await apiRefusal(kai.api.call("speedUp", { params: { intentId }, body: {} }))).toEqual({
    code: "conflict",
    detail: "not_repriceable",
  });
});

test("a cancel a person asks for, approved on the confirmation page at the wallet's threshold while the workspace is paused, is mined in the payment's place: nothing moves, the nonce is used once, and the spend still counts", async () => {
  const amount = "0.004";
  const before = await chain.getBalance({ address: STUCK_RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payerWallet.address });
  const spentBefore = await spentNative(payerWallet.id);
  const auditFrom = await auditHead();
  let intentId = "";
  let approvalId = "";
  let cancelId = "";
  let walletBefore = 0n;

  await withMiningHeld(async (mining) => {
    const proposal = await payer.proposeTransfer({
      chainId: CHAIN,
      to: STUCK_RECIPIENT,
      amount,
      memo: "cancelled by people",
    });

    intentId = proposal.intentId;
    approvalId = approvalIdOf(proposal);
    await ada.confirm(approvalId);

    const { intent, transaction } = await transactionOnceSent(
      intentId,
      (tx) => tx.status === "broadcast",
    );

    const [original] = transaction.attempts;

    if (!original) throw new Error("no first attempt");
    expect(await spentNative(payerWallet.id)).toBe(spentBefore + parseEther(amount));

    // Paused: the server raises no fee, and nobody can, but a cancel still works.
    await ada.api.call("pauseWorkspace", { params: { workspaceId: workspace.id }, body: {} });
    await expect
      .poll(async () => (await transactionOf(intentId)).stuckReason, { timeout: 30_000 })
      .toBe("workspace_paused");
    expect(await transactionOf(intentId)).toMatchObject({
      canSpeedUp: false,
      canCancel: true,
      pendingCancelApprovalId: null,
    });

    // Kai asks. Asking again, as anyone, answers the request that waits.
    const cancel = await kai.api.call("requestCancel", { params: { intentId }, body: {} });
    cancelId = cancel.id;
    const policyThreshold = payerPolicy(payerId).approvals.threshold;
    expect(cancel).toMatchObject({
      kind: "cancel-transaction",
      status: "pending",
      threshold: policyThreshold,
      approvals: 0,
      // The request is named after the payment's own request, which also names the recipient.
      title: expect.stringContaining(`Cancel payment: ${intent.display.title}`),
    });
    expect((await ada.api.call("requestCancel", { params: { intentId }, body: {} })).id).toBe(
      cancel.id,
    );
    expect(await transactionOf(intentId)).toMatchObject({
      canCancel: false,
      pendingCancelApprovalId: cancel.id,
    });
    const detail = await ada.api.call("getApproval", { params: { approvalId: cancel.id } });

    if (detail.subject.kind !== "cancel-transaction") throw new Error("not a cancel");
    expect(detail.subject).toMatchObject({
      intent: { id: intentId },
      sweep: null,
      txNonce: nonceBefore,
      maxFeeWei: wei("0.01"),
    });
    expect(detail.envelope).toMatchObject({
      type: "cancel-transaction",
      targetApprovalId: approvalId,
      walletId: payerWallet.id,
      chainId: CHAIN,
      txNonce: nonceBefore,
      maxFeeWei: wei("0.01"),
    });

    // The confirmation page shows, from the signer's own record of the payment, what the cancel
    // would stop, and that it is only an attempt. Nothing is signed before people approve it.
    const link = await ada.confirmationLink(cancel.id);
    expect(link.origin).toBe(stack.approveOrigin);
    const view = await ada.readConfirmation(link);
    expect(view).toMatchObject({
      approvalId: cancel.id,
      kind: "cancel-transaction",
      state: "open",
      title: `Try to cancel sending ${amount} ETH`,
    });
    expect(view.envelope).toEqual(detail.envelope);
    expect(view.lines.map((line) => line.value).join("\n")).toContain(STUCK_RECIPIENT);
    expect(view.lines).toContainEqual(
      expect.objectContaining({ label: "Transaction number (nonce)", value: String(nonceBefore) }),
    );
    expect(view.lines.map((line) => line.label)).toContain("Cancelling is an attempt");
    expect((await transactionOf(intentId)).attempts).toHaveLength(1);

    // Ada approves it there, at the policy's threshold; the signer signs the cancel while the
    // workspace is paused, and the server offers it to the chain.
    expect(await ada.approveOnConfirmationPage(link, view)).toMatchObject({
      collected: 1,
      required: policyThreshold,
    });
    await ada.api.call("collectApproval", { params: { approvalId: cancel.id }, body: {} });
    expect((await ada.settled(cancel.id)).status).toBe("executed");
    const { attempts } = await transactionOf(intentId);
    expect(attempts).toHaveLength(2);
    const [, cancelling] = attempts;

    if (!cancelling) throw new Error("no cancel attempt");
    expect(cancelling).toMatchObject({
      attempt: 1,
      kind: "cancel",
      gas: "21000",
      cancelApprovalId: cancel.id,
      status: "pending",
    });
    expectRaised(original, cancelling);
    expect(BigInt(cancelling.gas) * BigInt(cancelling.maxFeePerGas)).toBeLessThanOrEqual(
      BigInt(wei("0.01")),
    );
    // As the node holds it: a transfer of nothing from the wallet to itself, at the payment's
    // nonce.
    const pooled = await offered(cancelling);
    expect(pooled).toMatchObject({ nonce: nonceBefore, value: 0n, input: "0x" });
    expect(isAddressEqual(pooled.from, payerWallet.address)).toBe(true);
    expect(pooled.to !== null && isAddressEqual(pooled.to, payerWallet.address)).toBe(true);

    walletBefore = await chain.getBalance({ address: payerWallet.address });
    await mining.resume();
  });

  // The cancel is mined in the payment's place: the payment ends voided and moved nothing.
  expect(await intentSettles(intentId)).toBe("voided");
  const voided = await ada.api.call("getIntent", { params: { intentId } });
  expect(voided).toMatchObject({ status: "voided", failureCode: "transaction_cancelled" });
  const settled = voided.transaction;

  if (!settled) throw new Error("the transaction is gone");
  const [original, cancelling] = settled.attempts;

  if (!original || !cancelling) throw new Error("the attempts are gone");
  expect(settled).toMatchObject({ status: "cancelled", minedAttempt: 1, hash: cancelling.hash });
  expect(settled.attempts.map((attempt) => attempt.status)).toEqual(["not_mined", "mined"]);
  await expectMinedOnce(settled.attempts, cancelling);
  expect(await chain.getBalance({ address: STUCK_RECIPIENT })).toBe(before);
  expect(await chain.getTransactionCount({ address: payerWallet.address })).toBe(nonceBefore + 1);
  // The wallet paid the cancel's network fee and nothing else.
  const receipt = await receiptOf(cancelling.hash);

  if (!receipt) throw new Error("the cancel has no receipt");
  expect(walletBefore - (await chain.getBalance({ address: payerWallet.address }))).toBe(
    receipt.gasUsed * receipt.effectiveGasPrice,
  );
  // A landed cancel gives no spend back: the payment still counts toward the wallet's limits.
  expect(await spentNative(payerWallet.id)).toBe(spentBefore + parseEther(amount));

  const events = await auditAfter(auditFrom);
  expect(events).toContainEqual(
    expect.objectContaining({
      action: "transaction.cancel_requested",
      actor: expect.objectContaining({ type: "user", id: kaiId }),
      subject: { type: "approval", id: approvalId },
      detail: expect.objectContaining({ cancelApprovalId: cancelId, intentId }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      action: "transaction.cancel_signed",
      subject: { type: "approval", id: approvalId },
      detail: expect.objectContaining({
        cancelApprovalId: cancelId,
        transactionHash: cancelling.hash,
      }),
    }),
  );
  expect(await signerDecisions()).toContainEqual(
    expect.objectContaining({
      action: "cancel-transaction",
      approvalId: cancelId,
      outcome: "allowed",
    }),
  );
  // The agent sees how it ended, and both attempts.
  expect(await payer.call("get_intent", { intentId })).toMatchObject({
    status: "voided",
    failureCode: "transaction_cancelled",
    transactionHash: cancelling.hash,
    attempts: [
      { attempt: 0, kind: "original", status: "not_mined" },
      { attempt: 1, kind: "cancel", hash: cancelling.hash, status: "mined" },
    ],
  });
  // Nothing is left to cancel.
  expect(
    await apiRefusal(kai.api.call("requestCancel", { params: { intentId }, body: {} })),
  ).toEqual({ code: "conflict", detail: "transaction_final" });

  // Resume for the gate that follows; resuming needs the passkey, as always.
  const resume = await ada.api.call("requestResume", {
    params: { workspaceId: workspace.id },
    body: {},
  });

  await ada.confirm(resume.id);
  expect((await ada.settled(resume.id)).status).toBe("executed");
});

// Last: the fence refuses every envelope issued before it, plus the clock skew, so nothing is
// granted or approved after it in this file.
test("the operator's restore fence ends every live mandate", async () => {
  const granted = await grantMandate(payerWallet.id, mandateDraft(payerId));

  const paid = await payer.proposeTransfer({
    chainId: CHAIN,
    to: PAYEE,
    amount: "0.001",
    memo: "before the fence",
  });

  expect(paid).toMatchObject({ authorizedBy: "mandate", mandateId: granted.mandateId });
  expect(await intentSettles(paid.intentId)).toBe("confirmed");

  // The fence step of every restore (deploy/README.md), run on the signer host while it serves.
  expect(await signerAdmin("fence")).toMatchObject({ ok: true, action: "fence-set-by-operator" });
  expect(await getMandate(granted.mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "operator",
    usage: { uses: 1 },
  });
  expect(await signerDecisions()).toContainEqual(
    expect.objectContaining({
      action: "revoke-mandate-on-fence",
      approvalId: granted.grantId,
      outcome: "allowed",
    }),
  );
  expect(await payerMandates()).toEqual([]);
  await rejectWaiting(
    await payer.proposeTransfer({
      chainId: CHAIN,
      to: PAYEE,
      amount: "0.001",
      memo: "after the fence",
    }),
  );
});
