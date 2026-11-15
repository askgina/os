import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiErrorBody, type MandateDraft, type PolicyDraft, routes } from "@askgina/os-api";
import type { AgentId, ApprovalId, IntentId, MandateId } from "@askgina/os-protocol";
import { FakeHyperliquid } from "@askgina/os-testkit/fake-hyperliquid";
import type { Client } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, intents, venueOrders } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { TEST_CHAIN_ID, type TestPerson } from "../support/context.ts";
import { createFixture, draftFor, type Fixture, type TestAgent, toolJson } from "./fixture.ts";

/**
 * The testkit's fake Hyperliquid, which recovers the signer with its own encoder and keeps the
 * venue's nonce rule, served over HTTP on loopback so the server's own client reaches it as it
 * would the venue. A fetch the fake drops (its `drop` failure) closes the connection unanswered.
 */
let f: Fixture;
const venue = new FakeHyperliquid({
  network: "testnet",
  now: () => f.t.clock.now() * 1000,
  universe: [
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
    { name: "APT", szDecimals: 2, maxLeverage: 10 },
    { name: "ATOM", szDecimals: 2, maxLeverage: 10 },
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "OLD", szDecimals: 2, maxLeverage: 3, isDelisted: true },
  ],
});
/** The accepted bodies posted to `/exchange` with this action type, oldest first. */
const posted = (type: string) =>
  venue
    .exchangeLog()
    .filter((entry) => entry.accepted && entry.actionType === type)
    .map((entry) => entry.body);

let server: Server;
let bob: TestPerson;
let trader: TestAgent;
let client: Client;

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

async function startVenue(): Promise<string> {
  server = createServer(async (request, response) => {
    const body = await read(request);
    try {
      const answer = await venue.fetch(`http://fake-hyperliquid${request.url ?? "/"}`, {
        method: request.method ?? "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(await answer.text());
    } catch {
      response.destroy();
    }
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The fixture's EVM policy plus Hyperliquid testnet rules: BTC, ETH, a renamed and a delisted market. */
function venueDraft(agentId: AgentId): PolicyDraft {
  return draftFor(agentId, {
    venues: {
      hyperliquid: {
        network: "hyperliquid:testnet",
        markets: [
          { asset: 2, coin: "DOGE", maxNotionalPerOrderUsd6: "100000000" },
          { asset: 3, coin: "BTC", maxNotionalPerOrderUsd6: "1000000000" },
          { asset: 4, coin: "ETH", maxNotionalPerOrderUsd6: "100000000" },
          { asset: 5, coin: "OLD", maxNotionalPerOrderUsd6: "100000000" },
        ],
        maxNotionalPerDayUsd6: "5000000000",
        timeInForce: ["Gtc", "Ioc"],
        submitWindowSeconds: 60,
        withdrawals: true,
      },
    },
  });
}

/** A GTC buy below the book's ask, which rests. */
const order = (overrides: Record<string, unknown> = {}) => ({
  network: "hyperliquid:testnet",
  coin: "BTC",
  side: "buy",
  size: "0.01",
  limitPrice: "60000",
  timeInForce: "Gtc",
  memo: "funding turned",
  ...overrides,
});

async function call(name: string, args: Record<string, unknown>, as: Client = client) {
  return toolJson(await as.callTool({ name, arguments: args }));
}

async function intentRow(intentId: unknown) {
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, intentId as IntentId));
  if (!row?.approvalId) throw new Error("an intent without its approval");
  return { ...row, approvalId: row.approvalId };
}

/** Propose an order, approve it on the signer's confirmation page; the request is signed, not posted. */
async function approvedOrder(args: Record<string, unknown> = {}) {
  const answer = await call("propose_order", order(args));
  expect(answer).toMatchObject({
    authorizedBy: "person",
    mandateId: null,
    status: "pending_approval",
  });
  const row = await intentRow(answer.intentId);
  const approved = await f.t.approve(row.approvalId, [f.t.owner]);
  expect(approved.status).toBe("executed");
  return row;
}

const followUp = (approvalId: ApprovalId) => engineOf(f.t.ctx).steps().followUp(approvalId);

async function status(intentId: string) {
  return (await intentRow(intentId)).status;
}

beforeAll(async () => {
  const apiUrl = await startVenue();
  f = await createFixture(
    "exec_orders",
    1,
    {},
    {
      venues: [{ network: "hyperliquid:testnet", apiUrl }],
    },
  );
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
  trader = await f.newAgent("Perp trader");
  await f.setPolicy(f.workspaceId, trader.walletId, venueDraft(trader.id));
  venue.seedAccount(trader.address, "1234.5");
  client = await f.mcp(trader.token);
});
afterAll(async () => {
  await f?.close();
  server?.close();
});
beforeEach(() => {
  venue.setBook(3, { bid: "59000", ask: "64500" });
});

describe("proposing an order", () => {
  it("refuses, before any approval opens, what the policy or the venue's metadata does not allow", async () => {
    const before = await f.t.ctx.db.select({ id: approvals.id }).from(approvals);
    const refused = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "propose_order", arguments: order(args) });
      expect(result.isError).toBe(true);
      return toolJson(result);
    };
    expect(await refused({ coin: "XRP" })).toMatchObject({
      error: "policy_denied",
      detail: "market_not_allowed",
    });
    // The policy names asset 2 DOGE; the venue lists ATOM there.
    expect(await refused({ coin: "DOGE" })).toMatchObject({
      error: "conflict",
      detail: "market_metadata_mismatch",
    });
    expect(await refused({ coin: "OLD" })).toMatchObject({ detail: "market_metadata_mismatch" });
    // BTC takes 5 size decimals; a price has at most 5 significant figures unless whole.
    expect(await refused({ size: "0.000001" })).toMatchObject({
      error: "invalid_request",
      detail: "invalid_tick",
    });
    expect(await refused({ limitPrice: "65000.5" })).toMatchObject({ detail: "invalid_tick" });
    // 0.1 BTC at 60000 is 6,000 USD, over the market's 1,000 USD per order.
    expect(await refused({ size: "0.1" })).toMatchObject({ error: "policy_denied" });
    expect(await refused({ timeInForce: "Alo" })).toMatchObject({
      detail: "order_type_not_allowed",
    });
    expect(await refused({ network: "hyperliquid:mainnet" })).toMatchObject({
      detail: "venue_not_configured",
    });
    const after = await f.t.ctx.db.select({ id: approvals.id }).from(approvals);
    expect(after).toHaveLength(before.length);
  });

  it("opens a request people approve, even while a mandate covers the agent's transfers (D7)", async () => {
    const draft: MandateDraft = {
      agentId: trader.id,
      assets: [
        {
          chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
          asset: "native",
          maxPerAction: "1000000000000000000",
          maxPerWindow: "2000000000000000000",
          maxTotal: "3000000000000000000",
        },
      ],
      windowSeconds: 86_400,
      recipients: ["0x1111111111111111111111111111111111111111"],
      maxUses: 5,
      maxFeePerActionWei: "100000000000000000",
      notAfter: f.t.clock.now() + 86_400,
      purpose: "pay the supplier",
    };
    const opened = await f.t.owner.browser.api.call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: trader.walletId },
      body: draft,
    });
    const granted = await f.t.approve(opened.id as ApprovalId, [bob]);
    expect(granted.status).toBe("executed");
    expect(granted.subjectId as MandateId).toMatch(/^mnd_/);

    const answer = await call("propose_order", order());
    expect(answer).toMatchObject({
      authorizedBy: "person",
      mandateId: null,
      status: "pending_approval",
    });
    expect(answer.approvalUrl).toEqual(expect.any(String));
    const row = await intentRow(answer.intentId);
    const detail = await f.t.owner.browser.api.call("getApproval", {
      params: { approvalId: row.approvalId },
    });
    expect(detail.subject).toMatchObject({
      kind: "approve-intent",
      limits: null,
      venue: {
        network: "hyperliquid:testnet",
        maxPerOrderUsd6: "1000000000",
        maxNotionalPerDayUsd6: "5000000000",
        submitWindowSeconds: 60,
        accountValueUsd: expect.any(String),
      },
      intent: {
        display: {
          kind: "order",
          title: "Buy 0.01 BTC at 60000",
          coin: "BTC",
          asset: 3,
          notionalUsd: "600",
          cancellableByAgent: true,
        },
        order: null,
      },
    });
  });
});

describe("after approval", () => {
  it("posts the signed order once, byte for byte, and follows it until it fills", async () => {
    const sent = posted("order").length;
    // Crosses the ask of 64500: filled at once.
    const row = await approvedOrder({ timeInForce: "Ioc", limitPrice: "65000" });
    expect(await status(row.id)).toBe("signed");
    expect(await followUp(row.approvalId)).toEqual({ done: true, waitSeconds: 0 });
    expect(posted("order")).toHaveLength(sent + 1);
    const [stored] = await f.t.ctx.db
      .select()
      .from(venueOrders)
      .where(eq(venueOrders.approvalId, row.approvalId));
    const body = await f.t.ctx.sealer.open(
      row.workspaceId,
      `venue_orders.request:${row.approvalId}`,
      stored?.request ?? new Uint8Array(),
    );
    expect(posted("order").at(-1)).toBe(body);
    expect(venue.exchangeLog().at(-1)?.signer).toBe(trader.address.toLowerCase());
    expect(await status(row.id)).toBe("filled");
    const view = await call("get_intent", { intentId: row.id });
    expect(view).toMatchObject({
      status: "filled",
      to: null,
      explorerUrl: null,
      order: {
        coin: "BTC",
        filledSize: expect.any(String),
        averagePrice: expect.any(String),
        canCancel: false,
      },
    });
    // A second follow-up posts nothing more.
    await followUp(row.approvalId);
    expect(posted("order")).toHaveLength(sent + 1);
  });

  it("after a crash between signing and storing, posts the identical request once", async () => {
    const sent = posted("order").length;
    const row = await approvedOrder();
    const [first] = await f.t.ctx.db
      .select()
      .from(venueOrders)
      .where(eq(venueOrders.approvalId, row.approvalId));
    const body = await f.t.ctx.sealer.open(
      row.workspaceId,
      `venue_orders.request:${row.approvalId}`,
      first?.request ?? new Uint8Array(),
    );
    // The process died after the signer answered and before the row was stored.
    await f.t.ctx.db.delete(venueOrders).where(eq(venueOrders.approvalId, row.approvalId));
    await f.t.ctx.db.update(intents).set({ status: "approved" }).where(eq(intents.id, row.id));
    await f.t.ctx.db
      .update(approvals)
      .set({ status: "approved" })
      .where(eq(approvals.id, row.approvalId));
    expect(await engineOf(f.t.ctx).steps().execute(row.approvalId)).toEqual({ ok: true });
    await followUp(row.approvalId);
    expect(posted("order")).toHaveLength(sent + 1);
    expect(posted("order").at(-1)).toBe(body);
    expect(await status(row.id)).toBe("placed");
  });

  it("after a lost answer, asks the venue by client order id instead of posting again", async () => {
    const sent = posted("order").length;
    const row = await approvedOrder();
    // The venue takes the order and the answer never arrives.
    venue.failNext({ endpoint: "exchange", mode: "drop" });
    expect((await followUp(row.approvalId)).done).toBe(false);
    expect(await status(row.id)).toBe("submitted");
    const next = await followUp(row.approvalId);
    expect(next.done).toBe(false);
    expect(await status(row.id)).toBe("placed");
    expect(posted("order")).toHaveLength(sent + 1);
  });

  it("ends an order expired when its submit window passed before it was posted", async () => {
    const sent = venue.exchangeLog().length;
    const row = await approvedOrder();
    f.t.clock.advance(61);
    expect(await followUp(row.approvalId)).toEqual({ done: true, waitSeconds: 0 });
    expect(await status(row.id)).toBe("expired");
    expect(venue.exchangeLog()).toHaveLength(sent);
  });

  it("lets the agent cancel a resting order with one cancel, and no other agent see or cancel it", async () => {
    const row = await approvedOrder();
    await followUp(row.approvalId);
    expect(await status(row.id)).toBe("placed");

    const other = await f.newAgent("Other trader", await f.newWorkspace("Other desk"));
    const stranger = await f.mcp(other.token);
    const seen = await stranger.callTool({ name: "get_intent", arguments: { intentId: row.id } });
    expect(seen.isError).toBe(true);
    expect(toolJson(seen)).toMatchObject({ error: "not_found" });
    const cancelledByOther = await stranger.callTool({
      name: "cancel_intent",
      arguments: { intentId: row.id },
    });
    expect(toolJson(cancelledByOther)).toMatchObject({ error: "not_found" });

    const cancels = posted("cancelByCloid").length;
    expect(await call("cancel_intent", { intentId: row.id })).toEqual({
      intentId: row.id,
      status: "cancelled",
    });
    expect(posted("cancelByCloid")).toHaveLength(cancels + 1);
    // Final: a second cancel signs and posts nothing.
    expect(await call("cancel_intent", { intentId: row.id })).toMatchObject({
      status: "cancelled",
    });
    expect(posted("cancelByCloid")).toHaveLength(cancels + 1);
  });

  // The identity tests leave this to the execution tests: it is not on that test app.
  it("cancelOrder refuses a write without a same-site Origin, and cancels nothing", async () => {
    const row = await approvedOrder();
    await followUp(row.approvalId);
    expect(await status(row.id)).toBe("placed");
    const cancels = posted("cancelByCloid").length;
    const route = routes.cancelOrder;
    const path = route.path.replace(":intentId", row.id);
    const init = {
      method: route.method,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const missing = await f.t.owner.browser.fetch(path, { ...init, origin: null });
    const foreign = await f.t.owner.browser.fetch(path, {
      ...init,
      origin: "https://evil.example",
    });
    for (const response of [missing, foreign]) {
      expect(response.status).toBe(403);
      expect(ApiErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
    expect(posted("cancelByCloid")).toHaveLength(cancels);
    expect(await status(row.id)).toBe("placed");
  });

  it("lets a person cancel a resting order without a passkey", async () => {
    const row = await approvedOrder();
    await followUp(row.approvalId);
    const detail = await f.t.owner.browser.api.call("cancelOrder", {
      params: { intentId: row.id },
      body: {},
    });
    expect(detail).toMatchObject({ status: "cancelled", order: { canCancel: false } });
  });
});

describe("withdrawing from the venue", () => {
  it("goes to the wallet's own address only, and ends confirmed once accepted", async () => {
    const elsewhere = await client.callTool({
      name: "propose_transfer",
      arguments: {
        chainId: "hyperliquid:testnet",
        to: "0x1111111111111111111111111111111111111111",
        amount: "5",
        asset: "usdc",
        memo: "take profits home",
      },
    });
    expect(toolJson(elsewhere)).toMatchObject({ detail: "withdrawal_not_own_address" });

    const answer = await call("propose_transfer", {
      chainId: "hyperliquid:testnet",
      to: trader.address,
      amount: "5",
      asset: "usdc",
      memo: "take profits home",
    });
    expect(answer).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
    const row = await intentRow(answer.intentId);
    expect((await f.t.approve(row.approvalId, [f.t.owner])).status).toBe("executed");
    const sent = posted("withdraw3").length;
    expect(await followUp(row.approvalId)).toEqual({ done: true, waitSeconds: 0 });
    expect(posted("withdraw3")).toHaveLength(sent + 1);
    const body = JSON.parse(posted("withdraw3").at(-1) ?? "{}");
    expect(body.action).toMatchObject({
      type: "withdraw3",
      destination: trader.address.toLowerCase(),
    });
    expect(await status(row.id)).toBe("confirmed");
  });

  /** An approved withdrawal of 3 USDC to the wallet's own address, signed and not yet posted. */
  async function approvedWithdrawal() {
    const answer = await call("propose_transfer", {
      chainId: "hyperliquid:testnet",
      to: trader.address,
      amount: "3",
      asset: "usdc",
      memo: "rebalance",
    });
    const row = await intentRow(answer.intentId);
    expect((await f.t.approve(row.approvalId, [f.t.owner])).status).toBe("executed");
    return row;
  }
  const withdrawalsPosted = () =>
    venue.exchangeLog().filter((entry) => entry.actionType === "withdraw3").length;

  it("after a lost answer, finds the withdrawal in the venue's ledger and does not post it again", async () => {
    const row = await approvedWithdrawal();
    const sent = withdrawalsPosted();
    const taken = venue.withdrawals().length;
    // The venue takes the withdrawal and the answer never arrives.
    venue.failNext({ endpoint: "exchange", mode: "drop" });
    expect((await followUp(row.approvalId)).done).toBe(false);
    expect(await status(row.id)).toBe("submitted");
    expect(venue.withdrawals()).toHaveLength(taken + 1);
    expect(await followUp(row.approvalId)).toEqual({ done: true, waitSeconds: 0 });
    expect(await status(row.id)).toBe("confirmed");
    expect(withdrawalsPosted()).toBe(sent + 1);
    expect(venue.withdrawals()).toHaveLength(taken + 1);
  });

  it("after an answer that says nothing, posts a withdrawal the venue did not take once more", async () => {
    const row = await approvedWithdrawal();
    const taken = venue.withdrawals().length;
    // The request never reaches the venue's ledger: a server error before it is read.
    venue.failNext({ endpoint: "exchange", mode: "http", status: 502 });
    expect((await followUp(row.approvalId)).done).toBe(false);
    expect(await status(row.id)).toBe("submitted");
    expect(venue.withdrawals()).toHaveLength(taken);
    expect(await followUp(row.approvalId)).toEqual({ done: true, waitSeconds: 0 });
    expect(await status(row.id)).toBe("confirmed");
    expect(venue.withdrawals()).toHaveLength(taken + 1);
  });
});

describe("the wallet page", () => {
  const getWallet = (walletId: string) =>
    f.t.owner.browser.api.call("getWallet", { params: { workspaceId: f.workspaceId, walletId } });

  it("shows the venue's report of the account and the signer's 24-hour count against the cap", async () => {
    const owner = trader.address.toLowerCase();
    const open = venue.orders().filter((entry) => entry.user === owner && entry.status === "open");
    expect(open.length).toBeGreaterThan(0);
    const state = await f.t.ctx.signer.getWallet(trader.walletId);
    const spent = state.venueSpent.find((entry) => entry.chainId === "hyperliquid:testnet");
    expect(BigInt(spent?.amount ?? "0")).toBeGreaterThan(0n);

    const detail = await getWallet(trader.walletId);
    expect(detail.venue).toMatchObject({
      network: "hyperliquid:testnet",
      spentTodayUsd6: spent?.amount,
      maxNotionalPerDayUsd6: "5000000000",
      reported: {
        accountValueUsd: expect.stringMatching(/^\d/),
        withdrawableUsd: expect.stringMatching(/^\d/),
      },
    });
    expect(detail.venue?.reported?.positions).toContainEqual(
      expect.objectContaining({ coin: "BTC", side: "long" }),
    );
    expect(detail.venue?.reported?.openOrders).toEqual(
      open.map((entry) => ({
        coin: entry.coin,
        side: entry.isBuy ? "buy" : "sell",
        size: entry.size,
        limitPrice: entry.limitPx,
        venueOrderId: entry.oid,
        cloid: null,
      })),
    );
  });

  it("keeps the signer's count when the venue cannot be read, and has no section without a venue", async () => {
    venue.failNext({ endpoint: "info", mode: "http", status: 500, count: 2 });
    const unread = await getWallet(trader.walletId);
    expect(unread.venue).toMatchObject({
      network: "hyperliquid:testnet",
      spentTodayUsd6: expect.stringMatching(/^[1-9]/),
      reported: null,
    });
    const bystander = await f.newAgent("Bystander");
    expect(await getWallet(bystander.walletId)).not.toHaveProperty("venue");
  });
});
