import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IntentStatus } from "@askgina/os-api";
import { type AgentId, type MandateId, Memo, type WalletId } from "@askgina/os-protocol";
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
import { activeMandatesOf } from "../execution/mandates.ts";
import { attemptViews, transactionOf } from "../execution/transactions.ts";
import { HttpError } from "../http/errors.ts";

type AgentRow = typeof agents.$inferSelect;

/** Requests an agent may make per minute. Generous for a model, tight for a runaway loop. */
const REQUESTS_PER_MINUTE = 120;
/** Failed authentications one client may make per minute before it is refused unread. */
export const FAILED_AUTH_PER_MINUTE = 10;
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
  "voided",
];

// Tool inputs are published as JSON Schema, which the protocol package's custom validators
// cannot be turned into; these are the same rules written as plain patterns.
const WalletIdInput = z
  .string()
  .regex(/^wal_[0-9a-hjkmnp-tv-z]{26}$/)
  .transform((value) => value as WalletId);
const MandateIdInput = z
  .string()
  .regex(/^mnd_[0-9a-hjkmnp-tv-z]{26}$/)
  .transform((value) => value as MandateId);
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
  'If a mandate a person approved in advance covers the proposal (see whoami), it is signed and sent with no person asked: the answer says authorizedBy "mandate", its mandateId, status approved, and approvalUrl and expiresAt null. Otherwise (authorizedBy "person") nothing is sent yet: a person must approve the proposal with their passkey first, at approvalUrl, before expiresAt. Either way, call get_intent with the returned intentId and waitSeconds (up to 50) to wait for the outcome; repeat until the status is final (confirmed, reverted, stuck, rejected, expired, cancelled, denied, failed or voided). A stuck transaction is still valid: the server raises its fee by itself, and people may speed it up or cancel it (you cannot), so it can still become confirmed or reverted, or voided when a cancel people approved was mined in its place (nothing moved; a network fee was paid). get_intent lists every attempt at the same nonce, and stuckReason says why it is not mined yet. Two proposals racing for the last of a mandate\'s budget can both start approved: the signer signs one and the other ends denied with a counter code such as mandate_over_window_cap, and your next proposal then waits for a person.';

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * Run a tool and turn any failure into a refusal the agent can act on: a fixed message and a
 * stable code, never echoed input. Anything that is not an `HttpError` becomes one fixed
 * `internal` refusal, because its message can carry internals (a viem error carries the RPC
 * URL, which often holds an API key); only the error's kind is logged.
 */
async function answer<T>(ctx: AppContext, tool: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    const known =
      error instanceof HttpError
        ? error
        : new HttpError("internal", "something went wrong; try again later");
    if (!(error instanceof HttpError)) {
      ctx.log.error("mcp tool failed", {
        tool,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: known.code, message: known.message, detail: known.detail }),
        },
      ],
    };
  }
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

/**
 * One intent as an agent sees it: what it is, where it stands, and every attempt of its
 * transaction. Nothing here is an action: people speed up and cancel, never an agent.
 */
async function intentView(ctx: AppContext, row: IntentRow) {
  const [summary, transaction] = await Promise.all([
    intentSummary(ctx, row),
    transactionOf(ctx, row.approvalId),
  ]);
  const attempts = transaction ? await attemptViews(ctx, row.workspaceId, transaction) : [];
  const sent = transaction?.status === "broadcast" || transaction?.status === "stuck";
  return {
    intentId: summary.id,
    status: summary.status,
    authorizedBy: summary.mandateId === null ? "person" : "mandate",
    mandateId: summary.mandateId,
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
    stuckReason: sent ? (transaction?.stuckReason ?? null) : null,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      kind: attempt.kind,
      hash: attempt.hash,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      status: attempt.status,
      explorerUrl: attempt.explorerUrl,
    })),
  };
}

// How an MCP host may classify each tool. Reads change nothing. A proposal records a new intent
// each time it is called and never moves funds by itself: a person or a mandate authorizes it,
// and the signer signs. Cancelling withdraws a waiting proposal, and a second cancel changes
// nothing more.
const READ_ONLY = { readOnlyHint: true } as const;
const PROPOSES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

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
        "Describe who you are in this system: your agent id and name, your workspace, the wallets you may propose from, with their addresses, the chains they work on and their per-transaction and daily limits, and your live mandates: what people approved in advance, which the signer signs with no person asked (recipients, caps per payment, per window and in total in base units, what was used, payments left, end time). Call this first.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      answer(ctx, "whoami", async () => {
        const usable = await walletsFor(ctx, agent);
        const live = await activeMandatesOf(
          ctx,
          agent,
          usable.map((wallet) => wallet.id),
        );
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
          mandates: live.map(({ mandate, usage }) => ({
            mandateId: mandate.id,
            walletId: mandate.walletId,
            purpose: mandate.purpose,
            recipients: mandate.recipients,
            windowSeconds: mandate.windowSeconds,
            assets: mandate.assets.map((limit) => {
              const used = usage.assets.find(
                (entry) => entry.chainId === limit.chainId && entry.asset === limit.asset,
              );
              return {
                chainId: limit.chainId,
                asset: limit.asset,
                maxPerAction: limit.maxPerAction,
                maxPerWindow: limit.maxPerWindow,
                maxTotal: limit.maxTotal,
                usedInWindow: used?.inWindow ?? "0",
                usedTotal: used?.total ?? "0",
              };
            }),
            maxFeePerActionWei: mandate.maxFeePerActionWei,
            usesLeft: Math.max(0, mandate.maxUses - usage.uses),
            notAfter: mandate.notAfter,
          })),
        });
      }),
  );

  server.registerTool(
    "get_balances",
    {
      description:
        "Read the current balances of one of your wallets: the native coin of every chain its policy allows, and every token its policy lists. Amounts are in base units with their decimals. Omit walletId for your own wallet.",
      inputSchema: z.object({
        walletId: WalletIdInput.optional().describe("A wallet id from whoami; defaults to yours."),
      }),
      annotations: READ_ONLY,
    },
    async ({ walletId }) =>
      answer(ctx, "get_balances", async () => {
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
      }),
  );

  server.registerTool(
    "propose_transfer",
    {
      description: `Propose sending the chain's native coin or an ERC-20 token from one of your wallets. ${APPROVAL_NOTE} If the wallet's policy would refuse the transfer, you get a policy_denied error with a reason code and nothing is recorded. Name a mandateId to use exactly that mandate: if it does not cover the transfer you get a policy_denied error with its reason code (for example mandate_over_window_cap or mandate_expired) and nothing is recorded.`,
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
        mandateId: MandateIdInput.optional().describe(
          "A mandateId from whoami to use exactly that mandate; by default the one that covers the transfer and ends first is used, or a person is asked.",
        ),
      }),
      annotations: PROPOSES,
    },
    async (input) =>
      answer(ctx, "propose_transfer", async () => json(await proposeTransfer(ctx, agent, input))),
  );

  server.registerTool(
    "propose_contract_call",
    {
      description: `Propose calling a contract with raw calldata from one of your wallets. Works only for contracts the wallet's policy allowlists. A mandate never covers a contract call: a person always approves it. ${APPROVAL_NOTE}`,
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
      annotations: PROPOSES,
    },
    async (input) =>
      answer(ctx, "propose_contract_call", async () =>
        json(await proposeContractCall(ctx, agent, input)),
      ),
  );

  server.registerTool(
    "get_intent",
    {
      description:
        "Read one of your proposals. With waitSeconds, wait up to that long for its status to change before answering. authorizedBy says whether a mandate (mandateId) or a person approves it. When the transaction exists, the answer carries its hash (the mined attempt's, else the newest's) and an explorer link, every attempt at its nonce with its fees and whether it was mined, and, while it is not mined, stuckReason; when it ended without one, or was voided, failureCode says why.",
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
      annotations: READ_ONLY,
    },
    async ({ intentId, waitSeconds }, extra) =>
      answer(ctx, "get_intent", async () => {
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
        return json(await intentView(ctx, row));
      }),
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
      annotations: READ_ONLY,
    },
    async ({ status, limit }) =>
      answer(ctx, "list_intents", async () => {
        const { rows } = await listIntentRows(ctx, {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          ...(status === undefined ? {} : { status }),
          limit: limit ?? 20,
        });
        return json({ intents: await Promise.all(rows.map((row) => intentView(ctx, row))) });
      }),
  );

  server.registerTool(
    "cancel_intent",
    {
      description:
        "Withdraw one of your proposals while it still waits for approval. Once people approved it, it can no longer be cancelled; the answer then carries its current status.",
      inputSchema: z.object({
        intentId: z.string().describe("The intentId a propose tool returned."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ intentId }) =>
      answer(ctx, "cancel_intent", async () => {
        const row = await ownIntent(intentId);
        return json({ intentId: row.id, status: await cancelIntent(ctx, row) });
      }),
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
  /** Recent failed authentications per client, as timestamps in milliseconds. */
  const failures = new Map<string, number[]>();

  /**
   * The client a failed authentication is charged to. Behind the bundled proxy that is the
   * address the proxy appended last to `X-Forwarded-For`; a request without one is charged to a
   * shared bucket.
   */
  const clientOf = (request: Request) =>
    request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "direct";

  const recentFailures = (client: string, now: number) => {
    const recent = (failures.get(client) ?? []).filter((at) => now - at < 60_000);
    if (recent.length === 0) failures.delete(client);
    else failures.set(client, recent);
    return recent;
  };

  const authenticate = async (request: Request): Promise<AgentRow | Response> => {
    const client = clientOf(request);
    const now = Date.now();
    const recent = recentFailures(client, now);
    // Checked before the database is read, so guessing tokens costs no lookups.
    if (recent.length >= FAILED_AUTH_PER_MINUTE) {
      return deny(429, "rate_limited", "too many failed authentications; slow down");
    }
    const fail = () => {
      failures.set(client, [...recent, now]);
      return deny(401, "unauthenticated", "a valid agent token is required");
    };
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (osa_[A-Za-z0-9_-]{16,200})$/.exec(header);
    if (!match?.[1]) return fail();
    const hash = sha256(match[1]);
    const [agent] = await ctx.db.select().from(agents).where(eq(agents.tokenHash, hash));
    // The lookup is by hash; the constant-time compare keeps the final check free of timing.
    if (!agent || !timingSafeEqual(Buffer.from(agent.tokenHash), Buffer.from(hash))) {
      return fail();
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
