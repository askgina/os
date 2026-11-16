# Let an agent read the venue it trades on: markets, prices, its account

- Branch: `feature/port-read-only-mcp`
- Status: Draft, parked (2026-11-16). Nothing is built and nothing is planned to be. See the
  first entry of `Decision Log`. One part stays worth doing on its own: hardening the venue
  client (Milestone 1's refusal of redirects and its cap on answer size).
- Owner(s): the repository owner
- Created: 2026-11-16
- Last Updated: 2026-11-16
- Links: [Map #18](https://github.com/askgina/os/issues/18) | [Research report](research/agent-read-tools.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

Today an agent can propose a limit order on a Hyperliquid perpetual market and cannot see that
market. It has no tool that returns a price, an order book, a candle, its positions or its
fills, and on the network the stack gives it, it can reach nothing but the MCP endpoint. It
chooses a limit price blind, or its operator opens a path to the internet for it, which the
architecture tells them not to.

A sibling repository, `askgina/gina`, now serves "Gina Read": an MCP server of read-only market
and account tools for hosted assistants. This plan ports the part of it that fits this system,
which is the Hyperliquid reads, and rebuilds it on what is already here: the server's venue
client, the agent's bearer token, the wallet rules, the Postgres rate limits. The research
report says what was left behind and why.

After this change an agent has seven more tools, all read-only:

- `get_markets`, `get_prices`, `get_order_book`, `get_candles`: the venue's perpetual markets,
  current mid prices, an order book, and price history.
- `preview_order`: what an order of a given size would fill at now, the fee it would pay, and
  the notional the wallet's caps would count.
- `get_venue_account`, `get_venue_fills`: the value, positions, resting orders and recent fills
  of a wallet the agent may propose from, each resting order and fill tied to the intent that
  caused it.

Every read goes to the venue host the operator already listed in `VENUES_FILE`, for the network
the call names, so a testnet agent prices against testnet. No new outside host is contacted, no
new secret exists, and the agent's network stays closed. Using a venue stays the choice of
whoever runs the workspace: with `VENUES_FILE` unset, every one of these tools refuses.

How to see it working: in the release gates, an agent in a container that cannot reach the
internet reads a price through the gateway, proposes an order at that price, and after it fills
reads the position and the fill with the intent's id on them.

Non-goals, each out of scope for this plan:

- Any tool that signs, approves, administers or changes anything. The gateway's proposal tools
  are unchanged.
- The other parts of Gina Read: the OAuth authorization server, sign-in through a hosted
  provider, Redis, widgets and presentation tools, skills served from the endpoint, hosted error
  capture, the Effect runtime, the safety script (research report, "Fit, part by part").
- Prediction-market reads, token price and metadata reads from a paid data provider, and a
  cross-chain portfolio **(depends on owner decision D1)**.
- Markets this system cannot trade: builder-deployed perpetual markets, spot markets, and the
  venue's account modes (`specs/non-evm-operations.md`, non-goals).
- The venue's profit history and per-market trading capacity **(depends on owner decision D3)**.
- A connection for hosted assistants, and agents that can only read **(owner decision D4)**.
- A live price feed. Reads are requests; nothing subscribes to the venue.
- Any change to what people see in the web app, beyond one sentence on the agent page.
- Verifying what the venue reports. As today, nothing in this system checks it.

Success means:

- The MCP tool list is exactly fifteen tools: today's eight and the seven above. The seven are
  annotated read-only, and a test pins the list and the annotations.
- In the CI `stack` job, against the fake venue: an agent on the internal `agents` network reads
  markets, prices, a book and candles for the configured testnet and the configured mainnet and
  gets each network's own data; after its approved order fills, `get_venue_account` shows the
  position and `get_venue_fills` shows the fill with its `intentId`.
- An agent cannot read the venue account of a wallet it may not propose from: the answer is the
  same `not_found` as for a wallet that does not exist.
- An agent that spends the read budget is refused with `rate_limited`, and an approved order of
  another agent is still submitted and a cancel still reaches the venue while it is refused.
- A venue answer that redirects, is larger than the limit, or does not fit its schema becomes
  `venue_unreachable`, for the new reads and for the reads and posts the server already makes.
- No read result contains text the venue wrote: only numbers, times, enumerated words and
  market names that match the pattern `propose_order` already accepts.

## Progress

- [x] (2026-11-16) Research: what Gina Read is, what this repository has, and what fits
      ([research report](research/agent-read-tools.md)).
- [x] (2026-11-16) Define the approach and the validation plan (this file).
- [x] (2026-11-16) Parked before any owner decision; see `Decision Log`.
- [ ] Owner decisions D1 to D5 (not asked for while the plan is parked).
- [ ] Milestone 1: the venue client reads markets, books, candles and fills, and refuses
      redirects and oversized answers.
- [ ] Milestone 2: the read budget.
- [ ] Milestone 3: the seven MCP tools.
- [ ] Milestone 4: release gates.
- [ ] Milestone 5: documentation.
- [ ] Record outcomes, risks and follow-up work.

## Surprises & Discoveries

- Observation: the venue returns at most 20 order-book levels a side. Gina Read's tools accept a
  depth of up to 200 and get 20.
  Evidence: the venue's "Info endpoint" page, L2 book snapshot ("Returns at most 20 levels per
  side"); `lib/server/mcp/tools/perps.ts:472` in `askgina/gina` at `ed2387c`.
  Impact: `get_order_book` and `preview_order` say 20, and a preview of an order larger than
  20 levels of depth reports itself as not fully covered.
- Observation: a fill row names the venue's order id and no client order id.
  Evidence: the venue's "Info endpoint" page, user fills.
  Impact: fills and resting orders are tied to intents through `venue_orders.venueOrderId`,
  which the server already stores.
- Observation: the venue counts request weight for each client address across reads and signed
  requests together, 1,200 a minute, and a fills read costs one more unit for every 20 rows it
  returns, which the request cannot bound.
  Evidence: the venue's "Rate limits and user limits" page.
  Impact: Milestone 2. A read is admitted on its base weight and charged for its rows afterwards.
- Observation: the server's venue client follows redirects, reads an answer of any size, and
  sends no `user-agent`. The posts of signed orders go through the same function.
  Evidence: `apps/server/src/execution/venues/hyperliquid.ts:213-219`.
  Impact: Milestone 1 hardens the one function every venue request passes through.
- Observation: the example egress rules for Kubernetes allow the server to reach chain nodes and
  the key provider, and name no venue host.
  Evidence: `deploy/k8s/overlays/production-example/egress.yaml:1-30`.
  Impact: Milestone 5 adds the venue to that example and to the deploy guide's text; it is a gap
  for orders today, not one this plan creates.

## Decision Log

Owner decisions. Each is open; the plan is written for the recommended option.

- Decision: park this plan.
  Rationale: it was written for an agent that can reach nothing but this gateway. The agent it
  was meant to serve first, the Hermes plugin in `askgina/hermes-gina`, runs next to a person
  and takes its market and account data from the hosted Gina Read endpoint directly, so seven
  rebuilt market reads here would give that agent the same data twice. What this repository
  owed that plugin was agent pairing and `approvalUrl` on intent reads (PRs 29 and 30). Two
  parts of the plan stand without it and can be picked up alone: the venue client follows
  redirects and reads answers of any size (Milestone 1), and no hosted read can see a wallet
  held here, so `get_venue_account` and `get_venue_fills` are the tools to build first if an
  agent on the `agents` network needs to see its own positions.
  Date/Author: 2026-11-16, the lead.

- Decision D1 (open): which of Gina Read's data families come across. Recommended: (a) the
  Hyperliquid reads only. (b) also token prices from a data provider the operator holds a key
  for. (c) also prediction-market reads.
  Rationale for (a): a read belongs here when the workspace can act on it. This system trades
  Hyperliquid perpetual markets and nothing else at a venue. (b) adds an outside host, a secret
  and issuer-written text for little: with a venue configured, its mids price the majors.
  (c) is about 5,300 lines for markets no agent here can trade; it belongs with a plan that adds
  that venue.
  Date/Author: 2026-11-16, the lead.
- Decision D2 (open): tool names and count. Recommended: (a) seven tools in this gateway's
  style (`get_prices`), merging Gina Read's thirteen Hyperliquid tools. (b) Gina Read's names
  as they are (`perps.getHyperliquidPrice`), so its instruction files apply unchanged.
  Rationale for (a): Gina Read keeps its names because a published listing was reviewed against
  them. Nothing binds this gateway to them, and an agent here reads one tool list in one style.
  Date/Author: 2026-11-16, the lead.
- Decision D3 (open): the venue's profit history and per-market trading capacity. Recommended:
  (a) leave both out. (b) add `get_venue_performance` and a capacity block.
  Rationale for (a): this system has no operation that sets leverage or margin mode, so capacity
  is what `withdrawableUsd` and the position list already say; profit history can be derived
  from fills. Each costs 20 units of the read budget a call.
  Date/Author: 2026-11-16, the lead.
- Decision D4 (open): hosted assistants and read-only agents. Recommended: (a) neither in this
  plan; open one ticket for each under map 18. (b) add an agent kind that gets the read tools
  only. (c) port Gina Read's authorization server so a hosted assistant can connect.
  Rationale for (a): (b) is small but changes the agent model and the web app; (c) puts a
  sign-in server and a consent page on the control plane, which is a new trust boundary and
  deserves its own research.
  Date/Author: 2026-11-16, the lead.
- Decision D5 (open): how much of the venue's request allowance reads may use. Recommended:
  (a) half, 600 units a minute for each network, and 240 for each agent. (b) other numbers.
  Rationale for (a): order handling today uses a few units for each order (a post, status reads,
  a reconcile pass every five minutes); half leaves it far more than it uses and still serves
  some hundreds of price reads a minute.
  Date/Author: 2026-11-16, the lead.

Decisions the plan takes itself.

- Decision: rebuild on this repository's venue client; copy no module from `askgina/gina`.
  Rationale: every tool there is an Effect program bound to that application's service layers
  (research report, "The source"). What moves is the request shapes, the decode rules, the row
  limits and the tests' cases.
  Date/Author: 2026-11-16, the lead.
- Decision: reads go to the host `VENUES_FILE` names for the network in the call. There is no
  second setting for a data host.
  Rationale: an order goes to that host, so the price must come from it. No new outbound host,
  and one place to turn a venue on.
  Date/Author: 2026-11-16, the lead.
- Decision: no tool takes an address. Account reads take a `walletId` and apply the rule
  `get_balances` applies.
  Rationale: otherwise the server answers for any address on request.
  Date/Author: 2026-11-16, the lead.
- Decision: amounts and prices are decimal strings as the venue spelled them; arithmetic is in
  scaled integers.
  Rationale: the convention of `packages/protocol/src/venues.ts`. Gina Read uses floats.
  Date/Author: 2026-11-16, the lead.
- Decision: a row whose market name or numbers do not fit the strict result schema is dropped
  and counted in `omitted`; the read does not fail.
  Rationale: Gina Read's record shows one undeclared optional field failing a whole read. A
  dropped row also keeps venue-written text away from the agent.
  Date/Author: 2026-11-16, the lead.
- Decision: no `outputSchema` is published for the new tools.
  Rationale: none of the eight has one. The result still passes a strict schema on the server
  before it is sent, as the people's venue account does today.
  Date/Author: 2026-11-16, the lead.

## Outcomes & Retrospective

- Outcome: none yet; the plan is a draft.
  Evidence: `Progress`.
  Follow-up: the owner decisions.

## Context and Orientation

Words are used as [`docs/architecture.md`](../docs/architecture.md#words-used-on-this-page)
defines them. Three more:

- **Read tool.** An MCP tool that gets data and changes nothing in this system or at the venue.
- **Request weight.** The venue's unit for counting requests against its limit of 1,200 a minute
  for each client address. A price read weighs 2, most other reads 20, a signed request 1.
- **Gina Read.** The MCP server in `askgina/gina` this plan draws from, as of `ed2387c`.

Relevant repo rules:

- Read the applicable `AGENTS.md` chain before changing files.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): the local checks, the anti-slop rules, exact
  dependency pins, no feature flags, and that documentation says what is proven.
- No workspace depends on `effect`. This plan adds no dependency.

Current behavior:

- The gateway is `apps/server/src/mcp/gateway.ts`. `mountMcp` checks Host and Origin,
  authenticates the `osa_` bearer token, takes one token from the agent's request bucket (120 a
  minute), and serves the call from a server built for that agent by `buildServer`. A tool is
  `server.registerTool(name, { description, inputSchema, annotations }, handler)`; the handler
  wraps its work in `answer()`, which turns an `HttpError` into a refusal with a stable code and
  anything else into one fixed `internal` refusal.
- `walletsFor(ctx, agent)` returns the wallets an agent may use: its own, and any treasury
  whose rules name it as a requester.
- The venue client is `apps/server/src/execution/venues/hyperliquid.ts`. `venueClient(ctx,
  network)` in `apps/server/src/execution/orders.ts` returns the client for a network that
  `VENUES_FILE` lists, and throws `invalid_request` with detail `venue_not_configured`
  otherwise. Every request goes through one function, `call()`, with a 10-second deadline. A
  failure to reach the venue or to read its answer is a `VenueError`.
- `walletVenueAccount` in `orders.ts` builds what the wallet page shows people: account value,
  withdrawable, up to 100 positions and 100 resting orders.
- `apps/server/src/rate-limit.ts` has `takeToken(db, bucket, perMinute, burst)` and `hasToken`:
  token buckets in the table `os.rate_limits`, shared by every replica.
- The fake venue is `packages/testkit/src/fake-hyperliquid.ts`. Its `/info` serves `meta`,
  `orderStatus`, `clearinghouseState`, `openOrders` and `userNonFundingLedgerUpdates`. Tests
  set its state through `/control/*` routes (accounts, metadata, a best bid and ask per market,
  fills, the clock, failures).

How the relevant pieces fit together:

- An agent calls a tool at `/mcp` through the `agent-gateway` proxy. The server reads its own
  database, a chain node, or the venue, and answers. The signer plays no part in a read.
- The server reaches the venue from the `chain` network, the same path its order posts use.

Assumptions:

- The venue's answer shapes are as its published pages show and as Gina Read decodes them in
  production. Nothing in this plan was run against the venue.
- A deployment's server replicas reach the venue from one address, so one budget for each
  network is right. With several addresses the budget is stricter than it needs to be.

## Plan of Work

### Milestone 1: the venue client reads markets, books, candles and fills

Scope: everything that talks to the venue, with no MCP surface yet. It is first because the
hardening protects order posts today and every later milestone stands on these reads.

Files and interfaces:

- `apps/server/src/execution/venues/hyperliquid.ts`: harden `call()`; add the read methods.
- `packages/testkit/src/fake-hyperliquid.ts`: serve the new `/info` request types; two new
  failure modes.
- `apps/server/test/execution/venue-reads.test.ts` (new) and `orders.test.ts`.

Work:

Harden `call()`, for `/info` and `/exchange` alike:

- Send `redirect: "error"`. A redirect is a `VenueError`: for a post that means "outcome
  unknown, ask the venue", which is already how a lost answer is handled.
- Read the body through its stream and stop at `VENUE_ANSWER_MAX_BYTES` (4 MiB). More is a
  `VenueError`.
- Send `accept: application/json` and `user-agent: askgina-os`.

Add to `HyperliquidClient`, each decoding with a loose zod object that declares every field it
does not need as optional:

| Method                                        | `/info` request                          | Returns                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markets()`                                   | `metaAndAssetCtxs`                       | For each listed perpetual: name, asset index, size decimals, max leverage, isolated-only, mark, mid, oracle, hourly funding, open interest, day volume, previous-day price |
| `mids()`                                      | `allMids`                                | A map from market name to mid                                                                                                                                              |
| `book(coin)`                                  | `l2Book`                                 | The venue's time and up to 20 levels a side, or null for an unknown market                                                                                                 |
| `candles(coin, interval, startTime, endTime)` | `candleSnapshot`                         | Open time, close time, open, high, low, close, volume                                                                                                                      |
| `fills(user)`                                 | `userFills` with `aggregateByTime: true` | Time, market, side, price, size, fee, closed profit, whether it crossed, venue order id; and the row count                                                                 |
| `takerFeeRate(user)`                          | `userFees`                               | The address's taker rate less its referral discount, or null when either is not a number                                                                                   |

Extend `accountState` to return margin used and, for each position, position value, leverage,
liquidation price (or null) and margin used. Extend `openOrders` to return the time placed.
`walletVenueAccount` keeps its output.

The fake venue gains the same request types. A market's book becomes a list of levels (the
existing best bid and ask are its first level); mids come from the book; candles are set through
a new `PUT /control/candles`; fills are the ones it already records. Add failure modes
`redirect` (answers 302 to another address) and `oversize` (answers a body past the limit).

Acceptance:

- Run `node_modules/.bin/vitest run apps/server/test/execution/venue-reads.test.ts` and expect
  each method to return the fake's state; an unknown market's book to be null; a row with a
  missing optional field to be kept; a redirect, an oversized answer and a wrong shape each to
  throw `VenueError`.
- Run `node_modules/.bin/vitest run apps/server/test/execution/orders.test.ts` and expect the
  existing cases to pass, plus: a post that is redirected is recorded as an unknown outcome and
  is resolved by the order's status, and no request reaches the redirect's target.

### Milestone 2: the read budget

Scope: reads cannot use the request allowance that order handling needs. It comes before the
tools so no tool exists without it.

Files and interfaces:

- `apps/server/src/rate-limit.ts`: `takeTokens(db, bucket, perMinute, burst, cost)` and
  `chargeTokens(db, bucket, perMinute, burst, cost)`.
- `apps/server/src/execution/venues/reads.ts` (new): `venueReads(ctx, network, agentId)`.
- `apps/server/test/support/rate-limit.test.ts`, `venue-reads.test.ts`.

Work:

`takeTokens` is `takeToken` for a cost above one: it takes `cost` tokens when the bucket holds
them and changes nothing otherwise. `takeToken` becomes a call to it. `chargeTokens` subtracts
without a check and may leave the bucket below zero; the refill pays that back before the next
take succeeds.

`venueReads(ctx, network, agentId)` wraps the client's read methods. For each read it:

1. Answers from a per-process cache when it holds a fresh answer for the same request: markets
   for 15 seconds, mids and a book for 1 second, candles for 5 seconds, a fee rate for 10
   minutes. Account state, resting orders and fills are never cached. The cache holds at most
   200 answers, and concurrent identical reads share one request to the venue.
2. Otherwise takes the read's base weight from two buckets, `venue-read:<network>` (600 a
   minute) and `venue-read:<network>:<agentId>` (240 a minute). Either one empty: `HttpError`
   `rate_limited`, detail `venue_budget`, and no request is made. The weights are the venue's:
   mids, a book and account state 2; markets, candles, resting orders, fills and a fee rate 20.
3. Makes the request. Afterwards charges both buckets the weight only the answer reveals: one
   for every 60 candles, one for every 20 fills.
4. Turns a `VenueError` into `HttpError` `internal`, detail `venue_unreachable`, as
   `proposeOrder` does.

Order handling does not go through `venueReads` and takes from no bucket.

Acceptance:

- Run `node_modules/.bin/vitest run apps/server/test/support/rate-limit.test.ts` and expect: a
  take of 20 from a bucket holding 19 fails and leaves 19; a charge takes a bucket below zero
  and the next take fails until the refill has paid it back; two database connections taking at
  once never overdraw.
- Run `venue-reads.test.ts` and expect: a second identical price read inside a second makes no
  second request; reads past an agent's budget are refused with `venue_budget` while another
  agent's reads and a `proposeOrder` on the same network succeed; a fills read of 100 rows
  costs 25.

### Milestone 3: the seven MCP tools

Scope: the agent-facing surface.

Files and interfaces:

- `apps/server/src/mcp/venue-reads.ts` (new): `registerVenueReads(server, ctx, agent)`.
- `apps/server/src/mcp/gateway.ts`: `MCP_TOOL_NAMES` lists fifteen; `buildServer` calls
  `registerVenueReads`; `json`, `answer` and `walletsFor` are exported for it.
- `apps/server/test/execution/mcp.test.ts`, `cancel.test.ts` (its tool count), a new
  `apps/server/test/execution/mcp-venue-reads.test.ts`.

Work:

Shared input fields: `network` is a venue network from `whoami`, required, and refused with
`venue_not_configured` when `VENUES_FILE` does not list it. `coin` matches
`^[A-Za-z0-9]{1,16}$`, the pattern of `propose_order`. `walletId` is optional and defaults to
the agent's own wallet; a wallet outside `walletsFor` is `not_found`. Every tool is annotated
`{ readOnlyHint: true, openWorldHint: true }`. Every result carries `network` and `observedAt`
(the server's clock, ISO 8601). Prices, sizes and USD amounts are decimal strings.

| Tool                | Input                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                     | From Gina Read                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `get_markets`       | `network`, `coins?` (at most 50)                                                                              | Up to 500 markets: `coin`, `asset`, `sizeDecimals`, `maxLeverage`, `isolatedOnly`, `markPrice`, `midPrice`, `oraclePrice`, `fundingRateHourly`, `openInterest`, `dayVolumeUsd`, `previousDayPrice`, and `allowed`; `omitted`                                                                                                               | `perps.getHyperliquidMarkets`, without builder-deployed markets or text search                                   |
| `get_prices`        | `network`, `coins?` (at most 50)                                                                              | `prices`: `coin`, `mid`. Without `coins`, every perpetual market, at most 500                                                                                                                                                                                                                                                              | `perps.getHyperliquidPrice` and `perps.getHyperliquidPrices`, as one tool                                        |
| `get_order_book`    | `network`, `coin`, `depth?` (1 to 20, default 10)                                                             | `venueTime`, `mid`, `spread`, `bids` and `asks`: `price`, `size`, `orders`                                                                                                                                                                                                                                                                 | `perps.fetchHyperliquidOrderBook`, with the venue's real limit of 20                                             |
| `get_candles`       | `network`, `coin`, `interval` (one of the venue's 14), `count?` (1 to 500, default 60), `endTime?` (ISO 8601) | `candles`: `openTime`, `closeTime`, `open`, `high`, `low`, `close`, `volume`, `closed`                                                                                                                                                                                                                                                     | `perps.fetchHyperliquidCandles`, one interval a call; the five extra intervals it fetches for its chart are gone |
| `preview_order`     | `network`, `coin`, `side`, `size`, `limitPrice?`, `walletId?`                                                 | `fillableSize`, `unfilledSize`, `fullyCovered`, `averagePrice`, `worstPrice`, `bestPrice`, `mid`, `slippageBps`, `notionalUsd6`, `takerFeeRate`, `estimatedFeeUsd`, `levelsUsed`, `venueTime`                                                                                                                                              | `perps.previewHyperliquidOrderCost`, made aware of a limit price and of the caps                                 |
| `get_venue_account` | `network`, `walletId?`                                                                                        | `walletId`, `address`, `accountValueUsd`, `withdrawableUsd`, `marginUsedUsd`, up to 100 `positions` (`coin`, `side`, `size`, `entryPrice`, `positionValueUsd`, `unrealizedPnlUsd`, `leverage`, `liquidationPrice`, `marginUsedUsd`), up to 100 `openOrders` (`coin`, `side`, `size`, `limitPrice`, `placedAt`, `venueOrderId`, `intentId`) | `perps.getHyperliquidAccount`, `perps.getHyperliquidPositions` and `perps.getHyperliquidOpenOrders`, as one tool |
| `get_venue_fills`   | `network`, `walletId?`, `coin?`, `limit?` (1 to 200, default 50)                                              | `fills`, newest first: `time`, `coin`, `side`, `price`, `size`, `feeUsd`, `closedPnlUsd`, `taker`, `venueOrderId`, `intentId`                                                                                                                                                                                                              | `perps.fetchHyperliquidTrades`                                                                                   |

Rules that are this system's own:

- `allowed` in `get_markets` is true when a wallet the agent may use lists the market in its
  venue rules for that network. It saves a second call to `whoami`.
- `preview_order` walks the asks for a buy and the bids for a sell. With `limitPrice`, only
  levels at that price or better count, and `notionalUsd6` is size times limit price, the number
  the wallet's caps count (`orderNotionalUsd6` in `packages/protocol`). Without it,
  `notionalUsd6` is the walked notional. A book older than 10 seconds by the venue's time is
  refused with detail `venue_stale`. The fee rate is the wallet's own; when it cannot be read
  inside 3 seconds the two fee fields are null and the preview is still answered. All
  arithmetic is on scaled integers.
- `intentId` on a resting order or a fill is the intent of the agent's own whose
  `venue_orders.venueOrderId` is that order, on that wallet and network. It is null for an order
  that another agent proposed or that was placed outside this system.
- An unknown market is `not_found`, detail `market_unknown`.
- Each tool's description says the data is the venue's own report, unverified, and names the
  network it came from. `get_prices` says a mid is not a price an order will get.

Acceptance:

- Run `node_modules/.bin/vitest run apps/server/test/execution/mcp.test.ts` and expect "offers
  exactly the fifteen agent tools" and the annotation map to pass.
- Run `node_modules/.bin/vitest run apps/server/test/execution/mcp-venue-reads.test.ts` and
  expect: each tool's result for a known fake state; `allowed` true only for a market in the
  wallet's rules; a preview against a three-level book to give the hand-computed average price
  and `notionalUsd6`; another workspace's and another agent's wallet to be `not_found`; a
  network that is not configured to be refused; a fake market named with characters outside the
  pattern to appear in no result and to be counted in `omitted`; a fill of the agent's own
  order to carry its `intentId` and a fill of another agent's order to carry null.
- From `apps/server`, `../../node_modules/.bin/tsc --noEmit`; from the root, `bun run check`
  and `bun run lint:slop`.

### Milestone 4: release gates

Scope: the same behaviour through the real stack: the agent's closed network, the proxy, two
replicas, both networks.

Files and interfaces:

- `e2e/test/venue.spec.ts`, `e2e/test/release-gates.spec.ts` (`AGENT_TOOLS`).
- `e2e/src/fake-hyperliquid.mts` only if the fake's new control route needs wiring.

Work:

Change the two `AGENT_TOOLS` lists to fifteen. In `venue.spec.ts`, rename "an agent has exactly
eight tools…" and add:

- "an agent on the agents network reads each configured venue's own prices": the testnet and
  mainnet fakes hold different books; an agent container that cannot reach the internet reads
  both and gets each one's.
- "an agent prices an order from the book, and reads the position and the fill it caused":
  preview, propose at the previewed price, approve on the confirmation page, then
  `get_venue_account` and `get_venue_fills` carry the `intentId`.
- "an agent cannot read the venue account of a wallet it may not use".
- "an agent that spends the read budget is refused, and another agent's order and cancel still
  go through".

Acceptance:

- CI jobs `stack (amd64)`, `stack (arm64)`, `stack (split)`, `stack (replicas)` and
  `stack (openbao)` pass with the new gates. These run in CI; do not run `./e2e/run.sh` locally
  unless asked.

### Milestone 5: documentation

Scope: every page the change makes wrong, in the same pull request as the code.

Files and interfaces:

- `README.md`: the tool list under "Connect your own agent"; one paragraph under "Trade on
  Hyperliquid"; the Status table.
- `docs/architecture.md`: the Agent and Venue bullets; "What is proven".
- `docs/threat-model.md`: trust boundaries 1 and 8; "A malicious or prompt-injected agent"; "A
  stolen agent token"; "Venue orders".
- `deploy/README.md`: the venue section (reads, the budget, that the venue's host must be
  reachable from the server); `deploy/k8s/overlays/production-example/egress.yaml`: a venue
  entry.
- `apps/server/README.md`, `packages/testkit/README.md`, `e2e/README.md`.
- `apps/web/src/routes/agent.tsx`: the sentence on the "Connect the agent" card, which says an
  agent can "propose payments and read their outcome".
- `specs/README.md`: the plan and report rows.

Work:

What the threat model must say:

- An agent can now make the server send requests to the venue. They go only to the configured
  origin and the path `/info`, with a body the server builds from enumerated and
  pattern-checked inputs; the agent chooses no address and no URL.
- What stops an agent from starving order handling: the read budget. What does not: a venue
  that changes its limits, or other software sharing the server's outbound address.
- What an agent reads is unverified. A compromised control plane, or anyone on the path to the
  venue, can show an agent false prices and so steer what it proposes. A person still approves
  every order on the confirmation page, which shows the limit price and no market price: the
  signer never talks to the venue.
- A stolen agent token can now read the positions and fills of the wallets that agent may use.
  The venue publishes the same for any address.

Acceptance:

- `bun run check` passes (Biome checks Markdown and its tables).
- The tool list is the same fifteen names in `README.md`, `docs/architecture.md`,
  `docs/threat-model.md` and `MCP_TOOL_NAMES`.

## Interfaces and Dependencies

Local interfaces:

- `HyperliquidClient` (`apps/server/src/execution/venues/hyperliquid.ts`):
  - Input: a market name, an interval and two times, or an address.
  - Output: decoded rows as in Milestone 1.
  - Failure behavior: `VenueError` for no answer, a redirect, an oversized answer, a server
    error or a shape that does not decode.
  - Call sites affected: `orders.ts` (unchanged calls, hardened transport) and the new
    `reads.ts`.
- `venueReads(ctx, network, agentId)` (`apps/server/src/execution/venues/reads.ts`):
  - Input: a configured network and the agent charged for the read.
  - Output: the client's reads, cached and budgeted.
  - Failure behavior: `HttpError` `invalid_request`/`venue_not_configured`,
    `rate_limited`/`venue_budget`, `internal`/`venue_unreachable`.
- `takeTokens`, `chargeTokens` (`apps/server/src/rate-limit.ts`): as in Milestone 2.
  `takeToken` and `hasToken` keep their signatures.
- `registerVenueReads(server, ctx, agent)` (`apps/server/src/mcp/venue-reads.ts`): registers the
  seven tools on the server `buildServer` made.

External dependencies:

- The venue's `/info` endpoint:
  - Version or source checked: its published "Info endpoint", "Perpetuals" and "Rate limits and
    user limits" pages on 2026-11-16, and the schemas Gina Read decodes with at `ed2387c`
    (`lib/server/mcp/hyperliquid.ts`).
  - API used: `metaAndAssetCtxs`, `allMids`, `l2Book`, `candleSnapshot`, `userFills`,
    `userFees`, and the two the server already uses, `clearinghouseState` and `openOrders`.
  - Constraints: 1,200 request weight a minute for each client address; 20 book levels a side;
    the 2,000 most recent fills; the 5,000 most recent candles.
  - Reason this dependency is appropriate: the server already depends on this endpoint for
    orders.
- No package is added. `@modelcontextprotocol/server` stays at 2.4.0.

## Concrete Steps

From the repository root:

    bun install
    bun run services:up
    node_modules/.bin/vitest run apps/server/test/execution/venue-reads.test.ts
    node_modules/.bin/vitest run apps/server/test/support/rate-limit.test.ts
    node_modules/.bin/vitest run apps/server/test/execution/mcp.test.ts
    node_modules/.bin/vitest run apps/server/test/execution/mcp-venue-reads.test.ts
    node_modules/.bin/vitest run apps/server/test/execution/orders.test.ts
    bun run check
    bun run lint:slop
    (cd apps/server && ../../node_modules/.bin/tsc --noEmit)
    (cd packages/testkit && ../../node_modules/.bin/tsc --noEmit)
    bun run services:down

Expected evidence:

    ✓ offers exactly the fifteen agent tools
    ✓ a redirected answer is a VenueError and nothing is sent to its target
    ✓ reads past an agent's budget are refused and an order still goes out

## Validation and Acceptance

Automated validation:

- The five test files above, each alone: all pass.
- `bun run check`, `bun run lint:slop`, `tsc --noEmit` in `apps/server`, `packages/testkit` and
  `e2e`: clean.
- CI: every job green, with the four new gates in the `stack` jobs.

Manual or runtime validation:

- None is planned. The real venue is not contacted by any test. A read against the real testnet
  would be "proven once by hand" and needs the owner's word; the plan does not depend on it.

Regression checks:

- `propose_order`, the order follow-up, cancel and the withdrawal ledger read behave as before:
  `orders.test.ts`, `cancel.test.ts` and the existing gates in `venue.spec.ts`.
- The wallet page's venue account is unchanged: `walletVenueAccount` keeps its output.
- An agent's eight existing tools keep their inputs, results and annotations.

## Idempotence and Recovery

- Every new tool is a read; calling one twice changes nothing but the budget buckets.
- The buckets are rows in `os.rate_limits` created on first use. No migration is needed: the
  table exists, and a bucket that is never used is never created.
- The per-process cache is lost on restart, which costs one request for each read.
- Backing out is reverting the pull request. Nothing stored refers to the new tools.

## Rollout and Operations

- Feature flags/config/env vars: none. The tools are on when `VENUES_FILE` lists a venue, which
  is already how a venue is turned on. The budget numbers are constants.
- Migration or backfill order: none.
- Monitoring: one log line for each refused read, with the tool, the network and the code
  (`venue_budget`, `venue_unreachable`, `venue_stale`); never a market name an agent typed.
- Rollback: revert.
- After merge, in the fork `askgina/busy` (a separate repository and a separate change): its
  bot template's wallet guidance can tell a bot to read a price before it proposes an order.
  Bots discover the tools without it.

## Risks and Open Questions

- Risk: the venue's answers differ from its published pages.
  Mitigation or validation: every field a tool does not need is optional and a row that does
  not fit is dropped, so a difference costs rows, not the tool. A read against the real testnet
  (owner's word) would settle it.
- Risk: the venue changes its request limits or weights.
  Mitigation or validation: the budget is half the published allowance; the weights are
  constants in one file, named after the venue's page.
- Risk: fifteen tools make an agent's tool list long enough to change how a small model
  chooses.
  Mitigation or validation: seven tools, not Gina Read's thirteen; descriptions say when to use
  each. The fork's real-model runs are the place to see it.
- Risk: an agent treats a mid or a preview as a promise.
  Mitigation or validation: the descriptions say they are not; an order is still a limit order
  that a person approves.
- Open question: D1 to D5 in the `Decision Log`.
  Owner or next step: the repository owner.
- Open question: whether the venue treats a request with no `user-agent` differently.
  Owner or next step: none needed; the client names itself either way.

## Artifacts and Notes

Gina Read's Hyperliquid tools and where each went:

    perps.getHyperliquidMarkets         -> get_markets
    perps.getHyperliquidPrice           -> get_prices
    perps.getHyperliquidPrices          -> get_prices
    perps.fetchHyperliquidOrderBook     -> get_order_book
    perps.fetchHyperliquidCandles       -> get_candles
    perps.previewHyperliquidOrderCost   -> preview_order
    perps.getHyperliquidAccount         -> get_venue_account
    perps.getHyperliquidPositions       -> get_venue_account
    perps.getHyperliquidOpenOrders      -> get_venue_account
    perps.fetchHyperliquidTrades        -> get_venue_fills
    perps.getHyperliquidPerpDexes       -> not ported (markets this system cannot trade)
    perps.getHyperliquidPortfolio       -> not ported (D3)
    perps.getHyperliquidAssetData       -> not ported (D3)

## Revision Notes

- 2026-11-16: first draft, from the research report of the same date.
