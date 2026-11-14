/**
 * The agent's one connection to the outside world: the MCP gateway of an askgina/os stack,
 * authenticated with the agent's token. Through it the agent can read its own state and
 * propose; it cannot sign, approve or administer anything.
 *
 *   MCP_URL      the gateway, for example http://gateway:8080/mcp
 *   AGENT_TOKEN  the token shown once when the agent was created in the UI (osa_…)
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export class GatewayRefusal extends Error {
  override readonly name = "GatewayRefusal";
  readonly code: string;

  constructor(tool: string, code: string) {
    super(`${tool} was refused: ${code}`);
    this.code = code;
  }
}

let connection: Promise<Client> | undefined;

function connect(): Promise<Client> {
  const url = process.env.MCP_URL;
  const token = process.env.AGENT_TOKEN;
  if (!url) throw new Error("MCP_URL is not set");
  if (!token) throw new Error("AGENT_TOKEN is not set");
  const client = new Client({ name: "eve-agent", version: "0.1.0" });
  const ready = client
    .connect(
      new StreamableHTTPClientTransport(new URL(url), {
        authProvider: { token: async () => token },
      }),
    )
    .then(() => client);
  // A failed connection is retried on the next call instead of being cached forever.
  ready.catch(() => {
    connection = undefined;
  });
  return ready;
}

/** Call one gateway tool and return its JSON answer. A refusal becomes {@link GatewayRefusal}. */
export async function callGateway(name: string, args: Record<string, unknown>): Promise<unknown> {
  connection ??= connect();
  const client = await connection;
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.find((part) => part.type === "text")?.text ?? "";
  if (result.isError) {
    // Refusals carry a stable code; the message text is not passed on to the model verbatim.
    let code = "refused";
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
    } catch {}
    throw new GatewayRefusal(name, code);
  }
  return result.structuredContent ?? JSON.parse(text);
}
