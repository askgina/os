# @askgina/os-testkit

Shared test support for the other workspaces: throwaway Postgres databases, a scanner that looks for plaintext in every column, a fake Hyperliquid venue that verifies signatures on its own, an independent msgpack encoder, and helpers for the OpenBao test server. It is test equipment. Nothing that runs in production imports it, and the fake venue must never be deployed or pointed at by a real wallet.

## How it fits

Test files in `apps/server`, `apps/signer`, `packages/keys`, `packages/world` and `examples/eve-agent` import it, and so do the release gates in `e2e`. The end-to-end stack also runs the fake venue as two Compose services (`e2e/compose.venue.yaml`, through `e2e/src/fake-hyperliquid.mts`).

It reaches only what a test points it at: the test Postgres, the OpenBao test server and its container, and nothing on the internet.

## Exports

| Import                                 | Source                    | What it gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@askgina/os-testkit`                  | `src/postgres.ts`         | `createTestDatabase(label)`: an empty database with a unique name on the test Postgres, and `drop()` to remove it. Test files never see each other's rows.                                                                                                                                                                                                                                                                                                                                |
|                                        | `src/scan.ts`             | `scanForMarkers(url, markers)`: looks for marker strings in every column of every table outside the system schemas. A test plants markers in everything a person or agent can type, runs the system, then requires that none is found.                                                                                                                                                                                                                                                    |
| `@askgina/os-testkit/fake-hyperliquid` | `src/fake-hyperliquid.ts` | `FakeHyperliquid`: the venue's `POST /exchange` and `POST /info`, close enough to prove the signer's signatures end to end. It recomputes every signing hash itself and recovers the signer from each request, on the testnet or on mainnet. It also answers the market and account reads the agents' read tools make (markets, mids, a book of levels, candles a test sets, fills, fee rates), and fails on request, also with a redirect or an answer larger than a client should read. |
| `@askgina/os-testkit/msgpack`          | `src/msgpack.ts`          | `referenceMsgpackEncode`, from the `@msgpack/msgpack` library: an encoder written by someone else, to check the signer's own encoder byte for byte.                                                                                                                                                                                                                                                                                                                                       |
| `@askgina/os-testkit/openbao`          | `src/openbao.ts`          | Helpers for the OpenBao test server: `openBaoReachable`, `prepareTransit` (a fresh Transit key and an AppRole limited to it), `holdOpenBao` (one file at a time across Vitest workers), and `pauseOpenBao` / `unpauseOpenBao`.                                                                                                                                                                                                                                                            |

The scanner checks each value as stored and in every form it decodes to: `bytea` is CBOR-decoded, and byte strings the Workflow SDK compressed are decompressed. Each marker is searched as UTF-8, as hex and as base64. A scan that finds nothing is the evidence for the claim that what people and agents type is stored encrypted.

The fake venue is stricter than the real one in places, so a request it accepts is one the real venue would accept. Its header comment in `src/fake-hyperliquid.ts` lists what it checks, where it is stricter and what it leaves out (fees, funding, liquidation, partial fills; `userFees` answers the venue's base rates though no fill here pays a fee). `test/fake-hyperliquid.test.ts` first holds it to signed requests made with the venue's own Python SDK, then tests its behaviour.

## Settings

| Variable                  | Default                                                 | Meaning                                                   |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `TEST_POSTGRES_URL`       | `postgres://postgres:postgres@127.0.0.1:55432/postgres` | The Postgres server test databases are created on.        |
| `OPENBAO_TEST_ADDR`       | `http://127.0.0.1:55820`                                | The OpenBao test server.                                  |
| `OPENBAO_TEST_ROOT_TOKEN` | `test-root`                                             | Its root token.                                           |
| `OPENBAO_TEST_CONTAINER`  | `os-test-openbao-1`                                     | Its container, which `pauseOpenBao` pauses with `docker`. |

The defaults match `deploy/compose.test.yaml`, which `bun run services:up` starts (Postgres, a local chain and a development OpenBao; `bun run services:down` removes them). Outside CI, the tests that need OpenBao skip themselves when it does not answer; in CI they fail.

## Checking a change

From the repository root, after `bun install`:

```sh
cd packages/testkit && ../../node_modules/.bin/tsc --noEmit
```

```sh
node_modules/.bin/vitest run packages/testkit/test/fake-hyperliquid.test.ts
```

That test needs no services. A change to the database or OpenBao helpers shows in the files that use them, for example `packages/keys/test/transit.test.ts`, which needs `bun run services:up` first.

CI runs the rest on every push and pull request: the type check in job `check`, every test file in job `test`, and the venue gates against the fake venues in the `stack (amd64)` and `stack (arm64)` jobs (`e2e/test/venue.spec.ts`).
