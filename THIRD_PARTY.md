# Third-party software

This project is MIT-licensed (see [`LICENSE`](LICENSE)). It depends on packages under other
licences. `bun.lock` pins every one of them, and each package carries its own licence text in
`node_modules` after `bun install`.

Of the 434 installed packages, 328 are MIT and 71 are Apache-2.0. The rest are ISC, BSD, 0BSD,
BlueOak, Unlicense or dual permissive licences. The packages below are the ones whose terms
differ from that, or whose licence could not be read from their metadata.

| Package                         | Version | Licence                 | How it is used                                                                      |
| ------------------------------- | ------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `lightningcss` and its binaries | 1.33.0  | MPL-2.0                 | Build tool behind Tailwind for the web UI. Unmodified. Not in what the server runs. |
| `@vercel/cli-auth`              | 0.0.1   | Apache-2.0 (see note)   | Arrives with the Workflow CLI, a build tool. Not called by this project.            |
| `@swc/core` platform binaries   | 1.15.3  | Apache-2.0 AND MIT      | Compiler used by the Workflow CLI at build time.                                    |
| `argparse`                      | 2.0.1   | Python-2.0              | Transitive dependency of a build tool.                                              |
| `json-schema`                   | 0.4.0   | AFL-2.1 OR BSD-3-Clause | Transitive. Used under BSD-3-Clause.                                                |
| `@open-wallet-standard/core`    | 1.4.5   | MIT (see note)          | The signer's wallet vault. Runs in the signer.                                      |

Notes:

- **MPL-2.0** asks that changes to the covered files themselves stay under MPL-2.0. This project
  does not change `lightningcss`, and does not copy its source.
- **`@vercel/cli-auth`** has no `license` field in its `package.json`. The `LICENSE` file inside
  the package is Apache-2.0, and that file is what this table reports.
- **`@open-wallet-standard/core`** ships a native binary built from Rust crates. The licences of
  those crates were not checked one by one.

The container images start from `node`, `oven/bun`, `postgres`, `caddy` and
`ghcr.io/foundry-rs/foundry`, each pinned by digest in the Dockerfiles and `compose.yaml`, and
each under its own licence.
