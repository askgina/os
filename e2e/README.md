# @askgina/os-e2e

The release gates: end-to-end tests that `./e2e/run.sh` runs against the whole Compose stack, built from this checkout. They drive real Postgres, the real signer and its vault, the real workflow runtime, a local chain, both reverse proxies and the confirmation page, with people holding software or browser passkeys and agents connecting over MCP. The Kubernetes gates are the same kind of test against a throwaway kind cluster, run by `./e2e/run-k8s.sh`.

What they do not cover: no gate uses a public chain, the real Hyperliquid venues or real funds, a hardware security key, or a certificate from a public authority (the HTTPS gate uses Caddy's local one).

They build the images and start several stacks one after another, so a full run takes a long time. CI runs them on every push to `main` and every pull request. You can run them on your own machine, but you do not need to for most changes: the unit tests and type checks in each workspace cover those.

## The gates

The tests of a spec file run one at a time, in order. Most files share one installation's state from their first test to their last, so a single test cannot run alone.

| File                         | What it proves                                                                                                                                                                                                                                                                                                                                              | CI job                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `test/release-gates.spec.ts` | One installation's life through the API: setup, limits, payments approved on the confirmation page, refusals, crash and backup recovery, the audit chain, plaintext scans, mandates, notifications, reprices and cancels.                                                                                                                                   | `stack (amd64)`, `stack (arm64)`, `stack (split)`, `stack (replicas)`, `stack (openbao)` |
| `test/lifecycle.spec.ts`     | Retiring a wallet, exporting its key, deleting a workspace and what it leaves, templates, records, cloning and erasing a person.                                                                                                                                                                                                                            | `stack (amd64)`, `stack (arm64)`                                                         |
| `test/venue.spec.ts`         | Hyperliquid orders on testnet and mainnet against two fake venues that verify every signature themselves, and the agents' venue reads: each network's own prices from the `agents` network, an order priced from the book, its position and fill with the intent's id, the wallets an agent may not read, and the read budget. Nothing reaches Hyperliquid. | `stack (amd64)`, `stack (arm64)`                                                         |
| `test/browser.spec.ts`       | One person's first day through the real UI in Chromium with a virtual authenticator, every approval on the confirmation page.                                                                                                                                                                                                                               | `stack (amd64)`, `stack (arm64)`, and over HTTPS in `stack (tls)`                        |
| `test/split.spec.ts`         | The signer and its confirmation page in a second Compose project, as on their own host, joined to the control plane only by mutual TLS.                                                                                                                                                                                                                     | `stack (split)`                                                                          |
| `test/replicas.spec.ts`      | Two server replicas on one database: setup, a replica killed while signing, notifications and rate limits counted once.                                                                                                                                                                                                                                     | `stack (replicas)`                                                                       |
| `test/openbao.spec.ts`       | The key-encryption key in OpenBao Transit only: least privilege, OpenBao paused, key rotation and rewrap.                                                                                                                                                                                                                                                   | `stack (openbao)`                                                                        |
| `test/kubernetes.spec.ts`    | The kind overlay: two ready server replicas, network isolation, setup and one payment approved on the confirmation page.                                                                                                                                                                                                                                    | `k8s`                                                                                    |
| `test/kubernetes-ha.spec.ts` | Postgres as a three-instance CloudNativePG cluster: a payment lands once while the primary is deleted, and a write waits when no standby can confirm it.                                                                                                                                                                                                    | `k8s-ha`                                                                                 |

The names of the tests say exactly what each one asserts; read them with `rg -n '^test\(' e2e/test`.

## Compose overlays

Every overlay here is test equipment. Never use one for a real deployment.

| File                         | What it adds                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.e2e.yaml`           | Always on: Postgres and the chain on loopback ports for the tests, a webhook receiver the server notifies, a shorter wait before an automatic reprice, Caddy access logs, and a signer that accepts a key destruction time seconds ahead. |
| `compose.lifecycle.yaml`     | Web Push on, toward a push service that never resolves, for the lifecycle gates' own stack.                                                                                                                                               |
| `compose.venue.yaml`         | Two fake Hyperliquid venues, testnet and mainnet, and the server's `VENUES_FILE` naming both (`venues.json`).                                                                                                                             |
| `compose.replicas.yaml`      | Two server replicas.                                                                                                                                                                                                                      |
| `compose.openbao.yaml`       | A real OpenBao server, its bootstrap, and a server with `KEY_PROVIDER=openbao` and no keyring file.                                                                                                                                       |
| `compose.split-control.yaml` | Over `deploy/split/control.compose.yaml`: the control project's test ports, its side of the shared network, and its edge on a loopback port.                                                                                              |
| `compose.split-signer.yaml`  | Over `deploy/split/signer.compose.yaml`: the signer project's side of the shared network and a plain-HTTP confirmation page on a loopback port.                                                                                           |

`src/` holds what the gates share: a person driving the API with a software passkey (`person.ts`), an agent's MCP connection (`agent.ts`), the local chain (`chain.ts`), the stack's Compose project and ports (`stack.ts`), the webhook receiver and its checks (`webhook-receiver.mts`, `webhook.ts`), the fake venues' service (`fake-hyperliquid.mts`) and helpers (`venue.ts`), the OpenBao bootstrap (`openbao-bootstrap.mts`), and a funded installation for the variant gates (`installation.ts`).

## Running them

Both scripts need Docker with Compose and Chromium for Playwright (`cd e2e && bunx playwright install chromium`, after `bun install`). Each starts throwaway projects, prints the logs of the services when a gate fails, and removes everything at the end.

`./e2e/run.sh` with no variable runs four fresh stacks in turn, each step only if the one before passed: `release-gates.spec.ts`, then `lifecycle.spec.ts`, then `venue.spec.ts`, then `browser.spec.ts`. At most one of these variables may be `1`:

| Variable         | What runs                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `E2E_TLS=1`      | `browser.spec.ts` only, over HTTPS with `compose.tls.yaml`. Needs ports 80, 443 and 8443 free.                                |
| `E2E_SPLIT=1`    | `split.spec.ts`, then `release-gates.spec.ts` on the same split stack. Needs `openssl`, and `sudo nft` for the nftables gate. |
| `E2E_REPLICAS=1` | `replicas.spec.ts`, then `release-gates.spec.ts` on a fresh two-replica stack.                                                |
| `E2E_OPENBAO=1`  | `openbao.spec.ts`, then `release-gates.spec.ts` on a fresh stack of the same kind.                                            |

`./e2e/run.sh --keep` leaves the last stack running afterwards, for looking around. Without TLS the stack listens on `http://localhost:25902` and the confirmation page on `http://localhost:25903`; the gates' other ports are between 25900 and 25907. `HTTP_PORT`, `APPROVE_HTTP_PORT` and the `E2E_*_PORT` variables in `run.sh` move them.

`./e2e/run-k8s.sh` builds the server, signer and `approve` images, starts a kind cluster, applies `deploy/k8s/overlays/kind`, publishes the two origins with `kubectl port-forward` and runs `kubernetes.spec.ts`. `--ha` applies `deploy/k8s/overlays/kind-ha` after installing the CloudNativePG operator and runs `kubernetes-ha.spec.ts` instead. `--keep` leaves the cluster running. It needs `docker`, `kind`, `kubectl`, `curl` and `sha256sum`; the versions CI pins are in `.github/workflows/ci.yml`.

## Checking a change

Type-check this workspace from the repository root:

```sh
cd e2e && ../node_modules/.bin/tsc --noEmit
```

The gates themselves run in CI: the `stack` jobs run `./e2e/run.sh` with the variables above, `k8s` runs `./e2e/run-k8s.sh` after validating every Kubernetes overlay, and `k8s-ha` runs `./e2e/run-k8s.sh --ha`. When a `stack` job fails, CI keeps the Playwright traces as an artifact.
