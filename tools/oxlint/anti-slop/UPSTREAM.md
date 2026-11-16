# Provenance

- Source: https://github.com/K-Mistele/anti-slop
- Commit: `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3` (2026-11-15, "Merge pull request #5 from
  K-Mistele/kyle/readme-jev-pitch")
- Copied by: `node .agents/skills/install-anti-slop/scripts/install.mjs` (fresh install, no `--jev`),
  from the skill's `assets/anti-slop/`. That skill was added with
  `bunx skills add K-Mistele/anti-slop --skill install-anti-slop --agent universal --copy -y`
  (recorded in `skills-lock.json`); its files match `skills/install-anti-slop/` at the commit above.
- The copied files are byte-identical to upstream `src/` at that commit, minus its `*.test.ts` files.
- Installed with `oxlint` 1.93.0 and `@oxlint/plugins` 1.93.0 (the upstream README's install
  versions; upstream's own repository tests with 1.86.0).

## Entry points in use

- `index.ts` (plugin `anti-slop`): every core rule at `error`, plus `oxc/no-accumulating-spread`.
- `martinfowler/index.ts` (plugin `anti-slop-martinfowler`): at `warn`, `message-chains` off.

## Present but not registered

- `effect/`: no workspace depends on `effect`.
- `jev/`, `martinfowler/jev-*.ts`, `diff-rules/`: model-judged checks that need a paid API key.

## Local changes

None yet.
