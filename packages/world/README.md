# @askgina/os-world

The Workflow SDK's Postgres World (`@workflow/world-postgres` 5.2.0) with payload encryption
switched on. Every workflow run gets its own random data key, kept wrapped in Postgres by
[`@askgina/os-keys`](../keys), under a key-encryption key that lives in a file outside the
database.

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

Frameworks that pick the World by module name can use `WORKFLOW_TARGET_WORLD=@askgina/os-world/target`,
configured by `WORKFLOW_POSTGRES_URL` (or `DATABASE_URL`), `WORLD_KEYRING_FILE` and, optionally,
`WORLD_READABLE_ATTRIBUTE_KEYS` (comma-separated).

### Run attributes

`$retention`, `$rootRunId` and `$parentRunId` always stay readable: the SDK needs them and they
hold a setting and two run ids. Every other attribute keeps its key and loses its value, at run
creation, on later `setAttributes` calls, and in the queued job that starts a run. Reading an
attribute back returns `[withheld]`.

List a key as readable only if its value can never carry what a person or an agent typed. A
runtime that reads its own attributes back needs those keys listed: eve needs its ids, kinds and
version (see [`examples/eve-agent`](../../examples/eve-agent)), and its session title, which is
the first user message by default, must stay off the list.

## What is proven

`test/ciphertext-at-rest.test.ts` runs a workflow through the real SDK runtime (standalone build
on a small Hono host) that pushes ten unique markers through every payload kind (workflow
input, step input, step return, hook metadata, hook payload, stream chunk, workflow return and
step error text) and through two run attributes, one given at start and one set while the run
is in progress. It then scans every column of every table, decoding CBOR and decompressing
zstd/gzip, for the markers as UTF-8, hex and base64. On this World: zero hits, also while the
run is suspended; the run completes after its host is killed with SIGKILL between hook creation
and resume; after shredding the run's key the result and stream can no longer be read while the
metadata rows remain; and a key failure at start writes no run row. The identical scenario on the
stock World must expose all ten markers, or the test fails, because then the scanner is blind.
`test/conformance.test.ts` runs upstream's World conformance suite and allows only the failures
the suite causes itself by decoding outputs without a key.

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
[its README](../keys/README.md#operations). Shredding a run (`cli.ts shred run wrun_…`) leaves its
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
