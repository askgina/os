/**
 * An agent with no model in it. It connects to the MCP gateway with an agent token, asks who it
 * is, proposes one transfer from its own wallet, and waits until the transaction has settled:
 * after a person approved or rejected it, or at once when a mandate people granted in advance
 * covers it.
 *
 * It shows everything an agent can do here: read its own state and propose. It holds no key, it
 * cannot approve, and it never sees the signer.
 *
 *   MCP_URL        the gateway, for example http://localhost:8080/mcp
 *   AGENT_TOKEN    the token shown once when the agent was created (osa_…)
 *   TRANSFER_TO    recipient address
 *   AMOUNT         whole units of the chain's native coin (default 0.001)
 *   CHAIN_ID       CAIP-2 chain id (default eip155:31337, the bundled local chain)
 *   MEMO           the agent's stated reason, shown to the approver
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const Environment = z.object({
  MCP_URL: z.url(),
  AGENT_TOKEN: z.string().startsWith("osa_"),
  TRANSFER_TO: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  AMOUNT: z.string().default("0.001"),
  CHAIN_ID: z.string().default("eip155:31337"),
  MEMO: z.string().max(280).default("Example payment from the scripted agent"),
});

// Under a mandate there is no link to approve at and no expiry.
const Proposal = z.object({
  intentId: z.string(),
  status: z.string(),
  authorizedBy: z.enum(["mandate", "person"]),
  mandateId: z.string().nullable(),
  approvalUrl: z.string().nullable(),
  expiresAt: z.number().nullable(),
});

const IntentState = z.object({
  status: z.string(),
  transactionHash: z.string().nullish(),
  explorerUrl: z.string().nullish(),
  failureCode: z.string().nullish(),
});

/** Statuses after which nothing more will happen to an intent. */
const FINAL: Record<string, true> = {
  confirmed: true,
  reverted: true,
  stuck: true,
  rejected: true,
  expired: true,
  cancelled: true,
  denied: true,
  failed: true,
};

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const env = Environment.parse(process.env);
  const client = new Client({ name: "scripted-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(env.MCP_URL), {
      authProvider: { token: async () => env.AGENT_TOKEN },
    }),
  );

  // Tools answer with JSON, both as structured content and as text.
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    const text = content?.find((part) => part.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name} was refused: ${text}`);
    return result.structuredContent ?? JSON.parse(text);
  };

  try {
    say(`who am I: ${JSON.stringify(await call("whoami", {}))}`);

    const proposal = Proposal.parse(
      await call("propose_transfer", {
        chainId: env.CHAIN_ID,
        to: env.TRANSFER_TO,
        amount: env.AMOUNT,
        memo: env.MEMO,
      }),
    );
    say(`proposed ${proposal.intentId}: ${proposal.status}`);
    if (proposal.authorizedBy === "mandate") {
      say(`covered by mandate ${proposal.mandateId}: it is signed with no person asked`);
    } else {
      say(`a person must approve it here: ${proposal.approvalUrl}`);
    }

    for (;;) {
      const state = IntentState.parse(
        await call("get_intent", { intentId: proposal.intentId, waitSeconds: 50 }),
      );
      say(`status: ${state.status}`);
      if (!Object.hasOwn(FINAL, state.status)) continue;
      if (state.transactionHash) say(`transaction: ${state.explorerUrl ?? state.transactionHash}`);
      if (state.failureCode) say(`reason: ${state.failureCode}`);
      return state.status === "confirmed" ? 0 : 1;
    }
  } finally {
    await client.close();
  }
}

process.exitCode = await main();
