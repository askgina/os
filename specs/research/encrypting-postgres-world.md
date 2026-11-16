<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [Does a World derived from the Postgres World give ciphertext at rest?](https://github.com/askgina/os/issues/6). **Date:** 2026-11-14.
>
> Written by a research agent; the maintainer re-ran its `./verify.sh` the same day and it passed. File names below (`verify.sh`, `*.test.ts` and so on) refer to a scratch directory outside this repository. The code that was kept is named in [the ExecPlan](../agent-workspaces-v0.1.md).
>
> `refs/<name>` in this report means a shallow clone of the upstream repository at a fixed commit: `refs/workflow` is [vercel/workflow@47ae6d1](https://github.com/vercel/workflow/tree/47ae6d137f346000c9197e654c75e709b93ca715) (release `workflow@5.5.0`), `refs/ows-core` is [open-wallet-standard/core@947f562](https://github.com/open-wallet-standard/core/tree/947f5627cb71299951cd3163b178f1c2b1e9c850) (v1.4.5), `refs/simplewebauthn` is [MasterKale/SimpleWebAuthn@01d1a64](https://github.com/MasterKale/SimpleWebAuthn/tree/01d1a640d5ded4fced0b45a9d806fd0ff44ad244) (v14.1.0), `refs/eve` is [vercel/eve@be1adda](https://github.com/vercel/eve/tree/be1addaaa5b7c2b75537b58767a27c3fdb595931), `refs/busy` is [MatiSolina/busy@3dd91e1](https://github.com/MatiSolina/busy/tree/3dd91e16c0708bd02066377ba3e45aa06f4813c0), `refs/mcp-typescript-sdk` is [modelcontextprotocol/typescript-sdk@919bb8e](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c). "The `workflow@5.5.0` docs" means the documentation shipped inside the `workflow@5.5.0` npm package.

# Spike: world — an encrypting Postgres World

## Question

Does a World derived from `@workflow/world-postgres` 5.2.0 that implements
`getEncryptionKeyForRun()` give ciphertext at rest for every kind of user
payload, and what stays readable?

## Verdict

**Yes for every payload the SDK serializes, M1–M8 included.** A thin wrapper
(`world/src/index.ts`, about 70 lines, plus a 190-line key store) around the
stock `createWorld()` makes the real SDK runtime (workflow 5.5.0, spec 8)
write AES-256-GCM ciphertext for workflow input, step input, step return,
hook metadata, hook payload, stream chunks, workflow return **and step error
text**. A scan of all 144 columns of all 18 tables in every non-system schema
(raw, hex, base64 at three alignments, plus CBOR-decoded and zstd/gzip-
decompressed views) finds none of the eight markers, while the run completes
and reads back through the SDK. The identical scenario on the stock World
exposes all eight (control). The run survives SIGKILL between hook creation
and resume; a restarted process derives the same key. Shredding a run's key
leaves its metadata rows and makes every payload read fail.

**But "ciphertext at rest" is not "nothing readable".** Names, ids, hook
tokens, timestamps, attributes, statuses, step/run timing counters, the
runtime's Node/core versions and each run's X25519 public key stay
plaintext (full list below). Plaintext also leaks outside Postgres: the SDK
logs step errors (message and stack) to stdout. And the stock upstream web
observability UI hands the raw run key to whoever can reach it.

## What was built

`world/` — drop-in `packages/world` (own package.json, tsconfig, src, test):

- `src/keyring.ts` — `KeyProvider` interface (`activeKekId`, `hasKek`,
  `wrap(kekId, dataKey, aad)`, `unwrap(kekId, wrapped, aad)`) and
  `LocalKeyring`: a JSON keyring file `{active, keys: {id: base64}}` kept
  outside Postgres. Wrap = AES-256-GCM, `iv(12) ‖ ct(32) ‖ tag(16)`.
- `src/key-store.ts` — `RunKeyStore`: one random 32-byte data key per run,
  stored wrapped in **our own** table `os_world.run_keys` (own schema, own
  idempotent migration under a Postgres advisory lock). AAD =
  `["os-world/run-key/v1", runId, tenantId, kekId]`, so a wrapped key cannot
  be moved to another run, tenant or KEK id. `getOrCreate` = `INSERT … ON
  CONFLICT DO NOTHING` then read (concurrent first uses converge). `rewrap()`
  re-encrypts every live key under the active KEK (optimistic per-row
  update, keyset pagination, bad rows reported instead of aborting the
  rotation). `shred(runId)` destroys the wrapped key and leaves a tombstone
  (`shredded_at`), so a later key request throws instead of minting a new
  key. Unwrapped keys are cached in process for `cacheTtlMs` (default 60 s).
- `src/index.ts` — `createEncryptedWorld({postgres, keyProvider, …})`: calls
  upstream `createWorld(config.postgres)` and adds
  `getEncryptionKeyForRun` (both call shapes) and a `start()` that runs our
  migration first. It **never returns undefined**: invalid run ids, missing
  keys, tombstones and unwrap failures throw. Reads `context.osTenantId`
  (passed as a `start()` option) into the key row and AAD.
- `src/target.ts` — `WORKFLOW_TARGET_WORLD=@askgina/os-world/target`
  module (reads `WORKFLOW_POSTGRES_URL`, `OS_WORLD_KEYRING`).
- `test/key-store.test.ts` — 11 vitest tests against real Postgres 18.

`harness/` — the proof host and scanner:

- Host: **`workflow build` standalone target + a Hono server** (`server.ts`)
  that mounts `.well-known/workflow/v1/flow.mjs`. This is the smallest host
  the SDK supports: no framework, the same shape upstream's own conformance
  server uses (`refs/workflow/packages/world-testing/src/server.mts`), and the
  Postgres World's graphile-worker delivers queue messages to that flow route
  over loopback HTTP (`refs/workflow/packages/world-postgres/src/queue.ts:655-677`).
- `workflows/markers.ts` — the marker workflow; `world.ts` — harness World
  (encrypting, or stock with `OS_SPIKE_STOCK=1`, instrumented to log key
  requests); `scan.ts` — the column scanner; `proof.ts` — the proof;
  `conformance/encrypted.test.ts` — upstream's suite.

## Exact versions

Node v26.2.0, bun 1.4.4, Docker `postgres:18-alpine` (image `sha256:101873345701…`).
From `bun.lock`: workflow 5.5.0, @workflow/core 5.5.0, @workflow/world 5.2.0,
@workflow/world-postgres 5.2.0, @workflow/world-testing 5.1.0, pg 8.23.1,
cbor-x 1.6.9, hono 4.13.18, @hono/node-server 2.1.8, vitest 5.1.0,
typescript 7.0.2. Specs run at the default spec version 8. Source refs:
`refs/workflow` at 47ae6d1 (see refs/README.md).

## Findings

All proof numbers below come from the last `./verify.sh` run
(`.tmp/proof-report.json`, regenerated each run).

### 1. Ciphertext at rest (proof steps 1 and 2)

Markers: `OSMARK<n>_<random nonce>`. M1 = workflow input, M2 = step input,
M3 = step return, M4 = hook metadata, M5 = hook payload (`resumeHook`),
M6 = stream chunk, M7 = workflow return, M8 = `FatalError` message thrown
in a step. M6 and M8 are built inside their steps, so they reach storage
only as a stream chunk and as error text (an earlier draft passed them as
step arguments and they showed up in `workflow_steps.input_cbor`, which
would have masked where error text goes).

```
[proof] encrypted World: run completed after SIGKILL+restart; 0 marker hits in 144 columns
[proof] stock World control: all 8 markers found in plaintext
```

- Read-back through the SDK on the encrypting World: `getRun().returnValue`
  = `{m1,m3,m5,m7,m8}` with the right markers, `getReadable()` first chunk =
  M6, `getHookByToken().metadata` = `{m4}` (asserted in `proof.ts`).
- Scan coverage: 18 tables, 144 columns, every non-system schema
  (`workflow`, `workflow_drizzle`, `graphile_worker`, `os_world`, `public`).
  bytea is scanned raw, CBOR-decoded, and with every `zstd`/`gzip`-prefixed
  byte string decompressed recursively; everything else as its `::text`.
  Needles: UTF-8, hex, base64 (3 alignments), base64url.
- The scanner needs the decompression layer. The SDK compresses payloads
  before encrypting them, and on the stock World a step error is stored
  zstd-compressed (`step_failed` payload starts `…eerror\330@Y\x01Tzstd(\265/\375`);
  without decompression the control misses M8. With it, the control finds M8 in
  `workflow_steps.error_cbor[utf8+decoded]` and `workflow_events.payload_cbor`.
- **M8 (error text) is encrypted** on the encrypting World:
  `workflow_steps.error_cbor` starts `encr` and the `step_failed` event's
  `error` field is `<372 bytes, prefix encr>`. `world.steps.list()` returns
  the error as opaque bytes. Upstream's doc list of encrypted fields omits
  errors (`docs/how-it-works/encryption.mdx` in `workflow@5.5.0`,
  "What is encrypted"); the runtime encrypts them anyway.
- Formats seen: `encr` = AES-256-GCM under the run key; `encp` = sealed to
  the run's X25519 public key (hook payloads: the resumer never needs the
  symmetric key, `refs/workflow/packages/core/src/runtime/resume-hook.ts:849`).
- While suspended on the hook and while a delivery was stuck retrying, the
  scan was also clean (`markerHitsWhileSuspended: {}`, `markerHitsWhileStuck: {}`).
- Upstream conformance (`@workflow/world-testing` 5.1.0, the suite upstream
  runs on its own Postgres World, `refs/workflow/packages/world-postgres/test/spec.test.ts`):
  on the encrypting World 8 passed, 12 failed, 10 skipped; on the stock World
  (same harness, `CONFORMANCE_WORLD=stock`, run once by hand) 20 passed,
  10 skipped. Every one of the 12 failures is `RuntimeDecryptionError`
  thrown in the **test process** by
  `hydrateWorkflowReturnValue(run.output, run.runId, undefined)`: the suite
  hard-codes no key (`node_modules/@workflow/world-testing/dist/src/addition.mjs:18`
  and siblings), so it cannot check outputs of any encrypting World. The
  10 skips are the same on both (queue auth `skip` in the Postgres World).
  `verify.sh` fails if any failure is anything else. One hand run also hit
  `TypeError: fetch failed … bad port` in "refuses a stale in-band write":
  the suite listens on port 0 and can land on a WHATWG-blocked port; the
  previous run passed it, and `verify.sh` uses `--retry=1` [INFERENCE: flake].

### 2. What stays plaintext (proof step 5)

From the decoded rows of the encrypted run (`plaintextInventory` in the report):

| Where                           | Plaintext                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow_runs`                 | `id`, `deployment_id` (`"postgres"`), `status`, `name` (workflow id incl. source path `workflow//./workflows/markers//markers`), all timestamps, `attributes` (jsonb, e.g. `{"$retention":"0"}`), `encryption_public_key`, `job_prefix`, `spec_version`, `execution_context_cbor` = `{"traceCarrier":{},"workflowCoreVersion":"5.5.0","nodeVersion":"26.2.0","features":{"encryption":true},"hookResumeInputVersion":1}` |
| `workflow_steps`                | `step_id`, `step_name` (with source path), `status`, `attempt`, timestamps; `input_cbor`/`output_cbor`/`error_cbor` are `encr`                                                                                                                                                                                                                                                                                           |
| `workflow_events`               | `id`, `type`, `correlation_id`, timestamps, `resume_id`, `resume_payload_digest`; inside `payload_cbor`: `stepName`, `workflowName`, `deploymentId`, `ownerMessageId`, timing/optimizer counters (`ttfs`, `rsfs`, `stso`, `stepCount`, `eventCount`, `optimizations`), **hook `token`**, `isWebhook`, `encryptionPublicKey`, `executionContext`                                                                          |
| `workflow_hooks`                | token, ids, owner/project/environment while the hook is live (rows are removed when the run ends)                                                                                                                                                                                                                                                                                                                        |
| `workflow_stream_chunks`        | `stream_id` (`strm_<runId>_user`), chunk id, `run_id`, `eof`, sizes; `data` is `encr`                                                                                                                                                                                                                                                                                                                                    |
| graphile-worker `_private_jobs` | task `workflow_flows`, `messageId`, workflow id, `idempotencyKey` (`hook-<id>`), attempts, and base64 JSON `{runId, runSpecVersion, traceCarrier, hookResumeTiming}`. No user payload: queue messages carry ids only (captured while a delivery was stuck, `stuckQueueJobs`)                                                                                                                                             |
| `os_world.run_keys`             | `run_id`, `tenant_id`, `kek_id`, timestamps (key itself wrapped)                                                                                                                                                                                                                                                                                                                                                         |
| sizes                           | every ciphertext length (≈ plaintext length after compression)                                                                                                                                                                                                                                                                                                                                                           |

- `resume_payload_digest` is SHA-256 of the **sealed ciphertext**, not of the
  payload (checked: `sha256(payload) === digest` with payload prefix `encp`),
  so it does not allow guessing low-entropy hook payloads like "approve".
- Outside Postgres: the SDK prints step errors with message and stack to
  stdout (`FatalError: OSMARK8_… at failingStep (…/flow.mjs:…)` in the server
  log). Logs are a plaintext channel this World does not control.

### 3. Crash, restart, replay (proof step 3)

Process A starts the run, waits for the `workflow_hooks` row, reads the
stream, then gets `SIGKILL`. Process B (fresh process, empty key cache)
resumes the hook and the run completes with all markers. B's key store
did one DB read and one unwrap, then served 5 requests from cache.

### 4. Shred (proof step 4)

After `shred(runId)`: `getRun().returnValue` and the stream both fail with
`RunKeyShreddedError`; `getHookByToken` says `Hook not found` (the hook was
already consumed). Rows remaining: `{runs:1, events:14, steps:3,
stream_chunks:1, status:'completed', keys:0, tombstone:true}`.
First implementation deleted the key row; the next read then **minted a new
key** for the shredded run (data stayed unreadable, but a key existed again).
Fixed with a tombstone; unit test "shred destroys the key, leaves a
tombstone, and never re-mints".

### 5. Fail closed

- `getEncryptionKeyForRun` throws at `start()`: `start()` rejects with our
  error and **no run row is written** (`runsAfterFailedStart: []`).
- Throws during replay (key available at start, process restarted with a
  failing provider, hook resumed): `resumeHook` still returns 200 (the payload
  is sealed to the run's public key, no key lookup), the flow delivery fails
  (`[Graphile Worker] Failed task … attempt 1 of 73 … injected key failure`,
  logged as `code USER_ERROR`), the run stays `running` with no error, and
  graphile-worker retries. A process with the key restored completes the run
  with all markers. So a KEK/KMS outage stalls runs and does not fail them or
  fall back to plaintext; up to 73 attempts with backoff.

### 6. `context` and tenant binding

Observed contexts (key log): at `start()` `{"osTenantId":"ws_spike","deploymentId":"postgres"}`;
elsewhere `{"deploymentId":"postgres"}` or nothing (`null`), and the
`(run)` shape. `start()` passes its **whole options bag** plus
`deploymentId` (`refs/workflow/packages/core/src/runtime/start.ts:1341`),
so an extra start option reaches the World there and only there (the TS
type of `start()` options does not declare it; the harness casts). Other
call sites pass only `deploymentId` (`resume-hook.ts:215`,
`serialization.ts:2925`, `run.ts:299`). `deploymentId` is always the
constant `"postgres"` on this World. Consequence: tenant must be bound when
the key is created at start (we store it in the row and the AAD) and looked
up by run id afterwards. `createRunId(options)` is a second hook that sees
start options (`refs/workflow/packages/world/src/interfaces.ts:998`).

### 7. Operator debugging

- CLI works: `workflow inspect run <id> --backend ./world.ts` shows
  `input: 🔒 Encrypted`; with `--decrypt` it prints the decrypted input and
  output (ran it against a completed run). Requires the keyring on the
  operator's machine, i.e. full read access to every run; no audit trail.
- Web UI: not run. Source: its RPC `getEncryptionKeyForRun` returns the raw
  run key to the browser
  (`refs/workflow/packages/web/app/server/workflow-server-actions.server.ts:1382-1405`),
  and the Postgres World docs say observability has no auth. Running
  `workflow web` with this World's keyring is an unauthenticated key oracle
  [INFERENCE from source].

### 8. Upgrades and migrations

- Upstream `bootstrap` creates/migrates `workflow`, `workflow_drizzle`,
  `graphile_worker` (observed `\dn`); ours only `os_world`, idempotent,
  advisory-locked, run by `start()`. They do not touch each other, so order
  does not matter.
- The derived World inherits upstream's `specVersion`
  (`mintedSpecVersion(process.env, {inBandFence})`,
  `refs/workflow/packages/world-postgres/src/index.ts`) and capabilities
  unchanged, so the "keep `workflow` and `@workflow/world-postgres` on the
  same release cycle" rule applies as-is (postgres.mdx line 55). Spec 9 is
  opt-in via `WORKFLOW_SPEC_VERSION=9`; not tested here.
- Hazard [INFERENCE]: any future upstream migration that rewrites payload
  columns in SQL (re-encoding CBOR, moving JSONB twins) cannot work on
  ciphertext; migrations 0027/0028 touch only timestamps, hooks and locks.
- Hazard: we pass an explicit `PostgresWorldConfig`, so upstream's
  env-derived defaults in its zero-arg `createWorld()`
  (`WORKFLOW_POSTGRES_POLL_INTERVAL_MS`, `…_INVOKE`, `…_APPLICATION_MANAGED_SHUTDOWN`)
  must be mirrored in `target.ts` (only job prefix and concurrency are today).

### 9. Cost: how often the key is asked for

One run (3 steps, 1 stream, 1 hook, 2 processes): **16 calls**
(`runId` shape 9, `run` shape 7): 10 in process A until suspension, 6 in
process B from resume to completion. With the 60 s cache: 3 DB reads,
1 insert, 2 unwraps, 14 cache hits. So a cache is essential (a KMS round
trip per call would multiply latency ~16× per run); a TTL of about a minute
covers a whole run segment, and shred only evicts the local process (other
processes keep serving a shredded key until their TTL expires).

### 10. Retention

`experimental_retention: 0` works on the Postgres World with our World:
the run's `expired_at` is set, `input_cbor`/`output_cbor` are NULL, no event
keeps a payload, `attributes` = `{"$retention":"0"}`, and reading the result
throws `RunExpiredError`. Only zero is implemented
(`purgeRunUserDataIfZeroRetention`, `refs/workflow/packages/world-postgres/src/retention.ts`);
there is no sweeper for non-zero windows [from source; not run]. Our key row
stays live after the purge (`ourKeyStillLive: true`).

## Design decisions this forces

1. Use this World. Ciphertext at rest for all payloads is real with ~260
   lines; no fork of upstream needed.
2. Never return `undefined` from the key method; throw. Upstream turns
   `undefined` into silent plaintext.
3. Shred = tombstone, never delete; `getOrCreate` must refuse tombstones.
4. Bind tenant at `start()` (option → context) into the key row and AAD;
   everything after start is keyed by run id only.
5. Cache unwrapped keys in process (≈60 s) — and treat shred as effective
   only after that TTL fleet-wide (or add cross-process invalidation via
   `LISTEN/NOTIFY`).
6. Treat names, ids, hook tokens, timings and attributes as visible to
   anyone with DB read. Hook tokens are bearer secrets in the event log: use
   random tokens, and never put user data in workflow/step names, attributes
   or tokens.
7. Never run upstream `workflow web` with production keys; build our own
   authenticated, audited decrypt path (or a debug-only key provider).
8. Scrub logs: the SDK prints step error text and stacks to stdout.
9. Hook retention 0 into our key store (shred the key when a run expires)
   so expiry is also crypto-erasure.
10. KMS outage = stalled runs with 73 graphile retries; alert on
    key-provider (wrap/unwrap) failures and stuck deliveries, not on run failures.
11. Upstream's conformance suite cannot test encrypting Worlds' outputs; keep
    our own marker scan as the regression test.

## How to rerun

```
# SKIP_CONFORMANCE=1 ./verify.sh skips the 80 s upstream suite
```

It removes and recreates `osspike-world-pg` (127.0.0.1:55610), installs with
the frozen lockfile, typechecks, runs unit tests, builds the workflow,
runs `harness/proof.ts` (servers on 55611-55619) and the conformance suite,
then removes the container.

## Builds and heavy runs I did (Main's rule)

- `workflow build` (standalone): 16.7 s, 8.5 s, 10.9 s, plus one inside each verify run (~11 s).
- `bun install`: 3 times, ≤5 s each.
- world/ vitest: 4 runs, 5–18 s. Conformance suite: 4 runs, ~80 s each.
- `./verify.sh`: full run 3 m 06 s (last run, exit 0).

## Not checked

- Spec 9 (`WORKFLOW_SPEC_VERSION=9`), invoke mode, `start({experimental_hook})`,
  webhooks (`resumeWebhook`), `sleep`, child runs: payload paths beyond the eight markers.
- The web UI (only read its source). Non-zero retention windows.
- Health-check probes call `getEncryptionKeyForRun(probeRunId)` before the
  run exists (`refs/workflow/packages/core/src/runtime/helpers.ts:222`), which
  with our World would mint a key for a run that may never be created
  [INFERENCE; not exercised].
- Multiple Node hosts/replicas; KMS provider; the X25519 sealed path from
  another deployment; performance under load.
- The conformance suite opens servers on random ports outside 55610-55619
  (it listens on port 0); Docker stayed inside the range.

## verify.sh tail (last run)

```
[proof] encrypted World: run completed after SIGKILL+restart; 0 marker hits in 144 columns
[proof] shred: payload reads fail, metadata rows remain {
  runs: 1, events: 14, steps: 3, stream_chunks: 1, status: 'completed', keys: 0, tombstone: true
}
[proof] stock World control: all 8 markers found in plaintext
[proof] report written to .tmp/proof-report.json

== upstream World conformance suite (@workflow/world-testing 5.1.0) on the encrypting World (14:29:59)
conformance: 8 passed, 12 failed (test-side decrypt), 10 skipped
  decrypt-only failure: runs an addition
  … (12 listed, all RuntimeDecryptionError in the test process)

== PASS (14:31:38)
real	3m5.636s
```
