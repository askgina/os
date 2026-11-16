<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [What must an isolated signer hold to use the OWS Node SDK?](https://github.com/askgina/os/issues/3). **Date:** 2026-11-14.
>
> Written by a research agent; the maintainer re-ran its `./verify.sh` the same day and it passed. File names below (`verify.sh`, `*.test.ts` and so on) refer to a scratch directory outside this repository. The code that was kept is named in [the ExecPlan](../agent-workspaces-v0.1.md).
>
> `refs/<name>` in this report means a shallow clone of the upstream repository at a fixed commit: `refs/workflow` is [vercel/workflow@47ae6d1](https://github.com/vercel/workflow/tree/47ae6d137f346000c9197e654c75e709b93ca715) (release `workflow@5.5.0`), `refs/ows-core` is [open-wallet-standard/core@947f562](https://github.com/open-wallet-standard/core/tree/947f5627cb71299951cd3163b178f1c2b1e9c850) (v1.4.5), `refs/simplewebauthn` is [MasterKale/SimpleWebAuthn@01d1a64](https://github.com/MasterKale/SimpleWebAuthn/tree/01d1a640d5ded4fced0b45a9d806fd0ff44ad244) (v14.1.0), `refs/eve` is [vercel/eve@be1adda](https://github.com/vercel/eve/tree/be1addaaa5b7c2b75537b58767a27c3fdb595931), `refs/busy` is [MatiSolina/busy@3dd91e1](https://github.com/MatiSolina/busy/tree/3dd91e16c0708bd02066377ba3e45aa06f4813c0), `refs/mcp-typescript-sdk` is [modelcontextprotocol/typescript-sdk@919bb8e](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c). "The `workflow@5.5.0` docs" means the documentation shipped inside the `workflow@5.5.0` npm package.

# Spike: OWS as the vault inside an isolated signer

**Question.** What must an isolated signer hold and do to use `@open-wallet-standard/core` 1.4.5 for EVM wallets, and does it run headless in a container?

**Verdict.** Usable as a _key store with token-scoped decryption_, **not** as the policy authority. The signer can run in steady state with only the vault directory plus one `ows_key_` token per wallet (no owner passphrase). It runs headless in `node:26-slim` (glibc x64). But OWS policy for EVM is chain-id-only, keyed off a caller argument rather than the tx bytes, policy files are writable without any credential, and a token is a raw-hash/message/EIP-712 oracle on its allowed chain. So the signer must (1) decode and check every transaction itself against the approved intent, (2) derive the CAIP-2 chain from the tx, (3) never expose message/hash/typed-data signing, and (4) treat the vault directory as integrity-critical. Never use the musl image.

## Versions

`@open-wallet-standard/core` 1.4.5 (+`core-linux-x64-gnu` 1.4.5; source refs/ows-core v1.4.5 947f562), viem 2.57.19, vitest 5.1.0, typescript 7.0.2, Node v26.2.0 host / v26 `node:26-slim@sha256:e6bedef2…`, `node:26-alpine@sha256:6bd9ab43…` (Node 26.13.1), anvil `ghcr.io/foundry-rs/foundry@sha256:04375265…`. bun 1.4.4.

## Proof (all reproduced by `./verify.sh`, 12/12 vitest)

1–2. Wallet W created with passphrase; policy `allowed_chains:[eip155:31337]` + `expires_at`; API key T bound to W and that policy, also with key-level `expiresAt` (`vault.ts` `createScopedKey`).
3–5. A **child process whose env is only `PATH` and `OWS_TOKEN`** (`sign-child.ts`; it aborts if any `*PASS*` var exists) signs an EIP-1559 1.5 ETH transfer; viem recovers W's address; anvil receipt `success`, recipient balance +1.5 ETH.
6. Other chain → `policy denied: chain eip155:1 not in allowlist`; revoked key → `API key not found`; token against an empty vault dir → `… not found`; vault dir without token → `decryption failed: aead::Error` (no credential) / `API key not found` (made-up token); expired key → `API key expired: <id>`.
7. See F3/F4.

## Findings

- **F1 API surface** (installed `index.d.ts`, refs/ows-core/docs/sdk-node.md): `createWallet(name, passphrase?, words?, vaultPath?)`, `importWalletMnemonic`, `importWalletPrivateKey`, `listWallets`, `getWallet`, `deleteWallet`, `renameWallet`, `exportWallet(nameOrId, passphrase?)`, `signTransaction(wallet, chain, txHex, passphraseOrToken?, index?, vaultPath?)`, `signMessage`, `signTypedData`, `signHash`, `signAuthorization` (EIP-7702), `signAndSend`, `createPolicy(json)`, `listPolicies`, `getPolicy`, `deletePolicy`, `createApiKey(name, walletIds, policyIds, passphrase, expiresAt?)`, `listApiKeys` (no tokens), `revokeApiKey(id)`. The credential argument is overloaded: a string starting with `ows_key_` selects agent mode; anything else is a passphrase (refs/ows-core/ows/crates/ows-lib/src/ops.rs:605-617). Chain is a CAIP-2 id or alias. All calls are **synchronous** native calls (they block the event loop; scrypt ~175–270 ms).
- **F2 EVM tx input / chain binding hole.** `txHex` is the _unsigned_ serialized tx; OWS signs `keccak256(bytes)` blindly (ows-signer/src/chains/evm.rs:259-266) and, for EVM, builds a `TransactionContext` with no decoded fields (ows-signer/src/traits.rs:118-128). Policy `chain_id` is the **`chain` argument** (key_ops.rs:383-384). Proven: a tx encoding chainId 1, signed with `chain="eip155:31337"` by a 31337-only key, recovers to W (`proof.test.ts` "F2", `explore.ts` `err.chainArgVsTxChainId → NO ERROR`). `signature` is 65-byte r‖s‖v hex, `recoveryId` = yParity; `transaction` is undefined for EVM, so the caller assembles the signed tx (vault.ts does this with viem).
- **F3 Token signing paths beyond transactions.** With T: `signMessage`, `signTypedData`, `signHash` (any 32-byte digest), `signAuthorization` (EIP-7702 delegation!) all succeed on the allowed chain and are denied only on other chains. EIP-712 domain `chainId` must match the chain arg (key_ops.rs:280-287) but a domain **without** `chainId` is signed (proven). `allowed_typed_data_contracts` exists only for typed data. Value caps, recipient allowlists, daily spend are **not** declarative; only `executable` policies (subprocess, stdin JSON; non-zero exit = deny, proven with `/bin/false`).
- **F4 Owner passphrase bypasses policy entirely** (proven: `signTransaction`/`signHash` on eip155:1 with P succeed; docs/03-policy-engine.md access table).
- **F5 Policies are unauthenticated files.** `createPolicy` needs no credential and **silently overwrites an existing id**; after overwriting the key's policy with `eip155:1` the 31337 key signs for mainnet (proven). Policy id is joined into the path unsanitised: id `../escaped` wrote `<vault>/escaped.json` (policy_store.rs:18-23, reproduced). Policy files are mode 664 in a 775 dir (umask-dependent; `fs::write` without chmod) while wallets/keys are 600 in 700 dirs. Deleting a referenced policy makes the key fail closed (`invalid input: policy not found: pdel`). `deleteWallet` needs no credential.
- **F6 Vault layout** (explore.out.jsonl): `wallets/<uuid>.json` (600; plaintext `id,name,created_at,accounts[16 addresses]`, `crypto` = AES-256-GCM, scrypt n=65536 r=8 p=1, `key_type`), `keys/<uuid>.json` (600; `token_hash`=SHA-256(token), `wallet_ids`, `policy_ids`, `wallet_secrets[walletId]` = AES-256-GCM under HKDF-SHA256(token, salt, "ows-api-key-v1") — i.e. **the full mnemonic** re-encrypted per key), `policies/<id>.json` (plaintext). Key file expiry is plaintext `expires_at`. Addresses/names/policy are not confidential.
- **F7 Export.** `exportWallet` with token → `decryption failed` (it scrypt-decrypts the wallet file only; ops.rs:481-501). With passphrase → full mnemonic. **But** token + vault dir = mnemonic in principle: the key file holds the mnemonic under HKDF(token) (docs/03 "Token + disk access: can decrypt") [INFERENCE: not reimplemented here]. A token is therefore equivalent to the wallet's root secret for whoever can read the vault — it is not a narrower capability, only a policy-checked one when used through OWS.
- **F8 Passphrase optional = empty string.** `createWallet` without passphrase encrypts under `""`; `exportWallet(name)` then returns the mnemonic with no credential, and `createApiKey(..., "")` works (explore). The adapter refuses passphrases < 12 chars.
- **F9 Errors.** All are plain `Error` with `code: "GenericFailure"`; only the message differs: `decryption failed: aead::Error` (wrong passphrase, also on createApiKey), `API key not found` (wrong or revoked token), `API key expired: <id>`, `policy denied: chain <id> not in allowlist`, `policy denied: policy expired at <ts>`, `policy denied: executable exited with exit status: 1: `, `invalid input: policy not found: <id>`. The adapter classifies by message (`classifyOwsError`) — brittle across versions; pin exactly.
- **F10 Timing / concurrency** (host x64): createWallet 267–272 ms, createApiKey 176–203 ms, createPolicy 0.4 ms, token sign 3–4 ms, passphrase sign 174–201 ms. 10 parallel token signs in worker threads: 116–186 ms wall, 0 errors, identical signatures (deterministic RFC6979). Concurrent _writes_ (key creation racing) not checked.
- **F11 Platforms.** npm optionalDependencies: darwin-x64, darwin-arm64, linux-x64-gnu, linux-arm64-gnu only; `core-linux-x64-musl`/`-arm64-musl` → E404. `node:26-slim` amd64: full create/policy/key/sign smoke OK, vault dirs created 700. `node:26-alpine`: npm installs the gnu package (no `libc` field) and `index.js:308 throw loadError` at import. linux-arm64 not run (no emulation on host). Native addon is 33 MB; package also ships a 34 MB `ows` CLI binary.
- **F12 Backup/restore.** `cp -r` of the vault dir into a fresh dir: same address, same token keeps signing (proven). The token is not inside the vault, so a vault backup alone cannot sign; vault + passphrase can recover everything.
- **F13 Licences.** npm closure of the spike (59 packages): OWS core + gnu binary MIT (refs LICENSE "Copyright (c) 2026 MoonPay, Inc."); viem/ox/abitype/@noble/@scure MIT; dev-only: typescript Apache-2.0, lightningcss MPL-2.0 (vitest/vite), others MIT/ISC/BSD-3. The native binary statically links 669 Rust crates (refs/ows-core/ows/Cargo.lock); their licences were **not** audited (deny.toml has no licence policy).

## Design decisions forced

1. **Signer holds:** the vault dir (read-only mount in steady state) + per-wallet `ows_key_` tokens encrypted under a signer KEK. The owner passphrase is needed only at provisioning (createWallet, createApiKey) and recovery; keep it out of the signer runtime (a separate one-shot provisioner, or the signer holds it only during an explicit provisioning call). Proven: steady-state signing needs no passphrase.
2. **The signer, not OWS, is the policy authority.** Decode the tx (viem `parseTransaction`), compare every field to the approved intent hash, derive `chain = eip155:<tx.chainId>` from the bytes, then call OWS. OWS policy (chain + expiry) is defence-in-depth only. Expose only `signEvmTransaction`; never message/hash/typed-data/7702 — `vault.ts` follows this.
3. **Vault integrity:** mount `policies/` read-only (or don't rely on it), set umask 077, and never let untrusted input reach `createPolicy` ids. Treat vault-dir write access as equivalent to policy bypass, and vault read + token as key compromise.
4. **One OWS wallet (own mnemonic) per agent and per treasury.** OWS tokens and key files are per _wallet_ and carry that wallet's whole mnemonic; scoping by derived account index is not a policy rule (index is a call argument). Deriving all agents from one mnemonic would make any agent token + vault read = every agent's and the treasury's key. Cost: N mnemonics to back up — but backup is just the vault dir (+ passphrase escrow), so this is cheap. Blast radius per token = one wallet.
5. **Run OWS calls off the event loop** (worker threads) — they're synchronous and scrypt-heavy.
6. **Base image `node:26-slim` (glibc).** No Alpine. arm64-gnu binary exists but is unverified.
7. Pin `@open-wallet-standard/core` exactly; error mapping is string-based.

## Rerun

`./verify.sh` — reinstalls deps from `bun.lock`, starts `osspike-ows-anvil` on 127.0.0.1:55620, runs `explore.ts` (writes `explore.out.jsonl`), `tsc --noEmit`, vitest, the container smoke (`containers.sh`), asserts outcomes, and removes the container and `/tmp/osspike-ows-*` on exit.

Files: `vault.ts` (adapter + OWS impl), `sign-child.ts` (token-only process), `proof.test.ts`, `explore.ts`, `containers.sh`, `verify.sh`.

## Not checked

linux-arm64 at runtime; Rust crate licences; reimplementing HKDF decryption of a key file to extract the mnemonic from token + disk (F7 is docs + code reading); concurrent key/policy writes; `signAndSend`; executable policy context contents for EVM beyond source reading; behaviour when vault on a read-only mount (likely fine for signing [INFERENCE], untested); private-key-imported wallets.

## verify.sh tail

```
== containers
-- node:26-slim (linux/amd64)
npm notice To update run: npm install -g npm@12.2.2
npm notice
core
core-linux-x64-gnu
OK x64 0xdF29FF00364e641a8f746B9dBA168802bd9F0d05 130 home-default-mode: 700/700
-- arm64: no emulation on host (not checked)
-- node:26-alpine (linux/amd64)
npm notice To update run: npm install -g npm@12.2.2
npm notice
core
core-linux-x64-gnu
/app/node_modules/@open-wallet-standard/core/index.js:308
    throw loadError
    ^

VERIFY OK
```

## Builds and test runs executed (per Main's build rule)

No Docker images were built and no coverage was run. Everything below ran inside this spike directory or in throwaway containers.

- `bun install` (3 runs, about 1.5–3 s each)
- `bunx tsc --noEmit` (about 3 runs, each a few seconds)
- `bunx vitest run` (3 standalone runs of 7–14 s; each run is 12 tests)
- `./containers.sh`: `npm install` of OWS inside `node:26-slim` and `node:26-alpine` (4 standalone runs, 10–59 s)
- `./verify.sh` end to end (4 runs, 20–31 s each)
