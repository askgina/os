# Contributing

Thank you for helping. This page says how to set up, where things are, what reviews check, and
how decisions are made.

## Set up

You need:

- [Bun](https://bun.sh) 1.4.4 (the version in `package.json`'s `packageManager`).
- Node.js 26 (see `.node-version`). The services run their TypeScript sources directly with
  Node's type stripping.
- Docker with Compose v2, for the test services.

From the repository root:

```sh
bun install
bun run services:up     # Postgres on 127.0.0.1:55432 and a local chain (anvil) on 127.0.0.1:55545
bun run check           # Biome: formatting and lint
bun run typecheck       # TypeScript in every workspace
bun run test            # Vitest
bun run services:down   # stop the test services and delete their data
```

`bun run format` applies Biome's fixes.

## Repository layout

| Path | What it holds |
| --- | --- |
| `apps/server` | The control plane: REST API, MCP gateway, Workflow runtime; serves the built UI. |
| `apps/signer` | The isolated signer: wallet vault, policy, approver registry, signatures. |
| `apps/web` | The web UI (Vite and React), built to static files. |
| `packages/protocol` | Intents, policies, envelopes, digests, policy evaluation, the signer's API contract and client, the authorization verifier, a software authenticator for tests. |
| `packages/api` | The control plane's HTTP contract and typed client. |
| `packages/keys` | Keyring, wrapped data keys, sealing. |
| `packages/world` | The encrypting Postgres World for the Workflow SDK. |
| `packages/testkit` | Throwaway test databases and the plaintext scanner. |
| `examples` | Example agents that connect over MCP. |
| `e2e` | End-to-end tests against the whole stack. |
| `deploy` | Compose files and deployment configuration. |
| `docs` | Documentation. Start with [`docs/architecture.md`](docs/architecture.md). `docs/references/` is vendored outside material: context, not authority. |
| `specs` | The ExecPlan, research reports and tracker conventions. |

## Conventions reviews enforce

These come from [`AGENTS.md`](AGENTS.md) and the "Context and Orientation" section of
[`specs/agent-workspaces-v0.1.md`](specs/agent-workspaces-v0.1.md).

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
- `bun run check`, `bun run typecheck` and `bun run test` pass before a commit.

## How decisions are recorded

- **The Wayfinder map.** Open design questions and their answers are GitHub issues under the map
  [askgina/os#1](https://github.com/askgina/os/issues/1). Each decision ticket records what was
  decided and why, and can be reopened. The conventions are in
  [`specs/agents/issue-tracker.md`](specs/agents/issue-tracker.md).
- **ExecPlans.** Larger work is planned in a living document under `specs/`, copied from
  [`specs/_template.md`](specs/_template.md). The current plan is
  [`specs/agent-workspaces-v0.1.md`](specs/agent-workspaces-v0.1.md). Its Decision Log and
  Surprises sections are kept current as work proceeds.
- **Research.** Evidence behind a decision goes in `specs/research/`, with pinned versions and
  how to rerun it.

If your change contradicts a recorded decision, say so in the pull request and link the ticket.

## A good pull request

- Does one thing, and says what and why in the description.
- Includes tests that would fail without the change.
- Updates the documentation the change makes wrong, including `docs/approval-protocol.md` and
  `docs/threat-model.md` when behaviour at a trust boundary changes.
- Passes `bun run check`, `bun run typecheck` and `bun run test`.
- Names any security consequence. Report vulnerabilities privately instead; see
  [`SECURITY.md`](SECURITY.md).

## Licence

This project is under the MIT licence ([`LICENSE`](LICENSE)). By contributing, you agree that your
contributions are licensed under the same licence.
