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
import type { PolicyDraft, WalletSummary, WorkspaceDetail } from "@askgina/os-api";
import { scanForMarkers } from "@askgina/os-testkit";
import { expect, test } from "@playwright/test";
import { createPublicClient, createTestClient, formatEther, http, parseEther } from "viem";
import { foundry } from "viem/chains";
import { type AgentConnection, connectAgent, ToolRefused } from "../src/agent.ts";
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

/** Ask for a new policy and approve it, by default on the control plane's own page. */
async function setPolicy(
  draft: PolicyDraft,
  approve: (approvalId: string) => Promise<unknown> = (approvalId) => ada.approve(approvalId),
): Promise<void> {
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
    body: { draft },
  });
  expect(request.kind).toBe("set-policy");
  await approve(request.id);
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

  await ada.approve(approvalId);
  expect(await intentSettles(intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);

  // The approval is spent: presenting it again changes nothing.
  await expect(ada.approve(approvalId)).rejects.toThrow();
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);
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
  await Promise.all([ada.approve(first.approvalId), ada.approve(second.approvalId)]);

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

  // This change is approved on the signer's confirmation page.
  await setPolicy(
    policy({ contractCalls: { mode: "allowlist", targets: [CALL_TARGET] } }),
    (approvalId) => ada.confirm(approvalId),
  );
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
  await ada.approve(approvalId);

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
  const approving = ada.approve(approvalId).catch(() => undefined);
  await delay(4_000);
  await compose("kill", "server");
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
  await ada.approve(elsewhere.id);
  expect(await ada.settled(elsewhere.id)).toMatchObject({
    status: "failed",
    failureCode: "sweep_destination_not_allowed",
  });
  expect(await chain.getTransactionCount({ address: retired.wallet.address })).toBe(nonceBefore);

  // The treasury: one transaction, the approved amount, also while the workspace is paused.
  const treasuryBefore = await chain.getBalance({ address: treasury.address });
  const toTreasury = await sweep(treasury.address);
  await ada.approve(toTreasury.id);
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
  await ada.approve(resume.id);
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
  await ada.approve(paidAfterBackup.approvalId);
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
  await expect(ada.approve(spentApprovalId)).rejects.toThrow();

  // The chain is not part of a backup: the restored stack has a fresh local one. Whatever the
  // signer signed now would land on it.
  await chainAdmin.setBalance({ address: wallet.address, value: parseEther("1") });
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });

  // The restored control plane shows the payment made after the backup as waiting again. A
  // person who approves it is refused by the signer, whatever the control plane asks.
  const shown = await ada.api.call("getApproval", {
    params: { approvalId: paidAfterBackup.approvalId },
  });
  expect(shown.status).toBe("pending");
  for (const proposal of [paidAfterBackup, waiting]) {
    await ada.approve(proposal.approvalId);
    expect(await intentSettles(proposal.intentId, 200_000)).toBe("failed");
    const intent = await ada.api.call("getIntent", { params: { intentId: proposal.intentId } });
    expect(intent.failureCode).toBe("envelope_fenced");
  }
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore);
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(before);
  // The restored file is a new file, so the signer may already have fenced it when the operator's
  // command opened it; within the same second the operator's fence then changes nothing. The log
  // is read to its end: a page holds the oldest 100 entries.
  const actions: string[] = [];
  for (let after = 0; ; ) {
    const page = await ada.api.call("listSignerDecisions", {
      params: { workspaceId: workspace.id },
      query: { after: String(after) },
    });
    actions.push(...page.items.map((decision) => decision.action));
    const last = page.items.at(-1);
    if (!last || page.items.length < 100) break;
    after = last.seq;
  }
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
  await ada.approve(fresh.approvalId);
  expect(await intentSettles(fresh.intentId)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.001");
});
