import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IntentStatus } from "@askgina/os-api";
import {
  Address,
  Hex,
  HyperliquidTimeInForce,
  isVenueNetwork,
  MandateId,
  Memo,
  VENUE_NETWORK_NAMES,
  WalletId,
} from "@askgina/os-protocol";
import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { agents, wallets, workspaces } from "../db/schema.ts";
import { chainAccess } from "../execution/chains.ts";
import {
  getIntentRow,
  type IntentRow,
  intentSummary,
  listIntentRows,
  proposeContractCall,
  proposeTransfer,
} from "../execution/intents.ts";
import { activeMandatesOf } from "../execution/mandates.ts";
import { cancelIntentOrOrder, proposeOrder, proposeVenueWithdrawal } from "../execution/orders.ts";
import { attemptViews, transactionOf } from "../execution/transactions.ts";
import { HttpError } from "../http/errors.ts";
import { hasToken, takeToken } from "../rate-limit.ts";

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
  "filled",
  "partially_filled",
];

// Tool inputs are published as JSON Schema, which the protocol package's custom validators
// cannot be turned into; these are the same rules written as plain patterns. Each transform
// then decodes with the protocol's schema, which accepts everything the pattern let through.
const WalletIdInput = z
  .string()
  .regex(/^wal_[0-9a-hjkmnp-tv-z]{26}$/)
  .transform((value) => WalletId.parse(value));

const MandateIdInput = z
  .string()
  .regex(/^mnd_[0-9a-hjkmnp-tv-z]{26}$/)
  .transform((value) => MandateId.parse(value));

const CalldataInput = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => Hex.parse(value.toLowerCase()));

const MemoInput = z
  .string()
  .max(280)
  // Control characters and bidi overrides could make an approval card misleading.
  .refine((value) => Memo.safeParse(value).success, "memo contains control or bidi characters");

const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte hex address")
  .transform((value) => Address.parse(value.toLowerCase()));

/** Exactly the tools an agent gets. Nothing here signs, approves or administers. */
export const MCP_TOOL_NAMES = [
  "whoami",
  "get_balances",
  "propose_transfer",
  "propose_contract_call",
  "propose_order",
  "get_intent",
  "list_intents",
  "cancel_intent",
] as const;

const APPROVAL_NOTE =
  'If a mandate a person approved in advance covers the proposal (see whoami), it is signed and sent with no person asked: the answer says authorizedBy "mandate", its mandateId, status approved, and approvalUrl and expiresAt null. Otherwise (authorizedBy "person") nothing is sent yet: a person must approve the proposal with their passkey first, at approvalUrl, before expiresAt. Either way, call get_intent with the returned intentId and waitSeconds (up to 50) to wait for the outcome; repeat until the status is final (confirmed, reverted, stuck, rejected, expired, cancelled, denied, failed or voided). A stuck transaction is still valid: the server raises its fee by itself, and people may speed it up or cancel it (you cannot), so it can still become confirmed or reverted, or voided when a cancel people approved was mined in its place (nothing moved; a network fee was paid). get_intent lists every attempt at the same nonce, and stuckReason says why it is not mined yet. Two proposals racing for the last of a mandate\'s budget can both start approved: the signer signs one and the other ends denied with a counter code such as mandate_over_window_cap, and your next proposal then waits for a person.';

function json<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
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
 * transaction, or for a venue order its fields and what the venue reported. Nothing here is an
 * action: people speed up and cancel transactions, never an agent; an agent may cancel an order
 * it was approved to place.
 */
async function intentView(ctx: AppContext, row: IntentRow) {
  const [summary, transaction] = await Promise.all([
    intentSummary(ctx, row),
    transactionOf(ctx, row.approvalId),
  ]);

  const attempts = transaction ? await attemptViews(ctx, row.workspaceId, transaction) : [];
  const sent = transaction?.status === "broadcast" || transaction?.status === "stuck";
  const { display } = summary;
  const transfer = display.kind === "transfer" ? display : null;

  return {
    intentId: summary.id,
    status: summary.status,
    authorizedBy: summary.mandateId === null ? "person" : "mandate",
    mandateId: summary.mandateId,
    walletId: summary.walletId,
    chainId: summary.chainId,
    title: display.title,
    to: transfer?.to ?? null,
    amount: transfer?.amountFormatted ?? null,
    asset: transfer?.assetSymbol ?? null,
    order:
      display.kind === "order"
        ? {
            coin: display.coin,
            side: display.side,
            size: display.size,
            limitPrice: display.limitPrice,
            notionalUsd: display.notionalUsd,
            timeInForce: display.timeInForce,
            reduceOnly: display.reduceOnly,
            cloid: summary.order?.cloid ?? null,
            venueOrderId: summary.order?.venueOrderId ?? null,
            filledSize: summary.order?.filledSize ?? null,
            averagePrice: summary.order?.averagePrice ?? null,
            venueError: summary.order?.venueError ?? null,
            submitBy: summary.order?.submitBy ?? null,
            canCancel: summary.order?.canCancel ?? false,
          }
        : null,
    memo: summary.memo,
    createdAt: summary.createdAt,
    transactionHash: summary.transactionHash,
    explorerUrl:
      summary.transactionHash === null || isVenueNetwork(summary.chainId)
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
        "Describe who you are in this system: your agent id and name, your workspace, the wallets you may propose from, with their addresses, the chains they work on and their per-transaction and daily limits, the venue markets they may trade (on the Hyperliquid network the wallet's approved rules name, testnet or mainnet, where mainnet orders use real funds; per market: coin, asset index, notional cap per order and per day in micro-USD, time in force, submit window, whether withdrawals are allowed), and your live mandates: what people approved in advance, which the signer signs with no person asked (recipients, caps per payment, per window and in total in base units, what was used, payments left, end time). Mandates never cover orders. Call this first.",
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
          venues: ctx.config.venues.map((venue) => ({
            network: venue.network,
            name: VENUE_NETWORK_NAMES[venue.network],
          })),
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
                    venues: wallet.policy.venues ?? null,
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
      description: `Propose sending the chain's native coin or an ERC-20 token from one of your wallets. ${APPROVAL_NOTE} If the wallet's policy would refuse the transfer, you get a policy_denied error with a reason code and nothing is recorded. Name a mandateId to use exactly that mandate: if it does not cover the transfer you get a policy_denied error with its reason code (for example mandate_over_window_cap or mandate_expired) and nothing is recorded. With a venue network as chainId ("hyperliquid:testnet"), this withdraws USDC from the wallet's venue account: asset "usdc", to the wallet's own address only; a person always approves it, and it ends confirmed once the venue accepted it.`,
      inputSchema: z.object({
        chainId: z
          .string()
          .describe('The chain, as "eip155:<number>", or a venue network, from whoami.'),
        to: EvmAddress.describe("The recipient's address."),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('How much, in whole units of the asset, for example "0.05" or "250".'),
        asset: z
          .union([z.literal("native"), z.literal("usdc"), EvmAddress])
          .optional()
          .describe(
            '"native" (the default) or the ERC-20 token contract address; "usdc" for a venue withdrawal.',
          ),
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
      answer(ctx, "propose_transfer", async () => {
        if (isVenueNetwork(input.chainId)) {
          return json(await proposeVenueWithdrawal(ctx, agent, input));
        }

        if (input.asset === "usdc") {
          throw new HttpError("invalid_request", 'asset "usdc" is only for a venue withdrawal');
        }

        return json(await proposeTransfer(ctx, agent, { ...input, asset: input.asset }));
      }),
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
    "propose_order",
    {
      description:
        "Propose a limit order on a Hyperliquid perpetual market from one of your wallets. Orders go to the Hyperliquid network the wallet's approved rules name, testnet or mainnet; mainnet orders use real funds. The market must be one the wallet's policy lists (see whoami); the order's worst-case notional, size times limit price, counts against the policy's caps per order and per day. A person always approves an order with their passkey, at approvalUrl before expiresAt: no mandate covers one, so the answer always says authorizedBy \"person\" and mandateId null. Nothing is sent before that. Once approved, the server submits the order exactly once, within the policy's submit window. Call get_intent with the returned intentId and waitSeconds (up to 50); the status moves through approved, signed, submitted and placed (resting on the book) to filled, partially_filled (the rest was cancelled), cancelled, expired (the venue did not get it within its submit window) or failed (failureCode venue_refused, with the venue's own text in order.venueError); rejected, expired or cancelled before signing mean people did not approve it in time. You may cancel a submitted or placed order with cancel_intent. If the policy would refuse the order you get a policy_denied error with a reason code (market_not_allowed, over_per_order_cap, over_daily_cap, order_type_not_allowed, …) and nothing is recorded; market_metadata_mismatch means the venue no longer lists the market at the policy's index, and invalid_tick that the size or price has too many digits for the market.",
      inputSchema: z.object({
        network: z
          .string()
          .describe(
            'The venue network from whoami: "hyperliquid:testnet" or "hyperliquid:mainnet", as the wallet\'s approved rules name.',
          ),
        coin: z
          .string()
          .regex(/^[A-Za-z0-9]{1,16}$/)
          .describe('The market\'s coin as the wallet policy names it, for example "BTC".'),
        side: z.enum(["buy", "sell"]),
        size: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('How much of the coin, for example "0.01".'),
        limitPrice: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('The worst price you accept, in USD, for example "65000".'),
        timeInForce: HyperliquidTimeInForce.optional().describe(
          '"Ioc" (the default): fill what can be filled now and cancel the rest; "Gtc": rest on the book until filled or cancelled; "Alo": add liquidity only. The policy lists which are allowed.',
        ),
        reduceOnly: z
          .boolean()
          .optional()
          .describe("Only reduce an existing position. Defaults to false."),
        memo: MemoInput.describe(
          "Why you want this order, in one or two sentences. People read it before approving.",
        ),
        walletId: WalletIdInput.optional().describe("A wallet id from whoami; defaults to yours."),
      }),
      annotations: PROPOSES,
    },
    async (input) =>
      answer(ctx, "propose_order", async () => json(await proposeOrder(ctx, agent, input))),
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
        // SAFETY: this only widens `extra` to read an optional `signal`. SDK 2's ServerContext
        // has no top-level `signal` (it carries one at `extra.mcpReq.signal`), so this reads
        // undefined and the wait runs to its deadline or a status change.
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
          // Undefined means every status, as if the filter were left out.
          status,
          limit: limit ?? 20,
        });

        return json({ intents: await Promise.all(rows.map((row) => intentView(ctx, row))) });
      }),
  );

  server.registerTool(
    "cancel_intent",
    {
      description:
        "Withdraw one of your proposals while it still waits for approval, or cancel an order of yours that was submitted to the venue and is not final (approving an order includes your right to cancel it). Once people approved anything else, it can no longer be cancelled; the answer then carries its current status.",
      inputSchema: z.object({
        intentId: z.string().describe("The intentId a propose tool returned."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ intentId }) =>
      answer(ctx, "cancel_intent", async () => {
        const row = await ownIntent(intentId);
        const status = await cancelIntentOrOrder(ctx, row, { type: "agent", id: agent.id });

        return json({ intentId: row.id, status });
      }),
  );

  return server;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Answer with an HTTP status and a fixed JSON error. */
function deny(status: number, code: string, message: string): Response {
  const headers = new Headers({ "content-type": "application/json" });

  if (status === 401) headers.set("www-authenticate", "Bearer");

  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

/**
 * The MCP endpoint agents use, at `/mcp`. Stateless Streamable HTTP: every request carries the
 * agent's bearer token and is served by a fresh server bound to that agent.
 */
export function mountMcp(app: Hono, ctx: AppContext): void {
  const publicUrl = new URL(ctx.config.publicOrigin);
  /** Saves building a handler per request; it holds nothing about the agent but its id. */
  const handlers = new Map<string, McpHttpHandler>();

  /**
   * The client a failed authentication is charged to: the address `FORWARDED_HOPS` entries from
   * the end of `X-Forwarded-For`, which the proxies in front of the server appended (the bundled
   * one appends the last). Fewer entries than that means a proxy was bypassed, and the first is
   * the peer that did it. A request without the header is charged to a shared bucket.
   */
  const clientOf = (request: Request) => {
    const entries = request.headers.get("x-forwarded-for")?.split(",") ?? [];

    return entries[Math.max(0, entries.length - ctx.config.forwardedHops)]?.trim() || "direct";
  };

  // Both limits are buckets in the database, so every replica counts against the same ones.
  const authenticate = async (request: Request): Promise<AgentRow | Response> => {
    const bucket = `auth-fail:${clientOf(request)}`;

    // Checked before the agents are read, so guessing tokens costs no lookup there.
    if (!(await hasToken(ctx.db, bucket, FAILED_AUTH_PER_MINUTE))) {
      return deny(429, "rate_limited", "too many failed authentications; slow down");
    }

    const fail = async () => {
      await takeToken(ctx.db, bucket, FAILED_AUTH_PER_MINUTE);

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

    const [workspace] = await ctx.db
      .select({ lifecycle: workspaces.lifecycle })
      .from(workspaces)
      .where(eq(workspaces.id, agent.workspaceId));

    if (workspace?.lifecycle !== "active") {
      return deny(403, "forbidden", "this agent's workspace is being deleted");
    }

    return agent;
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

    if (!(await takeToken(ctx.db, `agent:${agent.id}`, REQUESTS_PER_MINUTE))) {
      return deny(429, "rate_limited", "too many requests; slow down");
    }

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
          const [current] = await ctx.db.select().from(agents).where(eq(agents.id, bound));

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
