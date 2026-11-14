# Running the stack

From a fresh clone:

    cp .env.example .env              # optional; the defaults run on http://localhost:8080
    docker compose --profile dev up -d --build

`--profile dev` adds a local chain (`anvil`). Without it, list real chains
in `deploy/chains.json` first.

For a public host name with HTTPS, set `OS_HOSTNAME` and `PUBLIC_HOST` in `.env` to the name and run
`docker compose -f compose.yaml -f compose.tls.yaml up -d --build`. Ports 80 and 443 must be
reachable so Caddy can obtain certificates. Changing the host name later invalidates every passkey.

## Services

| Service          | Purpose                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `init`           | Runs once at start; creates any missing secret in the secret volumes and never changes an existing one.                            |
| `postgres`       | Control-plane data and the encrypted Workflow history.                                                                             |
| `signer`         | Holds the wallets; verifies passkey approvals itself and signs at most once per approval. No outside access.                       |
| `server`         | UI, API, MCP gateway and the Workflow runtime.                                                                                     |
| `caddy`          | The only public entry point. Refuses `/.well-known/workflow/*` itself as a second lock.                                            |
| `agent-gateway`  | The only thing agent containers can reach. Forwards `/mcp` and nothing else.                                                       |
| `anvil`          | `dev` profile: a local chain (id 31337).                                                                                           |
| `scripted-agent` | An example agent, not started by `up`. `docker compose --profile dev run --rm -e AGENT_TOKEN=… -e TRANSFER_TO=0x… scripted-agent`. |

## Networks

| Network   | Members                                    | Why                                                                         |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `edge`    | caddy                                      | Where the published port lives.                                             |
| `control` | caddy, agent-gateway, server, postgres     | Proxies to the server; the server to Postgres.                              |
| `signing` | server, signer (internal)                  | The only path to the signer. No internet.                                   |
| `chain`   | server, anvil                              | RPC access for reading chains and broadcasting.                             |
| `agents`  | agent-gateway, agent containers (internal) | Agents reach `http://agent-gateway/mcp` and nothing else, not the internet. |

## Volumes

| Volume           | Holds                                                                                         | Read by  |
| ---------------- | --------------------------------------------------------------------------------------------- | -------- |
| `postgres-data`  | The database.                                                                                 | postgres |
| `signer-data`    | The wallet vault and the signer's SQLite (used approvals, policies, audit).                   | signer   |
| `server-secrets` | `keyring.json` (key-encryption keys), `signer-request-secret`, a copy of `postgres-password`. | server   |
| `signer-secrets` | `signer-request-secret`, `token-key`, `vault-passphrase`.                                     | signer   |
| `db-secrets`     | `postgres-password`.                                                                          | postgres |

## Backups and restoring

Back up `postgres-data`, `server-secrets`, `signer-data`, `signer-secrets` and `db-secrets`
together, from the same moment, with the stack stopped (`docker compose stop`):

- The database without the keyring is unreadable, and the keyring without the database is useless.
- `signer-data` is the wallets. Restoring an older copy would forget which approvals were used, so
  never restore it on its own.
- Without `vault-passphrase` new wallets cannot be created; without `token-key` existing wallets
  cannot sign.

One archive per volume, for example:

    docker run --rm -v os_signer-data:/v:ro -v "$PWD":/b alpine tar czf /b/signer-data.tgz -C /v .

Keep the archives encrypted; together they contain every key.

To restore onto a machine with no stack yet: create each volume from its archive
(`docker run --rm -v os_signer-data:/v -v "$PWD":/b alpine tar xzf /b/signer-data.tgz -C /v`),
then start the stack as usual. `init` leaves existing secrets alone. Keep the same
`PUBLIC_ORIGIN`: passkeys are bound to its host name.

A chain is not part of a backup. Approvals that were waiting when the backup was taken can still
be approved after the restore; approvals that were already used stay used.

## Rotating the keyring

The keyring holds the key-encryption keys that wrap every data key in the database. Rotating
re-wraps the data keys; it does not re-encrypt the data.

    docker compose run --rm init node /init/rotate-keyring.mjs add      # new key, made active
    docker compose restart server                                        # the server reads it at start
    docker compose exec server node packages/keys/src/cli.ts rewrap      # expect "failedCount":0
    docker compose run --rm init node /init/rotate-keyring.mjs prune --confirm-rewrapped
    docker compose restart server

Do not prune if rewrap reported failures: a data key still wrapped under a removed key can never
be read again. Back up `server-secrets` before and after.

## When no approver is left

Who may approve for a workspace is recorded in the signer, and normally changes only with a
passkey approval from an existing approver. If none is left (every approving passkey was lost),
the person registers a new passkey in the UI, where it waits as "pending", and the operator
enrolls it on the signer's host. The members page shows the command with its values filled in:

    docker compose exec signer node src/admin.ts enroll-approver \
      --workspace <workspace id> --user <user id> \
      --credential-id <credential id> --public-key <public key>

Whoever can run this command decides who approves. That is deliberate: access to the signer's
host is the root of trust in this design. The enrollment is written to the signer's decision log.

There is no way yet to sign in again after losing every passkey of an account. Register a second
passkey on another device while you can.

## Upgrading

    git pull
    docker compose --profile dev up -d --build

Database migrations run when the server starts. Take a backup first. The Workflow SDK and its
Postgres backend must stay on the same release line; this repository pins both.

## The setup token

Until the first owner exists, every start of the server prints a one-time setup token and retires
the previous one. Use the newest: `docker compose logs server | grep "setup token" | tail -1`.

## Stopping and removing

- Stop: `docker compose --profile dev stop`.
- Remove containers and networks, keep data: `docker compose --profile dev down`.
- Remove everything including all data and keys (irreversible): `docker compose --profile dev down -v`.
