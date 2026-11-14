<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [Does the eve agent runtime run with no Vercel services?](https://github.com/askgina/os/issues/2). **Date:** 2026-11-14.
>
> Written by a research agent; the maintainer re-ran its `./verify.sh` the same day and it passed. File names below (`verify.sh`, `*.test.ts` and so on) refer to a scratch directory outside this repository. The code that was kept is named in [the ExecPlan](../agent-workspaces-v0.1.md).
>
> `refs/<name>` in this report means a shallow clone of the upstream repository at a fixed commit: `refs/workflow` is [vercel/workflow@47ae6d1](https://github.com/vercel/workflow/tree/47ae6d137f346000c9197e654c75e709b93ca715) (release `workflow@5.5.0`), `refs/ows-core` is [open-wallet-standard/core@947f562](https://github.com/open-wallet-standard/core/tree/947f5627cb71299951cd3163b178f1c2b1e9c850) (v1.4.5), `refs/simplewebauthn` is [MasterKale/SimpleWebAuthn@01d1a64](https://github.com/MasterKale/SimpleWebAuthn/tree/01d1a640d5ded4fced0b45a9d806fd0ff44ad244) (v14.1.0), `refs/eve` is [vercel/eve@be1adda](https://github.com/vercel/eve/tree/be1addaaa5b7c2b75537b58767a27c3fdb595931), `refs/busy` is [MatiSolina/busy@3dd91e1](https://github.com/MatiSolina/busy/tree/3dd91e16c0708bd02066377ba3e45aa06f4813c0), `refs/mcp-typescript-sdk` is [modelcontextprotocol/typescript-sdk@919bb8e](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c). `/tmp/wf-scout/workflow-5.5.0/docs` is the documentation shipped inside the `workflow@5.5.0` npm package.

# Spike: does eve (and a Busy bot) run with no Vercel services?

Date 2026-11-14. Sources: `refs/eve` @ `be1addaaa5b7c2b75537b58767a27c3fdb595931`, `refs/busy` @ `3dd91e16c0708bd02066377ba3e45aa06f4813c0`. Runtime run used the published npm `eve@1.0.0-rc.17` (same version as `refs/eve/packages/eve/package.json`), `ai@7.0.173`, `zod@4.6.7`, `@workflow/world-postgres@5.2.0`, Node 26.2.0, bun 1.4.4, `postgres:18-alpine`.

## Verdict

| Subject                        | Verdict                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **eve**                        | **Runs today** with no Vercel service: reproduced end to end on the Local World and on the Postgres World (`@workflow/world-postgres` 5.2.0), offline model, `VERCEL*`/`AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` unset, approval pause survives a server restart. Every Vercel dependency is behind a documented seam (table below). |
| **Busy bot** (`templates/bot`) | **Not feasible without forking.** Vercel Sandbox + Drive, Vercel OIDC, Blob and the AI Gateway are imported directly in the bot template and the Hub; no interface. Also pins an old `eve@0.91.0`.                                                                                                                                  |
| Busy Hub                       | Not feasible without forking (Queues, Schedules, Blob, OIDC, Sandbox, Gateway imported directly; README states bots need "your own Vercel resources").                                                                                                                                                                              |

Design decision forced: **use eve (if at all) directly, not Busy.** Treat Busy as reference UX only.

## eve: each Vercel touchpoint

| Dependency                      | Where                                                                                                                                                                                                                    | Hard-wired or seam                                                                                                                     | Self-hosted replacement (adapter size)                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow World                  | `packages/eve/src/internal/workflow/world-target.ts:7-11` maps `"local"`/`"vercel"`, anything else is a package specifier; selected by `experimental.workflow.world` (`docs/guides/deployment/workflow-worlds.md:42-67`) | Seam                                                                                                                                   | `@workflow/world-postgres` ≥5.1.1 — **0 lines**, reproduced. Our encrypted World plugs in the same way (a package specifier).                                                                       |
| AI Gateway (models)             | `src/internal/gateway.ts:3` (`https://ai-gateway.vercel.sh`); string model IDs resolve via gateway (`ai/decision-adapter.ts:23`)                                                                                         | Seam: pass an AI SDK model object (`docs/guides/deployment/self-hosting/index.md:21`)                                                  | Any AI SDK provider object — **~1 line** in `agent.ts`. Must also set `modelContextWindowTokens` or build fails: "does not have known AI Gateway context window metadata" (observed).               |
| `auto()` approval classifier    | defaults to `typesafe-ai/jev` via Gateway (`docs/tools/human-in-the-loop.md`)                                                                                                                                            | Seam (`auto({ model })` or global AI SDK provider)                                                                                     | Don't use `auto()`; use `always()` / own policy — **0 lines**.                                                                                                                                      |
| Vercel Sandbox                  | `src/public/sandbox/vercel-sandbox.ts`, `src/execution/sandbox/bindings/vercel.ts`                                                                                                                                       | Seam: `defineSandbox`, `eve/sandbox/docker`, `eve/sandbox/just-bash`, `defineSandboxProvider()` (self-hosting doc :94-106)             | Docker sandbox built-in — **0–5 lines**. Not needed at all if tools don't call `ctx.getSandbox()` (doc :98). Multi-host replicas need a shared custom provider [INFERENCE: tens–hundreds of lines]. |
| Blob (file memory)              | `src/public/memory/file/backends/vercel-blob.ts:1`                                                                                                                                                                       | Seam: optional export `eve/memory/file/vercel`; `eve/memory/file` has other backends                                                   | Filesystem/S3 backend — 0 lines unless used.                                                                                                                                                        |
| Vercel OIDC (route auth)        | `src/channel/auth/vercel-oidc-project.ts`                                                                                                                                                                                | Seam: auth array; `httpBasic`, `jwtHmac`, `jwtEcdsa`, `oidc(...)`, custom `AuthFn` (`docs/guides/auth-and-route-protection.md:94-104`) | `jwtEcdsa`/`oidc` or custom verifier — **~3 lines**; spike used `httpBasic`.                                                                                                                        |
| Queues                          | none in eve: the World's own queue is used (Graphile Worker on Postgres)                                                                                                                                                 | n/a                                                                                                                                    | —                                                                                                                                                                                                   |
| Schedules on Vercel             | `eve/experimental/schedules/vercel` export                                                                                                                                                                               | Optional; `eve start` runs schedules in-process (self-hosted-operations.md "Run schedules")                                            | 0 lines.                                                                                                                                                                                            |
| Workspace peers / remote agents | default transport needs Vercel; callbacks refuse private/loopback hosts outside `eve dev`                                                                                                                                | Seam: explicit workspace-peer transport                                                                                                | Only if multi-agent delegation over HTTP is used.                                                                                                                                                   |
| CLI telemetry, registry         | `eve.dev/r` registry (`cli/commands/registry.ts:133`), telemetry on by default                                                                                                                                           | Opt-out                                                                                                                                | `EVE_TELEMETRY_DISABLED=1` (docs/reference/cli/index.md:30). Runtime egress not audited (see below).                                                                                                |
| Gateway catalog at build        | `compiler/artifacts.ts:268`                                                                                                                                                                                              | Bypassed by `modelContextWindowTokens`                                                                                                 | observed: build succeeded with it set.                                                                                                                                                              |

## What was reproduced (`./verify.sh`)

Minimal agent in `run/`: `agent/agent.ts` (offline `MockLanguageModelV4` from `ai/test`, streaming a `transfer` tool call then text), `agent/tools/transfer.ts` (`approval: { request: always(), prompt }`), `agent/channels/eve.ts` (`httpBasic`). Steps per World: `POST /eve/v1/session` → stream shows `call.requested`, `interaction.opened` (kind `approval`, prompt `Send 1.5 to 0xabc?`), `turn.paused`, and no `call.started` → **kill and restart `eve start`** → `POST /eve/v1/session/:id {"answers":[{interactionId, optionId:"approve"}]}` → exactly one `call.started` with `clearedBy:{interactionId}`, `call.settled` outcome `completed`, `turn.settled` `completed`.

Observed (manual run before verify.sh):

```
{"type":"interaction.opened","data":{"interactionId":"irWsPdpEhxHbJULb","request":{"allowFreeform":false,"display":"confirmation","kind":"approval","options":[{"id":"approve","label":"Approve"},{"id":"deny","label":"Deny"}],"prompt":"Send 1.5 to 0xabc?"},"subject":{"callId":"call_1"}}}
{"type":"turn.paused","data":{"awaiting":[{"interactionId":"irWsPdpEhxHbJULb"}],"turnId":"turn_0"}}
-- restart, answer --
{"type":"call.started","data":{"callId":"call_1","clearedBy":{"interactionId":"irWsPdpEhxHbJULb"}}}
{"type":"call.settled","data":{"callId":"call_1","outcome":"completed","output":{"ok":true,"sent":{"to":"0xabc","amount":"1.5"}}}}
```
Postgres World: 10 `workflow.*` tables created by `bootstrap`, 20 events written, no `.eve/.workflow-data` directory.

Surprises:

1. **Postgres World stores eve data readably.** `workflow_stream_chunks.data` is devalue-wrapped base64 JSON: `devl[["Uint8Array",1],"eyJhdCI6IjIwMjYtMTEtMTRU…"` (= `{"at":"2026-11-14T…`); `workflow_events.payload_cbor` is plain CBOR (`b900076c6465706c6f796d656e744964…` = `deploymentId…`). Confirms the verification note: encryption needs our own `getEncryptionKeyForRun` World. eve's stream events (tool inputs, approval prompts) are at rest in this table.
2. Build fails without `modelContextWindowTokens` for non-Gateway models, and without `agent/instructions.md`.
3. `MockLanguageModelV4` must implement `doStream`; eve always streams.
4. Graphile warns `maxPoolSize (10) smaller than concurrency (50)` — set `WORKFLOW_POSTGRES_MAX_POOL_SIZE=52` per eve docs.
5. eve upgrades strand in-flight sessions on self-hosted Worlds (`self-hosted-operations.md` "Upgrade"): a pending approval does not survive an eve version bump. Our approval protocol must tolerate that (re-propose).
6. eve requires a World with atomic start hooks (`world-postgres` ≥5.1.1) and `hookForceClaim`/`hookRetention` for compaction handoff (`docs/concepts/execution-model-and-durability.mdx:47`). A custom encrypting World must wrap world-postgres and keep those capabilities.

## eve approval suspension as an API (for mapping onto our protocol)

- Authoring: `approval` on `defineTool` or agent-wide in `defineAgent`. Types from `eve/tools/approval` (`packages/eve/src/approval/definition.ts:64-157`):
  - `ApprovalPolicy = (ctx: ApprovalContext) => ApprovalStatus | Promise<…>`; `ApprovalStatus` = `"user-approval" | "approved" | "denied" | "not-applicable" | boolean | {type, reason?}`.
  - `ApprovalConfiguration = { request: ApprovalPolicy; prompt?: (ctx)=>string; response?: ApprovalResponsePolicy }`.
  - `ApprovalResponsePolicy(ctx: { request: ApprovalRequest{callId, interactionId, principal, toolInput, toolName}, response: { decision: "approve"|"deny", principal }, session, auth }) => {status:"allowed"} | {status:"rejected", reason}` — rejection keeps the request pending.
- Where it pauses: `execution/invoke-tool.ts:304-322` runs the policy before `execute`; without clearance the call is not started. The turn emits `interaction.opened` + `turn.paused` and the workflow suspends on the session inbox Workflow hook (`execution/session-inbox/workflow-transport.ts:23-28`, `createHook` with token `sessionInboxHookToken(...)`).
- How it resumes: `POST /eve/v1/session/:id` with `{"answers":[{"interactionId","optionId":"approve"|"deny"}]}` (`docs/channels/eve.mdx:90-95`), authenticated by the channel auth; the response policy may reject a responder; the call policy is **re-checked** before running; `call.started.clearedBy = {interactionId}`.
- Doc caveats: approval is consent only, runs with the requester's identity; it does not make side effects exactly-once (`human-in-the-loop.md` rules).
- Mapping [INFERENCE]: eve's approval is a UI/consent gate, not a cryptographic grant. For wallet sends our design should keep eve's tool as a _proposer_ only: the `transfer` tool's `execute` submits an intent to our control plane and returns, or the `response` policy is used to require that the responder principal carries a verified passkey grant bound to `toolInput`. The signer must still verify the passkey assertion itself; eve's `answers` POST must never be what authorizes signing.

## Busy: Vercel coupling (hard-wired)

- Bot template `templates/bot/agent/sandbox.ts:1,3,29,50` — `Drive` from `@vercel/sandbox`, `VercelSandbox.environment`, `Drive.getOrCreate`.
- `templates/bot/agent/channels/eve.ts:1,34` and `lib/peers.ts:2,99` — `vercelOidc`; `lib/hub.ts:1`, `lib/fireside.ts:1`, `lib/subscription-model.ts:3`, `connections/marketplace.ts:1` — `getVercelOidcToken` as the service credential.
- `templates/bot/package.json`: `eve 0.91.0`, `@vercel/blob`, `@vercel/oidc`, `@vercel/sandbox`.
- Hub: `@vercel/queue` + `@vercel/schedules` (`apps/hub/app/api/queues/routine-runs/route.ts:1-2`, `lib/routines/outbox.ts:6`, `lib/routines/schedule.ts:5`); `@vercel/blob` (`lib/files.ts:2`, `lib/library-objects.ts:2`); `@vercel/sandbox` (`lib/live.ts:4`); `@vercel/oidc` in 11 files; AI Gateway URLs (`app/api/bot/firesides/gateway/language-model/route.ts:69`, `lib/account.ts:12`); bots deployed as Vercel projects (`README.md:27-30,72-73`).
- Replacing these = rewriting sandbox/drive, service identity, file storage, routines and deploy: a fork, not adapters.

## How to rerun

`./verify.sh` (≈2 min): re-runs the source greps, clean `bun install`, builds and drives the Local World flow, then starts `osspike-eve-pg` on 127.0.0.1:55602, bootstraps, drives the Postgres World flow, prints a readable stored chunk, removes the container. Exits non-zero on any failed assertion.

## Not checked

- Runtime network egress (no packet capture / egress block); I only unset Vercel env vars and saw no failures. Static grep shows gateway/api.vercel.com calls live in setup/model-auth/CLI paths.
- Docker sandbox, file memory, schedules, subagents, compaction handoff, multiple replicas on Postgres.
- A real model provider (only the AI SDK mock).
- eve `main`-branch source vs npm `1.0.0-rc.17` byte identity (version strings match only).
- Deny path and `response` policies at runtime (read from source/docs only).

## Builds run (all inside spikes/eve/run, no coverage runs, no tests)

| Build                                                      | Wall time                              |
| ---------------------------------------------------------- | -------------------------------------- |
| `eve build` attempt 1 (failed: no context window metadata) | 4.1 s                                  |
| `eve build` attempt 2 (failed: missing instructions.md)    | 3.1 s                                  |
| `eve build` Local World (success)                          | 29.2 s                                 |
| `eve build` Local World, rebuilt after mock `doStream` fix | ≈19 s (includes start + one request)   |
| `eve build` Postgres World                                 | ≈20 s (includes `bun add` + bootstrap) |
| `./verify.sh` (clean install + 2 `eve build` + both flows) | 81 s                                   |

Cleanup: the `osspike-eve-pg` container was removed (0 left); the `eve start` processes were killed. `run/node_modules`, `.eve`, `.output` remain in the spike directory so the proof can be rerun.

## verify.sh tail

Run 2026-11-14, exit 0, 81 s, 0 `osspike-eve` containers left afterwards:

```
local: paused sid=wrun_01M7D6QMN4WA5M1WRA3DYSETD5 interaction=55a7m1YU8EndHPhs prompt=Send 1.5 to 0xabc?
{"callId":"call_1","outcome":"completed","output":{"ok":true,"sent":{"to":"0xabc","amount":"1.5"}}}
local: OK approved after restart, tool ran once, turn completed
== Postgres World
✅ Database schema created successfully!
pg: paused sid=wrun_01M7D6RTQAX6CV95NBFW1Y0WS4 interaction=jibwvjII9nbb6wSw prompt=Send 1.5 to 0xabc?
{"callId":"call_1","outcome":"completed","output":{"ok":true,"sent":{"to":"0xabc","amount":"1.5"}}}
pg: OK approved after restart, tool ran once, turn completed
pg events: 20
pg stream chunk sample (base64 JSON, readable at rest):
\000\000\325devl[["Uint8Array",1],"eyJhdCI6IjIwMjYtMTEtMTRUMTQ6MTg6MjEuMTIyWiI
ALL OK
```
