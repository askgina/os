/**
 * The venue gates (`specs/non-evm-operations.md`, Milestone 6), against a stack of their own
 * (`e2e/run.sh`) whose server names a fake Hyperliquid testnet venue (`e2e/compose.venue.yaml`,
 * TEST EQUIPMENT). The fake recovers the signer of every request with its own encoder, independent
 * of the signer's, and keeps everything it was sent. Nothing here reaches Hyperliquid.
 *
 * A person approves every order on the signer's confirmation page with a passkey; the server
 * posts the signer's request and follows the order. The gates check what reached the venue
 * against what the signer recorded in its own SQLite file.
 *
 * The tests run in order and share state: the first claims the installation.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  ApiError,
  type IntentDetail,
  type MandateDraft,
  type PolicyDraft,
  type WalletSummary,
  type WorkspaceDetail,
} from "@askgina/os-api";
import type { ConfirmationView } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import {
  type FakeAsset,
  parseExchangeBody,
  recoverExchangeSigner,
} from "@askgina/os-testkit/fake-hyperliquid";
import { expect, test } from "@playwright/test";
import { isAddressEqual, parseEther, parseUnits } from "viem";
import { type AgentConnection, connectAgent, Proposal, ToolRefused } from "../src/agent.ts";
import { Person } from "../src/person.ts";
import {
  compose,
  containersOf,
  docker,
  execIn,
  setupToken,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import {
  requestsFor,
  seedVenueAccount,
  setVenueBook,
  setVenueUniverse,
  signedCancels,
  signedRequest,
  venueCancels,
  venueExchangeLog,
  venueOrders,
  venueReport,
} from "../src/venue.ts";

test.describe.configure({ mode: "serial" });

const CHAIN = "eip155:31337";
const TESTNET = "hyperliquid:testnet";
const run = Date.now().toString(36);
/** Text an agent types with an order. */
const ORDER_MEMO = `ORDERMEMO${run} buy a little bitcoin`;
const WORKSPACE_NAME = `Trading desk ${run}`;
/** The only mandate recipient; the mandate gate never pays it. */
const PAYEE = "0x000000000000000000000000000000000000b0b0";

/** Exactly the tools an agent gets: none signs, approves, administers, speeds up or cancels. */
const AGENT_TOOLS = [
  "cancel_intent",
  "get_balances",
  "get_intent",
  "list_intents",
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

/** An agent with its own wallet, under a policy that lets it trade BTC on the testnet. */
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

/** How a trader's wallet may trade BTC; the caps in whole USD. */
type TraderRules = Pick<HyperliquidRules, "timeInForce" | "submitWindowSeconds"> & {
  perOrderUsd: string;
  perDayUsd: string;
};

/**
 * A policy for `agentId` that lets it pay on the local chain (so a mandate can be granted on its
 * wallet) and trade BTC on the Hyperliquid testnet within `rules`.
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
        network: TESTNET,
        markets: [{ asset: BTC, coin: "BTC", maxNotionalPerOrderUsd6: usd6(rules.perOrderUsd) }],
        maxNotionalPerDayUsd6: usd6(rules.perDayUsd),
        timeInForce: rules.timeInForce,
        submitWindowSeconds: rules.submitWindowSeconds,
        withdrawals: false,
      },
    },
  };
}

/**
 * A new agent with its own wallet, a policy from {@link policyFor} approved on the signer's
 * confirmation page, and an account at the venue holding 1,000 USDC.
 */
async function newTrader(name: string, rules: TraderRules): Promise<Trader> {
  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name },
  });
  const agentId = created.agent.id as Trader["agentId"];
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: created.wallet.id },
    body: { draft: policyFor(agentId, rules) },
  });
  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
  await seedVenueAccount(created.wallet.address, "1000");
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

/** The agent proposes a BTC order on the testnet; the answer is checked. */
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
      last = `no answer: ${(error as Error).message}`;
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
    (error: unknown) => error,
  );
  if (!(outcome instanceof ToolRefused)) {
    throw new Error(`expected the tool to refuse, got ${String(outcome)}`);
  }
  return { code: outcome.code, detail: outcome.detail };
}

/** The code and reason the API refused `attempt` with; fails when it was not refused. */
async function apiRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string; detail: string | undefined }> {
  const outcome = await attempt.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiError)) {
    throw new Error(`expected the API to refuse, got ${String(outcome)}`);
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

/** Expect `body` to be signed by `wallet`, recovered here from its bytes alone. */
async function expectSignedBy(body: string, wallet: WalletSummary): Promise<void> {
  const parsed = parseExchangeBody(body);
  if (typeof parsed === "string") throw new Error(`the venue could not read a request: ${parsed}`);
  expect(isAddressEqual(await recoverExchangeSigner(parsed, "testnet"), wallet.address)).toBe(true);
}

// --- the server's way to the venue ------------------------------------------------------------

/** The Compose network the server reaches venues on, and the only one the fake venue is on. */
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
 * Cut the server off from the venue, as a network fault would: it can still sign, read its
 * database and answer people, but nothing it posts can reach the venue.
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

// A failed gate prints what the fake venue took, which no container log shows.
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

test("an agent has exactly eight tools, and sees the testnet venue and no other", async () => {
  expect(await trader.agent.tools()).toEqual(AGENT_TOOLS);
  const me = await trader.agent.call("whoami");
  expect(me.venues).toEqual([{ network: TESTNET, name: "Hyperliquid testnet" }]);
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
  if (typeof parsed === "string") throw new Error(parsed);
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
  // The signer's page says, in its own words, that approving includes this cancel (D4).
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

test("an order outside the wallet's policy, and any mainnet order or policy, is refused before anyone is asked", async () => {
  const pendingBefore = await pendingApprovals();
  const intentsBefore = await intentCount(trader.agent);
  const requestsBefore = (await venueExchangeLog()).length;

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
  // Mainnet: no server is configured with it (D2), so there is no such venue here.
  expect(
    await toolRefusal(
      proposeOrder(trader.agent, {
        network: "hyperliquid:mainnet",
        side: "buy",
        size: "0.0002",
        limitPrice: "65000",
      }),
    ),
  ).toEqual({ code: "invalid_request", detail: "venue_not_configured" });
  // Nor can a policy name it.
  const mainnet = policyFor(trader.agentId, {
    timeInForce: ["Ioc"],
    perOrderUsd: "50",
    perDayUsd: "200",
    submitWindowSeconds: 300,
  });
  const rules = mainnet.venues?.hyperliquid;
  if (rules === undefined) throw new Error("the policy has no venue rules");
  rules.network = "hyperliquid:mainnet";
  expect(
    await apiRefusal(
      ada.api.call("requestPolicy", {
        params: { workspaceId: workspace.id, walletId: trader.wallet.id },
        body: { draft: mainnet },
      }),
    ),
  ).toEqual({ code: "invalid_request", detail: "venue_not_allowed" });

  // No approval opened, nothing was recorded, and nothing reached the venue.
  expect(await pendingApprovals()).toBe(pendingBefore);
  expect(await intentCount(trader.agent)).toBe(intentsBefore);
  expect((await venueExchangeLog()).length).toBe(requestsBefore);
});

test("an order is never signed under a mandate: with a live mandate, it still waits for a person (D7)", async () => {
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
