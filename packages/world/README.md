# @askgina/os-world

The Workflow SDK's Postgres World (`@workflow/world-postgres` 5.2.0) with payload encryption
switched on. A World is the Workflow SDK's name for its storage and job-queue backend. Every
workflow run gets its own random data key, kept wrapped in Postgres by
[`@askgina/os-keys`](https://github.com/askgina/os/tree/main/packages/keys), under a
key-encryption key (KEK) that lives outside the database, in a keyring file or in OpenBao
Transit.

It is part of the [askgina/os](https://github.com/askgina/os) repository, a self-hosted service
in which AI agents propose payments that people approve with passkeys; its control plane
(`apps/server`) runs its workflows on this World, and so does the example agent in
`examples/eve-agent`. It is published to GitHub Packages (`npm.pkg.github.com`) as
`@askgina/os-world`, as ES modules with type declarations, tested on Node 26; the entry points
are `@askgina/os-world` and `@askgina/os-world/target`.

**Status.** Proven in CI: the tests in `test/` (job `test`; see "What is proven" below); the
package built, packed and imported from its tarball by a separate project (job `packages`); the
control plane's workflows on it in every `stack` job.

## The threat

Upstream's Postgres World stores every workflow payload as readable CBOR: the inputs and outputs
of workflows and steps, hook payloads, stream chunks and error text. Anyone with a database copy
reads everything an agent or a person passed through a workflow. The SDK can encrypt these
payloads with AES-256-GCM, but only if the World supplies `getEncryptionKeyForRun()`, and the
Postgres World does not. This package adds that one method. A database copy without the keyring
then holds no payload in readable form. It does not protect against someone who has the keyring
or controls a running process.

Run attributes are the exception inside the SDK: it never encrypts them, on any World, and the
World and the runtimes built on it read some of them back, so they cannot be encrypted here
either. This World replaces the value of every attribute with `[withheld]` before it is stored,
unless you list the attribute's key as readable.

## Use

```ts
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import { createEncryptedWorld, TENANT_START_OPTION } from "@askgina/os-world";

const world = createEncryptedWorld({
  postgres: { pool },
  dataKeys: new DataKeyStore({ pool, provider: LocalKeyring.fromFile(keyringPath) }),
  // Optional. Attribute keys whose values may be stored readable; all others are withheld.
  readableAttributeKeys: ["kind"],
});
await world.start(); // runs the key-table migration, then upstream's start

// The tenant is bound into the run's key when the run is created, and only then:
await start(workflow, args, { [TENANT_START_OPTION]: workspaceId });
```

Frameworks that pick the World by module name can use
`WORKFLOW_TARGET_WORLD=@askgina/os-world/target`, configured by `WORKFLOW_POSTGRES_URL` (or
`DATABASE_URL`), `WORLD_KEYRING_FILE` (or `KEY_PROVIDER=openbao` with the `OPENBAO_*` variables
of `@askgina/os-keys`) and, optionally, `WORLD_READABLE_ATTRIBUTE_KEYS` (comma-separated). The
upstream pool and queue settings `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (default 50),
`WORKFLOW_POSTGRES_MAX_POOL_SIZE` (default that plus 2), `WORKFLOW_POSTGRES_JOB_PREFIX`,
`WORKFLOW_POSTGRES_POLL_INTERVAL_MS` and `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS` are passed
through.

### Run attributes

`$retention`, `$rootRunId` and `$parentRunId` always stay readable: the SDK needs them and they
hold a setting and two run ids. Every other attribute keeps its key and loses its value, at run
creation, on later `setAttributes` calls, and in the queued job that starts a run. Reading an
attribute back returns `[withheld]`.

One write is refused, not replaced: `setAttributes()` called in a workflow body with an unlisted
key. The SDK compares that stored event with the body's values on every replay, so a replaced
value would read as a diverged replay. The World rejects the write and the SDK fails the run
with `setAttributes failed World validation`. Set the attribute from a step, or list its key.

List a key as readable only if its value can never carry what a person or an agent typed. A
runtime that reads its own attributes back needs those keys listed: the eve agent runtime needs
its ids, kinds and version (see
[`examples/eve-agent`](https://github.com/askgina/os/tree/main/examples/eve-agent)), and its
session title, which is the first user message by default, must stay off the list.

## What is proven

`test/ciphertext-at-rest.test.ts` runs a workflow through the real SDK runtime (standalone build
on a small Hono host) that pushes ten unique markers through every payload kind (workflow
input, step input, step return, hook metadata, hook payload, stream chunk, workflow return and
step error text) and through two run attributes, one given at start and one set from a step
while the run is in progress. It then scans every column of every table, decoding CBOR and decompressing
zstd/gzip, for the markers as UTF-8, hex and base64. On this World: zero hits, also while the
run is suspended; the run completes after its host is killed with SIGKILL between hook creation
and resume; after shredding the run's key the result and stream can no longer be read while the
metadata rows remain; an attribute set in a workflow body under an unlisted key fails the run
and is not stored; and a key failure at start writes no run row. The identical scenario on the
stock World must expose all ten markers, or the test fails, because then the scanner is blind.
`test/conformance.test.ts` runs upstream's World conformance suite and allows only the failures
the suite causes itself by decoding outputs without a key. The suite writes one attribute,
`fence_probe`, as a workflow body would; the test World lists that key as readable.

## What stays readable

| Where                    | Readable                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_runs`          | id, status, workflow name (with source path), timestamps, attribute keys (values only for keys listed as readable), the run's X25519 public key, spec version, runtime and Node versions |
| `workflow_steps`         | step id, step name (with source path), status, attempt, timestamps                                                                                                                       |
| `workflow_events`        | id, type, correlation id, timestamps, digest of the sealed hook payload; inside the payload envelope: step and workflow names, timing counters, **hook tokens**                          |
| `workflow_hooks`         | token and ids while the hook is live                                                                                                                                                     |
| `workflow_stream_chunks` | stream id, run id, end-of-stream flag, sizes                                                                                                                                             |
| graphile-worker jobs     | task name, message ids, run ids, attempts (queue messages carry ids only)                                                                                                                |
| `os_keys.data_keys`      | scope, id, tenant id, KEK id, timestamps                                                                                                                                                 |
| everywhere               | ciphertext lengths, which follow plaintext lengths after compression                                                                                                                     |

Consequences: never put user content in workflow or step names, attribute keys or hook tokens, and
treat hook tokens as bearer secrets (random, never derived from user data). The SDK also prints
step error messages and stacks to stdout, which this World does not control: steps throw errors
that carry codes, never user content.

## Rotate and shred

Key rotation and crypto-erasure are done with the `@askgina/os-keys` CLI; see
[its README](https://github.com/askgina/os/tree/main/packages/keys#operations). Shredding a run (`cli.ts shred run wrun_…`) leaves its
metadata rows in place and makes every payload of that run unreadable. A KEK or keyring outage
does not fail runs or fall back to plaintext: deliveries fail and graphile-worker retries them,
so alert on key-provider failures and stuck deliveries, not on failed runs.

## Hazards

- **Never return `undefined` from `getEncryptionKeyForRun`.** Upstream treats it as "store this
  run in plaintext", silently. This World throws on every failure, including a malformed run id,
  a missing or shredded key, and a key that will not unwrap.
- **Never run upstream's `workflow web` with the keyring.** It returns raw run keys to the
  browser without authentication. Inspect runs with `workflow inspect` on a trusted machine, or
  not at all.

## Health probes

Upstream's `start()` sends a health probe that names the run it is about to create when the run
goes to another deployment, and the responding deployment asks its World for that run's key to
publish the run's public key. This was checked (`ciphertext-at-rest.test.ts`): the probe mints and
stores a key for the named run, without a tenant, before the run exists. It matters in two ways,
both small. If the start then fails, an orphan key row remains; it protects nothing and costs one
row. If the start then names a tenant, the key store refuses because the stored key has none, so
that start fails rather than binding the run to no tenant. A single-deployment install, which is
what askgina/os runs, never sends this probe: `start()` probes only for cross-deployment starts.

## Checking a change

In the repository, from its root, after `bun install`: `bun run check` (Biome),
`bun run lint:slop` (Oxlint with the repository's anti-slop rules), and
`cd packages/world && ../../node_modules/.bin/tsc --noEmit`. The test files are left to CI, like
every other step that builds: before they run, `test/global-setup.ts` builds the proof host's
workflows with the SDK's `workflow build`. They need the test services (`bun run services:up`:
Postgres, and OpenBao for the key-provider cases) and run one after the other, because their
hosts use fixed ports.

CI runs the tests in job `test`, the type-check in job `check`, and in job `packages` builds the
package (`bun run build` in `packages/world`), packs it with `scripts/pack-packages.mjs` and
imports and type-checks it from the tarball with `scripts/smoke-packed-world.mjs`. The workflow
`.github/workflows/packages.yml` does the same on a `world-v*` tag and then publishes.
