# Run a fork of Busy self-hosted next to askgina/os, with wallet proposals through the MCP gateway

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-15
- Links: [Ticket #26](https://github.com/askgina/os/issues/26) | [Map #18](https://github.com/askgina/os/issues/18) | [Research](./research/busy-fork.md) | [eve research](./research/eve-without-vercel-services.md) | Built on main since the draft: [trusted display](./trusted-display.md), [mandates](./approval-mandates.md), [notifications](./approval-notifications.md) | PR: none

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
proposes the payment through the askgina/os MCP gateway and sends the person the approval link
(`approvalUrl`, the request's page in the askgina/os web app). The person opens it as a page of
its own, signs in, follows its link to the signer's confirmation page (`APPROVE_ORIGIN`), reads
the payment there and approves it with a passkey; the signer checks that passkey itself, and the
bot reports the transaction once it is confirmed. If a mandate a person granted that agent in
advance covers the payment, the signer sends it with no person asked, and the bot says which
mandate covered it instead of sending a link. Nothing a person clicks in the Busy chat can approve
a payment, and neither askgina/os page can be shown inside the Busy chat: both refuse to be
framed.

Non-goals:

- No change to the signer, the approval protocol, the envelope formats, the confirmation page or
  the seven MCP tools' behavior. The only askgina/os code change is packaging two packages and
  adding MCP tool annotations.
- No Busy-side notifications of waiting approvals. People learn about them from askgina/os's own
  channels (its signed webhook and sidecars, Web Push), which this plan does not change (D14).
- No granting, revoking or showing of mandates in the Busy Hub. Mandates are granted and revoked
  in askgina/os only; a bot reads its own live ones through `whoami`.
- Code tasks, firesides (second-opinion chats), bot-to-bot consultations and the macOS Desktop
  app stay switched off in this fork. AI Gateway and Vercel Token Pass billing are not offered.
- Sealing the Busy Hub's own message, event and memory tables is not in this plan (see Decision
  Log, D7).
- Hosted or multi-tenant operation.

Success means:

- A CI job brings up the fork's stack and the askgina/os stack together, creates a bot through
  the Hub API, has it propose a 0.001 ETH transfer, approves it on the signer's confirmation page
  with the askgina/os person driver (`e2e/src/person.ts`, `Person.confirm`), and sees `confirmed`
  on Anvil and in the bot's reply.
- In the same job, after a person grants the bot's agent a mandate on the confirmation page, a
  second transfer inside it comes back `authorizedBy: "mandate"` with no approval link, reaches
  `confirmed` with no person asked, and the bot's reply names the mandate.
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
- [x] (2026-11-15) Re-checked against main (`98cc6a1`): trusted display, mandates and
      notifications are built; no milestone of this plan was delivered by them; Milestone 7, the
      threat model and the gates now follow the confirmation page and mandates; new open decisions
      D13 and D14.
- [x] (2026-11-15) Owner decisions D1, D2, D5, D6, D7, D8, D10, D13 and D14 taken by the lead
      under Eric's delegation (Decision Log), each as the recommended option, with D1 and D10
      narrowed to what needs no third-party contact and makes nothing public. Still Eric's:
      making the fork repository public, the fork's product name, and any contact with the
      upstream Busy project.
- [x] (2026-11-15) Milestone 0: askgina/os packages and tool annotations. `eac3a6b`, green in
      CI run 43723043467 (new job `packages`: build, pack, smoke). No `world-v*` tag pushed yet,
      so nothing is published.
- [x] (2026-11-15) Milestone 1 prerequisite: private mirror `askgina/busy` created with upstream
      history at `3dd91e1`; GitHub Actions off until Milestone 1's workflows land.
- [x] (2026-11-15) Milestone 1: fork repository, attribution and upstream gate. `askgina/busy`
      `e919310`: `Ultracite` green (run 43723302469, Desktop job off), `fork-notice` green on
      push, `upstream-rebase` green against `3dd91e1` (run 43723344720). The notice check compares
      the upstream base tree with the working tree, not `base...HEAD`.
- [x] (2026-11-15) Milestone 2: platform seams in the Hub, Vercel behavior unchanged.
      `askgina/busy` `aa587af`, `Ultracite` green (run 43725123381, full hub suite unchanged),
      `fork-notice` green (run 43725123368). `BUSY_PLATFORM` unset or `vercel` selects upstream's
      code; `selfhosted` refuses each seam by name until its milestone adds an implementation.
      As built: the deploy seam is `deployPlatform()` and also covers deletion and promotion;
      computers are a bot-scoped handle; `SchedulesClient` is structural and includes `list`.
- [x] (2026-11-15) Milestone 3: OpenAI-compatible model connection. `askgina/busy` `444a46a`,
      `Ultracite` green (run 43727555327), `fork-notice` green (run 43727555315). As built:
      `@ai-sdk/openai-compatible` 3.0.81 (3.0.92 needs a newer `ai` than the fork's pin, D9); a
      bot stores `openai-compatible/<id>`; the proxy refuses a model other than the bot's own;
      the key is sealed bound to the base URL; fast replies call the endpoint directly.
      Unproven: a real endpoint end to end (Milestone 4's stub-model stack).
- [x] (2026-11-15) `@askgina/os-world` and `@askgina/os-keys` 0.1.0 published privately to
      GitHub Packages from tag `world-v0.1.0` (askgina/os run 43727574831).
- [ ] Milestone 4: bot runner, bot identity, bots on the encrypting World. Built (2026-11-15),
      `askgina/busy` `c07f727` (`Ultracite` run 43731297018, with the runner's own test job).
      First real stack run green: `Fork` run 43732818581 at `0023585`, job `selfhosted-stack`:
      the three images build, the stack starts, a bot is created through the Hub, built and
      promoted by the runner on `@askgina/os-world/target`, and answers through the stub model.
      As built, against the plan: the World and key packages are vendored as digest-checked
      tarballs (`vendor/askgina/`), because the fork's CI has no token that reads private
      packages; token hashes live in a table `bot_hub_tokens` (one row per token, bound to its
      build, older ones revoked at promotion); the runner commits the finished builder
      container as the bot image and runs the World's `bootstrap` at promotion; the runner API
      gains `GET /v1/bots/{slug}`. Left for this box: the full gate (ciphertext scan with a
      plaintext control bot, session round trip, token rules, redeploy, delete and shred, DNS),
      written and pushed, CI pending.
- [ ] Milestone 5: computers on gVisor with per-bot volumes. Built (2026-11-15), CI pending:
      the runner's computer broker (`runsc` by default, refused when the runtime is absent),
      per-bot drives, a live-view proxy with single-use tokens, the Hub's `selfhosted`
      computers seam. No real-stack gate yet; a hosted CI runner has no gVisor.
- [ ] Milestone 6: Hub on the encrypting World; storage, schedules, queues, observability.
      Built (2026-11-15), CI pending: schedules on Postgres with a ticker service, an S3 object
      store on Garage with uploads by descriptor, bot deletion completing on the self-hosted
      platform, the Hub's own workflows on the vendored World, OTLP traces only when configured.
      As built: the tick route is `POST /api/cron/schedules/tick`; the ticker is a script in the
      hub image, not a new workspace. No real-stack gate for files and routines yet.
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
- Observation (2026-11-14, fixed since): when this plan was drafted the eve example had no route
  to an external model and pointed at a gateway port nothing listened on. Commit `5da19e5` fixed
  both, and a third mistake: the agent joins `internal`, `agents` and `egress`, `MCP_URL`
  defaults to `http://agent-gateway/mcp` (the gateway's port 80), and the external network
  defaults to `os_agents` (it was `askgina-os_agents`). That stack has still never been started, so
  "a bot on `agents` plus an egress network" is unproven by any running stack; Milestones 4 and 7
  are its first run.
  Evidence: `examples/eve-agent/compose.yaml:80,91,104-112`; `compose.yaml:188-200,245-246`;
  `deploy/Caddyfile.agents:9-18`.
- Observation (2026-11-15): approvals now happen only on the signer's confirmation page. The
  `approvalUrl` a proposal returns is the request's page on `PUBLIC_ORIGIN`; that page, for a
  signed-in person, links to `APPROVE_ORIGIN/a/<approvalId>#<token>`, where the passkey prompt
  runs. Both origins send `frame-ancestors 'none'` (the confirmation page also `X-Frame-Options:
  DENY`), and the signer refuses an assertion the browser marks as made in a frame. So no Busy
  chat, card or MCP App frame can host either page, and the bot never holds the confirmation link.
  Evidence: `apps/server/src/notify/content.ts:11-13`; `packages/api/src/dto.ts:617`
  (`confirmUrl`); `packages/api/src/csp.ts:22`; `apps/approve/src/app.ts:32,40,46`;
  `packages/protocol/src/webauthn/verify-authorization.ts:57-69`; `docs/threat-model.md:133-141`.
- Observation (2026-11-15): with mandates, a proposal can come back already approved, with
  `authorizedBy: "mandate"`, a `mandateId`, and `approvalUrl` and `expiresAt` null. A skill that
  always sends a link would send `null`.
  Evidence: `apps/server/src/execution/intents.ts:236-243,430-438`;
  `apps/server/src/mcp/gateway.ts:81,134-155`.
- Observation (2026-11-15): the World now refuses, rather than withholds, an unlisted attribute
  set by `setAttributes()` in a workflow body, and the SDK then fails the run. Whether eve 0.91.0
  sets any unlisted `$eve.` key from a workflow body is unconfirmed.
  Evidence: `packages/world/src/attributes.ts:43,77-80`; `packages/world/README.md:45-56`.
- Observation (2026-11-15): Milestone 0 is still needed: the seven tools still carry no MCP
  annotations, and both packages are still `private: true` with source-only exports and no build.
  Evidence: `apps/server/src/mcp/gateway.ts:168-389`; `packages/world/package.json`;
  `packages/keys/package.json`; `.github/workflows/ci.yml` (jobs `check`, `test`, `ui`, `stack`).
- Observation (2026-11-15): the signed webhook is one URL per install and its body carries ids,
  a kind, an expiry and a link only: no agent id and no intent id. A Busy Hub receiving it could
  not tell which bot an approval belongs to.
  Evidence: `compose.yaml:108`; `apps/server/src/notify/webhook.ts:19-42`.

## Decision Log

Owner decisions were taken on 2026-11-15 by the lead under Eric's delegation ("delegate to you on
decisions like a CTO"), each as the option this plan recommended. Where the recommended option
would have made a repository public or contacted the upstream project, the lead took the
narrower option that does neither; those calls, and the fork's product name, stay Eric's and are
marked **Eric's** below.

- Decision D1, owner, **taken 2026-11-15** by the lead under Eric's delegation, **done**: the
  fork lives in a separate **private mirror** repository, `askgina/busy`, created by pushing
  upstream history at `3dd91e1` (`MatiSolina/busy`), not with GitHub's fork button, with
  upstream kept as a read-only `upstream` remote. GitHub Actions is off in it until Milestone 1
  lands cheap workflows (no macOS desktop job; benchmark and performance jobs disabled). Eric's
  unrelated personal private copy `ericjuta/busy` is not used by this plan.
  Alternatives: a GitHub fork (public, because a fork of a public repository cannot be private,
  and listed in upstream's network); inside askgina/os under `vendor/busy`; upstream
  contributions only.
  Rationale: the recommended separate repository keeps upstream history for rebasing, keeps
  pnpm, keeps the Apache-2.0 code out of the MIT askgina/os tree; the private push form makes
  nothing public and contacts no one. **Eric's**: making the repository public, or turning it
  into a GitHub fork.
  Date/Author: 2026-11-14 / research agent; taken 2026-11-15 / lead
- Decision D2, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended:
  the fork consumes `@askgina/os-world` and `@askgina/os-keys` as
  built packages published privately to GitHub Packages from askgina/os tags. Alternatives: a git
  dependency on a pinned askgina/os commit; a vendored copy checked by digest. The packages stay
  private (GitHub Packages visibility tied to the private askgina/os repository).
  Rationale: both packages are `private: true` and ship TypeScript source today
  (`packages/world/package.json`); Next.js and eve both need a resolvable package name at runtime
  (`specs/research/nextjs-as-control-plane-host.md`, finding 1).
  Date/Author: 2026-11-14 / research agent
- Decision D3: the seven gateway tools carry eve approval `never()` in the fork. The askgina/os
  passkey approval on the signer's confirmation page, or a mandate a person granted there, is the
  only authorization.
  Rationale: Busy's card is a cookie-authenticated POST to the Hub that the signer cannot verify;
  a second prompt for the same payment teaches people to approve without reading (research F6).
  Since trusted display a Busy card could not approve even if wired to try: the signer accepts
  only assertions made on the confirmation page's origin, outside any frame
  (`docs/threat-model.md:133-141`).
  Date/Author: 2026-11-14 / research agent; re-checked 2026-11-15
- Decision D4: each bot holds its own askgina/os agent token and connects to the gateway
  directly over the askgina/os `agents` network. The Hub stores the token sealed and hands it to
  the runner, never to the browser or to the bot computer.
  Rationale: avoids changing Busy's MCP network policy and auth modes; one token per bot keeps
  the blast radius of one bot to one askgina/os agent.
  Date/Author: 2026-11-14 / research agent
- Decision D5, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended:
  bot computers run in containers under the gVisor runtime
  (`runsc`). Alternatives: Firecracker or Kata microVMs (need KVM: bare metal or nested
  virtualization); plain `runc` containers.
  Rationale: runs on the hosts askgina/os already targets without KVM; a user-space kernel between
  untrusted browser and shell work and the host kernel.
  Date/Author: 2026-11-14 / research agent
- Decision D6, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended:
  in production the runner (which holds a Docker socket) runs on a
  host or VM other than the signer's. On one machine it is allowed for development only.
  Rationale: a Docker socket is root on its host; on the signer's host that is the "signer host"
  attacker position (`docs/threat-model.md:239-243`; "One machine running everything gives no
  protection against that machine", `:564`).
  Date/Author: 2026-11-14 / research agent; citation re-checked 2026-11-15
- Decision D7, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended:
  the first fork accepts plaintext in the Busy Hub's own tables,
  keeps that database in its own Postgres that never joins askgina/os networks, and says so in
  its README. Alternatives: seal `messages.text`, `events.data` and `memories.content` and drop
  full-text history search; do not ship until sealed.
  Rationale: sealing breaks upstream's search (`lib/history-search.ts:167-183`) and touches the
  most-edited upstream files.
  Date/Author: 2026-11-14 / research agent
- Decision D8, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended:
  code tasks, firesides, consultations and Desktop are switched
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
- Decision D10, owner, **taken 2026-11-15** by the lead under Eric's delegation, as recommended
  (the conservative option, which needs no third-party contact): the fork ships under its own
  name and says "based on Busy" only to describe its origin. Alternatives: keep the name "Busy";
  ask upstream for permission (contact with upstream, not taken).
  Rationale: Apache-2.0 section 6 grants no trademark rights (`busy@3dd91e1:LICENSE:139-142`).
  **Eric's**: the final product name. Until he names it, the fork's README and banner use the
  working name "Ask Gina Bots (working name)", and `askgina/busy` is a private repository name
  only.
  Date/Author: 2026-11-14 / research agent; taken 2026-11-15 / lead
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
- Decision D13, owner, new 2026-11-15, **taken 2026-11-15** by the lead under Eric's delegation:
  allow and document, with small caps, as recommended. An askgina/os agent that a Busy bot uses may
  hold mandates, like any agent. The fork's README and bot settings page say that whoever
  controls the Busy Hub holds every bot's agent token, and so can spend every live mandate of
  those agents with no person asked, up to each mandate's worst case. Alternatives: the fork's
  documentation forbids mandates for Busy bots (askgina/os cannot enforce it without a code
  change); add an askgina/os agent flag that refuses mandates (a change to askgina/os, outside
  this plan).
  Recommendation: allow and document, with small caps. Reason: the signer already bounds the
  loss to `min(maxTotal, maxUses × maxPerAction)` per asset (`docs/threat-model.md:291,297`), the
  same position as any stolen agent token.
  Date/Author: 2026-11-15 / plan refresh
- Decision D14, owner, new 2026-11-15, **taken 2026-11-15** by the lead under Eric's delegation:
  do not receive it, as recommended. The fork does not receive the askgina/os signed
  webhook and posts nothing about waiting approvals into Busy chats beyond the bot's own reply.
  Alternative: point `NOTIFY_WEBHOOK_URL` at the Busy Hub and post a chat message per
  `approval.opened`, `approval.reminder` and `mandate.used`.
  Recommendation: do not receive it. Reason: there is one webhook URL per install, so the Hub
  would displace the operator's own receiver (for example the ntfy sidecar), and the body has no
  agent or intent id, so the Hub cannot map an event to a bot; the bot already learns outcomes
  from `get_intent`.
  Date/Author: 2026-11-15 / plan refresh

## Outcomes & Retrospective

- Outcome: research done; nothing built.
  Evidence: [research/busy-fork.md](./research/busy-fork.md).
  Remaining: every milestone below (owner decisions taken 2026-11-15, except the calls that stay
  Eric's: a public repository, the product name, contact with upstream).
- Outcome (2026-11-15): still nothing built. Trusted display, mandates and notifications landed
  on main and delivered none of this plan's milestones; they changed what Milestone 7 drives (the
  confirmation page instead of an in-app approval), what the bot must handle (mandate-covered
  proposals) and the threat model (mandates spendable from the Hub).
  Evidence: `specs/trusted-display.md`, `specs/approval-mandates.md`,
  `specs/approval-notifications.md` (all Ready for Review); the re-check in Surprises & Discoveries.
  Remaining: Milestones 0 to 8; the owner decisions are taken (2026-11-15).

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
  `agents` network, port 80, path `/mcp`: `compose.yaml:188-200,245-246`,
  `deploy/Caddyfile.agents:9-18`). It has seven tools (`apps/server/src/mcp/gateway.ts:70-78`,
  registered at `:168-389`, none with MCP annotations).
- askgina/os proposals: `propose_transfer` and `propose_contract_call` return `{ intentId, status,
  authorizedBy, mandateId, approvalUrl, expiresAt }` (`apps/server/src/execution/intents.ts:
  236-243`). With `authorizedBy: "person"`, `approvalUrl` is the request's page on
  `PUBLIC_ORIGIN` (`/w/<workspaceId>/approvals/<approvalId>`, `apps/server/src/notify/content.ts:
  11-13`). That page shows a signed-in person a link to the signer's confirmation page on
  `APPROVE_ORIGIN` (`/a/<approvalId>#<token>`), served by the keyless `apps/approve` service with
  views the signer builds (`packages/protocol/src/confirmation.ts`); the passkey prompt runs there,
  at top level, and the signer accepts only assertions made on that origin and not in a frame
  (`specs/trusted-display.md`; `docs/threat-model.md:119-141`). With `authorizedBy: "mandate"`,
  the status is already `approved`, `approvalUrl` and `expiresAt` are null, and the signer signs
  with no person asked (`intents.ts:430-438`).
- askgina/os reads: `get_intent` (with `waitSeconds` up to 50) and `list_intents` return
  `intentId`, `status`, `authorizedBy`, `mandateId`, wallet, chain, title, recipient, amount,
  asset, memo, `transactionHash`, `explorerUrl` and `failureCode` (`gateway.ts:134-155`).
  `whoami` returns the agent, its workspace, chains, usable wallets with their policy, and
  `mandates`: for each live mandate its `mandateId`, wallet, purpose, recipients, window,
  per-asset caps with what was used, `maxFeePerActionWei`, `usesLeft` and `notAfter`
  (`gateway.ts:168-230`).
- askgina/os mandates: granted at the workspace's admin threshold on the confirmation page; they
  cover only native and ERC-20 transfers of one agent from one wallet, never a contract call;
  disabling the agent revokes them (`specs/approval-mandates.md`; `docs/threat-model.md:274-300`).
- askgina/os notifications: an outbox delivers a signed, retried webhook to one
  `NOTIFY_WEBHOOK_URL` per install with events `approval.opened`, `approval.reminder` and
  `mandate.used`, whose bodies hold ids, a kind, an expiry and a link only
  (`apps/server/src/notify/webhook.ts:19-42`); Web Push is off by default (`compose.yaml:108-113`;
  `docs/threat-model.md:361-380`). This plan consumes neither (D14).
- askgina/os: `@askgina/os-world/target` encrypts workflow payloads, stores `[withheld]` for run
  attribute values not listed in `WORLD_READABLE_ATTRIBUTE_KEYS`, and refuses an unlisted
  attribute set in a workflow body (`packages/world/README.md:41-61`). The eve example is wired to
  run on it (`examples/eve-agent`), but its Compose stack has never been started.
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
- The owner provides: the private fork repository (D1), private package publishing (D2), a read-only deploy key
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
  and `publishConfig.registry` `https://npm.pkg.github.com`. As built (2026-11-15): the top-level
  `exports` stay on source, because every consumer in this repository (Node running `src/*.ts`
  in the images, the eve image, vitest) resolves with no conditions; the published shape is in
  `publishConfig.exports`, and `scripts/pack-packages.mjs` promotes it in a staged copy before
  `npm pack` (tarballs under `.packs/`). Bump the keys version before a `world-v*` tag whenever
  keys changed, or the publish step skips it.
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
an automatic signal when upstream moves. Depends on D1 (the private mirror `askgina/busy`,
already created at `3dd91e1`, not a GitHub fork) and D10 (own name; the final name is Eric's,
"Ask Gina Bots (working name)" until he picks), both taken 2026-11-15. The fork's workflows are
cheap: no macOS desktop job, benchmark and performance jobs disabled; Actions stays off in the
repository until they land. Fetching upstream's public repository is read-only and
is not contact with the upstream project.

Files and interfaces:

- `fork:NOTICE`: keep upstream's text; append "This product includes modifications by Ask Gina
  (2026). Based on Busy by Matias Solina." as an addendum (Apache-2.0 4(d)).
- `fork:FORK.md`: new. What the fork changes and why, the switched-off features, the upstream
  commit it is based on, and the list of modified upstream files (generated, see below).
- `fork:README.md`: a banner naming the fork (D10; "Ask Gina Bots (working name)" until Eric picks
  the final name), "based on Busy", and linking `FORK.md`.
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
  key beyond rc.17's readable list (`examples/eve-agent/compose.yaml:78`) is settled by the
  session round trip in this milestone's acceptance. The World stores `[withheld]` for a withheld
  key set at run creation or from a step, but refuses one set by `setAttributes()` in a workflow
  body, which fails the run (`packages/world/README.md:50-54`); a withheld key that eve 0.91.0
  sets from a workflow body must move to the readable list (with a reason) or the session fails.
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
- The bot's logs for the whole spec contain no `setAttributes failed World validation`, and a
  second message to the same session is answered (the session round trip).

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

Scope: a bot proposes through the gateway; a person approves on the signer's confirmation page,
or a mandate covers the payment. Depends on Milestone 0 and the CI deploy key. Trusted display
and mandates, which this milestone drives, are already on askgina/os main; nothing here changes
them.

Files and interfaces:

- `fork:templates/bot/agent/connections/askgina-os.ts`: new. `defineDynamic` returning `null`
  unless `ASKGINA_OS_MCP_URL` is set; otherwise `defineMcpClientConnection({ url, description,
  auth: bearer token read from ASKGINA_OS_AGENT_TOKEN_FILE, approval: never(), tools: { allow:
  [the seven names] } })`. A comment states why `never()` (D3). Exact option names are checked
  against `eve@0.91.0:dist/src/public/definitions/connections/mcp.d.ts` when written.
- `fork:templates/bot/agent/skills/wallet/SKILL.md`: new. Call `whoami` first and read its
  `wallets` and `mandates` (recipients, caps, `usesLeft`, `notAfter`). Propose with a memo. If
  the answer says `authorizedBy: "person"`, give the person the `approvalUrl` as a plain link and
  say that it opens as its own page in askgina/os, where they sign in and approve on the signer's
  confirmation page; never put it in a card, an embed or a frame (both askgina/os origins refuse
  framing). If it says `authorizedBy: "mandate"`, send no link: say that mandate `mandateId`
  covered the payment and it is being sent. Wait with `get_intent` and `waitSeconds` (at most
  50, repeated); report a payment only at `confirmed`, with `transactionHash` and `explorerUrl`;
  on `stuck`, say it is sent but not yet confirmed and keep waiting. Never ask "OK?" with
  `ask_user` in place of the passkey; never treat a chat answer as approval; never claim a
  mandate exists that `whoami` did not list. A `policy_denied` refusal with a `mandate_` code
  means the named mandate does not cover the payment: say so and propose without `mandateId`.
- `fork:apps/hub/drizzle/0040_os_agent_token.sql`, `fork:apps/hub/lib/db/schema.ts`:
  `bots.os_agent_token_sealed` (sealed with `lib/mcp/crypto.ts`). `fork:apps/hub/app/api/bots/
  [slug]/route.ts` and bot settings UI accept the token write-only; reads return only
  `{ configured: true, prefix: "osa_xxxx" }`.
- Runner: when a bot has a token, write it to the bot's secret volume, set
  `ASKGINA_OS_MCP_URL=http://agent-gateway/mcp`, and attach the bot container to the external
  network named by `ASKGINA_OS_AGENTS_NETWORK` (default `os_agents`, the network Compose creates
  for the askgina/os project `os`). Computers never join it.
- `fork:e2e/wallet/wallet.spec.ts`: new. Uses the person driver from askgina/os
  (`e2e/src/person.ts`, a software passkey: `Person.confirm(approvalId)` reads the approval
  page's `confirmUrl`, approves on the confirmation page at `APPROVE_ORIGIN` and collects;
  `Person.proposeMandate` and `Person.revokeMandate` manage mandates) from a checkout of
  askgina/os at a pinned commit. The approval id is the last path segment of `approvalUrl`.

Acceptance (CI job `wallet`, checks out askgina/os with `ASKGINA_OS_READ_KEY`, brings up its
stack with the `dev` profile and the fork's stack):

- The stub model calls `propose_transfer` for 0.001 ETH to a fixed address. The intent appears
  in askgina/os with status `pending_approval`. The Busy chat projection contains no approval
  interaction for that call (`fork:apps/hub/lib/chat/items.ts` output checked in the spec).
- The spec posts `POST /api/bots/{slug}/answer` with a made-up `interactionId` and
  `optionId: "approve"`; the Hub returns an error; the askgina/os intent is still
  `pending_approval` five seconds later.
- The person driver approves on the confirmation page; `get_intent` reaches `confirmed`; Anvil
  shows the recipient's balance increased by exactly 0.001 ETH; the bot's last message contains
  the transaction hash. The bot's message holding `approvalUrl` contains it as text or a link,
  and the chat projection has no frame or embed for it.
- A person grants the bot's agent a mandate (one recipient, 0.001 ETH per payment, two uses) and
  approves it on the confirmation page. The bot's `whoami` lists it. The stub model proposes
  0.001 ETH to that recipient: the answer is `authorizedBy: "mandate"` with that `mandateId` and
  `approvalUrl` null, the Busy chat shows no approval interaction, the intent reaches
  `confirmed` with no person approving, and the bot's reply names the mandate and sends no link.
  After `Person.revokeMandate`, the same proposal comes back `authorizedBy: "person"`.
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
  content of the Threat Model section below, and one row in its "Mandates" table for a
  compromised Busy Hub; `docs/architecture.md`: one paragraph and the `agents` network rule for
  third-party runtimes.
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
  `list_intents`, `cancel_intent` (`apps/server/src/mcp/gateway.ts:70-78`;
  `specs/agent-workspaces-v0.1.md:398-408`). Only annotations are added. What the fork's skill
  and gates read from them:
  - `whoami`: `agent`, `workspaceId`, `chains`, `wallets[]` (with `policy`), `mandates[]`
    (`mandateId`, `walletId`, `purpose`, `recipients`, `windowSeconds`, `assets[]` with
    `maxPerAction`, `maxPerWindow`, `maxTotal`, `usedInWindow`, `usedTotal`,
    `maxFeePerActionWei`, `usesLeft`, `notAfter`) (`gateway.ts:183-228`).
  - `propose_transfer` (optional input `mandateId`) and `propose_contract_call`: `{ intentId,
    status, authorizedBy: "person" | "mandate", mandateId, approvalUrl, expiresAt }`
    (`apps/server/src/execution/intents.ts:236-243`). A contract call is never covered by a
    mandate.
  - `get_intent`, `list_intents`: the intent view with `status`, `authorizedBy`, `mandateId`,
    `transactionHash`, `explorerUrl`, `failureCode` (`gateway.ts:134-155`).
- Approval pages: `approvalUrl` on `PUBLIC_ORIGIN`, the confirmation page on `APPROVE_ORIGIN`;
  both top-level only (`packages/api/src/csp.ts:22`, `apps/approve/src/app.ts:32,40`). The fork
  links to the first and never embeds either.
- Signed webhook (`apps/server/src/notify/webhook.ts:19-42`: `approval.opened`,
  `approval.reminder`, `mandate.used`): not consumed by the fork (D14).
- `@askgina/os-world/target`: configured by `WORKFLOW_POSTGRES_URL`, `WORLD_KEYRING_FILE`,
  `WORLD_READABLE_ATTRIBUTE_KEYS` (`packages/world/README.md:41-61`).

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

- **Can:** everything `docs/threat-model.md:119-132` lists: read sealed content, show a person a
  misleading card in its own pages, link a person to the confirmation page of a different
  waiting request, pause workspaces; and, within live mandates, have the signer sign transfers
  that fit them with no person (`:290`). New: tell Busy bots false intent statuses through
  `get_intent` (for example "confirmed" for a payment that never happened, or "covered by a
  mandate" for one that waits), so bots report false outcomes in the Busy chat.
- **Cannot:** obtain an approval the signer accepts for anything the person did not see on the
  signer's confirmation page, exceed the signer's or a mandate's caps, reuse an approval, change
  policy or approvers, or grant or widen a mandate without passkeys (`:133-160`). The Busy fork
  gives it no new path to the signer and no new authority: Busy holds no askgina/os credential
  except agent tokens.

A compromised Busy Hub:

- **Can:** read every Busy conversation (plaintext tables, D7); unseal and use every bot's agent
  token, so propose as any bot, and have the signer sign, with no person asked, transfers inside
  every live mandate of those agents up to each mandate's worst case
  (`docs/threat-model.md:291,297`; D13); deploy any code into any bot; answer any Busy card; show
  a person a fake "approved" or "paid" message, or a lookalike approval link, in the Busy chat.
- **Cannot:** approve a request or grant, widen or revive a mandate. Its only route to
  askgina/os is the MCP gateway with agent tokens; no tool returns a confirmation link; the signer
  accepts only passkey assertions made on the confirmation page's origin, outside any frame, and
  verified against its own approver registry. It cannot frame the askgina/os pages. It cannot
  reach the askgina/os server, Postgres, the `approve` service or the signer: it is not on their
  networks. A lookalike link is the "lookalike host" position askgina/os already documents
  (`docs/threat-model.md:180-191`).

A compromised bot container: same as askgina/os's "malicious or prompt-injected agent" and
"stolen agent token" positions for its own agent (`docs/threat-model.md:62-91`), including its
own agent's live mandates, plus read access to its own World database and keyring.

A compromised computer container (untrusted web or shell content): reaches the internet and the
broker's API for its own computer only. It holds no agent token and cannot reach the gateway, the
Hub's internal routes, Postgres or other computers. Escaping gVisor reaches the runner host.

The runner: holds a Docker socket, so it is root on its host. If that host is the signer's host,
this is the "signer host" position (`docs/threat-model.md:239-243`, and "One machine running
everything gives no protection against that machine", `:564`), which is why D6 puts it
elsewhere in production.

Notifications: no Busy component sends or receives askgina/os notifications (D14), so this plan
adds nothing to `docs/threat-model.md:361-380`.

Invariant check: the signer still decides whether a person approved, on its own confirmation
page, or whether a mandate people granted covers a transfer, and signs only that. Busy's
approval cards are switched off for the seven tools and no Busy component can create an
approval or a mandate.

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
  it to pay 0.001 test ETH, open the link (it opens as its own page in askgina/os), follow it to
  the signer's confirmation page, approve with a phone passkey there, and see the confirmation in
  askgina/os and in the Busy chat. A real phone passkey on the confirmation page has not yet been
  proven in askgina/os itself (its gates use virtual and software authenticators), so this step
  is also the first such check.
- Grant the bot's agent a small mandate in askgina/os, ask the bot what it may pay without
  asking (it reads `whoami`), then ask it to pay inside the mandate: no link, a confirmed
  transaction, and a `mandate.used` notification on the operator's webhook if one is configured.
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
- Risk: the Docker socket on the runner host. Mitigation: D6 (taken): the runner never shares a
  host with the signer in production.
- Answered (2026-11-15, by the lead under Eric's delegation; no recommendation, so the
  conservative option): no rootless Docker daemon in the first fork; the runner uses a normal
  daemon on its own host under D6. Reason: smallest scope; gVisor under rootless Docker is not
  proven in this plan, and D6 already confines the socket to a host that holds no askgina/os
  secret.
- Risk: Hub plaintext (D7) is misread as covered by the World. Mitigation: the README states it
  and the threat model lists it.
- Risk: trademark. Mitigation: D10 (taken): own name, no use of "Busy" as a name, no request to
  upstream. The name itself stays Eric's.
- Risk: a compromised Busy Hub spends every live mandate of its bots' agents. Mitigation: D13
  (documented, small caps); the signer bounds each mandate's worst case; disabling an agent in
  askgina/os revokes its mandates at once.
- Risk: eve 0.91.0 sets a withheld `$eve.` attribute from a workflow body, which the World now
  refuses, failing sessions. Mitigation: Milestone 4's session round trip and log check; move the
  key to the readable list with a reason if its value can never carry typed text, else wait for
  upstream's eve bump. Unconfirmed until Milestone 4 runs.
- Risk: Busy renders a bot's link inside an MCP App frame or a preview card instead of as a plain
  link, so the approval page fails to load there. Mitigation: Milestone 7's chat-projection check;
  the skill sends the link as text. How Busy's chat renders links was not re-read for this
  refresh (unconfirmed).
- Risk: intent statuses changed under stuck-transaction repricing (askgina/os#22, built on main at
  `61d0326`): `IntentStatus` now includes `stuck` (`packages/api/src/dto.ts:289-305`).
  Mitigation: the skill reports only `confirmed` as
  paid and treats every other non-final status, `stuck` included, as "not yet"; re-read
  `get_intent`'s description when Milestone 7 starts.
- Risk: the eve example's Compose stack, the only askgina/os example of an agent on `agents` plus
  an egress network, has never been started. Mitigation: Milestones 4 and 7 run that topology in
  CI; a failure there is a finding for askgina/os too.
- Open question, **Eric's**: whether upstream would accept the provider-neutral seams of
  Milestones 2 and 3. Not delegated: contacting the upstream Busy project is Eric's call, and
  no milestone depends on it.
- Open, **Eric's**: making the fork repository public (D1) and the fork's final product name
  (D10). Not delegated; the plan builds in the private mirror `askgina/busy` under the working
  name "Ask Gina Bots (working name)".

## Artifacts and Notes

    Research: specs/research/busy-fork.md (findings F1 to F10)
    Upstream base: MatiSolina/busy 3dd91e16c0708bd02066377ba3e45aa06f4813c0 (v0.5.0)
    eve pinned by upstream: 0.91.0 (published 2026-10-30)
    Estimated fork size [INFERENCE]: 4,000 to 5,000 new or changed lines, about 40 upstream files
    Re-checked against askgina/os main: 98cc6a1 (2026-11-15); milestones 0 to 8 remain, none delivered

## Revision Notes

- 2026-11-14: First draft from the research for ticket #26. Written for the recommended option of
  every open owner decision.
- 2026-11-15: Re-checked against main after trusted display, mandates and notifications landed.
  Purpose, success criteria, Milestone 7 (skill, gates), Interfaces, Threat Model, manual
  validation and Risks now follow the signer's confirmation page (approval links open as their
  own page and cannot be framed) and mandates (`authorizedBy`, `mandateId`, `whoami.mandates`; a
  compromised Hub can spend its bots' live mandates). Milestone 4 accounts for the World refusing
  unlisted `setAttributes()` in a workflow body. The eve example's Compose observation is marked
  fixed by `5da19e5` (still never started). Stale line references corrected. New open decisions
  D13 (mandates for Busy bots) and D14 (no webhook into Busy). No milestone was delivered by
  other plans; Milestone 0 is still needed.
- 2026-11-15: D1, D2, D5 to D8, D10, D13 and D14 taken by the lead under Eric's delegation, each
  as recommended. D1 narrowed to a private mirror and done: `askgina/busy` with upstream history
  at `3dd91e1`, Actions off until Milestone 1's cheap workflows (a GitHub fork of a public
  repository is public); `ericjuta/busy` is unrelated and unused. D10 taken as the no-contact
  option (own name, no permission request); working name "Ask Gina Bots (working name)". Left with Eric: making any repository public, the product name, contact
  with upstream. The runner's rootless-Docker question is answered conservatively (not in the
  first fork). The repricing risk now cites the built `stuck` status (#22 at `61d0326`).
