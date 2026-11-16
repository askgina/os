# Vendor the anti-slop lint rules and make the code pass them

- Branch: main
- Ticket: [askgina/os#28](https://github.com/askgina/os/issues/28), on the map [askgina/os#18](https://github.com/askgina/os/issues/18)
- Status: In progress
- Owner: lead agent, under Eric's instruction of 2026-11-16 ("setup anti-slop + refactor")

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.

## Purpose / Big Picture

Most of this repository was written by coding agents. Agents tend to write
TypeScript that compiles but carries little evidence that it is right: a type
assertion with no stated reason, an `unknown` passed deep into the code instead
of being decoded where it enters, a `typeof` check standing in for a schema.
[anti-slop](https://github.com/K-Mistele/anti-slop) is a set of Oxlint rules
that reject those patterns and say what to write instead.

After this plan the rules are part of the repository (vendored, so they are our
code), every core rule is an error, the code passes them, and the CI `check`
job fails when a new violation arrives.

Non-goals: the rules judged by a language model (the "Jev" rule sets and the
diff rules), which cost money on every request; the Effect rule set, because
this repository does not use Effect; changing what the product does.

Success means:

- `bun run lint:slop` exits 0 on `main`.
- No rule was downgraded or silenced with a disable comment to get there. One
  rule is off for one named group of files that cannot load a schema library
  (see `Decision Log`).
- The CI `check` job runs `bun run lint:slop`, and the whole `ci` workflow is
  green on the commit that adds it.

## Progress

- [x] (2026-11-16 09:40Z) Milestone 1: vendored at upstream commit `b7c1619`,
      `oxlint.config.ts`, `bun run lint:slop`, Biome told to leave the vendored
      code alone. The config loads and the rules run under Node 26.
- [x] (2026-11-16 09:45Z) First measurement: 349 files, 10,610 findings (see
      `Artifacts and Notes`).
- [x] (2026-11-16 09:50Z) Milestone 2: blank-line findings fixed by the rule's
      own fixer, then Biome (commit `7ac59b7`, 306 files). Whitespace only,
      except three useless spreads that Oxlint's own fixer removed in
      `orders.ts` and `finalize.ts`. `tsc --noEmit` clean in every workspace
      afterwards. Second measurement: 1,558 errors, 193 warnings.
- [x] (2026-11-16 10:30Z) Milestone 3: thirteen slices, one agent each,
      working from per-slice finding lists; agents edited only, the lead ran
      every check. `bun run lint:slop`: 0 errors. Of 868 type assertions, 114
      remain, each under a `SAFETY:` comment; the rest were replaced by a
      decode, `satisfies`, a type guard or a better type. Local checks after
      the last edit: `tsc --noEmit` in every workspace; unit tests of the
      signer (227), protocol (468), api, testkit and approve (186), keys (119),
      the examples (13), web (347), and the server's execution, directory,
      identity, lifecycle, notify and support tests (294). Not run locally:
      `workflow.test.ts`, the World's tests and the release gates, which are
      CI's.
- [x] (2026-11-16 10:30Z) Milestone 4: code-smell warnings. 189 remain as
      warnings. Agents changed six in product source where the change was
      local (a build-up loop into a map, one extraction) and left the rest
      with a reason each; equipment, scripts and examples were left by rule.
- [ ] Milestone 5: `bun run lint:slop` in the CI `check` job; `ci` green.

## Surprises & Discoveries

- Observation: 8,866 of the 10,610 findings are one rule,
  `require-readable-spacing`, and that rule ships a whitespace-only fixer.
  Evidence: `tools/oxlint/anti-slop/rules/require-readable-spacing.ts`; the
  report's counts.
- Observation: `oxlint --fix` applies every rule's fixer, not only the spacing
  rule's. Oxlint's own `unicorn/no-useless-spread` (a default warning) rewrote
  three call sites. They were read and are equivalent.
  Evidence: `git diff -w --ignore-blank-lines` on `7ac59b7`.
- Observation: a classifier could not sort the code-smell warnings. A pilot of
  21 warnings (labels fixed before any was read) put 13 in "change", most with
  probability under 0.7; about 43% needed a person's read, above the 40% at
  which the classifier is not worth using.
  Evidence: pilot table in `Artifacts and Notes`.
- Observation: the refactor surfaced a bug it did not fix. The agent-facing
  `get_intent` tool reads its cancel signal from `extra.signal`, which the MCP
  server SDK 2.4.0 does not set (it is at `extra.mcpReq.signal`), so a client's
  cancel never ends the wait of up to 50 seconds early. Left as it was, with a
  comment that says so, because fixing it changes behaviour. Open with the
  owner.
  Evidence: `apps/server/src/mcp/gateway.ts`, the `get_intent` handler.
- Observation: two tests of the signer's pinned TLS failed once during
  verification because the lead's shell still exported
  `NODE_TLS_REJECT_UNAUTHORIZED=0` from a staging session. With it unset they
  pass. Not a code defect; unset it before running tests.
  Evidence: `packages/protocol/test/signer-transport.test.ts`, 6 of 6.
- Observation: the errors split almost evenly between tests and source (5,197
  in tests and test equipment, 5,228 in source).
  Evidence: the first report.

## Decision Log

- Decision: vendor the plugin with the upstream skill's installer, at
  `tools/oxlint/anti-slop/`, with `oxlint` and `@oxlint/plugins` pinned to the
  same exact version (1.93.0).
  Rationale: upstream says the plugin is meant to be vendored and edited, not
  installed from npm; the two packages must match.
  Date/Author: 2026-11-16 / lead
- Decision: enable every core rule at error, as upstream's README lists them;
  enable the code-smell bundle at warn with `message-chains` off; leave out the
  Effect rule set.
  Rationale: the upstream defaults; `effect` is not a dependency of any package
  here.
  Date/Author: 2026-11-16 / lead
- Decision: do not set up the rules judged by a language model.
  Rationale: each run costs money; upstream's own installer sets them up only
  on request, and the owner did not ask for them.
  Date/Author: 2026-11-16 / lead
- Decision: tests follow the same rules as source. No override relaxes a rule
  for test files.
  Rationale: half of the findings are in tests, and a test that asserts through
  an unexplained cast proves less than it seems to.
  Date/Author: 2026-11-16 / lead
- Decision: a finding is fixed by removing its cause where that is possible
  (decode with the schema that already exists, use `satisfies`, narrow with a
  type guard) and only otherwise by a `SAFETY:` comment, which must name the
  check that makes the assertion true.
  Rationale: a comment that restates the cast is the pattern the rule exists to
  stop.
  Date/Author: 2026-11-16 / lead
- Decision: code-smell warnings in test equipment, fixtures, fakes, development
  servers, scripts and examples are left. In product source the agent that owns
  the file changes one only when the change is local, clearly better and cannot
  change behaviour, and reports each as changed or left.
  Rationale: the classifier pilot was not decisive (see Surprises); the path of
  a file decides the first group, and the second needs someone reading the
  code.
  Date/Author: 2026-11-16 / lead
- Decision: `no-runtime-typeof` is off for files that run with no
  `node_modules`: `apps/web/public/*.js`, `apps/approve/public/*.js`,
  `apps/web/dev/confirm/*.js` (browser scripts served as they are),
  `deploy/init/*.mjs`, `e2e/src/openbao-bootstrap.mts`,
  `e2e/src/webhook-receiver.mts` (single files mounted into a bare Node
  container) and `examples/ntfy-sidecar/**` (dependency-free on purpose).
  Rationale: the rule asks for a schema decode at the boundary; where no schema
  library can load, a `typeof` check is the decode. Replacing `typeof` with a
  look-alike (`String(v) === v`) was proposed by an agent and refused: it hides
  the check from the lint and proves nothing more. Every other rule applies to
  those files.
  Date/Author: 2026-11-16 / lead
- Decision: `packages/keys`, `packages/world` and `packages/testkit` depend on
  `zod` 4.6.7, the version the rest of the repository uses.
  Rationale: they decoded key files, OpenBao answers and posted bodies by hand
  with `typeof`; the rule wants a schema, and these packages had none. The two
  published packages gain one runtime dependency with no dependencies of its
  own. The owner was told and may reverse it.
  Date/Author: 2026-11-16 / lead
- Decision: the code-smell warnings stay warnings and do not fail CI.
  Rationale: upstream calls them prompts to look. Each one is read once in
  Milestone 4.
  Date/Author: 2026-11-16 / lead

## Outcomes & Retrospective

- Outcome: none yet.

## Context and Orientation

The repository is a bun workspace: `apps/server` (control plane), `apps/signer`
(holds wallet keys, checks approvals), `apps/web`, `apps/approve`,
`packages/protocol`, `packages/api`, `packages/keys`, `packages/world`,
`packages/testkit`, `e2e`, `examples/*`. Formatting and the existing lint are
Biome (`bun run check`). Type checks are `bun run typecheck`.

Relevant repo rules:

- Builds, the whole test suite and the release gates run in CI only. Locally:
  `tsc --noEmit` per workspace, Biome, one test file at a time.
- The signer is the trust boundary. A refactor there must not change what it
  signs or refuses; its unit tests are the check.

Current behavior:

- Before this plan there was no Oxlint in the repository.

How the relevant pieces fit together:

- `oxlint.config.ts` registers two JavaScript plugins from
  `tools/oxlint/anti-slop/`. Oxlint runs them under Node; the rules look at
  syntax only, one file at a time, without the type checker.
- Biome ignores `tools/oxlint` and `.agents`. Oxlint ignores them too, plus
  `docs/references`, build output and generated files.

Assumptions:

- Node 26 and bun 1.4.4, as CI uses.

## Plan of Work

### Milestone 1: Vendor and configure

Scope: the plugin, the config, the script. Done.

Files and interfaces:

- `tools/oxlint/anti-slop/`: the plugin source; `UPSTREAM.md` records the
  commit.
- `oxlint.config.ts`: rules and ignore patterns.
- `package.json`: `lint:slop`.
- `.agents/skills/install-anti-slop/`, `skills-lock.json`: the upstream
  installer skill, for updates.

Acceptance:

- Run `bun run lint:slop --print-config` and expect both plugins listed.

### Milestone 2: Blank lines

Scope: `require-readable-spacing` asks for blank lines around declarations and
statement groups. Its fixer only adds whitespace.

Work:

- Run `node_modules/.bin/oxlint -c oxlint.config.ts --fix .`, then
  `bunx biome check --write .`.

Acceptance:

- The report shows no `require-readable-spacing` finding; `git diff -w --stat`
  is empty for the commit (whitespace only); `bun run typecheck` passes.

### Milestone 3: The remaining errors

Scope: about 1,560 errors in twelve rules. One slice per workspace so no two
slices touch one file; the signer has one owner.

How each rule is fixed:

- `require-safety-comment-for-type-assertion` (868): remove the assertion when
  a schema, `satisfies` or a type guard can carry the evidence; otherwise put
  `// SAFETY: <the check that makes this true>` directly before the statement.
- `no-unknown-parameters` (151), `no-unknown-returns` (29),
  `no-runtime-typeof` (149): decode the value with a zod schema where it enters
  the program and pass the decoded type on. A `cause` parameter and the subject
  of a type predicate may stay `unknown`.
- `no-unsafe-dictionary-type` (120): name the value type; a JSON value gets a
  named JSON type, not `Record<string, unknown>`.
- `no-conditional-spread` (105): build the object explicitly.
- `no-known-value-widening` (91): `satisfies` instead of an annotation that
  throws away the literal type.
- `no-chained-type-assertions` (18), `no-array-filter-map` (14),
  `no-object-parameters` (7), `no-shape-in-symbol-names` (4),
  `no-reflect-get` (2), `max-ternary-depth` (1): as each rule's message says.

Acceptance:

- `bun run lint:slop` reports 0 errors; `bun run typecheck` and
  `bun run check` pass; the unit test files of each changed module pass.

### Milestone 4: Code smells

Scope: 185 warnings (`long-function` 75, `loops` 48, `long-parameter-list` 27,
`repeated-switches` 16, `mutable-data` 12, others 7).

Work:

- Each warning is sorted once into "worth changing" or "leave": a classifier
  sorts them, the lead reads every one it flags, and only those are changed.

Acceptance:

- The table of decisions is in `Artifacts and Notes`; the changed code passes
  the same checks as Milestone 3.

### Milestone 5: CI

Scope: the `check` job runs the lint.

Files and interfaces:

- `.github/workflows/ci.yml`: one step, `bun run lint:slop`, after
  `bun run check`.

Acceptance:

- The `ci` workflow is green on the commit; a deliberate violation on a probe
  branch is not needed, because the rules' own behaviour was seen in the first
  report.

## Interfaces and Dependencies

External dependencies:

- `oxlint` 1.93.0 and `@oxlint/plugins` 1.93.0, exact and equal.
- `K-Mistele/anti-slop` at `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3`, MIT;
  `tools/oxlint/anti-slop/vendor/eslint-stylistic/` is MIT code from ESLint
  Stylistic and keeps its `LICENSE` and `UPSTREAM.md`.

## Concrete Steps

From the repository root:

    bun run lint:slop
    node_modules/.bin/oxlint -c oxlint.config.ts --format json . > report.json
    jq -r '.diagnostics[]|"\(.severity) \(.code)"' report.json | sort | uniq -c | sort -rn

## Validation and Acceptance

Automated validation:

- `bun run lint:slop`: expect exit 0.
- `bun run check`, `bun run typecheck`: expect no findings.
- The `ci` workflow: expect every job green.

Regression checks:

- The signer's unit tests and the release gates still pass: a refactor must not
  change a signature, a refusal or a wire format.

## Idempotence and Recovery

- Re-running the fixer and Biome is safe: both are stable on their own output.
- Updating the plugin: follow `tools/oxlint/README.md`; the installer merges
  upstream changes into the vendored copy.

## Rollout and Operations

- Nothing reaches a deployment: this is a development check.

## Risks and Open Questions

- Risk: a decode moved to a boundary changes an error message or a status code.
  Mitigation: the unit tests of the changed route; the release gates in CI.
- Risk: `SAFETY:` comments written to satisfy the rule rather than to state a
  real check.
  Mitigation: the lead reads a sample of every slice; a comment that only
  restates the cast is sent back.
- Risk: the blank-line fixer and Biome disagree.
  Mitigation: run both and run the lint again; a remaining finding is fixed by
  hand.

## Artifacts and Notes

First report, 2026-11-16 09:45Z, 349 files:

    8866 error   require-readable-spacing
     868 error   require-safety-comment-for-type-assertion
     151 error   no-unknown-parameters
     149 error   no-runtime-typeof
     120 error   no-unsafe-dictionary-type
     105 error   no-conditional-spread
      91 error   no-known-value-widening
      29 error   no-unknown-returns
      18 error   no-chained-type-assertions
      14 error   no-array-filter-map
       7 error   no-object-parameters
       4 error   no-shape-in-symbol-names
       2 error   no-reflect-get
       1 error   max-ternary-depth
     181 warning code-smell bundle; 4 warning oxlint's own rules

Errors other than blank lines, by workspace: server 523, signer 282, web 205,
e2e 171, protocol 101, testkit 89, keys 73, world 32, examples 43, approve 20,
api 14, deploy 6.

Code-smell pilot, 2026-11-16 (21 of 181 warnings, every ninth): change 13
(top probability 0.42 to 0.81, eight under 0.7), leave as equipment 7, leave as
inherent 1, unclear 0. Five of the "change" verdicts were also marked as
touching signing or wire code.

## Revision Notes

- 2026-11-16: created with Milestone 1 done and the first measurement.
