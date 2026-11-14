import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IntentStatus, type IntentSummary } from "@askgina/os-api";
import { type AgentId, Memo, type WalletId } from "@askgina/os-protocol";
import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { agents, wallets } from "../db/schema.ts";
import { chainAccess } from "../execution/chains.ts";
import {
  cancelIntent,
  getIntentRow,
  type IntentRow,
  intentSummary,
  listIntentRows,
  proposeContractCall,
  proposeTransfer,
} from "../execution/intents.ts";
import { HttpError } from "../http/errors.ts";

type AgentRow = typeof agents.$inferSelect;

/** Requests an agent may make per minute. Generous for a model, tight for a runaway loop. */
const REQUESTS_PER_MINUTE = 120;
const LAST_SEEN_INTERVAL_SECONDS = 60;
/** How often `get_intent` re-reads the status while it waits. */
const WAIT_POLL_MS = 1_000;
const TERMINAL: readonly IntentRow["status"][] = [
  "confirmed",
  "reverted",
  "stuck",
  "rejected",
  "expired",
  "cancelled",
  "denied",
  "failed",
];

// Tool inputs are published as JSON Schema, which the protocol package's custom validators
// cannot be turned into; these are the same rules written as plain patterns.
const WalletIdInput = z
  .string()
  .regex(/^wal_[0-9a-hjkmnp-tv-z]{26}$/)
  .transform((value) => value as WalletId);
const CalldataInput = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);
const MemoInput = z
  .string()
  .max(280)
  // Control characters and bidi overrides could make an approval card misleading.
  .refine((value) => Memo.safeParse(value).success, "memo contains control or bidi characters");

const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte hex address")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** Exactly the tools an agent gets. Nothing here signs, approves or administers. */
export const MCP_TOOL_NAMES = [
  "whoami",
  "get_balances",
  "propose_transfer",
  "propose_contract_call",
  "get_intent",
  "list_intents",
  "cancel_intent",
] as const;

const APPROVAL_NOTE =
  "Nothing is sent yet: a person must approve the proposal with their passkey first. Call get_intent with the returned intentId and waitSeconds (up to 50) to wait for the outcome; repeat until the status is final (confirmed, reverted, stuck, rejected, expired, cancelled, denied or failed).";

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** A refusal the agent can act on: a fixed message and a stable code, never echoed input. */
function refusal(error: unknown) {
  if (error instanceof HttpError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: error.code, message: error.message, detail: error.detail }),
        },
      ],
    };
  }
  throw error;
}

async function walletsFor(ctx: AppContext, agent: AgentRow) {
  const rows = await ctx.db
    .select()
    .from(wallets)
    .where(eq(wallets.workspaceId, agent.workspaceId));
  return rows.filter(
    (wallet) =>
      wallet.id === agent.walletId ||
      (wallet.kind === "treasury" && (wallet.policy?.requesters.includes(agent.id) ?? false)),
  );
}

function intentView(ctx: AppContext, summary: IntentSummary) {
  return {
    intentId: summary.id,
    status: summary.status,
    walletId: summary.walletId,
    chainId: summary.chainId,
    title: summary.display.title,
    to: summary.display.to,
    amount: summary.display.amountFormatted,
    asset: summary.display.assetSymbol,
    memo: summary.memo,
    createdAt: summary.createdAt,
    transactionHash: summary.transactionHash,
    explorerUrl:
      summary.transactionHash === null
        ? null
        : chainAccess(ctx).explorerLink(summary.chainId, summary.transactionHash),
    failureCode: summary.failureCode,
  };
}

function buildServer(ctx: AppContext, agent: AgentRow): McpServer {
  const server = new McpServer({ name: "askgina-os", version: "0.1.0" });

  const ownIntent = async (intentId: string) => {
    const row = await getIntentRow(ctx, intentId).catch(() => null);
    // Another agent's intent looks exactly like one that does not exist.
    if (row === null || row.agentId !== agent.id)
      throw new HttpError("not_found", "no such intent");
    return row;
  };

  server.registerTool(
    "whoami",
    {
      description:
        "Describe who you are in this system: your agent id and name, your workspace, and the wallets you may propose from, with their addresses, the chains they work on and their per-transaction and daily limits. Call this first.",
      inputSchema: z.object({}),
    },
    async () => {
      const usable = await walletsFor(ctx, agent);
      return json({
        agent: { id: agent.id, name: agent.name },
        workspaceId: agent.workspaceId,
        chains: chainAccess(ctx).list(),
        wallets: usable.map((wallet) => ({
          walletId: wallet.id,
          kind: wallet.kind,
          label: wallet.label,
          address: wallet.address,
          isDefault: wallet.id === agent.walletId,
          policy:
            wallet.policy === null
              ? null
              : {
                  chains: wallet.policy.chains,
                  limits: wallet.policy.assets,
                  recipients: wallet.policy.recipients,
                  contractCalls: wallet.policy.contractCalls,
                  approvalsNeeded: wallet.policy.approvals.threshold,
                },
        })),
      });
    },
  );

  server.registerTool(
    "get_balances",
    {
      description:
        "Read the current balances of one of your wallets: the native coin of every chain its policy allows, and every token its policy lists. Amounts are in base units with their decimals. Omit walletId for your own wallet.",
      inputSchema: z.object({
        walletId: WalletIdInput.optional().describe("A wallet id from whoami; defaults to yours."),
      }),
    },
    async ({ walletId }) => {
      try {
        const usable = await walletsFor(ctx, agent);
        const wallet = usable.find((candidate) => candidate.id === (walletId ?? agent.walletId));
        if (!wallet) throw new HttpError("not_found", "no such wallet");
        const chains = chainAccess(ctx);
        const chainIds = wallet.policy?.chains ?? chains.list().map((chain) => chain.chainId);
        const assets = [
          ...chainIds
            .filter((id) => chains.has(id))
            .map((chainId) => ({ chainId, asset: "native" as const })),
          ...(wallet.policy?.assets ?? [])
            .filter((limit) => limit.asset !== "native" && chains.has(limit.chainId))
            .map((limit) => ({ chainId: limit.chainId, asset: limit.asset })),
        ];
        return json({
          walletId: wallet.id,
          address: wallet.address,
          balances: await chains.balances(wallet.address, assets),
        });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    "propose_transfer",
    {
      description: `Propose sending the chain's native coin or an ERC-20 token from one of your wallets. ${APPROVAL_NOTE} If the wallet's policy would refuse the transfer, you get a policy_denied error with a reason code and nothing is recorded.`,
      inputSchema: z.object({
        chainId: z.string().describe('The chain, as "eip155:<number>", from whoami.'),
        to: EvmAddress.describe("The recipient's address."),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('How much, in whole units of the asset, for example "0.05" or "250".'),
        asset: z
          .union([z.literal("native"), EvmAddress])
          .optional()
          .describe('"native" (the default) or the ERC-20 token contract address.'),
        memo: MemoInput.describe(
          "Why you want this, in one or two sentences. People read it before approving.",
        ),
        walletId: WalletIdInput.optional().describe("A wallet id from whoami; defaults to yours."),
      }),
    },
    async (input) => {
      try {
        const result = await proposeTransfer(ctx, agent, input);
        return json({
          intentId: result.intentId,
          status: result.status,
          approvalUrl: result.approvalUrl,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    "propose_contract_call",
    {
      description: `Propose calling a contract with raw calldata from one of your wallets. Works only for contracts the wallet's policy allowlists. ${APPROVAL_NOTE}`,
      inputSchema: z.object({
        chainId: z.string().describe('The chain, as "eip155:<number>", from whoami.'),
        to: EvmAddress.describe("The contract's address."),
        data: CalldataInput.describe(
          "ABI-encoded calldata, 0x-prefixed, starting with the 4-byte selector.",
        ),
        valueWei: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Native coin to send with the call, in wei. Defaults to 0."),
        memo: MemoInput.describe("What this call does and why. People read it before approving."),
        walletId: WalletIdInput.optional().describe("A wallet id from whoami; defaults to yours."),
      }),
    },
    async (input) => {
      try {
        const result = await proposeContractCall(ctx, agent, input);
        return json({
          intentId: result.intentId,
          status: result.status,
          approvalUrl: result.approvalUrl,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    "get_intent",
    {
      description:
        "Read one of your proposals. With waitSeconds, wait up to that long for its status to change before answering. When the transaction exists, the answer carries its hash and an explorer link; when it ended without one, failureCode says why.",
      inputSchema: z.object({
        intentId: z.string().describe("The intentId a propose tool returned."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("0 to 50; 0 answers at once."),
      }),
    },
    async ({ intentId, waitSeconds }, extra) => {
      try {
        let row = await ownIntent(intentId);
        const initial = row.status;
        const deadline = Date.now() + (waitSeconds ?? 0) * 1000;
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        while (
          row.status === initial &&
          !TERMINAL.includes(row.status) &&
          Date.now() < deadline &&
          !signal?.aborted
        ) {
          await delay(Math.min(WAIT_POLL_MS, deadline - Date.now()));
          row = await ownIntent(intentId);
        }
        return json(intentView(ctx, await intentSummary(ctx, row)));
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    "list_intents",
    {
      description:
        "List your recent proposals, newest first, optionally only those with one status.",
      inputSchema: z.object({
        status: IntentStatus.optional().describe("Only proposals with this status."),
        limit: z.number().int().min(1).max(50).optional().describe("How many; default 20."),
      }),
    },
    async ({ status, limit }) => {
      const { rows } = await listIntentRows(ctx, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        ...(status === undefined ? {} : { status }),
        limit: limit ?? 20,
      });
      const summaries = await Promise.all(rows.map((row) => intentSummary(ctx, row)));
      return json({ intents: summaries.map((summary) => intentView(ctx, summary)) });
    },
  );

  server.registerTool(
    "cancel_intent",
    {
      description:
        "Withdraw one of your proposals while it still waits for approval. Once people approved it, it can no longer be cancelled; the answer then carries its current status.",
      inputSchema: z.object({
        intentId: z.string().describe("The intentId a propose tool returned."),
      }),
    },
    async ({ intentId }) => {
      try {
        const row = await ownIntent(intentId);
        return json({ intentId: row.id, status: await cancelIntent(ctx, row) });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  return server;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Answer with an HTTP status and a fixed JSON error. */
function deny(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
  });
}

/**
 * The MCP endpoint agents use, at `/mcp`. Stateless Streamable HTTP: every request carries the
 * agent's bearer token and is served by a fresh server bound to that agent.
 */
export function mountMcp(app: Hono, ctx: AppContext): void {
  const publicUrl = new URL(ctx.config.publicOrigin);
  const buckets = new Map<string, { tokens: number; at: number }>();
  const handlers = new Map<string, McpHttpHandler>();

  const authenticate = async (request: Request): Promise<AgentRow | Response> => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (osa_[A-Za-z0-9_-]{16,200})$/.exec(header);
    if (!match?.[1]) return deny(401, "unauthenticated", "a valid agent token is required");
    const hash = sha256(match[1]);
    const [agent] = await ctx.db.select().from(agents).where(eq(agents.tokenHash, hash));
    // The lookup is by hash; the constant-time compare keeps the final check free of timing.
    if (!agent || !timingSafeEqual(Buffer.from(agent.tokenHash), Buffer.from(hash))) {
      return deny(401, "unauthenticated", "a valid agent token is required");
    }
    if (agent.status !== "active") return deny(403, "forbidden", "this agent is disabled");
    return agent;
  };

  const allow = (agentId: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(agentId) ?? { tokens: REQUESTS_PER_MINUTE, at: now };
    bucket.tokens = Math.min(
      REQUESTS_PER_MINUTE,
      bucket.tokens + ((now - bucket.at) * REQUESTS_PER_MINUTE) / 60_000,
    );
    bucket.at = now;
    if (bucket.tokens < 1) {
      buckets.set(agentId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    buckets.set(agentId, bucket);
    return true;
  };

  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    // DNS rebinding and cross-site requests: the SDK checks neither, so this does.
    // The Node adapter builds the URL from the Host header; a plain web Request has only its URL.
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (host !== publicUrl.host) {
      return deny(403, "forbidden", "unexpected Host");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== ctx.config.publicOrigin) {
      return deny(403, "forbidden", "unexpected Origin");
    }
    const agent = await authenticate(request);
    if (agent instanceof Response) return agent;
    if (!allow(agent.id)) return deny(429, "rate_limited", "too many requests; slow down");

    const now = ctx.now();
    await ctx.db
      .update(agents)
      .set({ lastSeenAt: new Date(now * 1000) })
      .where(
        and(
          eq(agents.id, agent.id),
          or(
            isNull(agents.lastSeenAt),
            lt(agents.lastSeenAt, new Date((now - LAST_SEEN_INTERVAL_SECONDS) * 1000)),
          ),
        ),
      );

    let handler = handlers.get(agent.id);
    if (handler === undefined) {
      const bound = agent.id;
      handler = createMcpHandler(
        async () => {
          const [current] = await ctx.db
            .select()
            .from(agents)
            .where(eq(agents.id, bound as AgentId));
          if (!current) throw new HttpError("unauthenticated", "agent removed");
          return buildServer(ctx, current);
        },
        { responseMode: "json" },
      );
      handlers.set(agent.id, handler);
    }
    return handler.fetch(request);
  });
}
