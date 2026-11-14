# Run a fork of Busy self-hosted next to askgina/os, with wallet proposals through the MCP gateway

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-14
- Links: [Ticket #26](https://github.com/askgina/os/issues/26) | [Map #18](https://github.com/askgina/os/issues/18) | [Research](./research/busy-fork.md) | [eve research](./research/eve-without-vercel-services.md) | PR: none

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

Busy ([MatiSolina/busy](https://github.com/MatiSolina/busy), Apache-2.0) gives each AI bot a name,
memory, routines, a chat and its own Linux computer, managed from one web app called the Hub.
Upstream runs only on Vercel: every bot is a Vercel project, every computer a Vercel Sandbox with
a Drive, and models go through the Vercel AI Gateway. v0.1 of askgina/os dropped it for that
reason. This plan builds a fork that runs on one operator's own machines, next to an askgina/os
stack, with no Vercel service.

After this change an operator runs the fork's Compose file, signs in to the Hub, creates a bot,
pastes an askgina/os agent token into its settings, and asks it to pay an invoice. The bot
proposes the payment through the askgina/os MCP gateway and sends the person the approval link.
The person approves with a passkey in the askgina/os inbox, the signer checks that passkey
itself, and the bot reports the transaction once it is confirmed. Nothing a person clicks in the
Busy chat can approve the payment.

Non-goals:

- No change to the signer, the approval protocol, the envelope formats or the seven MCP tools'
  behavior. The only askgina/os code change is packaging two packages and adding MCP tool
  annotations.
- Code tasks, firesides (second-opinion chats), bot-to-bot consultations and the macOS Desktop
  app stay switched off in this fork. AI Gateway and Vercel Token Pass billing are not offered.
- Sealing the Busy Hub's own message, event and memory tables is not in this plan (see Decision
  Log, D7).
- Hosted or multi-tenant operation.

Success means:

- A CI job brings up the fork's stack and the askgina/os stack together, creates a bot through
  the Hub API, has it propose a 0.001 ETH transfer, approves it with Chromium's virtual
  authenticator in the askgina/os inbox, and sees `confirmed` on Anvil and in the bot's reply.
- In that run, a forged answer posted to the Busy Hub leaves the askgina/os intent at
  `pending_approval`.
- A DNS sinkhole that serves every fork container records zero lookups of `*.vercel.com`,
  `*.vercel.sh`, `*.vercel.app` or `*.vercel-storage.com` during the run.
- A plaintext scan of every bot database and of the Hub's `workflow` schema finds none of the
  run's markers. The Hub's own `public` tables are documented as plaintext.
- Out of scope, by design: the features listed under non-goals.

## Progress

- [x] (2026-11-14 21:20Z) Research upstream, eve 0.91.0 and the askgina/os seams: [research/busy-fork.md](./research/busy-fork.md).
- [x] (2026-11-14 21:40Z) Define the approach, the milestones and their gates (this file).
- [ ] Owner decisions D1, D2, D5, D6, D7, D8, D10 (Decision Log).
- [ ] Milestone 0: askgina/os packages and tool annotations.
- [ ] Milestone 1: fork repository, attribution and upstream gate.
- [ ] Milestone 2: platform seams in the Hub, Vercel behavior unchanged.
- [ ] Milestone 3: OpenAI-compatible model connection.
- [ ] Milestone 4: bot runner, bot identity, bots on the encrypting World.
- [ ] Milestone 5: computers on gVisor with per-bot volumes.
- [ ] Milestone 6: Hub on the encrypting World; storage, schedules, queues, observability.
- [ ] Milestone 7: the askgina/os wallet connection.
- [ ] Milestone 8: switched-off features, documentation, threat model.
- [ ] Run validation and record evidence.

## Surprises & Discoveries

- Observation: the Hub already injects its deploy side effects, its schedules client and its
  model decision; only the bot template imports Vercel packages with no seam.
  Evidence: `busy@3dd91e1:apps/hub/lib/bots/deploy.ts:13-39` (`DeployDeps`),
  `lib/routines/schedule.ts:52,93`, `lib/bots/creation.ts:28-31,75-81`.
- Observation: the Busy Hub stores messages, eve events and memories in plaintext tables, and its
  history search depends on that.
  Evidence: `busy@3dd91e1:apps/hub/lib/db/schema.ts:611-615,726-733,790-819`;
  `lib/history-search.ts:167-183`.
- Observation: an unmodified Busy would show an approval card saying "I'm about to move money"
  for `propose_transfer`, which moves nothing.
  Evidence: `busy@3dd91e1:templates/bot/agent/lib/approval.ts:49-62,111-146,301-315`;
  research F6.
- Observation: Busy's Hub refuses MCP servers on private hosts and has no bearer-token auth mode,
  so the gateway cannot be a Busy marketplace connection without code changes.
  Evidence: `busy@3dd91e1:apps/hub/lib/mcp/network.ts:197-207`;
  `templates/bot/agent/connections/marketplace.ts:20`.
- Observation: eve stores a continuation token in the run attribute `$eve.invocation_token` and
  reads it back; the World withholds it unless listed.
  Evidence: `eve@0.91.0:dist/src/internal/invocation/metadata.js`; research F5.
- Observation: the eve example in this repository has no route to an external model and points
  at a gateway port nothing listens on; a bot container here must avoid both mistakes.
  Evidence: `examples/eve-agent/compose.yaml:79,90,103-107` against `compose.yaml:3,183-184` and
  `deploy/Caddyfile.agents:9`.

## Decision Log

Decisions marked **Open (owner)** are written here as the recommended option. The plan below is
written for that option and names what changes if the owner chooses otherwise.

- Decision D1, **Open (owner)**: the fork lives in a separate repository, a GitHub fork of
  `MatiSolina/busy` under the askgina organization (working name `askgina/busy`). Alternatives:
  inside askgina/os under `vendor/busy`; upstream contributions only.
  Rationale: keeps upstream history for rebasing, keeps pnpm, keeps the Apache-2.0 code out of
  the MIT askgina/os tree. If the owner picks "inside askgina/os", every `fork:` path below moves
  under `vendor/busy/` and Milestone 0's packaging becomes a workspace dependency.
  Date/Author: 2026-11-14 / research agent
- Decision D2, **Open (owner)**: the fork consumes `@askgina/os-world` and `@askgina/os-keys` as
  built packages published privately to GitHub Packages from askgina/os tags. Alternatives: a git
  dependency on a pinned askgina/os commit; a vendored copy checked by digest.
  Rationale: both packages are `private: true` and ship TypeScript source today
  (`packages/world/package.json`); Next.js and eve both need a resolvable package name at runtime
  (`specs/research/nextjs-as-control-plane-host.md`, finding 1).
  Date/Author: 2026-11-14 / research agent
- Decision D3: the seven gateway tools carry eve approval `never()` in the fork. The askgina/os
  passkey approval is the only approval.
  Rationale: Busy's card is a cookie-authenticated POST to the Hub that the signer cannot verify;
  a second prompt for the same payment teaches people to approve without reading (research F6).
  Date/Author: 2026-11-14 / research agent
- Decision D4: each bot holds its own askgina/os agent token and connects to the gateway
  directly over the askgina/os `agents` network. The Hub stores the token sealed and hands it to
  the runner, never to the browser or to the bot computer.
  Rationale: avoids changing Busy's MCP network policy and auth modes; one token per bot keeps
  the blast radius of one bot to one askgina/os agent.
  Date/Author: 2026-11-14 / research agent
- Decision D5, **Open (owner)**: bot computers run in containers under the gVisor runtime
  (`runsc`). Alternatives: Firecracker or Kata microVMs (need KVM: bare metal or nested
  virtualization); plain `runc` containers.
  Rationale: runs on the hosts askgina/os already targets without KVM; a user-space kernel between
  untrusted browser and shell work and the host kernel.
  Date/Author: 2026-11-14 / research agent
- Decision D6, **Open (owner)**: in production the runner (which holds a Docker socket) runs on a
  host or VM other than the signer's. On one machine it is allowed for development only.
  Rationale: a Docker socket is root on its host; on the signer's host that is the "signer host"
  attacker position (`docs/threat-model.md:139-143,216-218`).
  Date/Author: 2026-11-14 / research agent
- Decision D7, **Open (owner)**: the first fork accepts plaintext in the Busy Hub's own tables,
  keeps that database in its own Postgres that never joins askgina/os networks, and says so in
  its README. Alternatives: seal `messages.text`, `events.data` and `memories.content` and drop
  full-text history search; do not ship until sealed.
  Rationale: sealing breaks upstream's search (`lib/history-search.ts:167-183`) and touches the
  most-edited upstream files.
  Date/Author: 2026-11-14 / research agent
- Decision D8, **Open (owner)**: code tasks, firesides, consultations and Desktop are switched
  off. Alternative: port code tasks (`durable-harness` on a self-hosted World and sandbox), more
  than 10,000 lines.
  Rationale: each depends on Vercel-only libraries or on eve remote-agent callbacks that refuse
  private hosts (research F2, F10).
  Date/Author: 2026-11-14 / research agent
- Decision D9: the fork follows upstream's eve pin (0.91.0 on `busy@3dd91e1`) and never bumps eve
  on its own.
  Rationale: every independent eve bump would conflict with upstream's template; the attribute
  test in Milestone 4 forces a review whenever upstream bumps.
  Date/Author: 2026-11-14 / research agent
- Decision D10, **Open (owner)**: the fork ships under its own name and says "based on Busy"
  only to describe its origin. Alternatives: keep the name "Busy"; ask upstream for permission.
  Rationale: Apache-2.0 section 6 grants no trademark rights (`busy@3dd91e1:LICENSE:139-142`).
  Date/Author: 2026-11-14 / research agent
- Decision D11: each bot gets its own Postgres database, role and World keyring. Deleting a bot
  deletes its keyring (crypto-shred), then its database.
  Rationale: a compromised bot container reads only its own runs; shredding one bot does not
  touch the others.
  Date/Author: 2026-11-14 / research agent
- Decision D12: bots are built per bot, as upstream does, by running `eve build` in a builder
  container that already holds the template's dependencies, with the bot's `agent/config.json`
  written in.
  Rationale: the template imports `config.json` at build time in six files
  (`agent/agent.ts`, `channels/eve.ts`, `instructions.ts`, `lib/lazy-tools.ts`, `sandbox.ts`,
  `tools/web_fetch.ts`); building per bot leaves them unchanged.
  Date/Author: 2026-11-14 / research agent

## Outcomes & Retrospective

- Outcome: research done; nothing built.
  Evidence: [research/busy-fork.md](./research/busy-fork.md).
  Remaining: every milestone below, after the owner decisions.

## Context and Orientation

Paths starting with `fork:` are in the fork repository (D1), relative to its root, which starts as
a copy of `MatiSolina/busy` at `3dd91e16c0708bd02066377ba3e45aa06f4813c0`. Paths without a prefix
are in askgina/os.

Relevant repo rules:

- Read the applicable `AGENTS.md` chain before changing files: `AGENTS.md` here; `fork:AGENTS.md`,
  `fork:apps/hub/AGENTS.md` and `fork:CONTRIBUTING.md` in the fork.
- askgina/os: builds, full test suites and `e2e/run.sh` run in CI only; locally run single test
  files, `tsc` and Biome. Use Bun 1.4.4.
- Fork: keep upstream conventions (pnpm 12.16.1, Node 24.15 or later, Ultracite/Biome, Vitest 5).
  New code goes into new files under `fork:apps/hub/lib/platform/`, `fork:apps/runner/`,
  `fork:images/bot-builder/`, `fork:deploy/` and `fork:e2e/selfhosted/`. Upstream files are edited
  only at the selection points this plan names, and each edited upstream file carries the notice
  required by Apache-2.0 section 4(b) (Milestone 1).
- Never add a route, tool or message that tells askgina/os an intent was approved.

Current behavior:

- askgina/os: an agent reaches the server only through the agent gateway (Caddy on the internal
  `agents` network, port 80, path `/mcp`: `compose.yaml:132-144`, `deploy/Caddyfile.agents`). It
  has seven tools (`apps/server/src/mcp/gateway.ts:65-73`). A proposal returns an `approvalUrl`;
  a person approves with a passkey; the signer verifies it (`docs/approval-protocol.md`).
- askgina/os: `@askgina/os-world/target` encrypts workflow payloads and withholds run attribute
  values not listed in `WORLD_READABLE_ATTRIBUTE_KEYS` (`packages/world/README.md`). The eve
  example runs on it (`examples/eve-agent`).
- Busy upstream: the Hub creates one Vercel project per bot and deploys the template with the
  bot's `config.json` (`fork:apps/hub/lib/bots/deploy.ts:65-147`, `lib/bots/files.ts:42-52`). Bots
  authenticate to the Hub with Vercel OIDC (`fork:templates/bot/agent/lib/hub.ts:1-16`,
  `fork:apps/hub/lib/bot-auth.ts:24-76`). Computers are Vercel Sandboxes with a Drive at `/data`
  (`fork:templates/bot/agent/sandbox.ts`). The full list of ties is research F2.

How the relevant pieces fit together:

- The Hub (Next.js) serves the browser, stores state in its Postgres, runs its own Workflow
  runs, and calls each bot's eve HTTP API with a five-minute ES256 token scoped to that bot
  (`fork:apps/hub/lib/hub-token.ts`). A bot is an eve server; its durable state is a Workflow
  World. When a tool needs a computer, eve calls the bot's sandbox definition. After this plan:
  the runner starts bot containers and computer containers on networks that keep each one to
  what it needs; the bot's World is `@askgina/os-world/target`; the bot's askgina/os connection
  reaches only the agent gateway.

Assumptions:

- One Busy install serves one askgina/os workspace; each Busy bot is one askgina/os agent. Busy
  itself is single-account ("The application uses one shared workspace", `fork:README.md:84`).
  If several workspaces are needed, run several installs.
- The owner provides: the fork repository (D1), package publishing (D2), a read-only deploy key
  for askgina/os in the fork's CI (secret `ASKGINA_OS_READ_KEY`) for Milestone 7.
- GitHub-hosted Ubuntu runners can install gVisor from its apt repository. If not, Milestone 5's
  CI job uses a self-hosted runner and the gate stays the same.

## Plan of Work

### Milestone 0: askgina/os packages and tool annotations

Scope: make the World and key packages consumable from another repository, and let any MCP host
classify the seven tools correctly. First, because every later milestone depends on the packages.

Files and interfaces:

- `packages/world/package.json`, `packages/keys/package.json`: add `build` (`tsc -p
  tsconfig.build.json`, output `dist/`), `exports` pointing at `dist/*.js` with `types`, `files`,
  and `publishConfig.registry` `https://npm.pkg.github.com`. Keep source exports for workspace use
  through a `development` condition.
- `packages/world/tsconfig.build.json`, `packages/keys/tsconfig.build.json`: new.
- `.github/workflows/packages.yml`: new. On tags `world-v*`: build both packages, `npm pack`,
  run `scripts/smoke-packed-world.mjs`, publish.
- `scripts/smoke-packed-world.mjs`: new. Installs the two tarballs into a temporary directory and
  imports `@askgina/os-world/target` and `@askgina/os-world` with Node 26.
- `apps/server/src/mcp/gateway.ts`: add `annotations` to each `registerTool`: `whoami`,
  `get_balances`, `get_intent`, `list_intents` get `readOnlyHint: true`; `propose_transfer` and
  `propose_contract_call` get `readOnlyHint: false, destructiveHint: false, idempotentHint:
  false`; `cancel_intent` gets `readOnlyHint: false, destructiveHint: false, idempotentHint: true`.
  Descriptions and behavior do not change.
- `apps/server/test/execution/mcp.test.ts`: new case "tools/list carries annotations".

Work: the packages keep their public API. No dependency changes beyond `typescript` for the build.

Acceptance:

- CI job `packages` (added to `.github/workflows/ci.yml`, also run on pull requests without
  publishing) builds, packs and runs `node scripts/smoke-packed-world.mjs`; expect exit 0 and the
  line `smoke: @askgina/os-world/target loaded`.
- `bunx vitest run apps/server/test/execution/mcp.test.ts` passes with the new case.

### Milestone 1: fork repository, attribution and upstream gate

Scope: a fork that builds and tests exactly like upstream, with licence duties checked by CI and
an automatic signal when upstream moves. Depends on D1 and D10.

Files and interfaces:

- `fork:NOTICE`: keep upstream's text; append "This product includes modifications by Ask Gina
  (2026). Based on Busy by Matias Solina." as an addendum (Apache-2.0 4(d)).
- `fork:FORK.md`: new. What the fork changes and why, the switched-off features, the upstream
  commit it is based on, and the list of modified upstream files (generated, see below).
- `fork:README.md`: a banner naming the fork (D10), "based on Busy", and linking `FORK.md`.
- `fork:scripts/fork-notice.mjs` and `fork:scripts/fork-notice.test.mjs`: new. Lists files changed
  against the recorded upstream base (`git diff --name-only $UPSTREAM_BASE...HEAD`), excluding new
  fork-only paths, and fails unless each modified upstream source file contains the comment
  `Modified by Ask Gina:` and appears in `FORK.md`.
- `fork:.github/workflows/fork.yml`: new jobs `fork-notice` (every push) and `upstream-rebase`
  (nightly and manual): fetch `MatiSolina/busy` `main`, rebase the fork branch onto it in the
  runner's checkout, then run upstream's checks (`pnpm check`, `pnpm typecheck`, `pnpm test --
  --maxWorkers=2`). It never pushes. A failure is the signal to rebase by hand.
- `fork:UPSTREAM_BASE`: one line, the upstream commit the fork is based on.

Acceptance:

- `fork-notice` passes on the first commit (no upstream file modified yet) and fails in its own
  test when a fixture modifies an upstream file without the notice.
- `upstream-rebase` passes against `3dd91e1`.

### Milestone 2: platform seams in the Hub, Vercel behavior unchanged

Scope: every Vercel side effect the Hub uses goes through an interface with a Vercel
implementation that is the upstream code, moved. Nothing self-hosted yet. This keeps later
milestones to new files plus one-line selections.

Files and interfaces:

- `fork:apps/hub/lib/platform/index.ts`: `platform(): "vercel" | "selfhosted"` from
  `BUSY_PLATFORM` (default `vercel`); refuses any other value with `EnvError`.
- `fork:apps/hub/lib/platform/deploy.ts`: `deployDeps(): DeployDeps` returns the upstream
  implementation (moved from `lib/bots/service.ts:122-143`) or, later, the runner one.
- `fork:apps/hub/lib/platform/object-store.ts`: `ObjectStore` (Interfaces section); Vercel Blob
  implementation moved from `lib/files.ts:97-299,429,461-480` and `lib/library-objects.ts:146,
  380,459`.
- `fork:apps/hub/lib/platform/bot-identity.ts`: `BotIdentityVerifier`; Vercel OIDC
  implementation is the current `lib/bot-auth.ts` body.
- `fork:apps/hub/lib/platform/computers.ts`: `ComputerControl` for the Hub's Live and keep-on
  paths; Vercel implementation moved from `lib/live.ts` (`Sandbox.get`, `runCommand`, `domain`,
  `extendTimeout`, `stop`).
- `fork:apps/hub/lib/platform/schedules.ts`: `schedulesClient(): SchedulesClient`.
- Edited upstream files (selection points only): `lib/bots/service.ts`, `lib/bot-auth.ts`,
  `lib/files.ts`, `lib/library-objects.ts`, `lib/live.ts`, `lib/keep-on.ts`,
  `lib/routines/schedule.ts`, `lib/routines/outbox.ts`, `lib/chat/store.ts` (`botCall` URL from
  `BOT_URL_TEMPLATE`, default `https://{slug}.${BOTS_DOMAIN}`).
- `fork:apps/hub/platform-selection.test.ts`: new.

Acceptance:

- Upstream's Hub suite passes unchanged: `pnpm --filter hub test`.
- `platform-selection.test.ts`: with `BUSY_PLATFORM` unset every selector returns the Vercel
  implementation; with `selfhosted` and no self-hosted implementation registered yet each throws
  `EnvError` naming the missing setting.

### Milestone 3: OpenAI-compatible model connection

Scope: a fifth AI connection, "OpenAI-compatible endpoint", usable on both platforms. Needed
before any self-hosted bot can answer.

Files and interfaces:

- `fork:apps/hub/lib/ai/openai-compatible.ts`: new. Stores `baseUrl`, `apiKey` (sealed with the
  Hub's existing `lib/mcp/crypto.ts`), `modelId`, `contextWindowTokens`; lists models from
  `GET {baseUrl}/models` when the endpoint offers it.
- `fork:apps/hub/drizzle/0037_openai_compatible.sql` and `fork:apps/hub/lib/db/schema.ts`: one row
  in `app_ai_settings` gains the connection kind `openai-compatible`; credentials go in a new
  sealed table `ai_endpoint_connections`.
- `fork:apps/hub/app/api/bot/ai/chat/completions/route.ts`: new proxy, like the subscription
  proxy at `/api/bot/ai`, authenticated with `botFromRequest`; forwards to the endpoint with the
  Hub-held key; streams the answer.
- `fork:apps/hub/lib/ai/catalog.ts`, `components/account-ai-connection.tsx`,
  `lib/bots/models.ts`, `lib/bots/creation.ts` (skip the Gateway decision for this kind; the
  fallback at `creation.ts:77` already picks the first catalog model), `lib/bots/deploy.ts`
  (billing `openai-compatible` adds no Gateway key).
- `fork:templates/bot/agent/agent.ts`: when `config.billing === "openai-compatible"`, the dynamic
  model returns `createOpenAICompatible({ baseURL: ${HUB_URL}/api/bot/ai, ... }).chatModel(id)`
  with `modelContextWindowTokens` from `config.json`.
- `fork:templates/bot/package.json`: add `@ai-sdk/openai-compatible` at the version the eve
  example uses (3.0.92).

Acceptance:

- `fork:apps/hub/openai-compatible-route.test.ts`: against a stub endpoint, the proxy forwards
  the body unchanged, adds the key, refuses a request without a bot credential (401), and never
  returns the key.
- `fork:templates/bot/agent/agent.openai-compatible.test.ts`: the dynamic model resolves to the
  compatible provider and never to a Gateway model string.

### Milestone 4: bot runner, bot identity, bots on the encrypting World

Scope: self-hosted bots. The runner builds and runs one container per bot; bots authenticate to
the Hub with a per-bot token; each bot stores its eve state in its own database on
`@askgina/os-world/target`. Depends on Milestone 0 and D2, D11, D12.

Files and interfaces:

- `fork:apps/runner/`: new Node 24 service. `src/main.ts` (HTTP server on the internal
  `busy-control` network), `src/docker.ts` (Docker Engine API over the unix socket with
  `undici`, no CLI), `src/bots.ts`, `src/builds.ts`, `src/secrets.ts` (keyrings and tokens in a
  volume only the runner mounts), `src/postgres.ts` (creates `bot_<slug>` database and role,
  runs the World's `bootstrap`). API in the Interfaces section. Auth: `RUNNER_TOKEN_FILE`
  (Hub only).
- `fork:images/bot-builder/Dockerfile`: new. Node 24 with `templates/bot` and its installed
  dependencies plus `@askgina/os-world`; entrypoint writes `agent/config.json` from stdin and runs
  `eve build`. The runtime image copies `.output` onto the same base and runs `eve start`.
- `fork:apps/hub/lib/platform/runner-deploy.ts`: `DeployDeps` against the runner.
  `ensureProject` → `PUT /v1/bots/{slug}`; `upsertProjectEnv`/`removeProjectEnv` → runner env;
  `addProjectDomain`/`aliasDeployment` → no-ops; `createDeployment` → `POST /v1/bots/{slug}/builds`;
  `getDeploymentState` → `GET /v1/builds/{id}` with Vercel's state names so
  `lib/bots/progress.ts` and the promotion protocol (`deploy.ts:180-207`) stay unchanged.
- `fork:apps/hub/lib/platform/bot-token.ts`: `BotIdentityVerifier` for `selfhosted`. Token format
  `busybot_<slug>_<43 base64url chars>`; the Hub stores `sha256(token)` in `bots.hub_token_hash`
  (migration `fork:apps/hub/drizzle/0038_bot_token.sql`) and compares in constant time. A new
  token is minted on every deploy and the old one stops working once the new deployment is
  promoted.
- `fork:templates/bot/agent/lib/credential.ts`: new. `botCredential(): Promise<string>` reads
  `BUSY_BOT_TOKEN_FILE` when set, else returns `getVercelOidcToken()`. Edited to use it:
  `fork:templates/bot/agent/lib/hub.ts:8`, `lib/fireside.ts:86`, `lib/subscription-model.ts:441`,
  `connections/marketplace.ts` (token broker call).
- `fork:templates/bot/agent/agent.ts:26-29`: `experimental.workflow.world` set from
  `BUSY_WORKFLOW_WORLD` when present, so the Vercel build is unchanged.
- `fork:templates/bot/agent/channels/eve.ts`: add `onMessage: (ctx) => ({ auth:
  defaultEveAuth(ctx), title: "Bot session" })` so the first message never becomes `$eve.title`.
- `fork:templates/bot/world-readable-keys.json`: the readable attribute keys for the pinned eve:
  `$eve.type`, `$eve.version`, `$eve.session`, `$eve.root`, `$eve.parent`, `$eve.parent_call`,
  `$eve.parent_turn`, `$eve.subagent`, `$eve.trigger`, `$eve.prewarm`; and a `withheld` list
  with a reason per key (`$eve.title`, `$eve.invocation_token`, `$eve.invocation_owner`,
  `$eve.trace_id`, `$eve.channel_request_id`, `$eve.schedule`, `$eve.is_trace_content_visible`,
  `$eve.is_otel_trace_enabled`, `$eve.model`, `$eve.input_tokens`, `$eve.output_tokens`,
  `$eve.cache_read_tokens`, `$eve.cache_write_tokens`, `$eve.cost_usd`, `$eve.tool_count`). The
  runner passes the readable list as `WORLD_READABLE_ATTRIBUTE_KEYS`. Whether eve 0.91.0 needs any
  key beyond rc.17's readable list (`examples/eve-agent/compose.yaml:77`) is settled by the
  session round trip in this milestone's acceptance.
- `fork:templates/bot/world-readable-keys.test.ts`: new. Scans the installed eve `dist` for
  `$eve.` attribute literals and fails if any key is in neither list.
- `fork:deploy/compose.selfhosted.yaml`: Hub, runner, `busy-postgres`, Caddy, DNS sinkhole
  (CoreDNS with query logging), stub model. Networks: `busy-edge`, `busy-control` (internal),
  `busy-bots` (internal), `busy-egress`. Bot containers join `busy-bots` and `busy-egress`.
- `fork:e2e/selfhosted/bot.spec.ts`: new.

Acceptance (CI job `selfhosted-stack` in `fork:.github/workflows/fork.yml`):

- `bot.spec.ts` creates a bot through the Hub API with the stub model, sends a message
  containing a unique marker, and receives the stub's reply in the chat stream.
- The same spec scans every table of the bot's database (the scanner from
  `packages/testkit` in askgina/os, ported as `fork:e2e/selfhosted/scan.ts`) for the marker as
  UTF-8, hex and base64: zero hits. A control run with `BUSY_WORKFLOW_WORLD` unset must find it,
  or the test fails.
- A request to the Hub's bot routes with another bot's token, a revoked token, or no token
  returns 401.
- `world-readable-keys.test.ts` passes.

### Milestone 5: computers on gVisor with per-bot volumes

Scope: replace Sandbox and Drive. Depends on D5.

Files and interfaces:

- `fork:apps/runner/src/computers.ts`: the computer broker (API in the Interfaces section).
  Starts one container per eve session from `BOT_BASE_IMAGE` with `HostConfig.Runtime` `runsc`,
  read-only root filesystem except `/workspace`, `/tmp` and mounts, memory and CPU limits, no
  capabilities beyond what Xvfb and Chrome need. Each computer gets its own network
  `busy-computer-<name>` shared only with the broker, with outbound NAT; `deny-all` uses an
  `internal: true` network instead. The broker refuses to start a computer when `runsc` is not
  among `docker info` runtimes, unless `COMPUTER_RUNTIME=runc` is set (development only; logged
  on every start).
- Volumes: `busy-drive-<slug>` mounted read-write at `/data`; a consultation-style read-only
  copy is `POST /v1/volumes/{name}/snapshot` (a copy into a new volume, mounted `ro`).
- Live view: the broker proxies the computer's port 6080 at `/live/{name}` behind a token from
  `POST /v1/computers/{name}/live-token` (single use, 60 seconds); Caddy routes `/live/*` from the
  Hub's origin to the broker.
- `fork:templates/bot/agent/lib/computer-provider.ts`: new. `defineSandboxProvider({ name:
  "busy-computer", environment })` from `eve/sandbox/provider`, implementing `prepare`, `start`,
  `resume`, `onSessionEnd` and the connection (`exec`, `readFile`, `writeFiles`, `stop`) against
  the broker with a per-bot computer token (`BUSY_COMPUTER_TOKEN_FILE`, scoped by the broker to
  that bot's slug and volumes).
- `fork:templates/bot/agent/sandbox.ts`: choose the provider by `BUSY_PLATFORM`; the self-hosted
  branch calls the provider with the same mounts and network policy as the Vercel branch.
- `fork:apps/hub/lib/platform/broker-computers.ts`: `ComputerControl` against the broker for
  `lib/live.ts` and `lib/keep-on.ts`.

Acceptance (job `selfhosted-stack`, step "computers"):

- `fork:e2e/selfhosted/computer.spec.ts`: the stub model calls a tool that writes a marker to
  `/data/marker.txt`; a second session of the same bot reads it back; another bot cannot read it.
- `docker inspect -f '{{.HostConfig.Runtime}}'` on the computer prints `runsc`.
- From inside the computer, connections to `agent-gateway`, `hub`, `runner`'s control port,
  `busy-postgres` and the bot container fail; a fetch of the stub web server on the egress network
  succeeds.
- `fork:apps/runner/test/computers.test.ts`: start refuses when `runsc` is missing and
  `COMPUTER_RUNTIME` is unset.
- The live view loads through `/live/{name}` with a fresh token and returns 403 on a reused or
  expired one.

### Milestone 6: Hub on the encrypting World; storage, schedules, queues, observability

Scope: the rest of the Hub's Vercel ties.

Files and interfaces:

- Hub World: `fork:apps/hub/next.config.ts` adds `serverExternalPackages` for `pg`,
  `graphile-worker`, `@workflow/world-postgres` and `@askgina/os-world` when
  `BUSY_PLATFORM=selfhosted` (finding 1 of `specs/research/nextjs-as-control-plane-host.md`). The
  Hub container sets `WORKFLOW_TARGET_WORLD=@askgina/os-world/target` at build and run time,
  `WORKFLOW_POSTGRES_URL` (database `hub_workflow`), `WORLD_KEYRING_FILE`, and runs the World's
  `bootstrap` before `next start`. Caddy refuses `/.well-known/workflow/*` from the edge.
- `fork:apps/hub/lib/platform/s3-object-store.ts`: `ObjectStore` on any S3-compatible service
  (`@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post`): presigned POST with
  `content-length-range` and an exact `Content-Type` for uploads; presigned GET/HEAD for reads.
  `fork:apps/hub/components/composer.tsx:69` posts a form when the upload descriptor says `POST`.
- `fork:apps/hub/lib/platform/pg-schedules.ts`: `SchedulesClient` on table `platform_schedules`
  (migration `0039_platform_schedules.sql`: id, cron, time zone, payload, state, next_run_at).
- `fork:apps/ticker/`: new small service. Every minute it calls the 10 routes of
  `fork:apps/hub/vercel.json:24-75` on their cron with `Authorization: Bearer $CRON_SECRET`, and
  calls `POST /api/platform/schedules/tick`, which claims due rows with `FOR UPDATE SKIP LOCKED`,
  advances `next_run_at`, and hands each payload to the same function the `routine-runs` queue
  route calls today (`fork:app/api/queues/routine-runs/route.ts` is split so the handler body is a
  plain function).
- Observability: `fork:apps/hub/app/layout.tsx` renders Speed Insights only on `vercel`;
  `fork:app/api/rum/route.ts` returns 204 on `selfhosted`; `fork:instrumentation.ts` registers
  plain OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the deploy error message names
  the runner's build log instead of "Check the build in Vercel." (`lib/bots/deploy.ts:149`).
- `fork:deploy/compose.selfhosted.yaml` adds Garage (S3) and the ticker.

Acceptance:

- `fork:e2e/selfhosted/files.spec.ts`: a 1 KiB upload succeeds; an upload larger than the
  declared size is refused by the object store; a download through the Hub returns the same
  bytes.
- `fork:e2e/selfhosted/routines.spec.ts`: a routine set to every minute runs within two ticks
  and once only per occurrence.
- `fork:apps/hub/pg-schedules.test.ts` (PGlite, as upstream's database tests use): create,
  update, enable, disable, delete and due-claim semantics.
- The plaintext scan of `hub_workflow` finds no marker from the routine's prompt.
- DNS gate: the CoreDNS query log for the whole `selfhosted-stack` job contains no name ending in
  `vercel.com`, `vercel.sh`, `vercel.app` or `vercel-storage.com`
  (`fork:e2e/selfhosted/dns-gate.ts`, run as the job's last step).

### Milestone 7: the askgina/os wallet connection

Scope: a bot proposes through the gateway and a passkey approves. Depends on Milestone 0 and the
CI deploy key.

Files and interfaces:

- `fork:templates/bot/agent/connections/askgina-os.ts`: new. `defineDynamic` returning `null`
  unless `ASKGINA_OS_MCP_URL` is set; otherwise `defineMcpClientConnection({ url, description,
  auth: bearer token read from ASKGINA_OS_AGENT_TOKEN_FILE, approval: never(), tools: { allow:
  [the seven names] } })`. A comment states why `never()` (D3). Exact option names are checked
  against `eve@0.91.0:dist/src/public/definitions/connections/mcp.d.ts` when written.
- `fork:templates/bot/agent/skills/wallet/SKILL.md`: new. Call `whoami` first; propose with a
  memo; give the person the `approvalUrl` as a plain link; wait with `get_intent` and
  `waitSeconds`; report a payment only at `confirmed`; never ask "OK?" with `ask_user` in place of
  the passkey; never treat a chat answer as approval.
- `fork:apps/hub/drizzle/0040_os_agent_token.sql`, `fork:apps/hub/lib/db/schema.ts`:
  `bots.os_agent_token_sealed` (sealed with `lib/mcp/crypto.ts`). `fork:apps/hub/app/api/bots/
  [slug]/route.ts` and bot settings UI accept the token write-only; reads return only
  `{ configured: true, prefix: "osa_xxxx" }`.
- Runner: when a bot has a token, write it to the bot's secret volume, set
  `ASKGINA_OS_MCP_URL=http://agent-gateway/mcp`, and attach the bot container to the external
  network named by `ASKGINA_OS_AGENTS_NETWORK` (default `os_agents`, the network Compose creates
  for the askgina/os project `os`). Computers never join it.
- `fork:e2e/wallet/wallet.spec.ts`: new. Uses the person driver from askgina/os
  (`e2e/src/person.ts`, Chromium virtual authenticator) from a checkout of askgina/os at a pinned
  commit.

Acceptance (CI job `wallet`, checks out askgina/os with `ASKGINA_OS_READ_KEY`, brings up its
stack with the `dev` profile and the fork's stack):

- The stub model calls `propose_transfer` for 0.001 ETH to a fixed address. The intent appears
  in askgina/os with status `pending_approval`. The Busy chat projection contains no approval
  interaction for that call (`fork:apps/hub/lib/chat/items.ts` output checked in the spec).
- The spec posts `POST /api/bots/{slug}/answer` with a made-up `interactionId` and
  `optionId: "approve"`; the Hub returns an error; the askgina/os intent is still
  `pending_approval` five seconds later.
- The person driver approves in the inbox; `get_intent` reaches `confirmed`; Anvil shows the
  recipient's balance increased by exactly 0.001 ETH; the bot's last message contains the
  transaction hash.
- A second run with the computer: from inside the computer, `curl http://agent-gateway/mcp`
  fails to resolve or connect.

### Milestone 8: switched-off features, documentation, threat model

Scope: say plainly what does not work, and record the new trust boundaries in both repositories.

Files and interfaces:

- `fork:apps/hub/lib/platform/features.ts`: `BUSY_DISABLED_FEATURES` (default on `selfhosted`:
  `code-tasks,firesides,consultations`). Disabled routes return 404 with
  `{ "error": "feature_disabled" }`; the UI hides their entry points; `/api/bot/directory`
  returns no peers, so eve peer subagents resolve to none (`templates/bot/agent/lib/peers.ts:84-104`).
- `fork:FORK.md`, `fork:README.md`, `fork:docs/selfhosted.md` (new): install, networks, the
  plaintext Hub tables (D7), the runner host rule (D6), upgrade and rebase procedure.
- `docs/threat-model.md` (askgina/os): a section "A Busy fork as the agent runtime" with the
  content of the Threat Model section below; `docs/architecture.md`: one paragraph and the
  `agents` network rule for third-party runtimes.
- `examples/README.md` or `README.md` (askgina/os): link to the fork.

Acceptance:

- `fork:apps/hub/features.test.ts`: every disabled route returns 404 `feature_disabled`.
- `fork-notice` passes with every modified upstream file listed in `FORK.md`.
- askgina/os `check` job (Biome) passes on the documentation change.

## Interfaces and Dependencies

Local interfaces (fork):

- `ObjectStore` (`fork:apps/hub/lib/platform/object-store.ts`):
  `put(pathname, body: ReadableStream | Uint8Array, { contentType }): Promise<void>`;
  `del(pathnames: string | string[]): Promise<void>`;
  `list({ prefix, cursor? }): Promise<{ objects: { pathname; size; uploadedAt }[]; cursor? }>`;
  `uploadTarget(pathname, { maxBytes, contentType, validUntil }): Promise<{ method: "PUT" | "POST";
  url: string; fields?: Record<string, string> }>`;
  `readUrl(pathname, operation: "get" | "head", validUntil): Promise<string>`.
  Failures throw; callers already treat Blob failures as retryable (`fork:docs/architecture.md:277-279`).
- `BotIdentityVerifier` (`fork:apps/hub/lib/platform/bot-identity.ts`):
  `verify(req: Request): Promise<{ slug: string } | Response>`, the signature of today's
  `botFromRequest`.
- `ComputerControl` (`fork:apps/hub/lib/platform/computers.ts`): `get(bot, name)`,
  `run(bot, name, { cmd, args, signal })`, `liveUrl(bot, name)`, `extendTimeout(bot, name, ms)`,
  `stop(bot, name)`.
- `DeployDeps` (`fork:apps/hub/lib/bots/deploy.ts:13-39`): unchanged.
- `SchedulesClient` (`@vercel/schedules` 0.0.3 type): `create`, `update`, `get`, `delete`,
  `enable`, `disable`, as used in `fork:apps/hub/lib/routines/schedule.ts:50-106`.
- Runner HTTP API (`fork:apps/runner`, JSON, `Authorization: Bearer <RUNNER_TOKEN>` from the Hub;
  computer routes also accept a bot's computer token, scoped to its slug):
  - `PUT /v1/bots/{slug}` `{ env, secrets }` → `{ id }` (idempotent: database, role, keyring,
    volume, secret files).
  - `POST /v1/bots/{slug}/builds` `{ files: DeployFile[] }` → `{ id, url }`.
  - `GET /v1/builds/{id}` → `{ state: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED",
    lastLine? }`.
  - `POST /v1/bots/{slug}/promote` `{ buildId }` → `{ state: "succeeded" | "failed" }`.
  - `DELETE /v1/bots/{slug}` → 204 after containers, volume, keyring, then database are gone.
  - `POST /v1/computers` `{ sessionId, botSlug, image, mounts, egress: "allow-all" | "deny-all",
    timeoutMs }` → `{ name }` (create-if-absent by `sessionId`).
  - `GET /v1/computers/{name}`; `POST /v1/computers/{name}/exec` (streamed stdout, stderr, exit
    code); `GET` and `PUT /v1/computers/{name}/files?path=`; `POST /v1/computers/{name}/stop`;
    `DELETE /v1/computers/{name}`; `POST /v1/computers/{name}/live-token` → `{ url, expiresAt }`;
    `POST /v1/volumes/{name}/snapshot` → `{ name }`.

Local interfaces (askgina/os, unchanged in behavior):

- MCP tools: `whoami`, `get_balances`, `propose_transfer`, `propose_contract_call`, `get_intent`,
  `list_intents`, `cancel_intent` (`apps/server/src/mcp/gateway.ts:65-73`;
  `specs/agent-workspaces-v0.1.md:396-406`). Only annotations are added.
- `@askgina/os-world/target`: configured by `WORKFLOW_POSTGRES_URL`, `WORLD_KEYRING_FILE`,
  `WORLD_READABLE_ATTRIBUTE_KEYS` (`packages/world/README.md:41-60`).

External dependencies:

- `eve` 0.91.0 (pinned by upstream; D9): `experimental.workflow.world` accepts a package
  specifier (`dist/src/internal/workflow/world-target.js`); `eve/sandbox/provider`
  (`docs/sandbox/custom-providers.mdx`); `eveChannel({ onMessage })` returns `{ auth, title }`
  (`dist/src/eve-channel/types.d.ts:61-85`); `defineMcpClientConnection` options `auth`, `headers`,
  `approval`, `tools` (`dist/src/public/definitions/connections/mcp.d.ts:14-112`).
- `workflow` 5.2.3 (Hub, upstream pin) with `@askgina/os-world` on `@workflow/world-postgres`
  5.2.0: compatibility proven only by Milestones 4 and 6.
- gVisor `runsc` (current release from gvisor.dev's apt repository), installed with
  `runsc install` and a Docker restart ([gVisor Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/)).
- Garage or any S3-compatible store; `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post`
  (versions pinned when added).
- `@ai-sdk/openai-compatible` 3.0.92.
- CoreDNS (DNS sinkhole for the gate), Caddy 2.11.9 as in askgina/os.

## Threat Model

What changes: a second agent platform (the Busy Hub, the runner, bot containers and computer
containers) sits on the agent side of the askgina/os gateway. No Busy component joins the
`control`, `signing` or `chain` networks.

A compromised askgina/os control plane (the server), after this change:

- **Can:** everything v0.1 lists (`docs/threat-model.md:96-105`): read sealed content, show a
  person a misleading approval card, pause workspaces. New: tell Busy bots false intent statuses
  through `get_intent` (for example "confirmed" for a payment that never happened), so bots
  report false outcomes in the Busy chat.
- **Cannot:** produce a passkey assertion, exceed the signer's caps, reuse an approval, or change
  policy or approvers without passkeys. The Busy fork gives it no new path to the signer and no
  new authority: Busy holds no askgina/os credential except agent tokens, which only propose.

A compromised Busy Hub:

- **Can:** read every Busy conversation (plaintext tables, D7); unseal and use every bot's agent
  token, so propose as any bot; deploy any code into any bot; answer any Busy card; show a person
  a fake "approved" or "paid" message in the Busy chat.
- **Cannot:** approve or sign. Its only route to askgina/os is the MCP gateway with agent tokens;
  the signer accepts only passkey assertions it verifies against its own approver registry. It
  cannot reach the askgina/os server, Postgres or signer: it is not on their networks.

A compromised bot container: same as v0.1's "malicious or prompt-injected agent" and "stolen
agent token" positions for its own agent, plus read access to its own World database and keyring.

A compromised computer container (untrusted web or shell content): reaches the internet and the
broker's API for its own computer only. It holds no agent token and cannot reach the gateway, the
Hub's internal routes, Postgres or other computers. Escaping gVisor reaches the runner host.

The runner: holds a Docker socket, so it is root on its host. If that host is the signer's host,
this is the v0.1 "signer host" position (`docs/threat-model.md:139-143`), which is why D6 puts it
elsewhere in production.

Invariant check: the signer still decides whether a person approved and signs only what was
approved. Busy's approval cards are switched off for the seven tools and no Busy component can
create an approval.

## Concrete Steps

From the askgina/os repository root, for Milestone 0 (locally only single files; CI builds):

    bunx vitest run apps/server/test/execution/mcp.test.ts
    bunx tsc -p packages/world/tsconfig.build.json --noEmit

Expected evidence:

    ✓ apps/server/test/execution/mcp.test.ts > tools/list carries annotations

From the fork repository root (CI runs the stack jobs):

    pnpm install --frozen-lockfile
    node scripts/fork-notice.mjs
    pnpm --filter hub test -- platform-selection
    docker compose -f deploy/compose.selfhosted.yaml up --build -d --wait
    pnpm --filter e2e-selfhosted test
    node e2e/selfhosted/dns-gate.ts

Expected evidence:

    fork-notice: 0 modified upstream files without a notice
    dns-gate: 0 queries for vercel names
    bot.spec.ts > bot database holds no marker (0 hits; control 1+ hits)

## Validation and Acceptance

Automated validation:

- askgina/os `ci.yml`: `check`, `test` (with the annotations case), `packages`, `stack` jobs green.
- Fork `fork.yml`: `fork-notice`, `upstream-rebase` (nightly), `selfhosted-stack` (Milestones 4
  to 6, including the DNS gate and both plaintext scans), `wallet` (Milestone 7) green; upstream's
  own `ultracite.yml` checks green.

Manual or runtime validation:

- Start: `docker compose -f deploy/compose.selfhosted.yaml up -d` from the fork root, with an
  askgina/os stack running from its root.
- Sign in to the Hub, create a bot with an OpenAI-compatible endpoint, paste an agent token, ask
  it to pay 0.001 test ETH, open the link, approve with a phone passkey, see the confirmation in
  both the inbox and the Busy chat.
- Open the bot's computer in Live view and see the desktop.

Regression checks:

- Upstream's Hub and template suites pass with `BUSY_PLATFORM` unset (the Vercel path is not
  broken by the seams).
- askgina/os release gates (`e2e/test/release-gates.spec.ts`) unchanged and green.

## Idempotence and Recovery

- Runner `PUT /v1/bots/{slug}` and `POST /v1/computers` are create-if-absent; repeating them is
  safe. Builds are new artifacts; a failed build leaves the promoted one running.
- Deleting a bot deletes its keyring first. If deletion stops halfway, the bot's payloads are
  already unreadable and `DELETE` can be repeated.
- Migrations `0037` to `0040` are additive. Backout: set `BUSY_PLATFORM=vercel` or stop the fork's
  stack; askgina/os needs no backout beyond reverting the annotations.
- Upstream rebase: the `upstream-rebase` job never pushes. A maintainer rebases locally, resolves
  conflicts in the files listed in `FORK.md`, and pushes after the stack jobs pass.

## Rollout and Operations

- Feature flags/config/env vars: `BUSY_PLATFORM`, `BOT_URL_TEMPLATE`, `RUNNER_TOKEN_FILE`,
  `BUSY_BOT_TOKEN_FILE`, `BUSY_COMPUTER_TOKEN_FILE`, `BUSY_WORKFLOW_WORLD`, `COMPUTER_RUNTIME`,
  `BUSY_DISABLED_FEATURES`, `ASKGINA_OS_MCP_URL`, `ASKGINA_OS_AGENT_TOKEN_FILE`,
  `ASKGINA_OS_AGENTS_NETWORK`, `OTEL_EXPORTER_OTLP_ENDPOINT`, plus the World variables per bot
  and for the Hub.
- Monitoring: runner build failures and stuck promotions (the Hub's `/api/cron/deploys`
  reconciler keeps working); ticker failures; key-provider failures as in
  `packages/world/README.md:97-103`.
- Upgrades: follow upstream; re-derive `world-readable-keys.json` whenever upstream bumps eve.
  An eve version change strands in-flight sessions on self-hosted Worlds
  (`examples/eve-agent/README.md:75-77`); proposals live in askgina/os and survive.

## Risks and Open Questions

- Risk: upstream rewrites the deploy flow, Live or the template in one "Sync" batch.
  Mitigation: changes live in new files; nightly `upstream-rebase` shows breakage the next day.
- Risk: eve 0.91.0's compiled Workflow core and `@askgina/os-world` disagree.
  Mitigation: Milestone 4's ciphertext test and session round trip; if they disagree, pin the
  World's `@workflow/world-postgres` to what eve compiles in, or wait for upstream's eve bump.
- Risk: Chrome, Xvfb, x11vnc or LibreOffice in the bot base image misbehave under gVisor.
  Mitigation: Milestone 5's computer spec drives the desktop; fallback is D5's microVM option on a
  KVM host.
- Risk: the Docker socket on the runner host. Mitigation: D6; a rootless Docker daemon for the
  runner is an open question.
- Risk: Hub plaintext (D7) is misread as covered by the World. Mitigation: the README states it
  and the threat model lists it.
- Risk: trademark. Mitigation: D10.
- Open question: whether upstream would accept the provider-neutral seams of Milestones 2 and 3.
  Contacting upstream is the owner's call.

## Artifacts and Notes

    Research: specs/research/busy-fork.md (findings F1 to F10)
    Upstream base: MatiSolina/busy 3dd91e16c0708bd02066377ba3e45aa06f4813c0 (v0.5.0)
    eve pinned by upstream: 0.91.0 (published 2026-10-30)
    Estimated fork size [INFERENCE]: 4,000 to 5,000 new or changed lines, about 40 upstream files

## Revision Notes

- 2026-11-14: First draft from the research for ticket #26. Written for the recommended option of
  every open owner decision.
