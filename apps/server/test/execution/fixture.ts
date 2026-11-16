import type { PolicyDraft } from "@askgina/os-api";
import type { AgentId, ApprovalId, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTestClient, http, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { z } from "zod";
import type { Config } from "../../src/config.ts";
import { registerExecution } from "../../src/execution/index.ts";
import { mountMcp } from "../../src/mcp/gateway.ts";
import {
  createTestContext,
  TEST_CHAIN_ID,
  TEST_ORIGIN,
  TEST_RPC_URL,
  type TestContext,
  type TestContextOptions,
  type TestPerson,
} from "../support/context.ts";
import { TOKEN_BYTECODE } from "./token.ts";

export const anvil = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(TEST_RPC_URL),
})
  .extend(publicActions)
  .extend(walletActions);

export interface TestAgent {
  id: AgentId;
  token: string;
  walletId: WalletId;
  address: `0x${string}`;
}

export interface Fixture {
  t: TestContext;
  workspaceId: WorkspaceId;
  agent: TestAgent;
  newAgent(name: string, workspaceId?: WorkspaceId): Promise<TestAgent>;
  newWorkspace(name: string): Promise<WorkspaceId>;
  /** Ask for a policy and approve it with the owner's passkey, as the UI would. */
  setPolicy(workspaceId: WorkspaceId, walletId: WalletId, draft: PolicyDraft): Promise<void>;
  mcp(token: string, headers?: Record<string, string>): Promise<Client>;
  /** Invite a person as an approver and enroll their passkey, approved by the owner. */
  addApprover(workspaceId: WorkspaceId, displayName: string): Promise<TestPerson>;
  close(): Promise<void>;
}

export function draftFor(agentId: AgentId, overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    chains: [TEST_CHAIN_ID],
    requesters: [agentId],
    assets: [
      {
        chainId: TEST_CHAIN_ID,
        asset: "native",
        maxPerTx: "5000000000000000000",
        maxPerDay: "10000000000000000000",
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: "100000000000000000" },
    approvals: { threshold: 1, ttlSeconds: 3_600 },
    ...overrides,
  };
}

export async function fund(address: `0x${string}`, wei: bigint): Promise<void> {
  await anvil.setBalance({ address, value: wei });
}

/** Deploy the test token with `supply` base units held by `holder`; returns its address. */
export async function deployToken(holder: `0x${string}`, supply: bigint): Promise<`0x${string}`> {
  const [deployer] = await anvil.getAddresses();

  if (!deployer) throw new Error("anvil has no unlocked account");

  const hash = await anvil.deployContract({
    abi: [
      {
        type: "constructor",
        inputs: [
          { name: "holder", type: "address" },
          { name: "supply", type: "uint256" },
        ],
        stateMutability: "nonpayable",
      },
    ],
    bytecode: TOKEN_BYTECODE,
    args: [holder, supply],
    account: deployer,
  });

  const receipt = await anvil.waitForTransactionReceipt({ hash });

  if (!receipt.contractAddress) throw new Error("token deployment failed");

  return receipt.contractAddress.toLowerCase() as `0x${string}`;
}

export async function createFixture(
  label: string,
  pollSeconds = 1,
  signer: TestContextOptions["signer"] = {},
  config: Partial<Config> = {},
): Promise<Fixture> {
  const t = await createTestContext({
    label,
    signer,
    // The test pool is small; Graphile needs a connection per concurrent delivery.
    config: { workflowWorkerConcurrency: 4, ...config },
    routes: (app, ctx) => {
      registerExecution(app, ctx, { pollSeconds });
      mountMcp(app, ctx);
    },
  });

  const api = t.owner.browser.api;

  const newWorkspace = async (name: string) =>
    (await api.call("createWorkspace", { body: { name } })).id as WorkspaceId;

  const setPolicy = async (workspaceId: WorkspaceId, walletId: WalletId, draft: PolicyDraft) => {
    const approval = await api.call("requestPolicy", {
      params: { workspaceId, walletId },
      body: { draft },
    });

    const row = await t.approve(approval.id as ApprovalId, [t.owner]);

    if (row.status !== "executed") throw new Error(`policy approval ended ${row.status}`);
  };

  const newAgent = async (name: string, workspaceId: WorkspaceId = defaultWorkspace) => {
    const created = await api.call("createAgent", { params: { workspaceId }, body: { name } });

    return {
      id: created.agent.id as AgentId,
      token: created.token,
      walletId: created.wallet.id as WalletId,
      address: created.wallet.address as `0x${string}`,
    };
  };

  const defaultWorkspace = await newWorkspace("Execution tests");
  const agent = await newAgent("Trader");
  await setPolicy(defaultWorkspace, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 100n * 10n ** 18n);

  const clients: Client[] = [];

  return {
    t,
    workspaceId: defaultWorkspace,
    agent,
    newAgent,
    newWorkspace,
    setPolicy,
    async addApprover(workspaceId, displayName) {
      const invite = await api.call("createInvite", {
        params: { workspaceId },
        body: { role: "approver" },
      });

      const token = invite.url.split("/").at(-1) ?? "";
      const browser = t.browser();

      const start = await browser.api.call("startInviteRegistration", {
        params: { token },
        body: { displayName },
      });

      const passkey = t.register(start.options);

      const session = await browser.api.call("finishInviteRegistration", {
        params: { token },
        body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
      });

      if (session.user === null) throw new Error("invite registration did not sign in");

      const pending = await api.call("listApprovals", {
        params: { workspaceId },
        query: { status: "pending" },
      });

      for (const approval of pending.items.filter((item) => item.kind === "add-approver")) {
        const row = await t.approve(approval.id as ApprovalId, [t.owner]);

        if (row.status !== "executed") throw new Error(`add-approver ended ${row.status}`);
      }

      return {
        userId: session.user.id,
        displayName,
        credentialId: passkey.credentialId,
        browser,
      };
    },
    async mcp(token, headers = {}) {
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", TEST_ORIGIN), {
        requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
        fetch: async (input, init) => t.app.fetch(new Request(input, init)),
      });

      const client = new Client({ name: "test-agent", version: "1.0.0" });
      await client.connect(transport);
      clients.push(client);

      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      await t.close();
    },
  };
}

/** The JSON a tool answered with, or its error body. */
const ToolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

export function toolJson(result: unknown): Record<string, unknown> {
  const text = ToolResult.parse(result).content.find((part) => part.type === "text")?.text;

  return z.record(z.string(), z.unknown()).parse(JSON.parse(text ?? "{}"));
}
