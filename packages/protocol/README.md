# @askgina/os-protocol

This package is the approval protocol in code. It defines what an agent proposes (an intent), what a wallet allows (a policy), what a person approves with a passkey (an envelope), how each is hashed, and how an intent is checked against a policy. It also holds the signer's HTTP contract, a typed client for it, and the WebAuthn check the signer runs on every approval.

The specification is [`docs/approval-protocol.md`](../../docs/approval-protocol.md). Where this package and that document disagree, one of them has a bug.

## How it fits

The signer (`apps/signer`) uses it to verify approvals, evaluate intents and check its requests. The control plane (`apps/server`) uses it to build intents and envelopes and to call the signer. The confirmation page's service (`apps/approve`) uses the signer client to relay confirmations. The web UI (`apps/web`), the control plane's HTTP contract (`packages/api`) and the release gates (`e2e`) import its schemas and types.

The root export does no I/O: schemas, hashing and evaluation are pure functions. Only the `signer` and `signer-transport` exports reach the network or read files.

## Exports

| Import                                  | What it gives                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@askgina/os-protocol`                  | Identifiers, intents, policies, envelopes, mandates, sweeps, venues, digests, policy and mandate evaluation, and the signer's view of a request. |
| `@askgina/os-protocol/signer`           | The signer's HTTP API (routes, request and response schemas, error codes), its client, and the request signature.                                |
| `@askgina/os-protocol/signer-transport` | Mutual TLS to a signer on another host: reads the three PEM files and returns a `fetch` that pins the signer's certificate.                      |
| `@askgina/os-protocol/webauthn`         | `verifyAuthorization` and `verifyPossession`: the passkey checks the signer runs.                                                                |
| `@askgina/os-protocol/testing`          | A software passkey (`SoftAuthenticator`) and helpers that assert an envelope with it. For tests only.                                            |

## Layout

| Path                                   | What it holds                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/primitives.ts`                    | Identifiers, addresses, amounts, chain ids, and `PROTOCOL_VERSION`.                                                                                   |
| `src/canonical.ts`                     | Canonical JSON (RFC 8785) and the domain tags: every digest is `SHA-256(tag ‖ "\n" ‖ canonical JSON)`.                                                |
| `src/intent.ts`                        | Intents: a native or ERC-20 transfer, a contract call, a Hyperliquid order or withdrawal; `intentHash`.                                               |
| `src/policy.ts`                        | Wallet policies: who may propose, caps per asset, recipients, contract calls, venue rules, threshold; `policyHash`.                                   |
| `src/envelopes.ts`                     | Envelopes, one kind per thing people authorize, and `envelopeChallenge`, the digest a passkey signs.                                                  |
| `src/evaluate.ts`                      | `evaluateIntent`: whether a policy allows an intent, and the refusal codes.                                                                           |
| `src/mandate.ts`                       | Mandates (approval given in advance for a series of transfers), their checks against a policy, and the digest of one use.                             |
| `src/sweep.ts`                         | Sweeps: emptying a wallet without an agent, to an allowed recipient or a treasury wallet.                                                             |
| `src/venues.ts`                        | Venue networks (Hyperliquid testnet and mainnet) and decimal arithmetic for orders.                                                                   |
| `src/confirmation.ts`                  | `renderConfirmation`, the view the signer builds from its own records for the confirmation page, and the possession challenge for adding an approver. |
| `src/signer/api.ts`                    | `signerRoutes`: every signer route, the secret that signs it, its schemas, and `SignerErrorCode`.                                                     |
| `src/signer/client.ts`                 | `createSignerClient` for the control plane and `createConfirmClient` for the `approve` service.                                                       |
| `src/signer/request-signature.ts`      | The HMAC request signature between the signer and its two callers.                                                                                    |
| `src/signer/transport.ts`              | `readSignerTls` and `createSignerFetch`.                                                                                                              |
| `src/webauthn/verify-authorization.ts` | The WebAuthn checks: a `webauthn.get` made top-level on the confirmation page's origin, with user verification, over the envelope's digest.           |
| `src/testing/`                         | The software passkey and a minimal CBOR encoder it needs.                                                                                             |

## Changing it

`evaluateIntent` runs in two places: the signer runs it with its own ledger and its answer is final; the control plane runs it only to tell an agent early that a proposal cannot pass. A change here changes both.

A change to the shape or meaning of anything hashed (an intent, a policy, an envelope, a mandate, an audit entry) is a new protocol version, never an edit in place. Existing digests must keep their meaning. Section 12 of [`docs/approval-protocol.md`](../../docs/approval-protocol.md#12-versioning) says what does not count as a version change, such as a new envelope kind under its own structure. The pinned digest vectors in `test/digests.test.ts` and `test/lifecycle-envelopes.test.ts` fail when a digest moves; update the specification's test vectors (section 11) with them.

## Checking a change

From the repository root, after `bun install`:

```sh
cd packages/protocol && ../../node_modules/.bin/tsc --noEmit
```

```sh
node_modules/.bin/vitest run packages/protocol/test/digests.test.ts
```

Run the test file closest to your change from `packages/protocol/test/`. None of them needs `bun run services:up`. `signer-transport.test.ts` makes throwaway certificates with `openssl`, which must be on your `PATH`.

CI runs the rest on every push and pull request: Biome, Oxlint and the type check in job `check`, every test file in job `test`. The signer and the control plane exercise this package end to end in the release gates (see [`e2e/README.md`](../../e2e/README.md)).
