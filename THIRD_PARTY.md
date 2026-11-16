# Third-party software

This project is MIT-licensed (see [`LICENSE`](LICENSE)). It depends on packages under other
licences. `bun.lock` pins every one of them, and each package carries its own licence text in
`node_modules` after `bun install`.

Of the 438 packages `bun install` puts in `node_modules` on Linux x64 (other platforms get their
own native binaries), 331 are MIT and 71 are Apache-2.0. The rest are ISC, BSD, 0BSD, BlueOak,
Unlicense or dual permissive licences. The packages below are the ones whose terms differ from
that, or whose licence could not be read from their metadata.

| Package                         | Version | Licence                 | How it is used                                                                                                               |
| ------------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `lightningcss` and its binaries | 1.33.0  | MPL-2.0                 | Build tool behind Tailwind for the web UI. Unmodified. Not in what the server runs.                                          |
| `@vercel/cli-auth`              | 0.0.1   | Apache-2.0 (see note)   | Arrives with the Workflow CLI, a dependency of `workflow`, which the server depends on directly. Not called by this project. |
| `@swc/core` platform binaries   | 1.15.3  | Apache-2.0 AND MIT      | Compiler used by the Workflow CLI at build time.                                                                             |
| `argparse`                      | 2.0.1   | Python-2.0              | In the server's runtime dependencies: `graphile-worker` → `cosmiconfig` → `js-yaml` → `argparse`. Unmodified.                |
| `json-schema`                   | 0.4.0   | AFL-2.1 OR BSD-3-Clause | Transitive. Used under BSD-3-Clause.                                                                                         |
| `@open-wallet-standard/core`    | 1.4.5   | MIT (see note)          | The signer's wallet vault. Runs in the signer.                                                                               |
| `@msgpack/msgpack`              | 3.1.3   | ISC                     | Test only (`packages/testkit`): checks the signer's own msgpack encoder.                                                     |

Notes:

- **MPL-2.0** asks that changes to the covered files themselves stay under MPL-2.0. This project
  does not change `lightningcss`, and does not copy its source.
- **`@vercel/cli-auth`** has no `license` field in its `package.json`. The `LICENSE` file inside
  the package is Apache-2.0, and that file is what this table reports.
- **Python-2.0** (the PSF licence) is permissive. It asks that a derivative work keep the
  licence's copyright notice and summarise its changes. This project changes nothing in
  `argparse`, which carries its licence text in `node_modules`.
- **`@open-wallet-standard/core`** ships a native binary built from Rust crates. The licences of
  those crates were not checked one by one.
- **`@msgpack/msgpack`** is permissive and listed only because it is chosen on purpose as an
  independent reference: the signer encodes msgpack itself and must not depend on it.
- **Hyperliquid signing vectors** in `apps/signer/test/vectors/hyperliquid-python-sdk.json` are
  copied from `hyperliquid-python-sdk` (MIT, Copyright (c) 2024 Hyperliquid Labs Pte. Ltd.) at
  commit `2fdb18f9517675ea03695a0962bd19eece9c83f0`. The file carries the MIT notice.

## Vendored code

These directories hold copies of code from other repositories, each with that repository's
licence text beside it.

| Directory                           | Upstream                                                      | Revision                                                                                                                | Licence                               |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `tools/oxlint/anti-slop/`           | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) | `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3` (see its `UPSTREAM.md`)                                                      | MIT, Copyright (c) 2026 Dillon Mulroy |
| `.agents/skills/install-anti-slop/` | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) | `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3`, its `skills/install-anti-slop/` (see `tools/oxlint/anti-slop/UPSTREAM.md`)  | MIT, Copyright (c) 2026 Dillon Mulroy |
| `.agents/skills/wayfinder/`         | [mattpocock/skills](https://github.com/mattpocock/skills)     | Not recorded at install; both files match `skills/engineering/wayfinder/` at `7739eaed7f8f3915437a8def198a6d0d7206dbc7` | MIT, Copyright (c) 2026 Matt Pocock   |

Inside them, `vendor/eslint-stylistic/` (in `tools/oxlint/anti-slop/` and in the skill's
`assets/anti-slop/`) and the skill's `assets/oxlint-plugin-jev/` carry their own `LICENSE` and
`UPSTREAM.md`.

The container images start from `node`, `oven/bun`, `postgres`, `caddy` and
`ghcr.io/foundry-rs/foundry`, each pinned by digest in the Dockerfiles and `compose.yaml`, and
each under its own licence.
