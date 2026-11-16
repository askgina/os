/**
 * The venue gates (`specs/non-evm-operations.md`), against a stack of their own
 * (`e2e/run.sh`) whose server names two fake Hyperliquid venues, one for the testnet and one for
 * mainnet (`e2e/compose.venue.yaml`, TEST EQUIPMENT). Each fake recovers the signer of every
 * request with its own encoder, independent of the signer's, as its network's venue does, and
 * keeps everything it was sent. Nothing here reaches Hyperliquid, and no gate places an order
 * with real funds.
 *
 * A person approves every order on the signer's confirmation page with a passkey; the server
 * posts the signer's request and follows the order. The gates check what reached the venue
 * against what the signer recorded in its own SQLite file.
 *
 * The tests run in order and share state: the first claims the installation.
 */
import { setTimeout as delay } from "node:timers/promises";
import type {
  IntentDetail,
  MandateDraft,
  PolicyDraft,
  VenueAccount,
  WalletSummary,
  WorkspaceDetail,
} from "@askgina/os-api";
import type { ConfirmationView } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import { scanForMarkers } from "@askgina/os-testkit";
import {
  type ExchangeBody,
  type FakeAsset,
  type FakeNetwork,
  parseExchangeBody,
  recoverExchangeSigner,
} from "@askgina/os-testkit/fake-hyperliquid";
import { expect, test } from "@playwright/test";
import { isAddressEqual, parseEther, parseUnits } from "viem";
import { z } from "zod";
import { type AgentConnection, connectAgent, Proposal, ToolRefused } from "../src/agent.ts";
import type { JsonValue } from "../src/json.ts";
import { Person } from "../src/person.ts";
import {
  compose,
  containersOf,
  databaseUrl,
  docker,
  execIn,
  fromAgentsNetwork,
  setupToken,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import {
  bootServerWith,
  type ProbeRequest,
  postToVenue,
  reachFrom,
  requestsFor,
  sealedVenueRequests,
  seedVenueAccount,
  setVenueBook,
  setVenueUniverse,
  signedCancels,
  signedRequest,
  venueAddress,
  venueCancels,
  venueExchangeLog,
  venueOrders,
  venueReport,
  venueWithdrawals,
} from "../src/venue.ts";
import { acknowledged, expectSignedDelivery, webhookSecret } from "../src/webhook.ts";

test.describe.configure({ mode: "serial" });

const CHAIN = "eip155:31337";

const TESTNET = "hyperliquid:testnet";

const MAINNET = "hyperliquid:mainnet";

const run = Date.now().toString(36);

/** Text an agent types with an order. */
const ORDER_MEMO = `ORDERMEMO${run} buy a little bitcoin`;

/** Text an agent types with the order whose approval the webhook announces. */
const NOTICE_MEMO = `NOTICEMARK${run} an order announced with no detail`;

/** Text an agent types with a withdrawal from the venue. */
const WITHDRAW_MEMO = `WITHDRAWMARK${run} take some of it home`;

/** Text an agent types with an order on the mainnet venue. */
const MAINNET_MEMO = `MAINNETMARK${run} an order for the mainnet venue`;

const WORKSPACE_NAME = `Trading desk ${run}`;

/** The only mandate recipient; the mandate gate never pays it. */
const PAYEE = "0x000000000000000000000000000000000000b0b0";

/**
 * Exactly the tools an agent gets: none signs, approves, administers or speeds up; the agent's
 * one cancel is of its own proposal or order.
 */
const AGENT_TOOLS = [
  "cancel_intent",
  "get_balances",
  "get_candles",
  "get_intent",
  "get_markets",
  "get_order_book",
  "get_prices",
  "get_venue_account",
  "get_venue_fills",
  "list_intents",
  "preview_order",
  "propose_contract_call",
  "propose_order",
  "propose_transfer",
  "whoami",
];

/** The venue's perpetuals, set here so no gate depends on the fake's defaults. */
const UNIVERSE: FakeAsset[] = [
  { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  { name: "APT", szDecimals: 2, maxLeverage: 10 },
  { name: "ATOM", szDecimals: 2, maxLeverage: 10 },
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
];

/** The one market every wallet below may trade: BTC, at its index in {@link UNIVERSE}. */
const BTC = 3;

/** Statuses an order passes through before the venue's answer decides it. */
const WAITING = ["proposed", "pending_approval", "approved", "signed", "submitted"];

const wei = (amount: string) => parseEther(amount).toString();

const usd6 = (amount: string) => parseUnits(amount, 6).toString();

const nowSeconds = () => Math.floor(Date.now() / 1000);

type HyperliquidRules = NonNullable<NonNullable<PolicyDraft["venues"]>["hyperliquid"]>;

/** An agent with its own wallet, under a policy that lets it trade BTC on one venue network. */
interface Trader {
  agentId: PolicyDraft["requesters"][number];
  token: string;
  wallet: WalletSummary;
  agent: AgentConnection;
}

const ada = new Person(stack.origin, "Ada");

let workspace: WorkspaceDetail;

/** Trades within 50 USD an order and 200 a day, immediate-or-cancel or resting. */
let trader: Trader;

/**
 * How a trader's wallet may trade BTC; the caps in whole USD. On the testnet and with no
 * withdrawals unless set.
 */
type TraderRules = Pick<HyperliquidRules, "timeInForce" | "submitWindowSeconds"> &
  Partial<Pick<HyperliquidRules, "withdrawals" | "network">> & {
    perOrderUsd: string;
    perDayUsd: string;
  };

/**
 * A policy for `agentId` that lets it pay on the local chain (so a mandate can be granted on its
 * wallet) and trade BTC on the Hyperliquid network `rules` name, the testnet unless named,
 * within `rules`.
 */
function policyFor(agentId: Trader["agentId"], rules: TraderRules): PolicyDraft {
  return {
    chains: [CHAIN],
    requesters: [agentId],
    assets: [{ chainId: CHAIN, asset: "native", maxPerTx: wei("0.05"), maxPerDay: wei("0.5") }],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: wei("0.01") },
    approvals: { threshold: 1, ttlSeconds: 3600 },
    venues: {
      hyperliquid: {
        network: rules.network ?? TESTNET,
        markets: [{ asset: BTC, coin: "BTC", maxNotionalPerOrderUsd6: usd6(rules.perOrderUsd) }],
        maxNotionalPerDayUsd6: usd6(rules.perDayUsd),
        timeInForce: rules.timeInForce,
        submitWindowSeconds: rules.submitWindowSeconds,
        withdrawals: rules.withdrawals ?? false,
      },
    },
  };
}

/**
 * A new agent with its own wallet, a policy from {@link policyFor} approved on the signer's
 * confirmation page, and an account holding 1,000 USDC at the venue of the policy's network.
 */
async function newTrader(name: string, rules: TraderRules): Promise<Trader> {
  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name },
  });

  const agentId = created.agent.id;

  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: created.wallet.id },
    body: { draft: policyFor(agentId, rules) },
  });

  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
  await seedVenueAccount(
    created.wallet.address,
    "1000",
    rules.network === MAINNET ? "mainnet" : "testnet",
  );

  return {
    agentId,
    token: created.token,
    wallet: created.wallet,
    agent: await connectAgent(`${stack.origin}/mcp`, created.token),
  };
}

interface OrderInput {
  side: "buy" | "sell";
  size: string;
  limitPrice: string;
  coin?: string;
  network?: string;
  timeInForce?: string;
  reduceOnly?: boolean;
  memo?: string;
}

/** The agent proposes a BTC order, on the testnet unless `order` names a network; checked. */
async function proposeOrder(agent: AgentConnection, order: OrderInput): Promise<Proposal> {
  return Proposal.parse(
    await agent.call("propose_order", {
      network: TESTNET,
      coin: "BTC",
      memo: "an order for the venue gates",
      ...order,
    }),
  );
}

function approvalIdOf(proposal: Proposal): string {
  return String(proposal.approvalUrl).split("/").at(-1) ?? "";
}

/** A person approves an order on the signer's page; the intent once the venue's answer decided it. */
async function approveOrder(proposal: Proposal): Promise<IntentDetail> {
  const approvalId = approvalIdOf(proposal);
  const link = await ada.confirmationLink(approvalId);
  await ada.approveOnConfirmationPage(link, await ada.readConfirmation(link));
  await ada.api.call("collectApproval", { params: { approvalId }, body: {} });

  return settles(proposal.intentId);
}

/**
 * The intent once the venue's answer has decided it (or a person, or the clock). An answer the
 * stack cannot give for a moment, while the server restarts, is asked again until `timeoutMs`.
 */
async function settles(intentId: string, timeoutMs = 120_000): Promise<IntentDetail> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer yet";

  for (;;) {
    try {
      const intent = await ada.api.call("getIntent", { params: { intentId } });

      if (!WAITING.includes(intent.status)) return intent;
      last = intent.status;
    } catch (error) {
      last = `no answer: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (Date.now() > deadline) throw new Error(`intent ${intentId} is still ${last}`);
    await delay(250);
  }
}

/** The value of the confirmation page's line labelled `label`. */
function lineValue(view: ConfirmationView, label: string): string {
  const line = view.lines.find((candidate) => candidate.label === label);

  if (line === undefined) throw new Error(`the confirmation page shows no "${label}" line`);

  return line.value;
}

/** The code and reason a tool refused `attempt` with; fails when it was not refused. */
async function toolRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string | null; detail: string | null }> {
  const outcome = await attempt.then(
    () => null,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ToolRefused)) {
    throw new Error(`expected the tool to refuse, got ${String(outcome)}`);
  }

  return { code: outcome.code, detail: outcome.detail };
}

/** The workspace's whole signer decision log, read to its end: a page holds the oldest 100. */
async function signerDecisions(): Promise<SignerDecision[]> {
  const decisions: SignerDecision[] = [];

  for (let after = 0; ; ) {
    const page = await ada.api.call("listSignerDecisions", {
      params: { workspaceId: workspace.id },
      query: { after: String(after) },
    });

    decisions.push(...page.items);
    const last = page.items.at(-1);

    if (!last || page.items.length < 100) return decisions;
    after = last.seq;
  }
}

/** The signer's decisions of `action` about one approval. */
async function decisionsAbout(approvalId: string, action: string): Promise<SignerDecision[]> {
  return (await signerDecisions()).filter(
    (decision) => decision.approvalId === approvalId && decision.action === action,
  );
}

async function pendingApprovals(): Promise<number> {
  const pending = await ada.api.call("listApprovals", {
    params: { workspaceId: workspace.id },
    query: { status: "pending" },
  });

  return pending.items.length;
}

/** How many proposals an agent has made, as it lists them. */
async function intentCount(agent: AgentConnection): Promise<number> {
  const { intents } = await agent.call("list_intents", { limit: 50 });

  return Array.isArray(intents) ? intents.length : Number.NaN;
}

/** How many times a person's passkey has signed anything. */
function passkeyUses(person: Person): number {
  let uses = 0;

  for (const credential of person.authenticator.credentials.values()) uses += credential.signCount;

  return uses;
}

/** Resume the workspace if it is paused; resuming needs the passkey, as always. */
async function resumeIfPaused(): Promise<void> {
  const { paused } = await ada.api.call("getWorkspace", { params: { workspaceId: workspace.id } });

  if (!paused) return;

  const resume = await ada.api.call("requestResume", {
    params: { workspaceId: workspace.id },
    body: {},
  });

  await ada.confirm(resume.id);
  expect((await ada.settled(resume.id)).status).toBe("executed");
}

/** The order request the signer signed for `approvalId`, once it has signed it. */
async function signedOnce(approvalId: string): Promise<{ request: string; cloid: string }> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const signed = await signedRequest(approvalId);

    if (signed !== null) {
      if (signed.cloid === null)
        throw new Error(`${approvalId} was signed with no client order id`);

      return { request: signed.request, cloid: signed.cloid };
    }

    if (Date.now() > deadline) throw new Error(`the signer has not signed ${approvalId}`);
    await delay(500);
  }
}

/** The wallet page's venue section: the signer's count, and the venue's report as the server read it. */
async function walletVenue(wallet: WalletSummary): Promise<VenueAccount> {
  const detail = await ada.api.call("getWallet", {
    params: { workspaceId: workspace.id, walletId: wallet.id },
  });

  if (detail.venue === undefined) throw new Error(`the page of ${wallet.id} shows no venue`);

  return detail.venue;
}

/**
 * Expect `body` to be signed by `wallet` for `network`'s venue, the testnet unless named,
 * recovered here from its bytes alone.
 */
async function expectSignedBy(
  body: string,
  wallet: WalletSummary,
  network: FakeNetwork = "testnet",
): Promise<void> {
  const parsed = parseExchangeBody(body);

  if (isRefusal(parsed)) throw new Error(`the venue could not read a request: ${parsed}`);
  expect(isAddressEqual(await recoverExchangeSigner(parsed, network), wallet.address)).toBe(true);
}

/** Whether the venue's parser could not read a body: it answers its reason, a string, then. */
function isRefusal(parsed: ExchangeBody | string): parsed is string {
  return z.string().safeParse(parsed).success;
}

// --- the server's way to the venue ------------------------------------------------------------

/** The Compose network the server reaches venues on, and the only one the fake venues are on. */
const venueNetwork = () => `${stack.project}_chain`;

async function serverContainer(): Promise<string> {
  const [server] = await containersOf("server");

  if (server === undefined) throw new Error("the stack has no server container");

  return server;
}

/** Whether a probe inside `container` resolves the fake venue's name. */
async function resolvesVenue(container: string): Promise<boolean> {
  const output = await execIn(
    container,
    "node",
    "-e",
    'require("node:dns/promises").lookup("fake-hyperliquid").then(() => console.log("yes"), () => console.log("no"))',
  );

  return output.trim() === "yes";
}

/**
 * Cut the server off from the venues, as a network fault would: it can still sign, read its
 * database and answer people, but nothing it posts can reach either venue.
 */
async function cutServerFromVenue(container: string): Promise<void> {
  await docker("network", "disconnect", venueNetwork(), container);
  expect(await resolvesVenue(container)).toBe(false);
}

/** Give the server its way to the venue back; does nothing when it has it. Running or stopped. */
async function reconnectServerToVenue(container: string): Promise<void> {
  const networks = await docker(
    "inspect",
    "--format",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
    container,
  );

  if (networks.split(" ").includes(venueNetwork())) return;
  await docker("network", "connect", "--alias", "server", venueNetwork(), container);
}

/**
 * Kill the server as a crash would, and return only once its container has stopped, as the
 * release gates do.
 */
async function killServer(): Promise<void> {
  await compose("kill", "server");
  await compose("stop", "--timeout", "0", "server");
}

test.beforeAll(async () => {
  await waitUntilHealthy();
});

// A failed gate prints what the fake venues took, which no container log shows.
test.afterEach(async () => {
  const info = test.info();

  if (info.status === info.expectedStatus) return;
  process.stderr.write(`\n--- the fake venue after "${info.title}" ---\n${await venueReport()}\n`);
});

test("a fresh installation, and an agent's wallet allowed to trade BTC on the Hyperliquid testnet once a person approves its policy", async () => {
  const session = await ada.setUp(await setupToken());
  expect(session.setupRequired).toBe(false);
  workspace = await ada.api.call("createWorkspace", { body: { name: WORKSPACE_NAME } });
  await setVenueUniverse(UNIVERSE);
  await setVenueBook(BTC, "63000", "64000");
  trader = await newTrader("Trader", {
    timeInForce: ["Gtc", "Ioc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });
});

test("an agent has exactly fifteen tools, and sees the two venues the server is configured with", async () => {
  expect(await trader.agent.tools()).toEqual(AGENT_TOOLS);
  const me = await trader.agent.call("whoami");
  expect(me.venues).toEqual([
    { network: TESTNET, name: "Hyperliquid testnet" },
    { network: MAINNET, name: "Hyperliquid mainnet" },
  ]);
});

test("an agent on the agents network reads each configured venue's own prices", async () => {
  await setVenueUniverse(UNIVERSE, "mainnet");
  await setVenueBook(BTC, "70000", "71000", "mainnet");
  await setVenueBook(BTC, "63000", "64000");

  // The agent's container reaches the MCP gateway and nothing else; the server reads each venue.
  const script = `
    const call = (name, args) => fetch("http://agent-gateway/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + ${JSON.stringify(trader.token)},
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json()).then((m) => JSON.parse(m.result.content[0].text), (e) => String(e));
    (async () => {
      console.log(JSON.stringify({
        testnet: await call("get_prices", { network: ${JSON.stringify(TESTNET)}, coins: ["BTC"] }),
        mainnet: await call("get_prices", { network: ${JSON.stringify(MAINNET)}, coins: ["BTC"] }),
        internet: await fetch("https://example.com/", { signal: AbortSignal.timeout(4000) }).then((r) => r.status, () => "unreachable"),
      }));
    })();`;

  const { output } = await fromAgentsNetwork(script);
  const seen = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  expect(seen.testnet).toMatchObject({ network: TESTNET, prices: [{ coin: "BTC", mid: "63500" }] });
  expect(seen.mainnet).toMatchObject({ network: MAINNET, prices: [{ coin: "BTC", mid: "70500" }] });
  expect(seen.internet).toBe("unreachable");
});

test("an agent prices an order from the book, and reads the position and the fill it caused", async () => {
  const buyer = await newTrader("Buyer", {
    timeInForce: ["Gtc", "Ioc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });

  await setVenueBook(BTC, "63000", "64000");

  const preview = await buyer.agent.call("preview_order", {
    network: TESTNET,
    coin: "BTC",
    side: "buy",
    size: "0.0002",
  });

  expect(preview).toMatchObject({
    network: TESTNET,
    fullyCovered: true,
    averagePrice: "64000",
    bestPrice: "64000",
    mid: "63500",
    notionalUsd6: "12800000",
    levelsUsed: 1,
  });

  // The agent proposes at the price the preview gave, and a person approves it.
  const proposal = await proposeOrder(buyer.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: String(preview.averagePrice),
    timeInForce: "Ioc",
    memo: "at the previewed price",
  });

  expect((await approveOrder(proposal)).status).toBe("filled");

  const account = await buyer.agent.call("get_venue_account", { network: TESTNET });
  expect(account).toMatchObject({
    network: TESTNET,
    walletId: buyer.wallet.id,
    positions: [{ coin: "BTC", side: "long", size: "0.0002", entryPrice: "64000" }],
    openOrders: [],
    omitted: 0,
  });

  const fills = await buyer.agent.call("get_venue_fills", { network: TESTNET });
  expect(fills).toMatchObject({
    fills: [
      {
        coin: "BTC",
        side: "buy",
        price: "64000",
        size: "0.0002",
        taker: true,
        intentId: proposal.intentId,
      },
    ],
    omitted: 0,
  });
});

test("an agent cannot read the venue account of a wallet it may not use", async () => {
  const neighbour = await newTrader("Neighbour", {
    timeInForce: ["Ioc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });

  const nobody = `wal_${"0".repeat(26)}`;

  for (const tool of ["get_venue_account", "get_venue_fills"]) {
    const theirs = await toolRefusal(
      trader.agent.call(tool, { network: TESTNET, walletId: neighbour.wallet.id }),
    );

    // The same answer as for a wallet that does not exist.
    expect(theirs).toEqual({ code: "not_found", detail: null });
    expect(
      await toolRefusal(trader.agent.call(tool, { network: TESTNET, walletId: nobody })),
    ).toEqual(theirs);
  }

  // The neighbour reads its own.
  expect(await neighbour.agent.call("get_venue_account", { network: TESTNET })).toMatchObject({
    walletId: neighbour.wallet.id,
  });
});

test("an agent that spends the read budget is refused, and another agent's order and cancel still go through", async () => {
  const reader = await newTrader("Reader", {
    timeInForce: ["Ioc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });

  const desk = await newTrader("Desk", {
    timeInForce: ["Gtc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });

  // Fills are never answered from a cache, and each is admitted at its worst case, 120, and keeps
  // 20 of it: within a few reads less than 120 of the agent's 240 a minute is left.
  let refusal: { code: string | null; detail: string | null } | null = null;

  for (let call = 0; call < 30 && refusal === null; call += 1) {
    try {
      await reader.agent.call("get_venue_fills", { network: TESTNET });
    } catch (error) {
      if (!(error instanceof ToolRefused)) throw error;
      refusal = { code: error.code, detail: error.detail };
    }
  }

  expect(refusal).toEqual({ code: "rate_limited", detail: "venue_budget" });

  // Another agent's order is posted, rests, and its cancel reaches the venue.
  const proposal = await proposeOrder(desk.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "50000",
    timeInForce: "Gtc",
    memo: "rest while another agent's reads are refused",
  });

  expect((await approveOrder(proposal)).status).toBe("placed");
  const { cloid } = await signedOnce(approvalIdOf(proposal));
  expect(await desk.agent.call("cancel_intent", { intentId: proposal.intentId })).toMatchObject({
    status: "cancelled",
  });
  expect(
    (await requestsFor(cloid)).map((request) => [request.actionType, request.accepted]),
  ).toEqual([
    ["order", true],
    ["cancelByCloid", true],
  ]);
  // And another agent still reads.
  expect(await desk.agent.call("get_venue_fills", { network: TESTNET, limit: 1 })).toMatchObject({
    walletId: desk.wallet.id,
  });
});

test("an order proposal becomes exactly one order at the venue after a passkey approval on the signer's page", async () => {
  const before = (await venueExchangeLog()).length;

  const proposal = await proposeOrder(trader.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "65000",
    timeInForce: "Ioc",
    memo: ORDER_MEMO,
  });

  // A person always approves an order.
  expect(proposal).toMatchObject({
    authorizedBy: "person",
    mandateId: null,
    status: "pending_approval",
  });
  const approvalId = approvalIdOf(proposal);
  // Nothing is signed or sent before that.
  expect(await signedRequest(approvalId)).toBeNull();
  expect((await venueExchangeLog()).length).toBe(before);

  // The signer's page shows the order as the signer will build it.
  const link = await ada.confirmationLink(approvalId);
  expect(link.origin).toBe(stack.approveOrigin);
  const view = await ada.readConfirmation(link);
  expect(view).toMatchObject({ approvalId, kind: "approve-intent", state: "open" });
  expect(view.title).toContain("Buy 0.0002 BTC");
  expect(lineValue(view, "Market")).toContain("BTC perpetual");
  expect(lineValue(view, "Market index")).toBe(String(BTC));
  expect(lineValue(view, "Side")).toBe("buy");
  expect(lineValue(view, "Size")).toBe("0.0002 BTC");
  expect(lineValue(view, "Limit price")).toBe("65,000 USD");
  expect(lineValue(view, "Notional at the limit price")).toBe("13 USD");
  expect(lineValue(view, "Time in force")).toContain("immediate or cancel");
  expect(lineValue(view, "Network")).toContain(TESTNET);
  expect(view.lines).toContainEqual(
    expect.objectContaining({ value: ORDER_MEMO, kind: "unchecked" }),
  );

  expect(await ada.approveOnConfirmationPage(link, view)).toMatchObject({
    collected: 1,
    required: 1,
  });
  await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
  const filled = await settles(proposal.intentId);
  expect(filled.status).toBe("filled");
  expect(Number(filled.order?.filledSize)).toBe(0.0002);

  // One request reached the venue: signed by the wallet, the approved order, and byte for byte
  // the request the signer signed once.
  const signed = await signedOnce(approvalId);
  expect(filled.order?.cloid.toLowerCase()).toBe(signed.cloid.toLowerCase());
  const requests = await requestsFor(signed.cloid);
  expect(requests).toHaveLength(1);
  const [posted] = requests;

  if (posted === undefined) throw new Error("no request reached the venue");
  expect(posted).toMatchObject({ accepted: true, actionType: "order", dropped: false });
  expect(posted.signer).toBe(trader.wallet.address.toLowerCase());
  await expectSignedBy(posted.body, trader.wallet);
  expect(posted.body).toBe(signed.request);
  const parsed = parseExchangeBody(posted.body);

  if (isRefusal(parsed)) throw new Error(parsed);
  expect(parsed.action).toEqual({
    type: "order",
    orders: [
      {
        a: BTC,
        b: true,
        p: "65000",
        s: "0.0002",
        r: false,
        t: { limit: { tif: "Ioc" } },
        c: expect.stringMatching(new RegExp(`^${signed.cloid}$`, "i")),
      },
    ],
    grouping: "na",
  });
  expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([
    expect.objectContaining({ outcome: "allowed" }),
  ]);
  // The agent sees the same order.
  expect(await trader.agent.call("get_intent", { intentId: proposal.intentId })).toMatchObject({
    status: "filled",
    order: { coin: "BTC", side: "buy", size: "0.0002", limitPrice: "65000", timeInForce: "Ioc" },
  });
});

test("the agent cancels a resting order with no passkey, also while the workspace is paused, and the cancel is the only other action signed", async () => {
  // Far below the best bid: it rests on the book.
  const proposal = await proposeOrder(trader.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "50000",
    timeInForce: "Gtc",
    memo: "rest below the market",
  });

  const approvalId = approvalIdOf(proposal);
  const link = await ada.confirmationLink(approvalId);
  const view = await ada.readConfirmation(link);
  // The signer's page says, in its own words, that approving includes this cancel.
  expect(lineValue(view, "Cancelling")).toContain("the agent may cancel this order");
  expect(lineValue(view, "Time in force")).toContain("good till cancelled");
  await ada.approveOnConfirmationPage(link, view);
  await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
  const placed = await settles(proposal.intentId);
  expect(placed.status).toBe("placed");
  expect(placed.order?.canCancel).toBe(true);
  const { cloid } = await signedOnce(approvalId);
  expect((await venueOrders()).find((order) => order.cloid === cloid.toLowerCase())?.status).toBe(
    "open",
  );

  await ada.api.call("pauseWorkspace", { params: { workspaceId: workspace.id }, body: {} });

  try {
    // Paused: the agent proposes nothing,
    expect(
      await toolRefusal(
        proposeOrder(trader.agent, { side: "buy", size: "0.0002", limitPrice: "65000" }),
      ),
    ).toEqual({ code: "conflict", detail: "workspace_paused" });
    // but may still take back what a person approved, with no one asked.
    const uses = passkeyUses(ada);
    expect(await trader.agent.call("cancel_intent", { intentId: proposal.intentId })).toMatchObject(
      { intentId: proposal.intentId, status: "cancelled" },
    );
    expect(passkeyUses(ada)).toBe(uses);
  } finally {
    await resumeIfPaused();
  }

  expect((await settles(proposal.intentId)).status).toBe("cancelled");
  expect((await venueOrders()).find((order) => order.cloid === cloid.toLowerCase())?.status).toBe(
    "canceled",
  );
  expect(
    (await venueCancels())
      .filter((cancel) => cancel.cloid.toLowerCase() === cloid.toLowerCase())
      .map((cancel) => cancel.result),
  ).toEqual(["success"]);
  // The order and its cancel, each once, each signed by the wallet, each byte for byte what the
  // signer signed.
  const requests = await requestsFor(cloid);
  expect(requests.map((request) => [request.actionType, request.accepted])).toEqual([
    ["order", true],
    ["cancelByCloid", true],
  ]);
  const [order, cancel] = requests;

  if (order === undefined || cancel === undefined) throw new Error("a request is missing");
  await expectSignedBy(order.body, trader.wallet);
  await expectSignedBy(cancel.body, trader.wallet);
  expect(order.body).toBe((await signedRequest(approvalId))?.request);
  expect(await signedCancels(approvalId)).toEqual([cancel.body]);
  expect(await decisionsAbout(approvalId, "cancel-venue-order")).toEqual([
    expect.objectContaining({ outcome: "allowed" }),
  ]);
});

test("an order outside the wallet's policy, also one on a venue network the policy does not name, is refused before anyone is asked", async () => {
  const pendingBefore = await pendingApprovals();
  const intentsBefore = await intentCount(trader.agent);
  const requestsBefore = (await venueExchangeLog()).length;
  const mainnetRequestsBefore = (await venueExchangeLog("mainnet")).length;

  // A market the venue lists and the policy does not.
  expect(
    await toolRefusal(
      proposeOrder(trader.agent, { coin: "ETH", side: "buy", size: "0.01", limitPrice: "3000" }),
    ),
  ).toEqual({ code: "policy_denied", detail: "market_not_allowed" });
  // An order type the policy does not allow.
  expect(
    await toolRefusal(
      proposeOrder(trader.agent, {
        side: "buy",
        size: "0.0002",
        limitPrice: "65000",
        timeInForce: "Alo",
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "order_type_not_allowed" });
  // Over the market's per-order cap: 0.001 BTC at 65,000 is 65 USD, over 50.
  expect(
    await toolRefusal(
      proposeOrder(trader.agent, { side: "buy", size: "0.001", limitPrice: "65000" }),
    ),
  ).toEqual({ code: "policy_denied", detail: "over_per_tx_cap" });
  // A venue the server is configured with, on a network the wallet's policy does not name: its
  // approved rules are for the testnet.
  expect(
    await toolRefusal(
      proposeOrder(trader.agent, {
        network: MAINNET,
        side: "buy",
        size: "0.0002",
        limitPrice: "65000",
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "venue_not_allowed" });

  // No approval opened, nothing was recorded, and nothing reached either venue.
  expect(await pendingApprovals()).toBe(pendingBefore);
  expect(await intentCount(trader.agent)).toBe(intentsBefore);
  expect((await venueExchangeLog()).length).toBe(requestsBefore);
  expect((await venueExchangeLog("mainnet")).length).toBe(mainnetRequestsBefore);
});

test("a wallet whose approved policy names Hyperliquid mainnet places an order on the mainnet venue, and neither venue accepts the other network's signature", async () => {
  await setVenueUniverse(UNIVERSE, "mainnet");
  await setVenueBook(BTC, "63000", "64000", "mainnet");

  // Its policy, approved with the passkey like every other, names mainnet; its account is at
  // the mainnet venue.
  const mainnet = await newTrader("Mainnet", {
    network: MAINNET,
    timeInForce: ["Ioc"],
    perOrderUsd: "25",
    perDayUsd: "30",
    submitWindowSeconds: 300,
  });

  const address = mainnet.wallet.address.toLowerCase();
  // An account at the testnet venue too, so a request that venue refuses below is refused for
  // the signer it recovers and not for a missing account.
  await seedVenueAccount(mainnet.wallet.address, "1000", "testnet");

  try {
    const me = await mainnet.agent.call("whoami");
    expect(JSON.stringify(me.wallets)).toContain(MAINNET);

    const proposal = await proposeOrder(mainnet.agent, {
      network: MAINNET,
      side: "buy",
      size: "0.0002",
      limitPrice: "65000",
      timeInForce: "Ioc",
      memo: MAINNET_MEMO,
    });

    // A person approves it, as every order.
    expect(proposal).toMatchObject({
      authorizedBy: "person",
      mandateId: null,
      status: "pending_approval",
    });
    const approvalId = approvalIdOf(proposal);
    expect(await signedRequest(approvalId)).toBeNull();
    const link = await ada.confirmationLink(approvalId);
    const view = await ada.readConfirmation(link);
    expect(view).toMatchObject({ approvalId, kind: "approve-intent", state: "open" });
    expect(view.title).toContain("Buy 0.0002 BTC");
    expect(lineValue(view, "Network")).toContain(MAINNET);
    await ada.approveOnConfirmationPage(link, view);
    await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
    const filled = await settles(proposal.intentId);
    expect(filled.status).toBe("filled");
    expect(Number(filled.order?.filledSize)).toBe(0.0002);

    // One request reached the mainnet venue, which recovered the wallet from a mainnet
    // signature: byte for byte the request the signer signed once.
    const signed = await signedOnce(approvalId);
    const requests = await requestsFor(signed.cloid, "mainnet");
    expect(requests).toHaveLength(1);
    const [posted] = requests;

    if (posted === undefined) throw new Error("no request reached the mainnet venue");
    expect(posted).toMatchObject({ accepted: true, actionType: "order", dropped: false });
    expect(posted.signer).toBe(address);
    expect(posted.body).toBe(signed.request);
    await expectSignedBy(posted.body, mainnet.wallet, "mainnet");
    expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([
      expect.objectContaining({ outcome: "allowed" }),
    ]);
    expect(
      (await venueOrders("mainnet"))
        .filter((order) => order.cloid === signed.cloid.toLowerCase())
        .map((order) => [order.status, Number(order.filledSize)]),
    ).toEqual([["filled", 0.0002]]);

    // The testnet venue was sent nothing for this wallet or this order.
    expect(
      (await venueExchangeLog("testnet")).filter((record) => record.signer === address),
    ).toEqual([]);
    expect(await requestsFor(signed.cloid, "testnet")).toEqual([]);

    // The same bytes posted to the testnet venue: it recovers another signer from them, so it
    // refuses them, though the wallet has an account there.
    const crossed = await postToVenue(posted.body, "testnet");
    expect(crossed.status).toBe(200);
    expect(crossed.answer).toMatchObject({ status: "err" });
    const onTestnet = await requestsFor(signed.cloid, "testnet");
    expect(onTestnet.map((record) => record.accepted)).toEqual([false]);
    expect(onTestnet[0]?.signer).not.toBeNull();
    expect(onTestnet[0]?.signer).not.toBe(address);
    expect(
      (await venueOrders("testnet")).filter((order) => order.cloid === signed.cloid.toLowerCase()),
    ).toEqual([]);

    // And the other way: an order the testnet venue took from the first trader, posted to the
    // mainnet venue, which now holds an account for that wallet too, recovers to another signer.
    const traderAddress = trader.wallet.address.toLowerCase();

    const testnetOrder = (await venueExchangeLog("testnet")).find(
      (record) =>
        record.accepted && record.actionType === "order" && record.signer === traderAddress,
    );

    if (testnetOrder === undefined) throw new Error("the testnet venue took no order from Trader");
    await seedVenueAccount(trader.wallet.address, "1000", "mainnet");
    const reverse = await postToVenue(testnetOrder.body, "mainnet");
    expect(reverse.status).toBe(200);
    expect(reverse.answer).toMatchObject({ status: "err" });

    const onMainnet = (await venueExchangeLog("mainnet")).filter(
      (record) => record.body === testnetOrder.body,
    );

    expect(onMainnet.map((record) => record.accepted)).toEqual([false]);
    expect(onMainnet[0]?.signer).not.toBeNull();
    expect(onMainnet[0]?.signer).not.toBe(traderAddress);
  } finally {
    await mainnet.agent.close();
  }
});

test("an order is never signed under a mandate: with a live mandate, it still waits for a person", async () => {
  const draft: MandateDraft = {
    agentId: trader.agentId,
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerAction: wei("0.01"),
        maxPerWindow: wei("0.03"),
        maxTotal: wei("0.05"),
      },
    ],
    windowSeconds: 3600,
    recipients: [PAYEE],
    maxUses: 10,
    maxFeePerActionWei: wei("0.01"),
    notAfter: nowSeconds() + 86_400,
    purpose: "pay the hosting invoices this week",
  };

  const grant = await ada.proposeMandate(workspace.id, trader.wallet.id, draft);
  await ada.confirm(grant.id);
  const granted = await ada.settled(grant.id);
  expect(granted.status).toBe("executed");

  if (granted.subject.kind !== "grant-mandate") throw new Error(`${grant.id} grants no mandate`);
  const mandateId = granted.subject.mandate.id;

  try {
    const { mandates } = await trader.agent.call("whoami");
    expect(JSON.stringify(mandates)).toContain(mandateId);

    const proposal = await proposeOrder(trader.agent, {
      side: "buy",
      size: "0.0002",
      limitPrice: "65000",
      memo: ORDER_MEMO,
    });

    expect(proposal).toMatchObject({
      authorizedBy: "person",
      mandateId: null,
      status: "pending_approval",
    });
    const approvalId = approvalIdOf(proposal);
    expect(approvalId).toMatch(/^apr_/);
    // Long enough for a payment under a mandate to be signed and sent; nothing is.
    await delay(3_000);
    expect(await signedRequest(approvalId)).toBeNull();
    expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([]);

    await ada.reject(approvalId);
    expect((await settles(proposal.intentId)).status).toBe("rejected");
    expect(await signedRequest(approvalId)).toBeNull();
    expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([]);
  } finally {
    await ada.revokeMandate(workspace.id, mandateId);
  }
});

test("a signed order whose submit window passed before it could be posted is never posted, and ends expired", async () => {
  // The shortest window a policy allows: 5 seconds from signing.
  const late = await newTrader("Late", {
    timeInForce: ["Ioc"],
    perOrderUsd: "25",
    perDayUsd: "30",
    submitWindowSeconds: 5,
  });

  const proposal = await proposeOrder(late.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "65000",
    memo: "an order that is posted too late",
  });

  const approvalId = approvalIdOf(proposal);
  const server = await serverContainer();
  let cloid = "";
  await cutServerFromVenue(server);

  try {
    await ada.confirm(approvalId);
    ({ cloid } = await signedOnce(approvalId));
    const { order } = await ada.api.call("getIntent", { params: { intentId: proposal.intentId } });
    const submitBy = order?.submitBy ?? 0;
    expect(submitBy).toBeGreaterThan(0);

    // Wait the window out, with a margin for the two clocks.
    while (nowSeconds() <= submitBy + 3) await delay(500);
  } finally {
    await reconnectServerToVenue(server);
  }

  expect(await resolvesVenue(server)).toBe(true);

  expect((await settles(proposal.intentId, 200_000)).status).toBe("expired");
  // Nothing was ever sent for it, not even a request the venue would refuse as expired.
  expect(await requestsFor(cloid)).toEqual([]);
  expect((await venueOrders()).filter((order) => order.cloid === cloid.toLowerCase())).toEqual([]);
  await late.agent.close();
});

test("a server killed after the signer signed an order and before it was posted still sends exactly one request to the venue", async () => {
  const proposal = await proposeOrder(trader.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "65000",
    memo: "an order that survives a crash",
  });

  const approvalId = approvalIdOf(proposal);
  const server = await serverContainer();
  let signed = { request: "", cloid: "" };
  // With the server cut off from the venue, the signed request cannot be posted. The approval is
  // sent without waiting for its answer, which the crash may cut short.
  await cutServerFromVenue(server);

  try {
    const approving = ada.confirm(approvalId).catch(() => undefined);
    signed = await signedOnce(approvalId);
    expect(await requestsFor(signed.cloid)).toEqual([]);
    await killServer();
    await approving;
  } finally {
    await reconnectServerToVenue(server);
  }

  await compose("up", "-d", "--wait", "--wait-timeout", "300", "server");
  await waitUntilHealthy();

  // Within the 300-second window the restarted server posts the one request, once.
  expect((await settles(proposal.intentId, 200_000)).status).toBe("filled");
  const requests = await requestsFor(signed.cloid);
  expect(requests).toHaveLength(1);
  const [posted] = requests;

  if (posted === undefined) throw new Error("no request reached the venue");
  expect(posted).toMatchObject({ accepted: true, actionType: "order" });
  await expectSignedBy(posted.body, trader.wallet);
  expect(posted.body).toBe(signed.request);
  expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([
    expect.objectContaining({ outcome: "allowed" }),
  ]);
  trader.agent = await connectAgent(`${stack.origin}/mcp`, trader.token);
});

test("a signed order sent twice is refused the second time, and the venue keeps the one order", async () => {
  // An order of its own: the venue would refuse a copy of an older one for its expiry first.
  const proposal = await proposeOrder(trader.agent, {
    side: "buy",
    size: "0.0002",
    limitPrice: "65000",
    memo: "an order someone sends twice",
  });

  const approvalId = approvalIdOf(proposal);
  await ada.confirm(approvalId);
  expect((await settles(proposal.intentId)).status).toBe("filled");
  const { cloid } = await signedOnce(approvalId);
  const [first, ...others] = await requestsFor(cloid);

  if (first === undefined) throw new Error("no request reached the venue");
  expect(others).toEqual([]);
  expect(first.accepted).toBe(true);

  // Anyone holding a copy of the signed request (the control plane, a log, the network) posts
  // it again, byte for byte, well inside its submit window.
  const replay = await postToVenue(first.body);
  expect(replay.status).toBe(200);
  expect(replay.answer).toMatchObject({ status: "err", response: expect.stringMatching(/nonce/i) });

  // The copy still recovers to the wallet: the venue refused it for its used nonce alone.
  const requests = await requestsFor(cloid);
  expect(
    requests.map((request) => [request.accepted, request.body === first.body, request.nonce]),
  ).toEqual([
    [true, true, first.nonce],
    [false, true, first.nonce],
  ]);
  expect(requests[1]?.signer).toBe(trader.wallet.address.toLowerCase());
  expect(
    (await venueOrders())
      .filter((order) => order.cloid === cloid.toLowerCase())
      .map((order) => [order.status, Number(order.filledSize)]),
  ).toEqual([["filled", 0.0002]]);
  const intent = await ada.api.call("getIntent", { params: { intentId: proposal.intentId } });
  expect(intent.status).toBe("filled");
  expect(Number(intent.order?.filledSize)).toBe(0.0002);
});

test("the daily cap counts every order but a reduce-only one, which still closes a position once the cap is spent", async () => {
  // 25 USD an order, 30 a day.
  const closer = await newTrader("Closer", {
    timeInForce: ["Ioc"],
    perOrderUsd: "25",
    perDayUsd: "30",
    submitWindowSeconds: 300,
  });

  try {
    // 0.0003 BTC at 65,000: 19.5 USD of the 30.
    const opening = await proposeOrder(closer.agent, {
      side: "buy",
      size: "0.0003",
      limitPrice: "65000",
      memo: "open a small position",
    });

    await ada.confirm(approvalIdOf(opening));
    expect((await settles(opening.intentId)).status).toBe("filled");
    expect((await walletVenue(closer.wallet)).spentTodayUsd6).toBe(usd6("19.5"));

    // 13 USD more would make 32.5: refused before anyone is asked.
    const pendingBefore = await pendingApprovals();
    expect(
      await toolRefusal(
        proposeOrder(closer.agent, { side: "buy", size: "0.0002", limitPrice: "65000" }),
      ),
    ).toEqual({ code: "policy_denied", detail: "over_daily_cap" });
    expect(await pendingApprovals()).toBe(pendingBefore);

    // A reduce-only sell of 12 USD is not counted, so it may close what the cap let open. The
    // signer's page says so, against the 19.5 USD it counted.
    const closing = await proposeOrder(closer.agent, {
      side: "sell",
      size: "0.0002",
      limitPrice: "60000",
      reduceOnly: true,
      memo: "close most of it",
    });

    const closingId = approvalIdOf(closing);
    const link = await ada.confirmationLink(closingId);
    const view = await ada.readConfirmation(link);
    expect(lineValue(view, "Reduce-only")).toMatch(/^yes/);
    expect(lineValue(view, "Spent in the last 24 hours")).toBe("19.5 USD of 30 USD");
    expect(lineValue(view, "Daily cap")).toContain("reduce-only");
    await ada.approveOnConfirmationPage(link, view);
    await ada.api.call("collectApproval", { params: { approvalId: closingId }, body: {} });
    expect((await settles(closing.intentId)).status).toBe("filled");
    const { cloid } = await signedOnce(closingId);
    const requests = await requestsFor(cloid);
    expect(requests.map((request) => request.accepted)).toEqual([true]);
    const parsed = parseExchangeBody(requests[0]?.body ?? "");

    if (isRefusal(parsed)) throw new Error(parsed);
    expect(parsed.action).toMatchObject({
      type: "order",
      orders: [{ a: BTC, b: false, p: "60000", s: "0.0002", r: true }],
    });
    // The signer counted the opening order only.
    expect((await walletVenue(closer.wallet)).spentTodayUsd6).toBe(usd6("19.5"));

    // So 10.4 USD more still fits (29.9 of 30): an approval opens, and its page shows 19.5.
    const more = await proposeOrder(closer.agent, {
      side: "buy",
      size: "0.00016",
      limitPrice: "65000",
      memo: "one more small one",
    });

    const moreId = approvalIdOf(more);
    expect(
      lineValue(
        await ada.readConfirmation(await ada.confirmationLink(moreId)),
        "Spent in the last 24 hours",
      ),
    ).toBe("19.5 USD of 30 USD");
    await ada.reject(moreId);
    expect((await settles(more.intentId)).status).toBe("rejected");
  } finally {
    await closer.agent.close();
  }
});

test("the wallet page shows the signer's own count and, as the venue reports it, the order resting there", async () => {
  // 25 USD an order, 30 a day, resting orders only.
  const rester = await newTrader("Rester", {
    timeInForce: ["Gtc"],
    perOrderUsd: "25",
    perDayUsd: "30",
    submitWindowSeconds: 300,
  });

  try {
    expect(await walletVenue(rester.wallet)).toMatchObject({
      network: TESTNET,
      spentTodayUsd6: "0",
      maxNotionalPerDayUsd6: usd6("30"),
      reported: { positions: [], openOrders: [] },
    });

    // Far below the best bid: 0.0002 BTC at 50,000 rests, 10 USD.
    const proposal = await proposeOrder(rester.agent, {
      side: "buy",
      size: "0.0002",
      limitPrice: "50000",
      timeInForce: "Gtc",
      memo: "rest below the market",
    });

    const approvalId = approvalIdOf(proposal);
    await ada.confirm(approvalId);
    expect((await settles(proposal.intentId)).status).toBe("placed");
    const { cloid } = await signedOnce(approvalId);
    const resting = (await venueOrders()).find((order) => order.cloid === cloid.toLowerCase());

    if (resting === undefined) throw new Error(`the venue has no order ${cloid}`);
    expect(resting.status).toBe("open");

    const venue = await walletVenue(rester.wallet);
    // The signer's own count, against the policy's cap.
    expect(venue).toMatchObject({
      network: TESTNET,
      spentTodayUsd6: usd6("10"),
      maxNotionalPerDayUsd6: usd6("30"),
    });
    // The venue's report: the account untouched, no position, and the order resting, named by
    // the venue's own order id.
    expect(Number(venue.reported?.accountValueUsd)).toBe(1000);
    expect(venue.reported?.positions).toEqual([]);
    expect(venue.reported?.openOrders).toHaveLength(1);
    const [open] = venue.reported?.openOrders ?? [];
    expect(open).toMatchObject({ coin: "BTC", side: "buy", venueOrderId: resting.oid });
    expect(Number(open?.size)).toBe(0.0002);
    expect(Number(open?.limitPrice)).toBe(50000);

    // Once the agent cancels it the report shows no order; the signer's count stays, because
    // it counts what it signed.
    expect(await rester.agent.call("cancel_intent", { intentId: proposal.intentId })).toMatchObject(
      { intentId: proposal.intentId, status: "cancelled" },
    );
    await expect
      .poll(async () => (await walletVenue(rester.wallet)).reported?.openOrders.length, {
        timeout: 30_000,
      })
      .toBe(0);
    expect((await walletVenue(rester.wallet)).spentTodayUsd6).toBe(usd6("10"));
  } finally {
    await rester.agent.close();
  }
});

test("a withdrawal from the venue goes to the wallet's own address only, after a passkey approval, and ends confirmed", async () => {
  const withdrawer = await newTrader("Withdrawer", {
    timeInForce: ["Ioc"],
    perOrderUsd: "25",
    perDayUsd: "30",
    submitWindowSeconds: 300,
    withdrawals: true,
  });

  try {
    const pendingBefore = await pendingApprovals();
    const requestsBefore = (await venueExchangeLog()).length;
    // To any other address: refused, whatever the policy allows.
    expect(
      await toolRefusal(
        withdrawer.agent.proposeTransfer({
          chainId: TESTNET,
          asset: "usdc",
          to: PAYEE,
          amount: "5",
          memo: "pay someone else from the venue",
        }),
      ),
    ).toEqual({ code: "invalid_request", detail: "withdrawal_not_own_address" });
    // Under a policy without withdrawals: refused, also to the wallet's own address.
    expect(
      await toolRefusal(
        trader.agent.proposeTransfer({
          chainId: TESTNET,
          asset: "usdc",
          to: trader.wallet.address,
          amount: "5",
          memo: "withdraw without the policy's leave",
        }),
      ),
    ).toEqual({ code: "policy_denied", detail: "withdrawal_not_allowed" });
    expect(await pendingApprovals()).toBe(pendingBefore);
    expect((await venueExchangeLog()).length).toBe(requestsBefore);

    const proposal = await withdrawer.agent.proposeTransfer({
      chainId: TESTNET,
      asset: "usdc",
      to: withdrawer.wallet.address,
      amount: "5",
      memo: WITHDRAW_MEMO,
    });

    expect(proposal).toMatchObject({
      authorizedBy: "person",
      mandateId: null,
      status: "pending_approval",
    });
    const approvalId = approvalIdOf(proposal);
    const link = await ada.confirmationLink(approvalId);
    const view = await ada.readConfirmation(link);
    expect(view).toMatchObject({ approvalId, kind: "approve-intent", state: "open" });
    expect(view.title).toContain("Withdraw 5 USDC");
    expect(lineValue(view, "Amount")).toBe("5 USDC");
    expect(lineValue(view, "To")).toContain("own address");
    expect(lineValue(view, "Withdrawals")).toMatch(/^allowed/);
    await ada.approveOnConfirmationPage(link, view);
    await ada.api.call("collectApproval", { params: { approvalId }, body: {} });
    expect((await settles(proposal.intentId)).status).toBe("confirmed");

    // One request reached the venue: signed by the wallet, byte for byte what the signer signed,
    // to the wallet's own address.
    const signed = await signedRequest(approvalId);

    if (signed === null) throw new Error(`the signer has not signed ${approvalId}`);
    expect(signed.cloid).toBeNull();

    const posted = (await venueExchangeLog()).filter(
      (record) =>
        record.actionType === "withdraw3" &&
        record.signer === withdrawer.wallet.address.toLowerCase(),
    );

    expect(posted.map((record) => record.accepted)).toEqual([true]);
    const [request] = posted;

    if (request === undefined) throw new Error("no withdrawal reached the venue");
    expect(request.body).toBe(signed.request);
    await expectSignedBy(request.body, withdrawer.wallet);
    const parsed = parseExchangeBody(request.body);

    if (isRefusal(parsed)) throw new Error(parsed);

    if (parsed.action.type !== "withdraw3") throw new Error(`a ${parsed.action.type} was posted`);
    expect(parsed.action.hyperliquidChain).toBe("Testnet");
    expect(isAddressEqual(parsed.action.destination, withdrawer.wallet.address)).toBe(true);
    expect(Number(parsed.action.amount)).toBe(5);

    const taken = (await venueWithdrawals()).filter((withdrawal) =>
      isAddressEqual(withdrawal.user, withdrawer.wallet.address),
    );

    expect(taken).toHaveLength(1);
    expect(isAddressEqual(taken[0]?.destination ?? PAYEE, withdrawer.wallet.address)).toBe(true);
    expect(Number(taken[0]?.amount)).toBe(5);
    expect(await decisionsAbout(approvalId, "sign-venue")).toEqual([
      expect.objectContaining({ outcome: "allowed" }),
    ]);
    // The venue now reports the account 5 USDC lighter.
    expect(Number((await walletVenue(withdrawer.wallet)).reported?.accountValueUsd)).toBe(995);
  } finally {
    await withdrawer.agent.close();
  }
});

/** The keys of an `approval.opened` webhook body, sorted: identifiers, a time and a link. */
const APPROVAL_EVENT_KEYS = [
  "approvalId",
  "deliveryId",
  "event",
  "expiresAt",
  "kind",
  "link",
  "v",
  "workspaceId",
];

test("an order's approval is announced to the webhook, signed, with no order field", async () => {
  const secret = await webhookSecret();

  // 0.00031 BTC at 64,321: values found in no identifier, time or link.
  const proposal = await proposeOrder(trader.agent, {
    side: "buy",
    size: "0.00031",
    limitPrice: "64321",
    memo: NOTICE_MEMO,
  });

  expect(proposal).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
  const approvalId = approvalIdOf(proposal);

  try {
    const requests = await acknowledged(
      (body) => body.approvalId === approvalId && body.event === "approval.opened",
    );

    const hidden = [
      NOTICE_MEMO,
      `NOTICEMARK${run}`,
      "0.00031",
      "64321",
      "64,321",
      "perpetual",
      "hyperliquid",
    ];

    for (const request of requests) {
      // Exactly the keys of any other approval's notice: no market, side, size or price.
      expect(expectSignedDelivery(secret, request, APPROVAL_EVENT_KEYS, hidden)).toEqual({
        v: 1,
        deliveryId: request.headers["x-os-delivery"],
        event: "approval.opened",
        approvalId,
        workspaceId: workspace.id,
        kind: "approve-intent",
        expiresAt: proposal.expiresAt,
        link: `${stack.origin}/w/${workspace.id}/approvals/${approvalId}`,
      });
    }
  } finally {
    await ada.reject(approvalId);
  }

  expect((await settles(proposal.intentId)).status).toBe("rejected");
  expect(await signedRequest(approvalId)).toBeNull();
});

const get = (url: string): ProbeRequest => ({ method: "GET", url });

const post = (url: string): ProbeRequest => ({ method: "POST", url });

test("the signer cannot reach either venue, which the server reaches, and no signer route signs typed data, a hash or a raw action", async () => {
  const venues = [
    get("http://fake-hyperliquid:8080/healthz"),
    get(`http://${await venueAddress()}:8080/healthz`),
    get("http://fake-hyperliquid-mainnet:8080/healthz"),
    get(`http://${await venueAddress("mainnet")}:8080/healthz`),
  ];

  const server = await serverContainer();
  const [signer] = await containersOf("signer");

  if (signer === undefined) throw new Error("the stack has no signer container");

  // The control: the server resolves each fake venue and reaches it by name and by address.
  expect(await reachFrom(server, venues)).toEqual({
    resolvesVenue: true,
    statuses: [200, 200, 200, 200],
  });
  // The signer does none of that, and reaches nothing outside its own networks.
  expect(await reachFrom(signer, [...venues, get("https://example.com/")])).toEqual({
    resolvesVenue: false,
    statuses: ["unreachable", "unreachable", "unreachable", "unreachable", "unreachable"],
  });

  // From the signing network, where the server is: no route signs typed data, a hash or an
  // action given to it, and the venue route answers only a signed request (the control that
  // the probe reaches the signer at all).
  const routes = [
    "/v1/sign-typed-data",
    "/v1/sign-hash",
    "/v1/venue/sign-action",
    "/v1/venue/sign",
  ];

  const { statuses } = await reachFrom(
    server,
    routes.map((path) => post(`http://signer:8787${path}`)),
  );

  expect(Object.fromEntries(routes.map((path, index) => [path, statuses[index]]))).toEqual({
    "/v1/sign-typed-data": 404,
    "/v1/sign-hash": 404,
    "/v1/venue/sign-action": 404,
    "/v1/venue/sign": 401,
  });
});

test("a server whose venues file pairs one of Hyperliquid's own hosts with the wrong network refuses to start", async () => {
  // The control: this stack's own venues file, both networks on fakes, gets past its venues and
  // stops only at the database it is given, which no container can reach.
  const both = await bootServerWith([
    { network: TESTNET, apiUrl: "http://fake-hyperliquid:8080" },
    { network: MAINNET, apiUrl: "http://fake-hyperliquid-mainnet:8080" },
  ]);

  expect(both.output).not.toContain("is Hyperliquid's");
  expect(both.output).toMatch(/"code":"(ENOTFOUND|EAI_AGAIN)"/);
  expect(both.exitCode, both.output).toBe(1);

  const wrong: [JsonValue, string][] = [
    [
      [{ network: TESTNET, apiUrl: "https://api.hyperliquid.xyz" }],
      "api.hyperliquid.xyz is Hyperliquid's mainnet API",
    ],
    [
      [{ network: MAINNET, apiUrl: "https://api.hyperliquid-testnet.xyz" }],
      "api.hyperliquid-testnet.xyz is Hyperliquid's testnet API",
    ],
  ];

  for (const [venues, refusal] of wrong) {
    const boot = await bootServerWith(venues);
    expect(boot.output, JSON.stringify(venues)).toContain(refusal);
    expect(boot.exitCode, boot.output).toBe(1);
  }
});

test("what an agent typed with an order or a withdrawal, and every signed request, is in no column of the database in the clear", async () => {
  const bodies = [
    ...new Set(
      [...(await venueExchangeLog()), ...(await venueExchangeLog("mainnet"))].flatMap((record) =>
        record.accepted && (record.actionType === "order" || record.actionType === "withdraw3")
          ? [record.body]
          : [],
      ),
    ),
  ];

  expect(bodies.length).toBeGreaterThan(0);

  const signatures = bodies.flatMap((body) => {
    const parsed = parseExchangeBody(body);

    if (isRefusal(parsed)) throw new Error(parsed);

    return [parsed.signature.r.slice(2), parsed.signature.s.slice(2)];
  });

  const url = await databaseUrl();

  const scan = await scanForMarkers(url, [
    ORDER_MEMO,
    NOTICE_MEMO,
    WITHDRAW_MEMO,
    MAINNET_MEMO,
    ...signatures,
  ]);

  expect(scan.hits).toEqual([]);
  // The control: a name a person typed is readable on purpose. If the scanner cannot find even
  // that, it is blind and the assertion above means nothing.
  const control = await scanForMarkers(url, [WORKSPACE_NAME]);
  expect(control.hits.length).toBeGreaterThan(0);

  // The server keeps a copy of every request the signer signed, posted or not, and every copy
  // is sealed: none of its JSON is readable.
  const sealed = await sealedVenueRequests();
  expect(sealed.length).toBeGreaterThanOrEqual(bodies.length);

  for (const { approvalId, request } of sealed) {
    const bytes = request.toString("latin1");

    for (const word of ['"action"', '"signature"', '"nonce"', "withdraw3"]) {
      expect(bytes, `${approvalId} holds ${word}`).not.toContain(word);
    }
  }
});
