<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [Is one Next.js app a sound host for the control plane?](https://github.com/askgina/os/issues/5). **Date:** 2026-11-14.
>
> Written by a research agent, whose `./verify.sh` passed on its third run; the maintainer read the report and its run log but did not re-run it, because the decision went the other way (see the ExecPlan: the host is a plain Hono server). File names below (`verify.sh`, `*.test.ts` and so on) refer to a scratch directory outside this repository. The code that was kept is named in [the ExecPlan](../agent-workspaces-v0.1.md).
>
> `refs/<name>` in this report means a shallow clone of the upstream repository at a fixed commit: `refs/workflow` is [vercel/workflow@47ae6d1](https://github.com/vercel/workflow/tree/47ae6d137f346000c9197e654c75e709b93ca715) (release `workflow@5.5.0`), `refs/ows-core` is [open-wallet-standard/core@947f562](https://github.com/open-wallet-standard/core/tree/947f5627cb71299951cd3163b178f1c2b1e9c850) (v1.4.5), `refs/simplewebauthn` is [MasterKale/SimpleWebAuthn@01d1a64](https://github.com/MasterKale/SimpleWebAuthn/tree/01d1a640d5ded4fced0b45a9d806fd0ff44ad244) (v14.1.0), `refs/eve` is [vercel/eve@be1adda](https://github.com/vercel/eve/tree/be1addaaa5b7c2b75537b58767a27c3fdb595931), `refs/busy` is [MatiSolina/busy@3dd91e1](https://github.com/MatiSolina/busy/tree/3dd91e16c0708bd02066377ba3e45aa06f4813c0), `refs/mcp-typescript-sdk` is [modelcontextprotocol/typescript-sdk@919bb8e](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c). `/tmp/wf-scout/workflow-5.5.0/docs` is the documentation shipped inside the `workflow@5.5.0` npm package.

# Spike: one Next.js app as the control-plane host

**Question.** Can one Next.js app in one long-running container host the whole control plane: the UI, API routes, the Workflow SDK 5 runtime on the Postgres World, and an MCP endpoint? Which settings does that take?

**Verdict: yes, with five settings that are easy to miss.** On this stack (Next 16.4.6, Turbopack, `output: "standalone"`, a custom World wrapping `@workflow/world-postgres`, and an MCP Streamable HTTP endpoint) `./verify.sh` passes every required check: the build; start through MCP; approval through the API; completion; the edge refusing `/.well-known/workflow/*`; recovery after SIGTERM and after kill -9; ciphertext at rest; and refusal of MCP calls without a valid token. It completed (exit 0) on 2026-11-14.

## Versions (exact-pinned)

next 16.4.6, react/react-dom 19.3.1, typescript 7.0.2 (`next build` type-checked with it), workflow 5.5.0, @workflow/world-postgres 5.2.0 (which brings graphile-worker 0.16.6 and pg 8.23.1), @modelcontextprotocol/server 2.4.0 and @modelcontextprotocol/client 2.4.0 (**SDK major 2**; npm `latest`, split packages), zod 4.6.7, @types/node 26.6.6, @types/pg 8.23.1, @types/react 19.3.0. Runtime and build images use node:26-slim, oven/bun:1.4.4 (only the bun binary is copied in), postgres:18-alpine and caddy:2.11.9-alpine. bun 1.4.4 runs with `linker = "hoisted"`.

## Layout

- `app/`: the Next app.
  - `workflows/approval.ts`: `prepare` step → `createHook({ token: "approve:<intentId>" })` → `finish` step. Both steps sleep for `slowMs`.
  - Routes: `api/start`, `api/approve` (constant-time bearer check, then `resumeHook`), `api/status`, `api/health`, and `mcp/route.ts` (`createMcpHandler` + `requireBearerAuth`, stateless, tools `start_approval` and `get_status`).
  - `instrumentation.ts` calls `world.start()`.
- `packages/encrypted-world/`: wraps `createWorld({ pool })` and adds `getEncryptionKeyForRun` (a fixed test key from env, both overloads). It owns the process-wide `pg.Pool` on `globalThis`, which the app's route handlers and steps reuse.
- `Dockerfile` targets:
  - `runtime`: standalone `node server.js`; non-root `node` user; tini as PID 1; a HEALTHCHECK.
  - `nextstart`: `next start` from the full tree with the stock World, used for comparison.
  - `mcpclient`: the MCP client.
- `compose.yaml`: `postgres`, `app`, `app-stock` and `caddy` on `osspike-host-back`. Caddy and `mcp-client` share `osspike-host-front`, so the client can reach Caddy only. Caddy is published on 127.0.0.1:55640.
- `docker/entrypoint.sh` runs the World's `bootstrap`, then `app-migrate.mjs` (advisory lock, schema `app`), then `exec`s the server.

## Findings (all reproduced in `verify-last-run.txt` unless cited or marked otherwise)

### 1. Getting the custom World, graphile-worker and pg into the standalone build

- **The runtime loads `WORKFLOW_TARGET_WORLD` through a bundler-ignored `require()` resolved from `process.cwd()`.** Neither bundler nor file tracer can see that load (`refs/workflow/packages/core/src/runtime/world.ts:22-38,170-185`). A build with no extra settings lacked the World entirely. My standalone check printed `@osspike/encrypted-world: MISSING`, `@workflow/world-postgres: MISSING`, `graphile-worker: MISSING` (build 2 below).
- **Turbopack inlined the workspace package even though it was in `serverExternalPackages`.** The package is a symlink into the repo, and its code turned up inside `.next/server/chunks/[root-of-the-server]__*.js` (`grep getEncryptionKeyForRun` found it there). So the package-name specifier cannot be resolved inside standalone.
- **What works:**
  1. `serverExternalPackages: ["pg","graphile-worker","@workflow/world-postgres","@osspike/encrypted-world"]`.
  2. `instrumentation.ts` does `await import("@osspike/encrypted-world")`. That import is traced, so `@workflow/world-postgres`, graphile-worker and pg land in standalone `node_modules`.
  3. `outputFileTracingIncludes: { "/*": ["../packages/encrypted-world/**"] }` ships the wrapper's own files.
  4. `outputFileTracingRoot` points at the workspace root.
  5. `WORKFLOW_TARGET_WORLD` is set to an absolute file path, `/app/packages/encrypted-world/index.js`.
  6. `transpilePackages` was not needed.
- **bun 1.4's default isolated linker (`node_modules/.bun` store with symlinks) produced a standalone tree with no resolvable packages:** `node_modules` held only `.bun`. Use `linker = "hoisted"`. An alternative would be to publish or pack the World as a real tarball dependency [INFERENCE: that would let the name specifier work; not tested].
- **The World's migrations need their own install.** The `bootstrap` CLI and its SQL files are not traced, so the image adds a separate `/opt/bootstrap` install (`@workflow/world-postgres` + pg).
- **`node server.js` versus `next start`:** both ran the same workflow to completion. The standalone run used the custom World; `next start` in `app-stock` used the stock World. Two variables changed at once, so this shows only that both work. Image sizes: standalone runtime 497 MB, full-tree `next start` 1.66 GB. I did not check whether `next start` prints a warning about `output: standalone`.

### 2. Where the worker delivers

- The worker delivers over loopback to `http://localhost:$PORT/.well-known/workflow/v1/flow`. `WORKFLOW_LOCAL_BASE_URL` overrides that; otherwise `PORT` is used; otherwise the port is probed (`refs/workflow/packages/world-postgres/src/queue.ts:655-674`; docs `worlds/postgres.mdx:248`).
- **Set `HOSTNAME=0.0.0.0` in the image.** The standalone server binds to `$HOSTNAME`, and Docker fills that with the container ID; the image ENV overrides it. [INFERENCE: without the override the server would not listen on loopback and deliveries would fail; I did not test the failure case.]
- Caddy answers 403 for `/.well-known/workflow/*` (both `v1/flow` and `manifest.json` checked). Loopback inside the container still reached the route: it returned 400 "Missing required headers", which is the route itself. Runs kept completing throughout.
- The Postgres World signs nothing (`queueAuthMode: 'skip'`, `queue.ts:1577`), so this edge block is the only protection on that route.

### 3. Bundler and where workflow files live

- The production build ran on Turbopack, the Next 16 default, and generated `/.well-known/workflow/v1/flow` and `webhook/[token]`.
- Workflow files live in the app (`app/workflows`). The docs say workflow and step files can live anywhere `start()` statically reaches them, including workspace packages (`api-reference/workflow-next/with-workflow.mdx`, "Workflow discovery" and "Monorepos"; set `outputFileTracingRoot`). I did not test workflow files placed in a workspace package. Given the inlining in finding 1 that should be fine, since workflow code is meant to be compiled [INFERENCE].

### 4. One pg pool; migration order

- **One pool works.** `createWorld({ pool })` shares a single `pg.Pool` between Drizzle and graphile-worker; the World does not close a pool it was handed, and the caller must add error listeners (README "Programmatic usage"). The route handlers and steps wrote `app.step_log` through the same pool. Postgres showed 11 idle connections from the app process.
- The World module is loaded by Node's `require`, while app code is bundled, so the two are different module instances. **The pool must be shared through `globalThis`** (a `Symbol.for` key), not through a module export.
- **Pool size.** graphile warned that `maxPoolSize` (20) was below the concurrency (50), so I set the pool to 52.
- **Migration order:** at container start, before the server runs, World `bootstrap` first (it owns schemas `workflow` and `graphile_worker`), then app migrations in schema `app` under an advisory lock. Migrations took 874 ms on a warm database and 2136 ms on a fresh one. The docs warn that some World migrations take table locks with a 10 s lock timeout, so with several replicas a one-shot migrate job is better than migrating on every start [INFERENCE].

### 5. Crash and stop behaviour

- **SIGTERM:**
  - graphile handled the signal itself ("graceful shutdown … ignored for the next 5 seconds"). It aborted the delivery that was in flight after about 5 s, and `docker stop` returned after 5.3 s with exit 143.
  - After restart, `prepare` ran again (`attempt=2`), and the run completed 12 s after approval.
  - My setting `stop_grace_period: 30s` does not buy a drain, because graphile's grace period is 5 s. Lengthening the drain needs `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1` plus our own hook; I did not test that.
- **kill -9:** run separately during `prepare` and during `finish`.
  - With `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30`, each step ran again and the run finished. `prepare` ended 44 s after the restart; the run completed 44 s after the second restart.
  - That matches the documented ~1.5× the lock window (~45 s at 30). With the setting unset, the documented recovery for spec-8 step jobs is the next `start()` re-enqueue or graphile's 4 h stale reset; I did not measure it.
- **Steps run at least once.** `step_log` shows the same step starting twice. Signing must therefore be idempotent at the signer.

### 6. Encryption is honoured in the production build

- **Custom World:**
  - `input_cbor` starts with `encr` and does not contain the canary.
  - None of the events contain the approver's name "alice".
- **Stock World:**
  - `input_cbor` begins `devl` and contains the canary.
  - 4 events contain "alice" in plaintext.
- Hook tokens (`approve:<id>`), names, IDs and statuses stay in plaintext in both, as the encryption docs describe.

### 7. MCP

- The SDK v2 `createMcpHandler` (`refs/mcp-typescript-sdk/packages/server/src/server/createMcpHandler.ts`) runs unchanged in a Next route handler (`POST`, `GET` and `DELETE` export the same function).
- **Unauthenticated calls are refused.** No token gives 401 with `WWW-Authenticate: Bearer error="invalid_token"`, and a wrong token gives 401.
- From the client container: `app:3000` and `postgres` do not resolve (ENOTFOUND), and Caddy answers 200.
- `createMcpHandler` does no Host/Origin validation. Behind Caddy that is needed for any browser-reachable deployment [INFERENCE]; I did not add it.

### 8. Resources

|                                                       | value               |
| ----------------------------------------------------- | ------------------- |
| Cold start (`docker restart` → healthy through Caddy) | 2.56 s              |
| Inside the cold start: migrations                     | 874 ms              |
| Inside the cold start: `world.start()`                | 1.19 s              |
| Idle app container (standalone, 30 s idle)            | 93 MiB, ~2.9 % CPU  |
| Idle `next start` container                           | 133 MiB, ~2.7 % CPU |

The idle CPU is graphile polling. By the docs' formula, 50 workers at a 500 ms poll interval make about 100 fetches/s. Tune `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` and `WORKFLOW_POSTGRES_POLL_INTERVAL_MS` [INFERENCE that this is the cause].

## Design decisions this forces

1. **The control plane is one Next.js app** with `output: "standalone"` and Turbopack. Workflow runtime, UI, API and `/mcp` run in one process, behind a reverse proxy that denies `/.well-known/workflow/*`.
2. **The custom World is required anyway,** for encryption and later for auth.
   - Ship it at a file path and set `WORKFLOW_TARGET_WORLD` to that absolute path.
   - Import it from `instrumentation.ts` so it is traced.
   - Use the hoisted linker.
3. **The World owns the process `pg.Pool` and exposes it on `globalThis`.**
   - Size the pool to at least concurrency + 2.
   - Run app migrations in a separate schema, after `bootstrap`, in a pre-start step.
4. **Set `HOSTNAME=0.0.0.0` and `PORT`** in the image (or `WORKFLOW_LOCAL_BASE_URL`).
5. **Set `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30`.** Every step must tolerate re-execution; this is proven, not theoretical.
6. **Signing must not be a workflow step.** A step is re-run after SIGTERM and after kill -9, so the signer has to enforce single use itself.

## Would I not choose Next.js?

No blocker was found. The friction is all at the edges: the trace/inlining gap for runtime-loaded Worlds; standalone not understanding bun's isolated layout; graphile's 5 s grace period; Host/Origin checks for MCP. If the UI grows heavy, the fallback would be a separate Hono or Nitro worker process for the workflow runtime and MCP, with Next serving only UI and API (the docs support Hono and Nitro). That doubles the deployables, so I would not start there.

## Builds run (disclosure)

| #   | command                                          | wall time | notes                                                                      |
| --- | ------------------------------------------------ | --------- | -------------------------------------------------------------------------- |
| 1   | `next build` on host (isolated linker)           | 29 s      | before the rule fired                                                      |
| 2   | `SPIKE_NO_TRACE_INCLUDES=1 next build` (hoisted) | ~30 s     | proved the World was missing from standalone                               |
| 3   | `next build` with trace anchor                   | ~14 s     |                                                                            |
| 4   | `next build` with `outputFileTracingIncludes`    | ~5 s      |                                                                            |
| 5   | `./verify.sh` (cold Docker build)                | 3 m 26 s  | build 184 s; peak RSS of the script 359 MB; failed on my wrong-token check |
| 6   | `./verify.sh`                                    | 1 m 48 s  | build 55 s (cached); failed on a `set -e` bug in my wait helper            |
| 7   | `./verify.sh`                                    | 4 m 10 s  | build 57 s; **all checks passed**; peak RSS 347 MB                         |

Builds 5–7 ran after Main's consent message. Before it, one `./verify.sh` was started and cancelled within seconds, then cleaned up.

## Rerun

`./verify.sh` from this directory. It generates throwaway secrets, builds, brings everything up, runs every check, and removes all `osspike-host-*` containers, the volume and the networks on exit.

## Not checked

- Multiple replicas.
- Recovery after kill -9 with `JOB_LOCK_STALE_SECONDS` unset.
- `APPLICATION_MANAGED_SHUTDOWN`.
- The failure case for an unset `HOSTNAME`.
- Workflow files in a workspace package.
- The webpack build.
- A real per-run key derivation.
- MCP Host/Origin validation.
- vitest (the proof is `verify.sh`).
- Whether `next start` warns about the standalone output.

## verify.sh tail (run 7)

```
custom World: canary_in_input=false approver_in_output=false input_head=\330@Xyencr8~'\264
stock World : canary_in_input=true approver_in_output=true input_head=\330@XYdevl[[1],{
events with plaintext approver (custom): 0
events with plaintext approver (stock) : 4
== shared pg pool: connections held by the app process
|idle|11
== cold start (docker restart -> healthy via edge)
healthy via edge after 2563ms
[entrypoint] migrations took 874ms
[instrumentation] world started in 1192ms pid=6 encryption=true
== idle resources (30 s idle)
osspike-host-app cpu=2.93% mem=93.4MiB / 61.77GiB
osspike-host-app-stock cpu=2.72% mem=132.7MiB / 61.77GiB
== ALL CHECKS PASSED
== cleanup
no osspike-host-* containers left
```
