import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

/** What `propose_transfer` takes. `mandateId` names the one mandate to use, or refuse. */
export interface TransferProposal {
  chainId: string;
  to: string;
  amount: string;
  memo: string;
  asset?: string;
  walletId?: string;
  mandateId?: string;
}

/**
 * What a propose tool answers: a request people approve (`person`, with its link and expiry), or
 * a payment a mandate covers (`mandate`), on its way to the signer with no person asked.
 */
export const Proposal = z.strictObject({
  intentId: z.string(),
  status: z.string(),
  authorizedBy: z.enum(["mandate", "person"]),
  mandateId: z.string().nullable(),
  approvalUrl: z.string().nullable(),
  expiresAt: z.number().nullable(),
});

export type Proposal = z.infer<typeof Proposal>;

/** An agent's connection to the MCP gateway. */
export interface AgentConnection {
  tools(): Promise<string[]>;
  /** Call a tool and return its JSON result; throws with the tool's message when it refuses. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Propose a transfer and return the answer, checked; throws {@link ToolRefused} when refused. */
  proposeTransfer(input: TransferProposal): Promise<Proposal>;
  close(): Promise<void>;
}

const Refusal = z.object({ error: z.string(), detail: z.string().optional() });

/** A tool refused the call. The message is the tool's answer, as the agent reads it. */
export class ToolRefused extends Error {
  override readonly name = "ToolRefused";
  /** The refusal's code, for example `policy_denied`; null when the answer carries none. */
  readonly code: string | null;
  /** Its reason, for example `over_per_tx_cap` or `mandate_over_window_cap`; null when none. */
  readonly detail: string | null;

  constructor(text: string) {
    super(text);
    let parsed: unknown = null;

    try {
      parsed = JSON.parse(text);
    } catch {}

    const refusal = Refusal.safeParse(parsed);
    this.code = refusal.success ? refusal.data.error : null;
    this.detail = refusal.success ? (refusal.data.detail ?? null) : null;
  }
}

export async function connectAgent(mcpUrl: string, token: string): Promise<AgentConnection> {
  const client = new Client({ name: "os-e2e-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      authProvider: { token: async () => token },
    }),
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    const text = content?.find((part) => part.type === "text")?.text ?? "";

    if (result.isError) throw new ToolRefused(text);

    return (result.structuredContent ?? JSON.parse(text)) as Record<string, unknown>;
  };

  return {
    async tools() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    },
    call,
    async proposeTransfer(input) {
      return Proposal.parse(await call("propose_transfer", { ...input }));
    },
    close: () => client.close(),
  };
}
