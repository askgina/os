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

- `KeyProvider`: `ready()`, `activeKekId()`, `wrap(kekId, dataKey, aad)`,
  `unwrap(kekId, wrapped, aad)`, `close()`. Every failure throws `KeyProviderUnavailableError`
  (retryable: no answer, a timeout, 429, 5xx, a sealed server) or `KeyProviderRefusedError`
  (permanent: the wrapped key does not open, the KEK or its version is unknown or retired, no
  permission). Messages carry KEK ids and HTTP statuses, never key material or AAD bytes. No
  provider falls back to another.
- `LocalKeyring`: a keyring file `{ "active": "k2", "keys": { "k1": "<base64>", "k2": "<base64>" } }`
  (each key 32 bytes, canonical base64; ids match `[A-Za-z0-9_-]+`). `LocalKeyring.generate()`
  makes a new one.
- `TransitKeyProvider`: an [OpenBao](https://openbao.org/) Transit key holds the KEK; KEK ids are
  `bao:<mount>/<key>@<version>`. The data key travels to OpenBao and back, so use an `https:`
  address between hosts. It signs in with a token file, AppRole or Kubernetes, renews its token
  at two thirds of its TTL, and reads the key's latest version again every `refreshSeconds`
  (default 300), so a rotation is picked up. One operation, its one retry included, takes at
  most `timeoutMs` (default 2000).
- `CompositeKeyProvider`: for moving from the file to Transit. New keys are wrapped under
  Transit only; `bao:` ids unwrap with Transit and file ids with the keyring.
- `keyProviderFromEnv(env, { keyringFileVariable })`: the provider the environment selects (see
  "Choosing the key provider"). Bad settings throw `KeyProviderConfigError`, whose `code` names
  the variable.
- `DataKeyStore`: `getOrCreate(scope, id, tenantId?)`, `get`, `rewrap`, `shred`,
  `shredTenant(scope, tenantId)`, in the table
  `os_keys.data_keys`, created by its own idempotent migration. The wrapping is bound to the
  scope (`run` or `workspace`), the id, the tenant and the KEK id, so a wrapped key copied to
  another row does not unwrap. A call that names a different tenant than the key was created
  for is refused (`DataKeyTenantMismatchError`). Every failure throws; there is no "no key" value.
  Every shred is announced on `LISTEN` channel `os_keys_shred` in its own transaction; a store
  created with `listen: true` and started with `start()` drops each announced key from its cache
  at once, and caches nothing while its listening connection is down. `close()` lets it go.
- `seal(key, bytes, context)` / `open`, `sealJson` / `openJson` (also at `@askgina/os-keys/seal`):
  AES-256-GCM, layout `version(1) || iv(12) || ciphertext || tag(16)`. `context` (for example
  `intents.payload:int_…`) is authenticated, so a sealed value moved to another row or column
  fails to open.

## What stays readable

Encryption covers payloads, not structure. In the workflow tables, names, ids, hook tokens,
timestamps, statuses and attributes stay readable; the full table is in the
[`@askgina/os-world` README](../world/README.md#what-stays-readable). In `os_keys.data_keys`:
scope, id, tenant id, KEK id and timestamps. Ciphertext lengths reveal plaintext lengths.

## Choosing the key provider

`KEY_PROVIDER=file` (the default) uses the keyring file named by `KEYRING_FILE` (the server and
the CLI) or `WORLD_KEYRING_FILE` (`@askgina/os-world/target`). `KEY_PROVIDER=openbao` uses Transit:

| Variable                                                 | Meaning                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OPENBAO_ADDR`                                           | The server, `https://…:8200` (`http:` only on one host)                                                                    |
| `OPENBAO_AUTH`                                           | `token`, `approle` or `kubernetes`                                                                                         |
| `OPENBAO_TOKEN_FILE`                                     | With `token`: a file holding the token                                                                                     |
| `OPENBAO_ROLE_ID_FILE`, `OPENBAO_SECRET_ID_FILE`         | With `approle`: files holding the role and secret ids                                                                      |
| `OPENBAO_KUBERNETES_ROLE`, `OPENBAO_KUBERNETES_JWT_FILE` | With `kubernetes`: the role, and the service account token (default `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_TRANSIT_KEY`           | Default `transit` and `os-kek`; the key must be `aes256-gcm96`, `aes128-gcm96` or `chacha20-poly1305`                      |
| `OPENBAO_CA_FILE`                                        | PEM CA for the server's certificate, when it is not a public one                                                           |
| `OPENBAO_TIMEOUT_MS`                                     | Per operation, 100 to 60000, default 2000                                                                                  |

Credential files are read at each login, so a sidecar may rewrite them. The token needs `update`
on `<mount>/encrypt/<key>` and `<mount>/decrypt/<key>` and `read` on `<mount>/keys/<key>`;
token lookup and renewal come from OpenBao's `default` policy. With `KEYRING_FILE` set as well,
the provider is the composite. When OpenBao is down, every operation that needs a key fails
with `KeyProviderUnavailableError` until it is back; shredding does not need it.

Move from the keyring file to OpenBao: set `KEY_PROVIDER=openbao` and the `OPENBAO_*`
variables, keep `KEYRING_FILE`, restart; run `node packages/keys/src/cli.ts rewrap` until it
reports `failedCount` 0; remove `KEYRING_FILE`; restart.

Rotate the Transit key: `bao write -f transit/keys/os-kek/rotate`; wait `refreshSeconds` (or
restart); run `rewrap`; then raise the key's `min_decryption_version` to the new version, after
which copies wrapped under older versions (in backups, too) no longer open.

## Operations

Every command reads `DATABASE_URL` and the key provider's variables above, and prints one JSON
line with ids and counts. Exit code 4 means the key provider could not be reached or refused;
rows `rewrap` moved before that stay moved, so run it again. `shred` and `shred-tenant` do not
contact the key provider.

Rotate the KEK in the keyring file:

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
Processes that already hold the key in memory and listen (the server does) drop it at once;
others keep it for up to their cache TTL (one minute by default), so a shred is complete across
the fleet only after that.

Shred every run key of one workspace (each key that was created with that tenant id):

    node packages/keys/src/cli.ts shred-tenant run ws_…

Each key becomes a tombstone as with `shred`. It exits 0 and reports the count as `shredded`;
0 is not an error, since a repeat finds nothing left. Keys created without a tenant id are not
found this way. The same cache TTL applies.

## Hazards

- **Never return `undefined` for a key.** The Workflow SDK reads a missing key as "store this
  run in plaintext". Every path in this package throws instead; keep it that way in any new
  `KeyProvider`.
- **Never run upstream's `workflow web` with this keyring.** Its server hands the raw run key to
  the browser without authentication: with the keyring it is an open decryption oracle.
- The keyring file is the root of all of this. Keep it out of the database and readable only by
  the service user. A backup needs both the database and the keyring from the same moment
  (see [`deploy/README.md`](../../deploy/README.md#backups-and-restoring)); store the two
  archives encrypted, and apart if you can, because together they read everything. A keyring that is not valid
  JSON is reported without quoting its contents.
- With Transit, the KEK never leaves OpenBao, but OpenBao, or anyone holding the server's
  OpenBao token, unwraps every data key it is given; with a database copy that reads everything.
  A backup then needs the database and an OpenBao that still holds the key versions it used.
