import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import type { PolicyDraft } from "@askgina/os-api";
import {
  Address,
  type AgentId,
  IntentId,
  type WalletId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import type { FakeHyperliquid } from "@askgina/os-testkit/fake-hyperliquid";
import {
  type CallToolRequestParams,
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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

/** A fake venue on a loopback port: what a test points `VENUES_FILE`'s `apiUrl` at. */
export interface ServedVenue {
  apiUrl: string;
  /** Every request it received, oldest first, recorded as it arrives. */
  requests: { method: string; path: string; body: string }[];
  /** Answer nothing until the function this returns is called; requests are still recorded. */
  hold(): () => void;
  close(): Promise<void>;
}

/** What `server.address()` is for a server listening on a TCP port. */
const ListeningAddress = z.object({ port: z.number() });

/**
 * The testkit's fake Hyperliquid served over HTTP on loopback, so the server's own client reaches
 * it as it would the venue: a dropped answer closes the connection unanswered, and a redirect
 * carries its `location`.
 */
export async function serveVenue(venue: FakeHyperliquid): Promise<ServedVenue> {
  const requests: ServedVenue["requests"] = [];
  let held = Promise.resolve();

  const server = createServer(async (request, response) => {
    const body = (await buffer(request)).toString("utf8");
    const path = new URL(request.url ?? "/", "http://fake-hyperliquid").pathname;
    const method = request.method ?? "GET";
    requests.push({ method, path, body });
    await held;
    const answer = await venue.handle({ method, path, body });

    if (answer.kind === "drop") {
      response.destroy();

      return;
    }

    if (answer.location !== undefined) response.setHeader("location", answer.location);
    response.writeHead(answer.status, { "content-type": answer.contentType });
    response.end(answer.status === 204 ? undefined : answer.body);
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;

  return {
    apiUrl: `http://127.0.0.1:${ListeningAddress.parse(server.address()).port}`,
    requests,
    hold() {
      const gate = Promise.withResolvers<void>();
      held = gate.promise;

      return () => {
        held = Promise.resolve();
        gate.resolve();
      };
    },
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      server.closeAllConnections();
      await closed.promise;
    },
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

  return Address.parse(receipt.contractAddress.toLowerCase());
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
    (await api.call("createWorkspace", { body: { name } })).id;

  const setPolicy = async (workspaceId: WorkspaceId, walletId: WalletId, draft: PolicyDraft) => {
    const approval = await api.call("requestPolicy", {
      params: { workspaceId, walletId },
      body: { draft },
    });

    const row = await t.approve(approval.id, [t.owner]);

    if (row.status !== "executed") throw new Error(`policy approval ended ${row.status}`);
  };

  const newAgent = async (name: string, workspaceId: WorkspaceId = defaultWorkspace) => {
    const created = await api.call("createAgent", { params: { workspaceId }, body: { name } });

    return {
      id: created.agent.id,
      token: created.token,
      walletId: created.wallet.id,
      address: created.wallet.address,
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
        body: { ceremonyId: start.ceremonyId, response: passkey.response },
      });

      if (session.user === null) throw new Error("invite registration did not sign in");

      const pending = await api.call("listApprovals", {
        params: { workspaceId },
        query: { status: "pending" },
      });

      for (const approval of pending.items.filter((item) => item.kind === "add-approver")) {
        const row = await t.approve(approval.id, [t.owner]);

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

/** The arguments a tool is called with, as the MCP client takes them. */
export type ToolArguments = NonNullable<CallToolRequestParams["arguments"]>;

/** The JSON a tool answered with, or its error body. */
const ToolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

/** A tool's answer: the JSON object in its text content. */
const ToolAnswer = z.record(z.string(), z.json());

export type ToolAnswer = z.infer<typeof ToolAnswer>;

export function toolJson(result: CallToolResult): ToolAnswer {
  const text = ToolResult.parse(result).content.find((part) => part.type === "text")?.text;

  return ToolAnswer.parse(JSON.parse(text ?? "{}"));
}

/** The intent a `propose_*` tool answered with; throws with the whole answer when it has none. */
export function intentIdOf(answer: ToolAnswer): IntentId {
  const intentId = IntentId.safeParse(answer.intentId);

  if (!intentId.success) throw new Error(JSON.stringify(answer));

  return intentId.data;
}
