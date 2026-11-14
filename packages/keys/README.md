# @askgina/os-keys

Key management for data that askgina/os stores in Postgres: key-encryption keys (KEKs) kept
in a file outside the database, random 32-byte data keys kept inside it, wrapped under a KEK,
and `seal`/`open` for encrypting single values with a data key.

## The threat

Someone who gets a copy of the database (a leaked backup, a read-only SQL credential, a
compromised replica) should learn nothing that a person or an agent typed. So nothing readable
is stored: workflow payloads are encrypted by [`@askgina/os-world`](../world) with one data key
per run, and the control plane seals its own content columns with one data key per workspace.
The data keys are in the database only in wrapped form; unwrapping them needs the keyring file,
which lives on the host, not in Postgres. A database copy without the keyring is ciphertext.
This does not protect against someone who has both the database and the keyring, or who
controls a running server process.

## What it provides

- `LocalKeyring`: a keyring file `{ "active": "k2", "keys": { "k1": "<base64>", "k2": "<base64>" } }`
  (each key 32 bytes, canonical base64). `LocalKeyring.generate()` makes a new one. It
  implements `KeyProvider`, so a KMS-backed provider can replace it without other changes.
- `DataKeyStore`: `getOrCreate(scope, id, tenantId?)`, `get`, `rewrap`, `shred`, in the table
  `os_keys.data_keys`, created by its own idempotent migration. The wrapping is bound to the
  scope (`run` or `workspace`), the id, the tenant and the KEK id, so a wrapped key copied to
  another row does not unwrap. A call that names a different tenant than the key was created
  for is refused (`DataKeyTenantMismatchError`). Every failure throws; there is no "no key" value.
- `seal(key, bytes, context)` / `open`, `sealJson` / `openJson` (also at `@askgina/os-keys/seal`):
  AES-256-GCM, layout `version(1) || iv(12) || ciphertext || tag(16)`. `context` (for example
  `intents.payload:int_…`) is authenticated, so a sealed value moved to another row or column
  fails to open.

## What stays readable

Encryption covers payloads, not structure. In the workflow tables, names, ids, hook tokens,
timestamps, statuses and attributes stay readable; the full table is in the
[`@askgina/os-world` README](../world/README.md#what-stays-readable). In `os_keys.data_keys`:
scope, id, tenant id, KEK id and timestamps. Ciphertext lengths reveal plaintext lengths.

## Operations

Both commands read `DATABASE_URL` and `KEYRING_FILE` and print one JSON line with ids and counts.

Rotate the KEK:

1. Add a new key to the keyring file and make it `active`; keep the old one. Restart the
   services, so new data keys are wrapped under the new KEK.
2. `node packages/keys/src/cli.ts rewrap` re-wraps every live data key under the active KEK.
   The data keys themselves, and so everything encrypted with them, do not change. Exit code 2
   means some rows could not be unwrapped; they are listed as `failed`. Investigate them before
   going on: they may have been tampered with.
3. When `rewrap` exits 0, remove the old key from the keyring file and restart the services.

Shred (crypto-erase) one run or one workspace:

    node packages/keys/src/cli.ts shred run wrun_…
    node packages/keys/src/cli.ts shred workspace ws_…

The wrapped key is destroyed and a tombstone stays, so the id can never get a new key and
everything encrypted under the old one is unreadable for good. Exit code 3 means there was no
live key (already shredded, or never created); the tombstone is in place either way.
Processes that already hold the key in memory keep it for up to their cache TTL (one minute by
default); a shred is complete across the fleet only after that.

## Hazards

- **Never return `undefined` for a key.** The Workflow SDK reads a missing key as "store this
  run in plaintext". Every path in this package throws instead; keep it that way in any new
  `KeyProvider`.
- **Never run upstream's `workflow web` with this keyring.** Its server hands the raw run key to
  the browser without authentication: with the keyring it is an open decryption oracle.
- The keyring file is the root of all of this. Keep it out of the database, out of backups that
  sit next to the database, and readable only by the service user. A keyring that is not valid
  JSON is reported without quoting its contents.
