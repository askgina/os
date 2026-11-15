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
  type MandateDraft,
  type PolicyDraft,
  type WalletSummary,
  type WorkspaceDetail,
} from "@askgina/os-api";
import { keyFingerprint } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import { b64url, coseEc2, SoftAuthenticator } from "@askgina/os-protocol/testing";
import { scanForMarkers } from "@askgina/os-testkit";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createPublicClient, createTestClient, formatEther, http, parseEther } from "viem";
import { foundry } from "viem/chains";
import { type AgentConnection, connectAgent, type Proposal, ToolRefused } from "../src/agent.ts";
import { ConfirmationRefused, Person } from "../src/person.ts";
import {
  backUpInto,
  compose,
  composeArgs,
  databaseUrl,
  exec,
  fromAgentsNetwork,
  restoreFrom,
  setupToken,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import {
  bodyOf,
  failFirstAttempts,
  type ReceivedRequest,
  receivedRequests,
  signatureVerifies,
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

const chain = createPublicClient({
  chain: foundry,
  transport: http(stack.anvilUrl),
  cacheTime: 0,
});
const chainAdmin = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(stack.anvilUrl),
});

const ada = new Person(stack.origin, "Ada");
let workspace: WorkspaceDetail;
let wallet: WalletSummary;
let agentId: string;
let agentToken: string;
let agent: AgentConnection;
/** The approval of the first confirmed payment, used later to show it cannot be used again. */
let spentApprovalId: string;

function policy(extra: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    chains: [CHAIN],
    requesters: [agentId as PolicyDraft["requesters"][number]],
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

function approvalIdOf(result: Record<string, unknown>): string {
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
    (error: unknown) => error,
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

/** The workspace's whole signer decision log, read to its end: a page holds the oldest 100. */
/**
 * Kill the server as a crash would, and return only once its container has stopped. `kill`
 * returns before that, and an `up --wait` that still sees the container running then fails
 * when it exits.
 */
async function killServer(): Promise<void> {
  await compose("kill", "server");
  await compose("stop", "--timeout", "0", "server");
}

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
  expect(await agent.tools()).toEqual([
    "cancel_intent",
    "get_balances",
    "get_intent",
    "list_intents",
    "propose_contract_call",
    "propose_transfer",
    "whoami",
  ]);
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
    (error: unknown) => error,
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
  expect(seen.ui).toBe(404);
  expect(seen.workflow).toBe(404);
  expect(seen.internet).toBe("unreachable");
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
  const sweep = (to: string) =>
    ada.api.call("requestSweep", {
      params: { workspaceId: workspace.id, walletId: retired.wallet.id },
      body: { chainId: CHAIN, asset: "native", to: to as `0x${string}` },
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
  return (mandates as { mandateId: string }[]).map((mandate) => mandate.mandateId);
}

/** How many proposals the payer has made, as it lists them. */
async function payerIntentCount(): Promise<number> {
  const { intents } = await payer.call("list_intents", { limit: 50 });
  return (intents as unknown[]).length;
}

/** The code and reason a tool refused `attempt` with; fails when it was not refused. */
async function toolRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string | null; detail: string | null }> {
  const outcome = await attempt.then(
    () => null,
    (error: unknown) => error,
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
    (error: unknown) => error,
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

/** Run one of the signer's operator commands on its host, as the deploy guide does. */
async function signerAdmin(...args: string[]): Promise<Record<string, unknown>> {
  const output = await exec("signer", "node", "src/admin.ts", ...args);
  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
}

/** Run the example agent once, in a container on the agents network, to its end. */
async function runExampleAgent(
  env: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  const variables = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  try {
    return { exitCode: 0, output: await compose("run", "--rm", ...variables, "scripted-agent") };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
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
  const invite = await ada.api.call("createInvite", {
    params: { workspaceId: workspace.id },
    body: { role: "approver" },
  });
  const { user } = await lin.join(invite.url);
  if (!user) throw new Error("Lin did not join");
  const pending = await ada.api.call("listApprovals", {
    params: { workspaceId: workspace.id },
    query: { status: "pending" },
  });
  let addLin: string | undefined;
  for (const item of pending.items.filter((candidate) => candidate.kind === "add-approver")) {
    const change = await ada.api.call("getApproval", { params: { approvalId: item.id } });
    if (change.subject.kind === "add-approver" && change.subject.user.id === user.id) {
      addLin = item.id;
    }
  }
  if (!addLin) throw new Error("joining as an approver opened no approver change");
  await lin.provePossession(addLin);
  await ada.confirm(addLin);
  expect((await ada.settled(addLin)).status).toBe("executed");

  // Lin grants one mandate, Ada another, for the same agent and wallet.
  const byLin = await grantMandate(payerWallet.id, mandateDraft(payerId), lin);
  const byAda = await grantMandate(payerWallet.id, mandateDraft(payerId));
  expect((await getMandate(byLin.mandateId)).grantedBy.map((person) => person.displayName)).toEqual(
    ["Lin"],
  );

  // Lin stops approving: the signer removes her passkey and, in the same transaction, revokes
  // what it granted.
  const demoted = await ada.api.call("setMemberRole", {
    params: { workspaceId: workspace.id, userId: user.id },
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

/** The recorded requests whose body `match` selects, once the receiver accepted one of them. */
async function acknowledged(
  match: (body: Record<string, unknown>) => boolean,
): Promise<ReceivedRequest[]> {
  let matching: ReceivedRequest[] = [];
  await expect
    .poll(
      async () => {
        matching = (await receivedRequests()).filter((request) => match(bodyOf(request)));
        return matching.some((request) => request.status === 200);
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  return matching;
}

/** The webhook's outbox rows for one request or use and one event, as the server keeps them. */
async function webhookDeliveries(
  approvalId: string,
  event: string,
): Promise<{ id: string; state: string; attempts: number }[]> {
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string; state: string; attempts: number }>(
      "SELECT id, state, attempts FROM os.notification_deliveries WHERE approval_id = $1 AND event = $2 AND target = 'webhook' ORDER BY id",
      [approvalId, event],
    );
    return rows;
  } finally {
    await db.end();
  }
}

/**
 * Check one recorded attempt the way the deploy guide tells a receiver to: a JSON POST, signed
 * with the secret from the server's volume over its exact bytes, with a timestamp within 300
 * seconds, and a body that is canonical JSON with exactly `keys` and none of `secrets`.
 */
function expectSignedDelivery(
  secret: string,
  request: ReceivedRequest,
  keys: string[],
  secrets: string[],
): Record<string, unknown> {
  expect(request.method).toBe("POST");
  expect(request.headers["content-type"]).toBe("application/json");
  expect(signatureVerifies(secret, request)).toBe(true);
  // One more byte and it no longer verifies: the check above is a real one.
  expect(signatureVerifies(secret, { ...request, body: `${request.body} ` })).toBe(false);
  const timestamp = Number(request.headers["x-os-timestamp"]);
  expect(Number.isInteger(timestamp)).toBe(true);
  expect(Math.abs(request.receivedAt / 1000 - timestamp)).toBeLessThanOrEqual(300);

  const body = bodyOf(request);
  expect(Object.keys(body)).toEqual(keys);
  // Sorted keys and no white space: the exact bytes JSON.stringify gives for what it parsed.
  expect(request.body).toBe(JSON.stringify(body));
  expect(body).toMatchObject({ v: 1, deliveryId: request.headers["x-os-delivery"] });
  const seen = `${JSON.stringify(request.headers)}\n${request.body}`.toLowerCase();
  for (const value of secrets) expect(seen).not.toContain(value.toLowerCase());
  return body;
}

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
