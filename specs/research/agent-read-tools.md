# What of Gina Read is worth porting to this system, and how?

- Date: 2026-11-16
- Author: research agent (the lead, with two read-only research agents)
- Question: `askgina/gina` now serves "Gina Read", an MCP (Model Context Protocol) server with
  read-only market and account tools. Which parts of it belong in this repository, and in what
  form?
- Answer in short: the Hyperliquid reads, rebuilt on this repository's own venue client and MCP
  gateway. Nothing else: not the sign-in server, not the widgets, not the stores, not the other
  data providers. The plan is [`../agent-read-tools.md`](../agent-read-tools.md).

Claims are tagged with their source. `[INFERENCE]` marks a conclusion that was reasoned, not
observed. Nothing was built or run for this report; no network call was made to a venue.

## Versions this was checked against

| What                    | Version                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Source, `askgina/gina`  | `main` at `ed2387c` (2026-11-16), which holds pull requests 7, 9, 10 and 11                |
| Target, this repository | `main` at `a99f56b` (2026-11-16)                                                           |
| MCP SDK                 | `@modelcontextprotocol/server` 2.3.0 in the source, 2.4.0 here                             |
| Hyperliquid API pages   | "Info endpoint", "Perpetuals" and "Rate limits and user limits", as published on that date |

## The source: what the pull request added

Pull request 7 of `askgina/gina` ("port the Gina Read MCP behind an admin-list flag", merged
2026-11-16 as `9df73a9`) added 59,583 lines over 314 files (GitHub's count). Three small pull
requests followed the same day: 9 (account reads use the caller's first embedded wallet, whether
or not it is delegated), 10 (functions run in one region) and 11 (every JSON request names its
client in `user-agent`).

What it is, by part (line counts are of the non-test TypeScript under each path at `ed2387c`):

| Part                               | Where in the source                                                                                                    | Size                                                | What it does                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read tools                         | `lib/server/mcp/tools/*`                                                                                               | about 7,800 lines                                   | 27 tools: 7 Hyperliquid market reads, 6 Hyperliquid account reads, 6 Polymarket market reads, 3 Polymarket account reads, 3 CoinGecko reads, 2 wallet reads                                    |
| Provider callers                   | `lib/server/mcp/{hyperliquid,polymarket,coingecko,codex,polygon}.ts`                                                   | about 2,200 lines                                   | One module per outside API: the request shapes, the schema each answer is decoded with, and the conversion to the tool's rows                                                                  |
| Outbound client                    | `lib/server/upstream.ts`                                                                                               | 330 lines                                           | Every outbound request: a fixed table of origins, keys looked up by API name, redirects refused, a 10-second deadline, a 60-second in-memory cache, a named `user-agent`, every answer decoded |
| Transport and encoding             | `lib/server/mcp/{server,encode,request-policy,errors,host}.ts`, `app/ai/gina/mcp/route.ts`                             | about 780 lines                                     | Stateless Streamable HTTP, a fresh server per request, Host and Origin checks, a 256 KiB body cap, a fixed error vocabulary, a published output schema per tool                                |
| Caller identity                    | `lib/server/mcp/{verify-token,active-user,identity,wallets,privy}.ts`                                                  | about 370 lines                                     | The caller is a user of a hosted sign-in provider; each account read looks up that user's wallet address there                                                                                 |
| Authorization server               | `lib/server/oauth/*`, `app/ai/mcp/oauth/*`, the discovery routes                                                       | about 2,100 lines                                   | OAuth for hosted assistants: client registration, consent page, codes, access and refresh tokens, revocation                                                                                   |
| Stores                             | `lib/server/redis.ts`, `lib/server/mcp/{rate-limit,result-store,source-receipts,presentation-receipts,negotiation}.ts` | about 1,300 lines                                   | Redis: per-user rate windows, OAuth records, and short-lived records that link a tool result to a widget                                                                                       |
| Widgets and presentation tools     | `app/mcp-apps/**`, `lib/server/mcp/{dashboard,prediction-render}/*`, `app-resources.ts`, `presentation.ts`             | about 3,900 lines server side, plus the widget tree | 5 presentation tools and 5 widget families that a widget-capable host draws                                                                                                                    |
| Skills, server card, error capture | `lib/server/mcp/{skills,server-card}.ts`, `lib/server/sentry.ts`                                                       | about 400 lines                                     | Instruction files served from the endpoint, a discovery document, error reports to a hosted service                                                                                            |
| Safety script                      | `scripts/check-safety.mjs`                                                                                             | 3,067 lines                                         | Pins the tool list, the annotation lines, the provider paths each caller may use, and that nothing signs or sends                                                                              |

Sources: `gh pr view 7 --repo askgina/gina`; `lib/server/mcp/tools/index.ts:21,28`;
`scripts/check-safety.mjs:865-898` (the pinned list of 27 names); `wc -l` over the paths named.

Properties of the source that matter for a port:

- Every tool body is an Effect program that needs the source's own service layers; the tools
  cannot run without that runtime (`lib/server/mcp/encode.ts:118`, `lib/server/runtime.ts:60`).
  The source's own design record says the same about the application it replaced: names,
  schemas and call shapes moved across "as source to adapt rather than import"
  (`specs/gina-read-mcp.md` in the source, section 2).
- Every Hyperliquid request goes to one fixed origin, `https://api.hyperliquid.xyz`, which is the
  venue's mainnet (`lib/server/upstream.ts`, `ORIGINS`).
- Numbers in tool results are JavaScript numbers parsed from the venue's decimal strings
  (`lib/server/mcp/tools/perps.ts:41`, `finite`).
- The caller's address for an account read comes from the sign-in provider's record of the
  caller, never from tool input (`lib/server/mcp/wallets.ts:43`).
- Every tool is annotated `readOnlyHint: true, destructiveHint: false, idempotentHint: true`, and
  the tools that pass on a provider's data also `openWorldHint: true`
  (`lib/server/mcp/server.ts:41`).

## The target: what this repository has today

- **One MCP endpoint, for agents.** `/mcp` on the server, stateless Streamable HTTP, a bearer
  token per agent, a fresh server per request bound to that agent
  (`apps/server/src/mcp/gateway.ts:592-713`). Eight tools: `whoami`, `get_balances`,
  `propose_transfer`, `propose_contract_call`, `propose_order`, `get_intent`, `list_intents`,
  `cancel_intent` (`gateway.ts:101-110`). Inputs are zod schemas; a result is JSON, sent as text
  and as `structuredContent`; a failure is a fixed message and a stable code (`gateway.ts:115-154`).
- **Agents cannot reach the internet.** An agent runs on an internal network whose only other
  member forwards `/mcp` and nothing else; a release gate checks that such a container resolves
  no other service and cannot reach an outside host (`docs/architecture.md:86-93`,
  `e2e/test/release-gates.spec.ts:614-648`).
- **Agents can trade on Hyperliquid and see almost nothing of it.** `propose_order` proposes a
  limit order on a perpetual market the wallet's rules list (`gateway.ts:451-491`). The only
  venue facts an agent gets are the network names and the wallet's venue rules in `whoami`, and
  the fields of its own orders in `get_intent`. No tool returns a price, an order book, a
  position or a fill.
- **The server already reads the venue.** Its client calls the venue's `/info` for market
  metadata, an order's status, the account's value and positions, its resting orders and its
  withdrawal ledger (`apps/server/src/execution/venues/hyperliquid.ts:70-88`). The account's
  value, positions and resting orders reach people on the wallet page
  (`apps/server/src/execution/orders.ts:1008-1078`), not agents.
- **The venue's host is the operator's choice.** `VENUES_FILE` lists at most one API URL per
  network, testnet or mainnet (`apps/server/src/config.ts:29-33,389-421`). The release gates
  point both at a fake venue (`e2e/venues.json`).
- **The venue client has three gaps the source's client does not.** It follows redirects (no
  `redirect` option is set), reads an answer of any size (`response.text()` with no cap), and
  sends no `user-agent` (`hyperliquid.ts:213-219`).
- **Conventions.** No workspace depends on `effect`; the server uses Hono, zod, drizzle and viem
  (`apps/server/package.json`). Money is a decimal string, never a float
  (`packages/protocol/src/venues.ts`, `Decimal`). Rate limits are token buckets in Postgres that
  every replica shares (`apps/server/src/rate-limit.ts`). Tests run against a fake venue that
  serves five `/info` request types (`packages/testkit/src/fake-hyperliquid.ts:1490-1564`).

## Fit, part by part

| Part of the source                                | Verdict         | Why                                                                                                                                                                                                                          |
| ------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hyperliquid market reads (7 tools)                | Port, adapted   | An agent here can propose a limit order and cannot see the market it prices against. The server already talks to the venue.                                                                                                  |
| Hyperliquid account reads (6 tools)               | Port, adapted   | The address is the agent's wallet, which the server already knows. The server already reads two of the six for people.                                                                                                       |
| The outbound client's rules                       | Port the rules  | Refused redirects, a size limit, a named client and "every answer is decoded" apply to the venue client here, for the reads it already makes as much as for new ones.                                                        |
| The tool contract ideas                           | Port            | Read-only annotations pinned by a test, a fixed error vocabulary, bounded rows, and the lesson that every optional upstream field must be declared optional or one odd row fails the whole read.                             |
| Polymarket reads (9 tools)                        | Do not port now | This system has no Polymarket venue: an agent could read a market it cannot act on. About 5,300 lines of tools and a 770-line caller, three more outside hosts. They belong with a Polymarket venue plan, if one is written. |
| CoinGecko reads (3 tools)                         | Do not port now | They need a paid key and a new outside host, and return token names and descriptions written by token issuers, which is free text into a model. With a venue configured, the venue's own mids price the majors.              |
| Cross-chain portfolio and address tools (2 tools) | Do not port     | `whoami` and `get_balances` already answer both from the chains the operator configured. The source's version needs a second paid key.                                                                                       |
| Caller identity through a sign-in provider        | Do not port     | An agent here is identified by its own token, and its wallets are rows in this system's database.                                                                                                                            |
| Authorization server                              | Do not port     | It exists so hosted assistants can sign a person in. Agents here hold a bearer token on a private network. An OAuth server on the control plane would be a new trust boundary and is a separate question.                    |
| Redis stores                                      | Do not port     | The rate windows have a Postgres equivalent here. The other records exist to feed widgets.                                                                                                                                   |
| Widgets and presentation tools                    | Do not port     | Agents here are programs, not chat hosts that draw widgets. People see requests and accounts in the web app and approve on the confirmation page.                                                                            |
| Skills, server card, hosted error capture         | Do not port     | Discovery documents and hosted telemetry for a public endpoint. This endpoint is private to the installation and logs to stdout.                                                                                             |
| The Effect runtime                                | Do not port     | It would add a second way to write a service to a codebase that has one.                                                                                                                                                     |
| The safety script                                 | Do not port     | Its job is done here by tests and release gates that pin the tool list and its annotations, and by the signer, which is the only place a key exists.                                                                         |

`[INFERENCE]` The part worth moving is roughly the Hyperliquid caller and its two tool files:
2,214 of the source's lines (`hyperliquid.ts` 1,032, `tools/perps.ts` 732,
`tools/perps-account.ts` 450). About half of that serves things this system cannot trade
(builder-deployed markets, spot holdings, account modes) or widgets. The port is a rewrite of
the rest on this repository's client, an estimated 900 to 1,200 lines of TypeScript before tests.

## Where the two differ, and what each difference means for the port

1. **Which network.** The source reads mainnet always. Here an order goes to the network the
   wallet's approved rules name, and a testnet price is not a mainnet price. Every read must go
   to the configured host of the network the tool call names. This also means no new outside
   host: the reads use the origins the operator already listed.
2. **Whose account.** The source resolves the caller's address at a sign-in provider. Here the
   address is the wallet's, from this system's own records, and the rule that already governs
   `get_balances` applies: the agent's own wallet, or a treasury whose rules name the agent. A
   tool that took an address as input would turn the server into a lookup service for any
   address.
3. **What can be traded.** The source covers builder-deployed markets, spot holdings and the
   venue's account modes. Here only perpetual markets of the first market list are tradable
   (`specs/non-evm-operations.md`, non-goals), so those parts have nothing to serve.
4. **Numbers.** The source parses to floats. Here amounts stay decimal strings as the venue
   spelled them, and arithmetic (walking an order book) is done in scaled integers, as
   `orderNotionalUsd6` already does.
5. **What a result may carry.** The source passes on some provider text (market display names,
   deployer names). Here an agent may be following injected instructions, and its proposals
   reach a person's approval inbox. A read result should carry numbers, enumerated words and
   names that match a strict pattern, and no free text from the venue.
6. **The venue's request limit is shared with order handling.** The venue allows 1,200 units of
   request weight a minute for each client address, across reads and signed requests
   ("Rate limits and user limits": weight 2 for `l2Book`, `allMids`, `clearinghouseState` and
   `orderStatus`; 20 for most other reads; `candleSnapshot` one more per 60 rows; `userFills`
   one more per 20 rows; a signed request 1). The source rate-limits each user and nothing
   else, because it submits nothing. Here the same server address posts approved orders and
   cancels and follows them. An agent that could spend the whole allowance on reads could delay
   a cancel. Reads need their own budget, counted in the venue's weights, that leaves room for
   order handling.
7. **Depth.** The source's order-book tools accept up to 200 levels a side. The venue returns at
   most 20 ("Info endpoint", L2 book snapshot). A ported tool should say 20.
8. **Fills name an order id, not a client order id.** A fill row carries `oid` and no `cloid`
   ("Info endpoint", user fills). This system stores each order's venue order id
   (`apps/server/src/db/schema.ts`, `venue_orders.venueOrderId`), so a fill or a resting order
   can be tied to the intent that caused it by that id.

## How to rerun this

- The source's tool list: in a checkout of `askgina/gina` at `ed2387c`,
  `git grep -c 'defineRead({' -- lib/server/mcp/tools` (27 in all) and
  `lib/server/mcp/tools/index.ts`.
- The source's sizes: `wc -l` over the paths in the first table.
- The target's tool list and client: `apps/server/src/mcp/gateway.ts` and
  `apps/server/src/execution/venues/hyperliquid.ts` at `a99f56b`.
- The venue's limits and answer shapes: the three API pages named under "Versions".

## Not checked

- No request was sent to the venue. The answer shapes in the plan are from the venue's published
  pages and from the schemas the source decodes with in production.
- Whether the venue treats a request without a `user-agent` differently. The source names its
  client on every request because another provider refused the runtime's default.
- The source's widget tree was listed, not read.
