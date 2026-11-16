/**
 * What the gates of one stack variant (`replicas.spec.ts`, `openbao.spec.ts`) start from: a fresh
 * installation claimed by Ada with the setup token, one workspace, and an agent whose wallet is
 * funded and may pay under a policy approved on the signer's confirmation page. The release
 * gates build the same with more people and rules; these files run on stacks of their own.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { PolicyDraft, WalletSummary, WorkspaceDetail } from "@askgina/os-api";
import { expect } from "@playwright/test";
import { parseEther } from "viem";
import { type AgentConnection, connectAgent } from "./agent.ts";
import { chainAdmin } from "./chain.ts";
import { Person } from "./person.ts";
import { setupToken, stack } from "./stack.ts";

export const CHAIN = "eip155:31337";

export interface PayingAgent {
  workspace: WorkspaceDetail;
  wallet: WalletSummary;
  agentId: string;
  agentToken: string;
  agent: AgentConnection;
}

/** Claim the fresh installation as Ada with a setup token from the operator's command. */
export async function claim(): Promise<Person> {
  const ada = new Person(stack.origin, "Ada");
  const session = await ada.setUp(await setupToken());
  expect(session.setupRequired).toBe(false);

  return ada;
}

/**
 * A workspace named `name` with one agent, its wallet funded with 1 ETH on the local chain and
 * allowed to pay anyone up to 0.05 ETH at a time and 0.5 a day once a person approves.
 */
export async function payingAgent(ada: Person, name: string): Promise<PayingAgent> {
  const workspace = await ada.api.call("createWorkspace", { body: { name } });

  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Payer" },
  });

  const draft: PolicyDraft = {
    chains: [CHAIN],
    requesters: [created.agent.id],
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerTx: parseEther("0.05").toString(),
        maxPerDay: parseEther("0.5").toString(),
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: parseEther("0.01").toString() },
    approvals: { threshold: 1, ttlSeconds: 3600 },
  };

  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: created.wallet.id },
    body: { draft },
  });

  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
  await chainAdmin.setBalance({ address: created.wallet.address, value: parseEther("1") });

  return {
    workspace,
    wallet: created.wallet,
    agentId: created.agent.id,
    agentToken: created.token,
    agent: await connectAgent(`${stack.origin}/mcp`, created.token),
  };
}

/** The agent proposes a payment; a person must approve it. */
export async function propose(
  agent: AgentConnection,
  to: string,
  amount: string,
  memo: string,
): Promise<{ intentId: string; approvalId: string }> {
  const result = await agent.call("propose_transfer", { chainId: CHAIN, to, amount, memo });

  return {
    intentId: String(result.intentId),
    approvalId: String(result.approvalUrl).split("/").at(-1) ?? "",
  };
}

/**
 * The status an intent ends in, once it leaves the waiting ones. An answer the stack cannot give
 * for a moment (a replica just died, a key provider is paused) is asked again until `timeoutMs`.
 */
export async function intentSettles(
  ada: Person,
  intentId: string,
  timeoutMs: number,
): Promise<string> {
  const pending = ["proposed", "pending_approval", "approved", "signed", "broadcast"];
  const deadline = Date.now() + timeoutMs;
  let last = "no answer yet";

  for (;;) {
    try {
      const { status } = await ada.api.call("getIntent", { params: { intentId } });

      if (!pending.includes(status)) return status;
      last = status;
    } catch (error) {
      last = `no answer: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (Date.now() > deadline) throw new Error(`intent ${intentId} is still ${last}`);
    await delay(250);
  }
}
