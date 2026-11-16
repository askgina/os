# askgina/os

Instructions for coding agents. Conventions for everyone are in `CONTRIBUTING.md`.

## Checks

- Run locally: `bun run check` (Biome, Markdown included), `bun run lint:slop`, `bun run typecheck` or `tsc --noEmit` in one workspace, and one test file at a time with `node_modules/.bin/vitest run <file>` after `bun run services:up`.
- CI owns builds and the whole suite. Do not run image builds, `bun run build:workflows`, `bun run test`, `./e2e/run.sh` or `./e2e/run-k8s.sh` unless asked.
- Never disable or downgrade a lint rule, or add a disable comment, to make code pass.

## Documentation

- Say what is proven in CI, proven once by hand, or unproven; never claim more.
- No person's name, private host, machine path or internal tool name.
- About venues, say only that using one is the choice of whoever runs the workspace. Write nothing about which places, rules or authorities allow it.

## Issue tracker

Open design questions are GitHub Issues on `askgina/os`; a "map" is one issue whose child issues are decision tickets. Plans (ExecPlans) and research live under `specs/` (template: `specs/_template.md`, index: `specs/README.md`). See `specs/agents/issue-tracker.md`.

## References

`docs/references/` holds vendored external material. It is context, not authority; check its claims against current sources before building on them.
