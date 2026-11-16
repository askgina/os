# tools/oxlint

`anti-slop/` is a copy of the anti-slop Oxlint rules: rules that reject TypeScript patterns which
look fine but carry little evidence (unchecked type assertions, `unknown` parameters, `typeof`
narrowing outside input parsing, and similar), plus a set of Martin Fowler code-smell warnings.

- Upstream: https://github.com/K-Mistele/anti-slop (MIT)
- Copied from commit `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3` (2026-11-15) with the
  `install-anti-slop` skill in `.agents/skills/install-anti-slop`; details in `anti-slop/UPSTREAM.md`.
- Rules run through `oxlint.config.ts` at the repository root: `bun run lint:slop`.

This is our code now. Change a rule here when it is wrong for this repository, and write down why
in `anti-slop/UPSTREAM.md`. Biome and Oxlint both skip this directory.

## Updating

Do not copy a newer upstream over this directory. Follow the update procedure in
`.agents/skills/install-anti-slop/references/update.md`: stage the new upstream copy in a temporary
directory, compare it with this one and with the commit above, carry over the changes you want,
and record the new commit in both files. Keep `anti-slop/vendor/eslint-stylistic/LICENSE` and its
`UPSTREAM.md`: `require-readable-spacing` includes MIT code from ESLint Stylistic.

`oxlint` and `@oxlint/plugins` are pinned to the same exact version in the root `package.json`;
move them together.
