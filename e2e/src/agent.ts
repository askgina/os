import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** An agent's connection to the MCP gateway. */
export interface AgentConnection {
  tools(): Promise<string[]>;
  /** Call a tool and return its JSON result; throws with the tool's message when it refuses. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export class ToolRefused extends Error {
  override readonly name = "ToolRefused";
}

export async function connectAgent(mcpUrl: string, token: string): Promise<AgentConnection> {
  const client = new Client({ name: "os-e2e-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      authProvider: { token: async () => token },
    }),
  );
  return {
    async tools() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    },
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[] | undefined;
      const text = content?.find((part) => part.type === "text")?.text ?? "";
      if (result.isError) throw new ToolRefused(text);
      return (result.structuredContent ?? JSON.parse(text)) as Record<string, unknown>;
    },
    close: () => client.close(),
  };
}
