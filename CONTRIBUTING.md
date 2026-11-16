# Contributing

This page says how to set up, which checks to run before you push, where things are, what reviews
check, and how decisions are recorded.

## Set up

You need:

- [Bun](https://bun.sh) 1.4.4 (the version in `package.json`'s `packageManager`).
- Node.js 26 (see `.node-version`). The services run their TypeScript sources directly with
  Node's type stripping.
- Docker with Compose v2, for the test services.

From the repository root:

```sh
bun install
```

## Checks you run locally

CI is the authority for builds and for the whole test suite. Before you push, run the fast checks
and the test files that cover your change.

```sh
bun run check            # Biome: formatting and lint, Markdown and its tables included
bun run lint:slop        # Oxlint with the anti-slop rules (oxlint.config.ts)
bun run typecheck        # TypeScript in every workspace
```

`bun run format` applies Biome's fixes. To type-check one workspace only, run its compiler from
inside it: `cd apps/server && ../../node_modules/.bin/tsc --noEmit` (in `e2e`, the path is
`../node_modules/.bin/tsc`).

Run one test file at a time, from the repository root:

```sh
bun run services:up      # Postgres on 127.0.0.1:55432, a local chain (Anvil) on 127.0.0.1:55545,
                         # and a development OpenBao on 127.0.0.1:55820
node_modules/.bin/vitest run apps/signer/test/signing.test.ts
bun run services:down    # stop the test services and delete their data
```

Most test files need the test services. A few need the workflow bundle, which is a build, and run
in CI only: `apps/server/test/execution/workflow.test.ts` (it needs `bun run build:workflows` in
`apps/server` first) and the tests in `packages/world/test/` (their setup runs `workflow build`).

The web app's journeys run locally against the Vite dev server and a fixture API, with no build:
`cd apps/web && bunx playwright test --project=phone-light`. See
[`apps/web/README.md`](apps/web/README.md).

### The anti-slop rules

`bun run lint:slop` runs Oxlint with rules vendored in [`tools/oxlint/`](tools/oxlint/README.md).
They reject patterns such as unchecked type assertions, `unknown` parameters and `typeof` checks
outside input parsing. Errors fail CI; code-smell warnings do not. Fix the code: never disable or
downgrade a rule, and never add a disable comment, to make a change pass. A type assertion that
is truly needed carries a `// SAFETY:` comment that names the check that makes it safe. If a rule
is wrong for this repository, change it in `tools/oxlint/` and record why, as that directory's
README says.

### What CI runs

The `ci` workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull
request and every push to `main`:

| Job                                                    | What it runs                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                                                | A guard that the removed control-plane approval prompt has not come back, then `bun run check`, `bun run lint:slop` and `bun run typecheck`.                                              |
| `packages`                                             | Builds, packs and smoke-tests `@askgina/os-keys` and `@askgina/os-world` as another repository would install them.                                                                        |
| `test`                                                 | The test services, `bun run build:workflows` in `apps/server`, then `bun run test` (every Vitest project), then image builds of the eve and ntfy examples.                                |
| `ui`                                                   | The web app's Playwright journeys against its fixture API, then the web build.                                                                                                            |
| `stack (amd64)`, `stack (arm64)`, `stack (tls)`        | `./e2e/run.sh`: builds the images, starts the whole stack and runs the release gates. `tls` runs the browser gate over HTTPS only.                                                        |
| `stack (split)`, `stack (replicas)`, `stack (openbao)` | `./e2e/run.sh` with the signer on a separate Compose project, two server replicas, or OpenBao as the key provider: that variant's own gates, then every release gate.                     |
| `k8s`, `k8s-ha`                                        | The Kubernetes manifests validated, then installed on a throwaway kind cluster with the Kubernetes gates; `k8s-ha` with three-instance CloudNativePG Postgres and a failover mid-payment. |

Release gates are the end-to-end tests in `e2e/test/` ([`e2e/README.md`](e2e/README.md)). They
build images and take a long time; you may run them on your own machine with `bun run test:e2e`,
but CI runs them on every push.

A push to a branch cancels that branch's run in progress. Batch fixes into one push.

## Repository layout

| Path                | What it holds                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/approve`      | The signer's confirmation page on its own origin: one hand-written page and a keyless relay to the signer's confirmation routes.                                |
| `apps/server`       | The control plane: REST API, MCP gateway, Workflow runtime; serves the built UI.                                                                                |
| `apps/signer`       | The isolated signer: wallet vault, policy, approver registry, signatures.                                                                                       |
| `apps/web`          | The web UI (Vite and React), built to static files.                                                                                                             |
| `packages/protocol` | Intents, policies, envelopes, digests, policy evaluation, the signer's API contract and client, the authorization verifier, a software authenticator for tests. |
| `packages/api`      | The control plane's HTTP contract and typed client.                                                                                                             |
| `packages/keys`     | Keyring, key providers, wrapped data keys, sealing.                                                                                                             |
| `packages/world`    | The encrypting Postgres World (storage backend) for the Workflow SDK.                                                                                           |
| `packages/testkit`  | Throwaway test databases, the plaintext scanner, a fake Hyperliquid venue, OpenBao helpers.                                                                     |
| `examples`          | Example agents that connect over MCP, and a notification sidecar.                                                                                               |
| `e2e`               | Release gates: end-to-end tests against the whole stack.                                                                                                        |
| `deploy`            | Compose files and deployment configuration: Caddy, the split host, OpenBao, Kubernetes.                                                                         |
| `docs`              | Documentation. Start with [`docs/architecture.md`](docs/architecture.md).                                                                                       |
| `specs`             | Plans, research reports and tracker conventions; see [`specs/README.md`](specs/README.md).                                                                      |
| `scripts`           | Packing and smoke-testing the published packages.                                                                                                               |
| `tools/oxlint`      | The vendored anti-slop lint rules.                                                                                                                              |

Each app, package, example and `e2e` has a README that says what it is and how to check a change
to it.

## Conventions reviews enforce

- TypeScript is strict and ESM, with erasable syntax only: no enums, no parameter properties, no
  namespaces. Node runs the sources directly. Relative imports carry the `.ts` (or `.tsx`)
  extension. Workspace packages are imported by name, for example `@askgina/os-protocol`.
- No `console.*`. Services log one JSON object per line through their logger, with identifiers,
  codes and counts only. Never log an intent, a memo, an address a person typed, a token or key
  material.
- Errors that can reach a log, an HTTP response or a workflow step carry a stable code and a
  fixed message. They never quote what a person or an agent typed.
- Every dependency is pinned to an exact version. Add one with `bun add --exact`. Do not edit
  `bun.lock` by hand.
- Comments explain why, in plain words. No TODOs, stubs, placeholders, dead code, feature flags
  or compatibility shims.
- Tests check behaviour and security properties that a user would notice if broken, not wiring
  or source text. They are deterministic and isolated, and wait for conditions instead of
  sleeping. Use `createTestDatabase()` from `@askgina/os-testkit` for a private database per test
  file.
- A change to anything that is hashed (an intent, a policy, an envelope) is a new protocol
  version, never an edit in place. See [`docs/approval-protocol.md`](docs/approval-protocol.md#12-versioning).
- Documentation states what is proven in CI, what was proven once by hand, and what is unproven,
  and never claims more. It names no person, private host or machine path.

## How decisions are recorded

- **Issues.** Open design questions and their answers are GitHub issues in this repository. A
  "map" is one issue that lists related questions as child issues ("tickets"); the first is
  [issue 1](https://github.com/askgina/os/issues/1). Each decision ticket records what was decided
  and why, and can be reopened. The conventions are in
  [`specs/agents/issue-tracker.md`](specs/agents/issue-tracker.md).
- **Plans.** Larger work is planned in a living document under `specs/` (an "ExecPlan"), copied
  from [`specs/_template.md`](specs/_template.md). Its Progress, Decision Log and Surprises
  sections are kept current as work proceeds. [`specs/README.md`](specs/README.md) lists every
  plan and its status.
- **Research.** Evidence behind a decision goes in `specs/research/`, with pinned versions and
  how to rerun it.

If your change contradicts a recorded decision, say so in the pull request and link the ticket.

## A good pull request

- Does one thing, and says what and why in the description.
- Includes tests that would fail without the change.
- Updates the documentation the change makes wrong, including `docs/approval-protocol.md` and
  `docs/threat-model.md` when behaviour at a trust boundary changes.
- Passes the local checks above, then every CI job.
- Names any security consequence. Report vulnerabilities privately instead; see
  [`SECURITY.md`](SECURITY.md).

## Licence

This project is under the MIT licence ([`LICENSE`](LICENSE)). By contributing, you agree that your
contributions are licensed under the same licence.
