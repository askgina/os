# Verification: ChatGPT share "Combine Encryption Approval UX"

Checks the factual claims in [`chatgpt-combine-encryption-approval-ux.md`](./chatgpt-combine-encryption-approval-ux.md) against primary sources. Line numbers refer to that file. Design proposals ("I'd build…") are not checked; only statements about what upstream projects are or do.

- Checked: 2026-11-14
- Verdicts: **Confirmed** (source says so), **Wrong** (source says otherwise or the thing does not exist), **Stale** (was true, no longer), **Unverifiable** (no primary source found or fetched).
- The dump names no Workflow environment variables. For reference, the Postgres World uses `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL` (falls back to `DATABASE_URL`).

Sources and versions read:

| Project | Source | Version / commit |
| --- | --- | --- |
| Workflow SDK | https://vercel.com/blog/workflow-sdk-5 (published 2026-11-12) | — |
| Workflow SDK | https://workflow-sdk.dev/docs/how-it-works/encryption (lastUpdated 2026-11-13), https://workflow-sdk.dev/worlds/postgres, https://workflow-sdk.dev/docs/observability/attributes | — |
| Workflow SDK | https://github.com/vercel/workflow (shallow clone; `packages/world-postgres`, `worlds-manifest.json`, `docs/content/docs/v5`) | `b1f92691bcc3bc18b9df094d45379c6464cf4d65` (2026-11-13); latest release `workflow@5.5.0`; `@workflow/world-postgres` 5.2.0 |
| Workflow SDK | https://vercel.com/kb/guide/human-in-the-loop-with-chat-sdk-and-workflow-sdk | — |
| OWS | https://openwallet.sh/ ("Open Standard v1.0.0"), https://docs.openwallet.sh/ ("v1.4.3") | — |
| OWS | https://github.com/open-wallet-standard/core (shallow clone; `README.md`, `docs/00`, `03`, `04`, `05`, `sdk-node.md`, `ows/crates`) | `947f5627cb71299951cd3163b178f1c2b1e9c850` (2026-11-12); latest release v1.4.5 |
| OWS | https://github.com/open-wallet-standard/core/issues/119 | open |
| Busy | https://busybot.dev/ | — |
| Busy | https://github.com/MatiSolina/busy (shallow clone; `README.md`, `LICENSE`, `docs/architecture.md`, `docs/coworker-features.md`, `docs/handbook.md`) | `3dd91e16c0708bd02066377ba3e45aa06f4813c0` (2026-11-10); release v0.5.0 |
| eve | https://github.com/vercel/eve (repo metadata, README) | `be1addaaa5b7c2b75537b58767a27c3fdb595931` |
| SimpleWebAuthn | https://simplewebauthn.dev/docs/packages/server (docs 14.1.x); `packages/server/src/authentication/*.ts` in https://github.com/MasterKale/SimpleWebAuthn | `01d1a640d5ded4fced0b45a9d806fd0ff44ad244`; release v14.1.0 |
| Better Auth | https://github.com/better-auth/better-auth `packages/passkey/package.json` | `f39e6c66cc657e677b72828d0aff20b6ade2adae`; `@better-auth/passkey` 1.7.23 |
| W3C SPC | https://www.w3.org/TR/secure-payment-confirmation/ | Candidate Recommendation Draft, 13 October 2026 |
| MDN | https://github.com/mdn/content `files/en-us/web/api/web_authentication_api/index.md`, `…/publickeycredentialcreationoptions/index.md` | `deca95e12eeba261ff77a5e4db4575da16d0c1f5` |

Source drift noticed on the way: docs.openwallet.sh still shows v1.4.3 and an older `Policy` type (`executable` required, `action: "deny" | "warn"`, `simulation` in `PolicyContext`); the repo's `docs/03-policy-engine.md` has `rules` + optional `executable`, `action: "deny"` only, and no `simulation` field. Use the repo.

## Vercel Workflow SDK 5

| Claim | Verdict | Evidence |
| --- | --- | --- |
| L38: Workflow SDK gives encrypted event logs, retries, replay, suspended workflows. | Confirmed | Blog: "The Workflow event log stores step arguments and return values so a run can recover after a crash or deployment." |
| L44: Payloads encrypted with AES-256-GCM, including on self-hosted Worlds with a custom key provider. | Confirmed | Blog: "encrypted with AES-256-GCM, using a unique key for each run"; "Encryption is implemented in the SDK, so it can also protect payloads on self-hosted Worlds". |
| L104: Self-hosted World implements `getEncryptionKeyForRun()`; replay must get the same 32 bytes. | Confirmed | Encryption doc: "Return the raw 32-byte key as a `Uint8Array`"; "Ensure the same key is returned for the same run ID across invocations". Two call shapes: `(run)` and `(runId, context?)`. |
| L106: Cross-run sealed writes and configurable payload retention exist. | Confirmed | Blog: cross-run payload "is encrypted to the target run's public key"; retention via `experimental_retention: 0` (experimental). |
| L106: Run attributes are plaintext. | Confirmed | Blog: "Attributes are plaintext, so they should not contain secrets." |
| L108: Not end-to-end from human device to wallet; workflow code sees plaintext. | Confirmed | Blog: "Plaintext is decrypted in your deployment or in authorized observability tools." |
| L287–288: Workflow SDK 5 brings "existing replay, encryption and hooks" with Postgres World as the World backend. | **Wrong** | `packages/world-postgres/README.md` (https://github.com/vercel/workflow/blob/b1f9269/packages/world-postgres/README.md): "This World does not currently implement `getEncryptionKeyForRun()` … inputs and return values, hook payloads and metadata, and stream chunks are all stored in your database in readable form." `worlds-manifest.json`: `postgres` features `[]`, `vercel` features `["encryption"]`. |
| L297: Workflow supports self-hosted Worlds; Vercel maintains a Postgres reference implementation. | Confirmed | `worlds-manifest.json`: `@workflow/world-postgres`, type `official`, "Self-hosted reference world using PostgreSQL". |
| L297: v5 encryption can use a custom `getEncryptionKeyForRun()`, so hosted Vercel is not needed. | Confirmed | Encryption doc "Custom World implementations". It is a method on a custom/derived `World`, not a config switch. |
| L358: Vercel's Chat SDK/Workflow guide shows suspend-and-resume via a callback URL; put auth in front of resume. | Confirmed | https://vercel.com/kb/guide/human-in-the-loop-with-chat-sdk-and-workflow-sdk: "`createWebhook()` returns an object with a `url` that's a public endpoint"; buttons use `callbackUrl={webhookUrl}`. |
| L649: Workflow SDK 5 "Released 12 November 2026". | **Wrong** | 12 Nov is the blog date. GitHub release `workflow@5.0.0` published 2026-10-01; current `workflow@5.5.0` (2026-11-10). |
| L649: `@workflow/world-postgres` uses PostgreSQL and Graphile Worker. | Confirmed | https://workflow-sdk.dev/worlds/postgres: "uses PostgreSQL for durable storage and graphile-worker"; `package.json` depends on `graphile-worker` 0.16.6. |
| L649: Encryption requires a compatible per-run key provider. | Confirmed | Encryption doc: "`World` implementations opt into encryption by providing a `getEncryptionKeyForRun()` method." |
| L836–838: `createHook()` + `resumeHook()` is the server-controlled HITL pattern; whoever holds a `createWebhook()` URL can resume it. | Confirmed | `docs/content/docs/v5/foundations/hooks.mdx` (https://github.com/vercel/workflow/blob/b1f9269/docs/content/docs/v5/foundations/hooks.mdx): "Anyone who has the URL, or can compute its token, can resume the workflow"; recommends `createHook()` behind your own route. |
| L841–854: `import { createHook } from "workflow"`, `createHook<T>({ token })`, `await hook`. | Confirmed | `hooks.mdx` examples. Same file: custom tokens "are usually built from domain data … easier to reconstruct"; generated tokens are seeded from the run ID, "not like a credential". |
| L865: Approval API checks permissions, then calls `resumeHook()`. | Confirmed | `hooks.mdx` § "Authorize before calling `resumeHook()`": "neither `resumeHook()` nor the webhook endpoint checks who is sending the payload"; example uses `getHookByToken()` from `workflow/api`. |
| L940: Encrypts inputs, outputs, hooks and streams when the World supports it; names, IDs, timestamps stay plaintext. | Confirmed | Encryption doc "What is encrypted"; "workflow names, step names, entity IDs, timestamps, and lifecycle states are **not** encrypted". |
| L942: Selecting the Postgres backend does not prove encryption is on; implement or wrap the key provider. | Confirmed | Understated: Postgres World README states it does not encrypt at all; "A World derived from this one can opt in by implementing that single method". |
| L959: Encrypted payloads need a provider implementation. | Confirmed | As above. |
| L1047: Exactly-once on-chain effects cannot be assumed from workflow durability. | Confirmed | `docs/content/docs/v5/foundations/idempotency.mdx`: "it is not always possible to ensure an operation has only been performed once"; use step IDs as idempotency keys. |

## Open Wallet Standard (OWS)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| L39: OWS provides encrypted vault, **signing isolation**, scoped policies. | **Wrong** (isolation) | `docs/05-key-isolation.md` (https://github.com/open-wallet-standard/core/blob/947f562/docs/05-key-isolation.md): "The agent and signer share an address space"; subprocess enclave is under "Future". `docs/00-specification.md`: "subprocess or enclave-style isolation" is optional. Vault and policies are real. |
| L44: Wallet keys sit behind OWS's access and policy layer. | Confirmed | `docs/03-policy-engine.md`: policies evaluated before decryption for `ows_key_` tokens. Owner passphrase: "**None.** Full access to all wallets." |
| L108: OWS encrypts keys at rest; spec describes in-process hardening, not a hardware enclave. | Confirmed | `README.md`: "Current implementations harden in-process memory handling"; architecture box "Signing Core (in-process)". |
| L174: OWS has a local-first vault. | Confirmed | `README.md`: vault at `~/.ows/wallets/`. |
| L299: Spec covers encrypted local wallets, scoped agent access, policy-gated signing. | Confirmed | https://docs.openwallet.sh/ abstract: "local wallet storage, delegated agent access, and policy-gated signing". |
| L299, L936, L962: Spec is MIT; implementation licence to be checked. | Confirmed | Repo `LICENSE` MIT; every crate `Cargo.toml` and `bindings/node/package.json` declare `MIT`. Implementation is MIT too. |
| L465: OWS exposes wallet operations through **MCP, REST**, SDK and CLI. | **Wrong** | Reference implementation is SDK (Node/Python via FFI) + CLI only. `README.md`: "Native SDK and CLI today." `ows/crates/ows-cli` has no `serve`/MCP command; no HTTP server crate. MCP/REST appear only in https://openwallet.sh/ marketing copy. Issue #119 (open): "`ows serve --mcp` … error: unrecognized subcommand 'serve'". |
| L465: Model includes scoped API tokens, wallet IDs, policy IDs. | Confirmed | https://docs.openwallet.sh/ `ApiKey { walletIds; policyIds; expiresAt? }`. |
| L473, L480: Control plane creates wallet and scoped token via OWS admin interface. | Confirmed | `docs/sdk-node.md`: `createApiKey(name, walletIds, policyIds, passphrase, expiresAt?, vaultPath?)` — needs the owner passphrase; token is shown once (`03-policy-engine.md` step 8). |
| L540: OWS access tokens stay inside the OWS subsystem; our DB stores only references. | **Wrong** | `03-policy-engine.md`: OWS stores `token_hash: SHA256(T)` and "Displays T once — owner provisions it to the agent". The raw token lives with the caller and is passed on every sign call. |
| L588, L897: Agent could call `ows_sign` directly. | **Wrong** | No `ows_sign` tool in the reference implementation. Name appears only on https://openwallet.sh/ ("Agent calls ows_sign via MCP, REST, or SDK"). |
| L655: Repo supports local encrypted wallets, SDK/CLI, policy-constrained API keys; policies attach to credentials, not wallets. | Confirmed | `03-policy-engine.md` § Policy Attachment: "Policies are attached to API keys, not wallets." |
| L661: Website advertises MCP; spec treats transports as optional; README emphasizes SDK/CLI; an issue reports missing `ows serve --mcp`. | Confirmed | `docs/04-agent-access-layer.md` lists in-process, subprocess, local service, CLI profiles; no MCP. Issue #119, opened 2026-03-25, still open. docs.openwallet.sh index still labels doc 04 "MCP server, REST API, and SDK interface"; the page body does not. |
| L669, L891: Signing is in-process; the API token derives a key that decrypts the key's own encrypted wallet-secret copy; token + key file is signing material outside the policy path. | Confirmed | `03-policy-engine.md`: "re-encrypts it under a key derived from the API token … the token serves as both authentication and decryption capability"; threat table: "Token + disk access — Can decrypt, but requires bypassing OWS process entirely". |
| L895: Agent credentials look like `ows_key_...`. | Confirmed | `03-policy-engine.md`: `ows_key_<64 hex chars>`. |
| L898: Several spending controls need executable policies, not declarative rules. | Confirmed | `03-policy-engine.md`: "Per-transaction value caps, recipient allowlists, and cumulative daily spend are **not** implemented as declarative rules". Also: on EVM `transaction.effects` is empty, so a policy "has to decode `raw_hex` itself". |
| L963: OWS MCP transport not confirmed in current core. | Confirmed | See L465 row. |
| L1025: Owner unlock for privileged lifecycle; unattended signing with a scoped credential held by the signer. | Confirmed | `03-policy-engine.md` access model: owner passphrase vs `ows_key_` token tiers. |

## Busy and eve

| Claim | Verdict | Evidence |
| --- | --- | --- |
| L40: Busy/eve gives per-agent sandboxes, an **approval inbox**, chat, mobile UX. | **Wrong** (inbox) | `docs/coworker-features.md` (https://github.com/MatiSolina/busy/blob/3dd91e1/docs/coworker-features.md): approvals are eve approval prompts rendered "as a card" in chat; no inbox exists in docs. Sandboxes, chat and mobile layouts (`docs/handbook.md`: "works in a browser, including mobile layouts") are real. |
| L44: Busy provides approval flows and isolation between bots. | Confirmed | `coworker-features.md`: `templates/bot/agent/lib/approval.ts` "is the approval policy on every MCP marketplace connection". `docs/architecture.md`: per-bot OIDC and JWT audience. |
| L160: eve is an agent runtime with approval suspension. | Confirmed | https://busybot.dev/: "Built on eve: durable sessions, approvals and subagents." vercel/eve is Apache-2.0. |
| L170: Hub centralizes state and credentials; each bot is a separate Vercel project with a sandbox. | Confirmed | `docs/architecture.md`: "Each bot runs as an independently deployable Eve application with its own Vercel project, durable session and isolated computer." |
| L170: Busy does not have transaction-bound cryptographic approvals. | Confirmed | `coworker-features.md`: approval triggers from MCP tool annotations (`readOnlyHint`, `destructiveHint`) and verb heuristics, decided inside the bot's eve app. |
| L667: Hub runs locally; bots need Vercel projects, Sandbox, Drive and related services. | Confirmed | `architecture.md` § "What this architecture does not promise": "creating live bots requires the operator to configure the Vercel resources". Also Workflow, Queues, Schedules, Blob, AI Gateway/OIDC, Container Registry, wildcard DNS. |
| L667, L967: Busy is Apache-2.0. | Confirmed | Repo `LICENSE`: "Apache License Version 2.0"; GitHub `license.spdx_id` `Apache-2.0`. |
| L968: Busy's infrastructure is Vercel-oriented. | Confirmed | https://busybot.dev/: "Runs on Vercel Workflow, Queues, Sandbox and AI Gateway." |
| L289, L1027: eve can be the agent runtime in a default deployment with no Vercel services. | Unverifiable | Blog says eve sessions are "powered natively by Workflow SDK and Worlds", but no eve doc read here shows eve running on a self-hosted World or outside Vercel Sandbox. |

## WebAuthn, SimpleWebAuthn, Better Auth, Secure Payment Confirmation

| Claim | Verdict | Evidence |
| --- | --- | --- |
| L718, L761: Registration uses `navigator.credentials.create()`, approval uses `navigator.credentials.get()`. | Confirmed | MDN Web Authentication API (https://github.com/mdn/content/blob/deca95e/files/en-us/web/api/web_authentication_api/index.md). |
| L721: Private key stays in the authenticator. | Confirmed | MDN: "The asymmetric key pair is stored in the authenticator". |
| L723: Better Auth's passkey plugin uses SimpleWebAuthn. | Confirmed | `@better-auth/passkey` 1.7.23 depends on `@simplewebauthn/server ^13.3.2`, `@simplewebauthn/browser ^13.3.0`. SimpleWebAuthn latest is v14.1.0, so Better Auth is one major behind. |
| L764–774: `await generateAuthenticationOptions({ rpID, allowCredentials, userVerification: "required" })`. | Confirmed | `generateAuthenticationOptions.ts`: async; `userVerification?: 'required' \| 'preferred' \| 'discouraged'`, default `'preferred'`. |
| L780–789: `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, credential, requireUserVerification })`. | Confirmed | `verifyAuthenticationResponse.ts`: `credential: WebAuthnCredential`, `requireUserVerification?: boolean` (default `true`). |
| L792: Browser side is `@simplewebauthn/browser`. | Confirmed | https://simplewebauthn.dev/docs/packages/server: options "can be passed directly into @simplewebauthn/browser's `startAuthentication()`". |
| L794: Verification checks signature, challenge, RP ID, origin, UV; the app stores and consumes the challenge. | Confirmed | Same page: "(Pseudocode) Remember this challenge for this user"; verify call takes expected challenge/origin/RP ID. |
| L798–800: A passkey assertion does not prove the user saw transaction details. | Confirmed | MDN: `get()` returns "the challenge signed by the private key". SPC exists to add that proof (next row). |
| L802: W3C SPC covers supported payment flows, not general agent or crypto operations. | Confirmed | https://www.w3.org/TR/secure-payment-confirmation/ abstract: "authentication during a payment transaction … cryptographic evidence that the user has confirmed transaction details"; invoked via `PaymentRequest` method `"secure-payment-confirmation"` with payee, total, instrument fields. Status: Candidate Recommendation Draft. |
| L1031: Passkeys are scoped to the RP domain; localhost works for dev; production needs HTTPS and a stable host. | Confirmed | MDN `publickeycredentialcreationoptions`: `rp.id` "needs to equal the origin's effective domain, or a domain suffix thereof", scheme `https`. SimpleWebAuthn docs: "'localhost' is okay for local dev". |

## Tally

| Verdict | Workflow | OWS | Busy/eve | WebAuthn/SPC | Total |
| --- | --- | --- | --- | --- | --- |
| Confirmed | 18 | 14 | 7 | 10 | 49 |
| Wrong | 2 | 4 | 1 | 0 | 7 |
| Stale | 0 | 0 | 0 | 0 | 0 |
| Unverifiable | 0 | 0 | 1 | 0 | 1 |

## Corrections that matter for design

1. **Postgres World stores everything in plaintext** (L287–288). `@workflow/world-postgres` does not implement `getEncryptionKeyForRun()`. Encryption on a self-hosted stack means shipping our own World derived from it, plus a test that rows hold ciphertext. The same World also does not authenticate requests to `/.well-known/workflow/*`; gate those at the proxy (https://workflow-sdk.dev/worlds/postgres).
2. **OWS has no MCP or REST server** (L465, L588, L897). There is no `ows serve --mcp` and no `ows_sign` tool. "Mount OWS MCP connection" (L476) is not available; the agent-facing MCP surface is ours to build over the Node SDK inside the signer.
3. **OWS signing is in-process** (L39). Isolation is an optional, unimplemented profile. The signer service is the only isolation boundary.
4. **The raw `ows_key_` token cannot stay inside OWS** (L540). OWS keeps only its SHA-256 hash and shows the token once. The signer must hold the raw token in its own secret store, and token + API-key file decrypts the wallet secret. Creating a key also needs the owner passphrase, so provisioning is a privileged signer-side step.
5. **Busy has no approval inbox or grant model** (L40). Its approvals are eve tool-annotation cards inside each bot, running in that bot's Vercel project. Inbox, intent binding and grants must be built.
6. **eve off Vercel is unverified** (L289, L1027). Busy bots require Vercel projects, Sandbox and Drive. A no-Vercel default cannot assume eve or Busy bots run self-hosted until eve on a self-hosted World is proven.
