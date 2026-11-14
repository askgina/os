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
import { Person } from "../src/person.ts";
import {
  compose,
  composeArgs,
  databaseUrl,
  fromAgentsNetwork,
  restoreInto,
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

async function setPolicy(draft: PolicyDraft): Promise<void> {
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
    body: { draft },
  });
  expect(request.kind).toBe("set-policy");
  await ada.approve(request.id);
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
      for (const host of ["server", "postgres", "signer", "anvil", "caddy"]) {
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

test("a restored backup keeps wallets and waiting approvals, and refuses a spent one", async () => {
  // Something still waiting when the backup is taken: its workflow is suspended, encrypted.
  const waiting = await propose("0.005", "approved only after the restore");
  await agent.close();

  await restoreInto(`${stack.project}-restore`);

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

  // The chain is not part of a backup: the restored stack has a fresh local one.
  await chainAdmin.setBalance({ address: wallet.address, value: parseEther("1") });
  const before = await chain.getBalance({ address: RECIPIENT });
  await ada.approve(waiting.approvalId);
  expect(await intentSettles(waiting.intentId, 200_000)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.005");

  // And the restored stack keeps working for new proposals.
  agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
  const fresh = await propose("0.001", "after the restore");
  await ada.approve(fresh.approvalId);
  expect(await intentSettles(fresh.intentId)).toBe("confirmed");
});
