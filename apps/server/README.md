# @askgina/os-server

The control plane. It keeps people, workspaces, agents, wallets and approval requests in Postgres, serves the web UI and its API, and runs the MCP gateway agents connect to. It asks the signer for every signature and every change of authority, and it follows each approval with a durable workflow until the result is final.

It holds no wallet key and cannot approve anything. The design treats it as something that could be compromised: a person approves on the signer's confirmation page (`apps/approve`, at `APPROVE_ORIGIN`), and the signer checks that approval and the wallet's policy itself. What a compromised control plane can and cannot do is in [`docs/threat-model.md`](../../docs/threat-model.md); how it fits with the other parts is in [`docs/architecture.md`](../../docs/architecture.md).

## How it fits

- People reach it through Caddy at `PUBLIC_ORIGIN`: the UI built from `apps/web`, the API defined in [`packages/api`](../../packages/api/README.md), and `/healthz` and `/readyz`.
- Agents use only `/mcp`, with an agent token: through the public edge, or, from a container on the internal `agents` network, through the agent gateway (`deploy/Caddyfile.agents`). The tools are listed in `MCP_TOOL_NAMES` in `src/mcp/gateway.ts`. None signs, approves or administers.
- It calls the signer at `SIGNER_URL` with a request signature (`SIGNER_HMAC_SECRET_FILE`), over mutual TLS when the signer runs on its own host. The contract is [`packages/protocol`](../../packages/protocol/README.md).
- It reaches the chains in `CHAINS_FILE` to read and broadcast, and the venues in `VENUES_FILE` to post signed orders.
- What people and agents type is stored sealed with per-workspace data keys ([`packages/keys`](../../packages/keys/README.md)); the workflow runtime stores its data encrypted through [`packages/world`](../../packages/world/README.md).

## Layout

| Path                    | What it holds                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`           | Boot: configuration, migrations, key provider, signer client, the public listener and the loopback listener for workflow deliveries, background work, shutdown.        |
| `src/config.ts`         | Every setting, read and checked once at boot.                                                                                                                          |
| `src/cli.ts`            | The operator command `setup-token`.                                                                                                                                    |
| `src/http/`             | The public app and the internal app, the route binding for `packages/api`, error mapping, and serving the built UI.                                                    |
| `src/identity/`         | Passkeys, sessions, setup of the first owner, and erasing a person (`erase-cli.ts` is the operator's form of it).                                                      |
| `src/directory/`        | Workspaces, members and roles, agents, wallets, approvers and the audit log's views.                                                                                   |
| `src/execution/`        | The approval engine and the intents, transactions, mandates, sweeps, orders, reprices and cancels it runs; chains, the Hyperliquid venue client, the workflow runtime. |
| `src/lifecycle/`        | Retiring wallets, deleting workspaces, templates, cloning, exporting a workspace's record, and `verify-record.ts`.                                                     |
| `src/notify/`           | The outbox that sends the operator's webhook and Web Push notifications.                                                                                               |
| `src/mcp/gateway.ts`    | The MCP gateway: agent tokens, the tools, per-agent rate limits.                                                                                                       |
| `src/db/`               | The schema (`schema.ts`), sealed columns (`sealed.ts`), the SQL migrations and the code that applies them.                                                             |
| `src/audit.ts`          | The hash-chained audit log.                                                                                                                                            |
| `workflows/approval.ts` | One workflow run per approval request: it waits for the decision, applies it, and follows a transaction until it is final.                                             |

An approval's workflow run collects the decision from the signer by itself: 5 seconds after it starts, then at doubling intervals of at most two minutes, until a decision or the expiry. Nobody needs to come back to the page.

## Running it

In Compose it is the `server` service; see the [README](../../README.md) and [`deploy/README.md`](../../deploy/README.md). To run it directly, from `apps/server`:

```sh
bun run build:workflows   # writes the workflow bundle to .well-known/; boot refuses to start without it
node src/main.ts
```

It needs Postgres, a running signer, and the settings in `src/config.ts`. Required: `PUBLIC_ORIGIN`, `APPROVE_ORIGIN` (a different origin from `PUBLIC_ORIGIN`), `DATABASE_URL`, `SIGNER_URL`, `SIGNER_HMAC_SECRET_FILE` and `CHAINS_FILE`, plus a key provider: `KEYRING_FILE` by default, or `KEY_PROVIDER=openbao` with the `OPENBAO_*` settings. It listens on `PORT` (default 3000) and on `127.0.0.1:INTERNAL_PORT` (default 3001) for the workflow runtime's own deliveries, which are never on the public listener. A missing or invalid setting stops the boot; the log names the setting, never its value. `compose.yaml` shows a complete set.

The SQL migrations in `src/db/migrations/` are applied at every start, in name order, under a lock, so several replicas may start at once. To change the schema, edit `src/db/schema.ts` and run `bun run db:generate` in `apps/server`, which writes a new migration. An applied migration never runs again, so a change always goes in a new file.

Operator commands, run where the server runs, with its configuration:

| Command                                                      | What it does                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node apps/server/src/cli.ts setup-token`                    | Replaces the setup token and prints `{ "ok": true, "setupToken": … }`. After the first owner exists it prints `{ "ok": false, "code": "setup_done" }` and exits 3. |
| `node apps/server/src/identity/erase-cli.ts --user <usr_id>` | Erases a person who cannot sign in to do it themselves. Refused while their passkeys still approve somewhere.                                                      |
| `node apps/server/src/lifecycle/verify-record.ts <file>`     | Verifies an exported workspace record offline. Exits 0 when it verifies, 2 when it does not, 1 when the file cannot be read.                                       |

No boot creates a setup token and no log line carries one: `setup-token` is the only way to get one. With Compose: `docker compose exec server node apps/server/src/cli.ts setup-token`.

## Checking a change

From the repository root, after `bun install`:

```sh
cd apps/server && ../../node_modules/.bin/tsc --noEmit
```

```sh
bun run services:up
node_modules/.bin/vitest run apps/server/test/identity/identity.test.ts
```

Pick the test file in `test/` closest to your change. The tests start a real signer in process and use the throwaway Postgres and local chain that `bun run services:up` starts (`bun run services:down` removes them). `test/execution/workflow.test.ts` needs the workflow bundle, so leave it to CI.

CI runs the rest on every push and pull request: Biome, Oxlint and the type check in job `check`; every test file, after building the workflow bundle, in job `test`; the release gates against the whole Compose stack in the `stack` jobs; and the Kubernetes gates in `k8s` and `k8s-ha` (see [`e2e/README.md`](../../e2e/README.md)).
