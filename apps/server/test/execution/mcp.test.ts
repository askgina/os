import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../../src/mcp/gateway.ts";
import { TEST_CHAIN_ID, TEST_ORIGIN } from "../support/context.ts";
import { createFixture, type Fixture, toolJson } from "./fixture.ts";

let f: Fixture;

beforeAll(async () => {
  f = await createFixture("exec_mcp");
});
afterAll(async () => {
  await f?.close();
});

const RECIPIENT = "0x00000000000000000000000000000000000000aa";

async function rawMcp(headers: Record<string, string>, url = `${TEST_ORIGIN}/mcp`) {
  return f.t.app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
}

describe("the MCP gateway", () => {
  it("offers exactly the eight agent tools", async () => {
    const client = await f.mcp(f.agent.token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(8);
    expect(MCP_TOOL_NAMES).toHaveLength(8);
  });

  it("tools/list carries annotations", async () => {
    const client = await f.mcp(f.agent.token);
    const { tools } = await client.listTools();
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    const proposes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    expect(annotations).toEqual({
      whoami: { readOnlyHint: true },
      get_balances: { readOnlyHint: true },
      get_intent: { readOnlyHint: true },
      list_intents: { readOnlyHint: true },
      propose_transfer: proposes,
      propose_contract_call: proposes,
      propose_order: proposes,
      cancel_intent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    });
  });

  it("tells an agent who it is and which wallet it may use", async () => {
    const client = await f.mcp(f.agent.token);
    const me = toolJson(await client.callTool({ name: "whoami", arguments: {} }));
    expect(me.agent).toMatchObject({ id: f.agent.id });
    expect(me.wallets).toEqual([
      expect.objectContaining({
        walletId: f.agent.walletId,
        address: f.agent.address,
        isDefault: true,
      }),
    ]);
    // No one approved anything in advance for this agent.
    expect(me.mandates).toEqual([]);
  });

  it("refuses a missing or unknown token", async () => {
    expect((await rawMcp({})).status).toBe(401);
    expect((await rawMcp({ authorization: `Bearer osa_${"x".repeat(40)}` })).status).toBe(401);
  });

  it("refuses a wrong Host and a foreign Origin", async () => {
    const auth = { authorization: `Bearer ${f.agent.token}` };
    expect((await rawMcp(auth, "http://evil.example:55710/mcp")).status).toBe(403);
    expect((await rawMcp({ ...auth, host: "evil.example" })).status).toBe(403);
    expect((await rawMcp({ ...auth, origin: "https://evil.example" })).status).toBe(403);
    expect((await rawMcp({ ...auth, origin: TEST_ORIGIN })).status).toBe(200);
  });

  it("refuses a disabled agent's token", async () => {
    const other = await f.newAgent("Soon disabled");
    expect((await rawMcp({ authorization: `Bearer ${other.token}` })).status).toBe(200);
    await f.t.owner.browser.api.call("disableAgent", {
      params: { workspaceId: f.workspaceId, agentId: other.id },
      body: {},
    });
    expect((await rawMcp({ authorization: `Bearer ${other.token}` })).status).toBe(403);
  });

  it("answers a proposal the policy would refuse with its code and stores nothing", async () => {
    const client = await f.mcp(f.agent.token);
    const result = await client.callTool({
      name: "propose_transfer",
      arguments: { chainId: TEST_CHAIN_ID, to: RECIPIENT, amount: "6", memo: "too much" },
    });
    expect(result.isError).toBe(true);
    expect(toolJson(result)).toMatchObject({ error: "policy_denied", detail: "over_per_tx_cap" });
    const list = toolJson(await client.callTool({ name: "list_intents", arguments: {} }));
    expect(list.intents).toEqual([]);
  });

  it("refuses an amount more precise than the asset", async () => {
    const client = await f.mcp(f.agent.token);
    const result = await client.callTool({
      name: "propose_transfer",
      arguments: {
        chainId: TEST_CHAIN_ID,
        to: RECIPIENT,
        amount: "0.0000000000000000001",
        memo: "dust",
      },
    });
    expect(toolJson(result)).toMatchObject({ error: "invalid_request" });
  });

  it("shows an agent only its own intents", async () => {
    const mine = await f.mcp(f.agent.token);
    const proposed = toolJson(
      await mine.callTool({
        name: "propose_transfer",
        arguments: { chainId: TEST_CHAIN_ID, to: RECIPIENT, amount: "0.01", memo: "rent" },
      }),
    );
    expect(proposed).toMatchObject({
      status: "pending_approval",
      authorizedBy: "person",
      mandateId: null,
    });
    expect(String(proposed.approvalUrl)).toMatch(
      new RegExp(`^${TEST_ORIGIN}/w/${f.workspaceId}/approvals/apr_`),
    );
    expect(
      toolJson(
        await mine.callTool({ name: "get_intent", arguments: { intentId: proposed.intentId } }),
      ),
    ).toMatchObject({ authorizedBy: "person", mandateId: null });

    const sibling = await f.newAgent("Sibling");
    const theirs = await f.mcp(sibling.token);
    const peek = await theirs.callTool({
      name: "get_intent",
      arguments: { intentId: proposed.intentId },
    });
    expect(toolJson(peek)).toMatchObject({ error: "not_found" });
    expect(
      toolJson(await theirs.callTool({ name: "list_intents", arguments: {} })).intents,
    ).toEqual([]);

    const otherWorkspace = await f.newWorkspace("Elsewhere");
    const stranger = await f.newAgent("Stranger", otherWorkspace);
    const strangerClient = await f.mcp(stranger.token);
    expect(
      toolJson(
        await strangerClient.callTool({
          name: "get_intent",
          arguments: { intentId: proposed.intentId },
        }),
      ),
    ).toMatchObject({ error: "not_found" });

    const cancelled = toolJson(
      await mine.callTool({ name: "cancel_intent", arguments: { intentId: proposed.intentId } }),
    );
    expect(cancelled.status).toBe("cancelled");
  });
});
