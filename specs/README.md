# Plans and research

This directory holds the planning records of the repository: one plan per larger piece of work,
the research behind each plan, and the rules the maintainers' coding agents follow when they use
GitHub Issues.

These files are records. They say what was planned, decided and proven on a given date, and they
can lag the code. For current behaviour read [`README.md`](../README.md),
[`docs/architecture.md`](../docs/architecture.md), [`docs/threat-model.md`](../docs/threat-model.md),
[`docs/approval-protocol.md`](../docs/approval-protocol.md), [`deploy/README.md`](../deploy/README.md)
and the README of each app and package.

## What is here

- **Plans** (`specs/*.md`). Each plan is an ExecPlan: a living document for one larger piece of
  work, copied from [`_template.md`](./_template.md). Its header names its owner, branch, status
  and links. While the work runs, its author keeps four
  sections current: `Progress` (timestamped checklist), `Decision Log` (each decision with its
  reason), `Surprises & Discoveries` (what turned out different, with evidence) and
  `Outcomes & Retrospective` (what was achieved and what remains). The template adapts
  [OpenAI's ExecPlan guidance](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md).
- **Research reports** (`research/*.md`). Evidence recorded on the date at the top of each report,
  usually by a research agent, to answer one question before a plan was written. They are not kept
  current. Claims are tagged with their source (a file and line, or a URL); `[INFERENCE]` marks a
  conclusion that was reasoned, not observed. Some reports name files (such as `verify.sh`) in a
  scratch directory that is not part of this repository.
- **Issue tracker rules** ([`agents/issue-tracker.md`](./agents/issue-tracker.md)). How the
  maintainers' coding agents create, link and close GitHub Issues, including the Wayfinder maps
  below. It is written as instructions for agents.

## Words used in the plans

| Term                       | Meaning                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ExecPlan, plan             | A living plan for one larger piece of work, kept in `specs/` and copied from `_template.md`.                                                                                                                                                                                            |
| Wayfinder map              | A GitHub issue labelled `wayfinder:map` that lists open design questions as child issues. Its body holds notes, decisions so far and "fog" (what is still unknown). The method comes from the `wayfinder` agent skill, vendored in `.agents/skills/wayfinder` from `mattpocock/skills`. |
| Ticket                     | One child issue of a map: a question whose answer is a decision. Research tickets lead to a report in `research/`.                                                                                                                                                                      |
| v0.1                       | The first build, planned in [`agent-workspaces-v0.1.md`](./agent-workspaces-v0.1.md) under map [#1](https://github.com/askgina/os/issues/1). Later plans hang off map [#18](https://github.com/askgina/os/issues/18), "After v0.1: wider approvals, more venues, more machines".        |
| D1, D2, … Dn               | Owner decisions in one plan's `Decision Log`. The numbers are local to that plan: D2 in one plan is unrelated to D2 in another.                                                                                                                                                         |
| Owner decision, delegation | A choice the plan leaves to the repository owner. On 2026-11-15 the owner delegated most of them to the lead agent, which took the option each plan recommended. Making a repository public, a product name and contact with an outside project were not delegated.                     |
| Milestone                  | One independently checkable step of a plan, with its files, its work and how to see that it works.                                                                                                                                                                                      |
| Release gate               | An end-to-end test in `e2e/test/` that `./e2e/run.sh` runs against the whole Compose stack.                                                                                                                                                                                             |
| The lead, lead agent       | The coding agent that led the work, split it between other agents and ran the checks.                                                                                                                                                                                                   |
| Research, building agent   | Coding agents that wrote a research report or one part of the code. `Date/Author` lines name a role, not a person.                                                                                                                                                                      |
| Spike                      | A small throwaway experiment that answers one research question. It ran in a scratch directory outside this repository; code that was kept is named in the plan that used it.                                                                                                           |
| The fork                   | `askgina/busy`, a private fork of an outside project named Busy (`MatiSolina/busy`). Its bots connect to this system as agents. See [`busy-fork.md`](./busy-fork.md).                                                                                                                   |
| CI run 43…                 | A GitHub Actions run recorded as evidence on the day. Its logs expire; every CI job also runs again on every push to `main` and every pull request.                                                                                                                                     |
| Proven by hand             | Done once by a person or agent outside CI. Nothing keeps it true afterwards.                                                                                                                                                                                                            |

The product terms (workspace, approver, agent, wallet, intent, venue, policy, envelope, mandate,
signer, control plane, World) are defined once in
[`docs/architecture.md`](../docs/architecture.md#words-used-on-this-page). "Confirmation page"
means the page the `approve` service serves at `APPROVE_ORIGIN`.

## How to read a Status line

Each plan starts with a `Status` line. The template allows `Draft | In Progress | Ready for Review | Merged`. The plans use:

- `Draft`: written, nothing built. No plan is in this state.
- `In Progress` (or `In progress`): being built.
- `Ready for Review`: the milestones are built, apart from any the Status line names as open. Most
  add, in brackets, the date and the CI run that showed the milestones passing.
- `Merged`: not used by any plan.

The Status line is edited less often than `Progress`. Where they disagree, `Progress` and
`Revision Notes` are newer.

## Plans

| Plan                                                                 | Purpose                                                                                            | Status (as the plan states it)                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agent-workspaces-v0.1.md`](./agent-workspaces-v0.1.md)             | Build v0.1: self-hosted agent workspaces with passkey approvals enforced at the signer.            | In Progress                                                                                                                                                                      |
| [`trusted-display.md`](./trusted-display.md)                         | Approve on a page the control plane cannot change: the signer's confirmation page.                 | Ready for Review                                                                                                                                                                 |
| [`approval-mandates.md`](./approval-mandates.md)                     | Approve in advance: signer-enforced mandates for one agent's transfers.                            | Ready for Review                                                                                                                                                                 |
| [`approval-notifications.md`](./approval-notifications.md)           | Tell approvers about a waiting approval outside the inbox (Web Push, signed webhook).              | Ready for Review                                                                                                                                                                 |
| [`stuck-transaction-repricing.md`](./stuck-transaction-repricing.md) | Reprice or cancel a stuck transaction under the approval it already has.                           | Ready for Review                                                                                                                                                                 |
| [`workspace-lifecycle.md`](./workspace-lifecycle.md)                 | Clone, export and delete a workspace whose wallets hold assets.                                    | Ready for Review (built 2026-11-15; …)                                                                                                                                           |
| [`beyond-one-machine.md`](./beyond-one-machine.md)                   | Run on more than one machine: split signer host, key providers, replicas, Kubernetes, HA Postgres. | Ready for Review (built 2026-11-15; every milestone green in CI run 43744005029)                                                                                                 |
| [`non-evm-operations.md`](./non-evm-operations.md)                   | Sign Hyperliquid orders that the signer builds from an approved intent.                            | Ready for Review (Milestones 1 to 6 built 2026-11-15, …; the manual testnet proof is open because no funded testnet account exists). Milestone 7, Hyperliquid mainnet …, is open |
| [`busy-fork.md`](./busy-fork.md)                                     | Run a fork of Busy self-hosted next to this system, with wallet proposals through the MCP gateway. | Ready for Review (built 2026-11-15 in the private repository `askgina/busy`; …)                                                                                                  |
| [`anti-slop.md`](./anti-slop.md)                                     | Vendor the anti-slop Oxlint rules and make the code pass them.                                     | In progress                                                                                                                                                                      |
| [`agent-read-tools.md`](./agent-read-tools.md)                       | Give agents read tools for the venue they trade on, drawn from Gina Read in `askgina/gina`.        | In Progress (built; its release gates wait for CI)                                                                                                                               |

Three Status lines lag their plan's `Progress`: `agent-workspaces-v0.1.md` and `anti-slop.md`
tick every milestone, and `non-evm-operations.md` ticks Milestone 7 (Hyperliquid mainnet) as done
on 2026-11-16.

## Research reports

| Report                                                                                                | Question it answers                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`eve-without-vercel-services.md`](./research/eve-without-vercel-services.md)                         | Does the eve agent runtime run with no Vercel services?                                    |
| [`ows-node-sdk-in-an-isolated-signer.md`](./research/ows-node-sdk-in-an-isolated-signer.md)           | What must an isolated signer hold to use the OWS Node SDK?                                 |
| [`passkey-assertion-bound-to-one-approval.md`](./research/passkey-assertion-bound-to-one-approval.md) | How is a passkey assertion bound to one exact approval?                                    |
| [`nextjs-as-control-plane-host.md`](./research/nextjs-as-control-plane-host.md)                       | Is one Next.js app a sound host for the control plane?                                     |
| [`encrypting-postgres-world.md`](./research/encrypting-postgres-world.md)                             | Does a World derived from the Postgres World give ciphertext at rest?                      |
| [`approval-mandates.md`](./research/approval-mandates.md)                                             | How can one approval cover many actions without weakening the signer's check?              |
| [`trusted-display.md`](./research/trusted-display.md)                                                 | How can a person be sure the approval they sign is the operation they were shown?          |
| [`non-evm-operations.md`](./research/non-evm-operations.md)                                           | How do operations that are not EVM transactions fit the intent, policy and signer model?   |
| [`stuck-transaction-repricing.md`](./research/stuck-transaction-repricing.md)                         | How should a signed transaction that is not mined be repriced under its existing approval? |
| [`workspace-lifecycle.md`](./research/workspace-lifecycle.md)                                         | What do cloning, exporting and deleting a workspace mean when its wallets hold assets?     |
| [`approval-notifications.md`](./research/approval-notifications.md)                                   | How should people learn about a waiting approval outside the inbox?                        |
| [`beyond-one-machine.md`](./research/beyond-one-machine.md)                                           | What changes when the system runs on more than one machine?                                |
| [`busy-fork.md`](./research/busy-fork.md)                                                             | What would a fork of Busy that runs self-hosted on this system take?                       |
| [`agent-read-tools.md`](./research/agent-read-tools.md)                                               | What of Gina Read, the read-only MCP server in `askgina/gina`, belongs in this system?     |

## Adding a plan

Copy [`_template.md`](./_template.md) to `specs/<short-name>.md`, fill in the header and
`Purpose / Big Picture`, and keep the four living sections current as the work proceeds. Add a row
to the table above. Put the evidence behind a decision in `research/`, with the versions it was
checked against and how to rerun it.
