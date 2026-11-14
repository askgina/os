<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [What do cloning, exporting and deleting a workspace mean when its wallets hold assets?](https://github.com/askgina/os/issues/23). **Date:** 2026-11-14.
>
> **Map:** [After v0.1: wider approvals, more venues, more machines](https://github.com/askgina/os/issues/18).
>
> Written by a research agent from source and documentation only. Nothing in this report was run: no build, no test, no stack. Every claim is tagged as read from a file (path and line), read from a URL, or `[INFERENCE]`. Line numbers refer to `main` at `61dd59c`.
>
> Draft ExecPlan built on this report: [`specs/workspace-lifecycle.md`](../workspace-lifecycle.md).

# Workspace lifecycle: clone, export and delete when wallets hold assets

## Question

v0.1 can create and pause a workspace. What should clone, export and delete do to wallets, keys, policies, the audit log and encrypted workflow history, what must be refused while assets remain, and how does deletion relate to key shredding and to backups?

## Answer

- **Clone is a template, never a key copy.** A clone is a new workspace with fresh wallets and fresh agent tokens. It carries names, the admin threshold, wallet kinds and labels, and each wallet's policy as a _proposal_ that the new workspace's approvers must approve with passkeys. Members are invited, not copied into the signer. No key, intent, approval, transaction, audit entry or workflow run is copied. This needs no signer change. Two workspaces holding one key would split one account's daily caps and nonce order across two ledgers, so "restore an existing wallet into a clone" is refused; funds move between workspaces only by an approved transfer.
- **Export is two files, neither with keys.** A _template_ (the clone input, no secrets) and a _record_ (the opened audit log with its chain, intents, transactions and the signer's decision log, verifiable offline). Both are produced by the control plane, which can already read sealed content, so a passkey step-up for export protects against a stolen session, not against a compromised control plane. A wallet key leaves the signer only through the signer's admin CLI on the signer host. There is no HTTP path, because the passkey proves a digest, not that the person saw which recipient key the mnemonic is encrypted to.
- **Delete is staged and the signer gates the irreversible step.** Pause, empty the wallets, request deletion (a new `delete-workspace` envelope at the admin threshold, naming every wallet and address the signer holds for the workspace and a `destroyAfter` time), wait out a delay the signer enforces, then finalize: the signer destroys the wallet keys, the control plane shreds the workspace key and every run key of the workspace, and both keep a tombstone. Cancelling is free during the delay and leaves the workspace paused.
- **"Refuse while assets remain" cannot be enforced by the signer.** The signer has no network path to any chain. Balances come from the control plane, which the design does not trust. What the signer can enforce is that enough approvers signed an envelope naming the exact wallet set and acknowledging that whatever is left is lost, plus a delay. The control plane refuses to _offer_ deletion while it sees balances, pending approvals or unmined transactions; that refusal is advisory.
- **v0.1 has no way for a person to move funds out.** Only agents propose, and only agents named in a policy's `requesters`. Emptying a wallet whose agent is gone, or emptying it beyond its caps, needs a new operation. The recommended one is a `sweep-wallet` envelope at the admin threshold whose destination must already be on the wallet's recipient allowlist or be the workspace's own treasury.
- **Deletion is not erasure from backups.** A backup taken before deletion contains the wrapped data keys and the keyring that unwraps them, and the vault with the passphrase and token key that open it. Deleted content becomes unrecoverable only when every copy of the KEK that wrapped the shredded keys is gone: rotate the keyring after a deletion and let older keyring backups expire. For wallet keys, backups are a feature (recovery of funds deleted by mistake) as long as they are protected like the funds.
- **EU data protection is a question for counsel.** The audit chain covers user ids, not names, and its details are salted and sealed. Erasing a member can delete names, passkeys and sessions while the ids stay in the chain. Whether pseudonymous ids may stay is the open question; a commitment-based chain is the fallback design.

## Findings

### 1. What a workspace owns in v0.1

Control-plane tables in schema `os` (`apps/server/src/db/schema.ts`):

| Table                                                            | Lines   | Owned by the workspace?                                                                                                       | Readable or sealed                                          |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workspaces`                                                     | 114-131 | the root row; also holds the audit head (`audit_seq`, `audit_head`, 129-130) and a mirror of the signer's `paused` flag (123) | name readable                                               |
| `memberships`, `approver_credentials`, `invites`                 | 133-206 | yes, by `workspace_id`                                                                                                        | readable ids and roles; invite token stored as a hash (186) |
| `wallets`                                                        | 208-232 | yes                                                                                                                           | address, label and policy readable                          |
| `agents`                                                         | 234-256 | yes; `status` is `active` or `disabled` (250); token stored as a hash (244)                                                   | name readable                                               |
| `approvals`, `approval_assertions`, `approval_rejections`        | 277-347 | yes                                                                                                                           | envelope readable; `detail` sealed                          |
| `intents`, `transactions`                                        | 364-434 | yes                                                                                                                           | `payload`, `presentation`, `raw` sealed                     |
| `audit_events`                                                   | 436-463 | yes, hash-chained per workspace                                                                                               | `detail` sealed                                             |
| `nonce_reservations`                                             | 465-481 | yes, through its wallet                                                                                                       | readable                                                    |
| `users`, `credentials`, `sessions`, `ceremonies`, `installation` | 46-112  | no: installation-wide; one person can be in several workspaces                                                                | display name and public keys readable                       |

Source-read. The comment at `schema.ts:28-37` states the readable/sealed split.

Keys (`packages/keys`):

- One data key per `(scope, id)`, scopes `run` and `workspace` (`packages/keys/src/data-key-store.ts:8-12`). The table has a `tenant_id` column bound into the wrapping AAD (`data-key-store.ts:25-35`, `43-49`). Source-read.
- The control plane seals with `getOrCreate("workspace", workspaceId, workspaceId)` (`apps/server/src/db/sealed.ts:20-25`). Source-read.
- Every workflow run is started with the tenant option set to the workspace id (`apps/server/src/execution/workflow-runtime.ts:140`), and the World passes it to `getOrCreate("run", runId, tenant)` (`packages/world/src/index.ts:55-65`). So every run key of a workspace can be found by `tenant_id`. Source-read.
- `shred(scope, id)` replaces the wrapped key with a tombstone and returns whether a live key existed (`data-key-store.ts:258-279`). The CLI shreds one id at a time (`packages/keys/src/cli.ts:5`, `47-53`). There is no "shred every run of a tenant". Source-read.
- Other processes keep an unwrapped key for up to the cache TTL, one minute by default (`data-key-store.ts:105`, `packages/keys/README.md:62-63`). Source-read.

Workflow history (`workflow` and `graphile_worker` schemas): payloads are ciphertext under the run key; names, ids, hook tokens, timestamps and statuses stay readable; run attribute values are replaced by `[withheld]` (`docs/threat-model.md:167-193`, `specs/agent-workspaces-v0.1.md:144-146`). After a run key is shredded, metadata rows remain and payload reads fail (`specs/agent-workspaces-v0.1.md:503-505`). In v0.1 every run is an approval run (`apps/server/workflows/approval.ts`; `approvals.run_id`, `schema.ts:300-301`). Source-read.

The signer's own state (`apps/signer/src/db.ts:9-102`): `workspaces` (with `paused` and the decision-log head), `approvers`, `wallets` (with `sealed_credential`, line 37), `policies`, `used_nonces`, `approvals`, `signatures` (the signed raw transaction in plaintext, line 73), `spends`, `decisions`. The schema is created with `CREATE TABLE IF NOT EXISTS` and has no migration step. Source-read.

The OWS vault (`apps/signer/src/vault.ts:79-160`): one OWS wallet with its own 24-word mnemonic per wallet id (105), one `ows_key_` API key per wallet, named after the wallet id (119). Only the token is kept, sealed under the signer's token key. On disk, `wallets/<uuid>.json` holds the mnemonic under the vault passphrase and `keys/<uuid>.json` holds it again under a key derived from the token (`specs/research/ows-node-sdk-in-an-isolated-signer.md`, F6 and F7). Source-read.

On chain: balances and transaction history. Neither the signer nor the control plane can remove them. `[INFERENCE]` from how public chains work.

### 2. What v0.1 can do to a workspace today

- **Create**: control plane and signer (`CreateWorkspaceRequest`, `packages/protocol/src/signer/api.ts:50-61`; signer `createWorkspace`, `apps/signer/src/signer.ts:431-459`). The first approvers are trust on first use (`docs/threat-model.md:224-231`). Source-read.
- **Pause**: request signature only, because it only removes authority (`signer.ts:461-470`; `packages/api/src/routes.ts:157-158`). **Resume** needs a `resume-workspace` envelope at the admin threshold (`packages/protocol/src/envelopes.ts:83-88`; `signer.ts:472-483`). Source-read.
- **Disable an agent**: control plane only (`apps/server/src/directory/routes.ts:700-720`); the MCP gateway refuses a disabled agent (`apps/server/src/mcp/gateway.ts:429`). The signer is not told. Source-read.
- **Nothing else.** No envelope, signer route or API route exists for clone, export, delete, wallet retirement or key export (`envelopes.ts:90-105`, `api.ts:30-46`, `packages/api/src/routes.ts`). The v0.1 plan lists "workspace clone, export and delete" as a non-goal (`specs/agent-workspaces-v0.1.md:42-46`), and so does the threat model (`docs/threat-model.md:265`). Source-read.

### 3. Only agents can move funds, and only within caps

- An `Intent` carries a required `agentId` (`packages/protocol/src/intent.ts:80-94`), the envelope binds it (`envelopes.ts:34-43`), and `evaluateIntent` refuses an agent not in the policy's `requesters` (`packages/protocol/src/evaluate.ts:38-40`). Source-read.
- Treasury wallets are proposed from by agents the treasury's policy names (`apps/server/src/execution/intents.ts:259-274`). Source-read.
- Every transfer is capped per transaction and per rolling day (`packages/protocol/src/policy.ts:24-32`), and an asset with no entry cannot leave the wallet (comment at `policy.ts:23`). Source-read.
- Consequence: a wallet whose agent was disabled or removed, or which holds more than its caps or an asset not in its policy, cannot be emptied without first changing the policy (admin threshold) and then having an agent propose. A disabled agent cannot propose at all. `[INFERENCE]` from the above.
- Consequence: the control plane could fabricate an intent under any agent id the policy lists; the signer does not authenticate agents (`signer.ts:710-745` checks the envelope and policy, not the agent). That is v0.1's existing posture: an intent still needs passkey approvals. `[INFERENCE]`.

### 4. The signer cannot see balances

- The signer has no outbound network and no route except from the server (`specs/agent-workspaces-v0.1.md:237-239`; `deploy/README.md` networks table, `signing` is internal). Source-read.
- The signer builds transactions from the intent and signs them; it does not read chain state, and it counts a signed amount as spent even if the transaction never lands (`docs/threat-model.md:241-243`). Source-read.
- So no rule of the form "refuse while the balance is not zero" can be checked by the signer. Any balance shown to an approver comes from the control plane, which is untrusted for exactly this kind of claim. `[INFERENCE]`.
- Native-coin dust always remains after a "send everything" transaction: an EIP-1559 sender pays `gas_used × effective_gas_price`, which is not known when the transaction is signed, and unused fee is not spent ([EIP-1559](https://eips.ethereum.org/EIPS/eip-1559), "Specification"). An amount chosen as `balance − gas × maxFeePerGas` leaves the difference behind. Source-read for the fee rule; the dust consequence is `[INFERENCE]`.
- Tokens the policy does not list (an airdrop, a mistaken transfer, an NFT) are invisible to a control plane that reads only the assets in the policy. `[INFERENCE]`.

### 5. A signed, unmined transaction outlives its key

- The signer keeps every signed raw transaction (`apps/signer/src/db.ts:68-76`) and so does the control plane, sealed (`schema.ts:398-434`, `raw` at 414). Source-read.
- A signed EVM transaction stays valid until the account's nonce passes it. `[INFERENCE]` from EVM nonce rules.
- After the wallet's key is destroyed, nobody can send a replacement at that nonce. Whoever holds a copy of the signed transaction (a backup, the database) can broadcast it at any later time, for example after someone sends funds to the old address. It pays only the recipient and amount that were approved. `[INFERENCE]`.
- A `stuck` transaction keeps being watched in v0.1 (`specs/agent-workspaces-v0.1.md:156-158`) and repricing it is not designed ([#22](https://github.com/askgina/os/issues/22)). Source-read.

### 6. Shredding and what it does not reach

- A shred removes the wrapped key from the live row (`data-key-store.ts:264-279`). Postgres keeps the old row version until `VACUUM` reclaims it, and even then the bytes may remain in the page until reused ([PostgreSQL 18, Routine Vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html)). The old row is also in the WAL and in any backup. Source-read for vacuum semantics; the rest is `[INFERENCE]`.
- A wrapped key is useless without the KEK that wrapped it, and the keyring keeps every KEK until it is pruned after a rewrap (`deploy/README.md:85-98`, `packages/keys/README.md:44-52`). Source-read.
- The backup instructions say to back up `postgres-data`, `server-secrets` (the keyring), `signer-data` and `signer-secrets` together, "from the same moment" (`deploy/README.md:60-83`). Source-read. A backup set taken before a deletion therefore restores the deleted workspace in full, readable. `[INFERENCE]`.
- Erasure that holds against old backups needs the KEK that wrapped the shredded keys to be destroyed in every copy: rotate (add, rewrap, prune) after the shred, and let keyring backups older than the rotation expire. Until then, the erasure window equals the keyring backup retention. `[INFERENCE]` from the two facts above.
- For wallet keys the same logic gives a different answer. The wallet file is encrypted under the vault passphrase, which is installation-wide (`vault.ts:96-104`); a backup of `signer-data` with `signer-secrets` contains every wallet ever created there. Deleting a wallet leaves it recoverable from backups. Because the alternative is losing funds by mistake, this is useful, provided backups are protected as funds (`docs/threat-model.md:145-155`). `[INFERENCE]` for the value judgment.
- OWS 1.4.5 exposes `deleteWallet(nameOrId, vaultPath?)` and `revokeApiKey(id, vaultPath?)` and `listApiKeys` (installed `node_modules/.bun/node_modules/@open-wallet-standard/core/index.d.ts:57-58`, `100-103`). `ApiKeyResult` has an `id` (`index.d.ts:87-95`); the signer does not store it, but the key is named after the wallet id (`vault.ts:119`), so `listApiKeys` finds it. Source-read. Whether `deleteWallet` also removes the API key file is not documented; the plan calls both. `[INFERENCE]`.
- SQLite keeps deleted content in free pages and the WAL unless `PRAGMA secure_delete` is on ([SQLite pragma documentation](https://www.sqlite.org/pragma.html#pragma_secure_delete)). The signer does not set it (`apps/signer/src/db.ts:103-111`). Source-read.

### 7. The audit chain and member erasure

- The chained fields are workspace id, seq, time, actor type, **actor id**, action, subject type, subject id, a digest of the sealed detail, and the previous hash (`apps/server/src/audit.ts:30-41`). Source-read.
- The sealed detail includes a 16-byte random salt, so the digest in the chain does not confirm a guess about the detail (`audit.ts:19-27`, `70-73`). Source-read.
- Details carry workspace and agent names and agent memos (`apps/server/src/directory/routes.ts:276`, `659`; `apps/server/src/execution/intents.ts:451`), not member display names. Source-read.
- Shredding the workspace key leaves the chain verifiable (hashes and digests are plaintext) and every detail unreadable. `[INFERENCE]` from the two points above.
- User ids remain in the chain and in `approval_assertions` (whose WebAuthn `userHandle` is the user id). A person's display name lives only in `users.display_name` (`schema.ts:51-55`). Source-read.
- The signer's decision log has no user id (`apps/signer/src/db.ts:89-100`); its `approvers` table has `user_id` and the public key (`db.ts:22-29`). Source-read.

On the legal side, named as questions, not answered here:

- GDPR Article 17 gives a right to erasure with exceptions in 17(3) ([Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj)). Source-read for the existence of the article and its exceptions; whether any exception applies to this audit log is a legal question.
- The EDPB's Guidelines 02/2025 on blockchain technologies, version 2.0 adopted 7 July 2026, say that a salted or keyed hash is still personal data, but that after the salt or key is deleted "the hash should not be linkable to the original data" (paragraph 52); that a perfectly hiding commitment is useless once the data and its witness are deleted (paragraph 53); that "technical impossibility cannot be invoked to justify non-compliance" (paragraph 50); and that encrypted personal data remains personal data, with key deletion making it unintelligible (paragraph 51) ([guidelines PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf), [EDPB page](https://www.edpb.europa.eu/documents/guideline/guidelines-022025-on-processing-of-personal-data-through-blockchain_en)). Source-read. Paragraph 13 places chains "generated and controlled by and for a single entity" partly out of scope, which describes this audit log. Source-read. Applying the guidelines here is `[INFERENCE]`.

### 8. The vendored conversation's lifecycle section

`docs/references/chatgpt-combine-encryption-approval-ux.md:544-560`, "5. Lifecycle is where this gets interesting", proposes: lifecycle operations as durable workflows; Clone copies configuration with a fresh wallet; Export exports configuration and an encrypted backup separately; Delete revokes credentials, stops the agent, handles remaining assets, then deletes; cloning never silently clones a private key, "unless the owner explicitly authorizes restoring an existing wallet"; provisioning is idempotent. Source-read.

What holds:

- Clone with fresh wallets and no key copy: holds, and is stronger here (no exception, see finding 9).
- Delete as revoke, stop, handle assets, then delete: holds as an order. "Handle remaining assets" cannot be enforced by the signer (finding 4).
- Idempotent, resumable steps: holds. The finalize step in the plan is a sweeper that repeats safely.
- Export of configuration separate from data: holds.

What does not hold:

- "OWS is the wallet authority; your workspace service is the lifecycle authority" (`chatgpt-…-ux.md:482`). In this design the signer is the authority over wallets and policy (`specs/agent-workspaces-v0.1.md:121-123`), and the irreversible lifecycle step (destroying keys) must be decided by the signer too, not by the control plane. Source-read for the v0.1 decision; the extension to lifecycle is this report's recommendation.
- "Export … encrypted backup" per workspace: v0.1 has one database, one keyring and one vault for the installation; a per-workspace encrypted backup would need per-workspace KEKs and vault separation. `[INFERENCE]`. Not recommended now.
- "Restoring an existing wallet" into a clone: refused (finding 9).
- "Pause … suspend workflows": v0.1 pause stops signing at the signer and does not suspend runs (`signer.ts:461-470`). Source-read. Nothing in lifecycle needs runs suspended, only ended before their keys are shredded (finding 10).

### 9. Why one key must not live in two workspaces

- Daily caps are counted per wallet id in the signer's `spends` (`db.ts:79-87`, `signer.ts:770-776`). Nonce reservations are per wallet id in the control plane (`schema.ts:465-481`). Source-read.
- Two wallet ids over one key would give one account two independent cap ledgers and two nonce sequences: twice the daily cap, and colliding nonces that make one workspace's transactions replace the other's. `[INFERENCE]`.
- OWS one-mnemonic-per-wallet was chosen so wallets never share a blast radius (`specs/agent-workspaces-v0.1.md:130-132`). Copying a key would undo that. Source-read for the decision.

### 10. Live workflow runs and shredding

- The encrypting World throws when a key is missing, and the run "stalls and retries instead of leaking" (`docs/threat-model.md:189-191`). Source-read.
- Shredding the key of a run that is still waiting on an approval therefore leaves a run that retries forever. Deletion must end every run first: cancel pending approvals, revoke them at the signer (`revokeApproval`, `api.ts:43`, `106-108`), wake the run so it finishes, then shred. `[INFERENCE]`.

## Options compared

### Clone

| Option                                                                                                                                   | Signer change          | Keys   | Risk                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| A. Template at the control plane: new workspace, creator as first approver, policies proposed as `set-policy` approvals, members invited | none                   | fresh  | none new; every authority in the clone is re-approved with passkeys there                       |
| B. Signer-side clone: a `clone-workspace` envelope copies approvers and policies inside the signer                                       | new envelope and route | fresh  | approver set copied without the new workspace's own TOFU step; more signer code for convenience |
| C. Clone with the same keys                                                                                                              | new key-sharing logic  | shared | splits caps and nonces (finding 9); refused                                                     |

### Export

| Option                                                        | Contents                                                                                             | Who approves                                             | Note                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A. Template + record, produced by the control plane           | template: names, policies, labels; record: opened audit log, intents, transactions, signer decisions | owner, with a fresh passkey sign-in at the control plane | protects against a stolen session; a compromised control plane already reads all of it                        |
| B. Per-workspace encrypted backup                             | ciphertext and wrapped keys of one workspace                                                         | owner                                                    | needs per-workspace KEKs and vault split; large change                                                        |
| C. Key export over HTTP                                       | mnemonic encrypted to a recipient key in a passkey envelope                                          | admin threshold at the signer                            | a compromised control plane shows one recipient and submits its own; the mnemonic bypasses every cap. Refused |
| D. Key export only by the signer admin CLI on the signer host | mnemonic to a file on the signer host                                                                | the operator (host access is the root of trust)          | adds no capability the host lacks; logged in the decision log                                                 |

### Delete and remaining assets

| Option                                                                                      | What the signer enforces                                               | Remaining assets                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A. Control plane deletes alone                                                              | nothing                                                                | the signer keeps keys forever; or the control plane asks to delete them with no human check. Breaks the invariant for an irreversible act |
| B. Passkey envelope, immediate destruction                                                  | admin threshold over the exact wallet set                              | lost at once if the control plane lied about balances or misled the approver                                                              |
| C. Passkey envelope plus a signer-enforced delay, free cancel, then finalize                | admin threshold, exact wallet set, `destroyAfter ≥ issuedAt + minimum` | the delay is the window to notice; keys are also in backups until they expire                                                             |
| D. Never destroy keys; "delete" only tombstones the workspace and pauses the signer forever | pause, plus a terminal state                                           | always recoverable by the operator; never erased                                                                                          |

### Emptying wallets before deletion

| Option                                                                                                                                                                                                    | Change                                           | Effect                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A. Existing kinds only: raise caps and add an agent to `requesters` by `set-policy`, then approve intents                                                                                                 | none                                             | works only while an agent can propose; one policy change and one approval per asset; caps raised for the duration  |
| B. `sweep-wallet` envelope: admin threshold; signer signs one transfer of a caller-chosen amount of one asset to a destination already on the wallet's recipient allowlist or to the workspace's treasury | new envelope, route and builder                  | no agent needed; caps do not apply; the destination was approved earlier by passkeys or is the workspace's own key |
| C. Person-proposed intents (an intent without an agent)                                                                                                                                                   | protocol change to `Intent` and `evaluateIntent` | general, but changes the meaning of every intent and of `requesters`                                               |

### Backups after deletion

| Option                                                                                         | Erasure window                                       | Cost                                                    |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| A. Document only                                                                               | until every pre-deletion backup set is destroyed     | none                                                    |
| B. Rotate the keyring after each deletion; keep keyring backups on a shorter, stated retention | until keyring backups older than the rotation expire | one rotation per deletion; operator discipline          |
| C. Per-workspace KEK, destroyed on deletion                                                    | until keyring backups expire, per workspace          | keyring format change                                   |
| D. Deletion ledger re-applied on restore                                                       | none for restores that carry the ledger              | the ledger must live outside the backup set it protects |

## Recommendation

This is a recommendation, for the owner to accept or change.

1. **Clone: option A, template at the control plane.** No signer change. Same installation: members become invites with their roles; across installations, the template carries no members. Refuse any clone that copies keys.
2. **Export: options A and D.** A template file and a record file from the control plane, owner only, with a passkey sign-in no older than five minutes. Wallet keys only through a new `export-wallet` command in the signer's admin CLI, recorded as `export-wallet-by-operator` in the decision log. No HTTP route, ever.
3. **Delete: option C.** New envelope `delete-workspace` at the admin threshold, naming every live wallet id and address the signer holds for the workspace and `destroyAfter`. The signer refuses if the set differs from its own, or if `destroyAfter − issuedAt` is below `SIGNER_MIN_DESTROY_DELAY_SECONDS` (recommended default 7 days). Cancel needs only the request signature and leaves the workspace paused, so signing again still needs `resume-workspace`. Finalize needs only the request signature and is refused before `destroyAfter`. The control plane runs finalize from a sweeper, shreds the workspace key and every run key of the tenant after the signer reports the keys destroyed, and keeps a tombstone (ids, statuses, hashes, addresses, the audit chain; names cleared).
4. **Single wallet: the same shape.** `retire-wallet` envelope, same delay, cancel leaves the wallet `held` (signing refused until a new policy is approved), finalize destroys its key. **Single agent:** removal is a control-plane action (it only removes authority); the agent's wallet stays until it is swept and retired.
5. **Emptying: option B, `sweep-wallet`.** One approval, one transaction, as everywhere else. Destination limited to the wallet's existing recipient allowlist or the workspace's treasury address. Allowed while the workspace is paused, not after a delete or retire request (cancel first). Batching several assets into one passkey ceremony waits for the mandates work ([#19](https://github.com/askgina/os/issues/19)).
6. **Preconditions at the control plane, advisory:** no pending approvals, no runs that are not finished, no transactions in `signed`, `broadcast` or `stuck`, and a balance read of native coin and every asset in each policy. Shown on the delete card as "read by the server, not checked by the signer". Unmined transactions block finalize until they are confirmed, rejected, or replaced (the latter depends on [#22](https://github.com/askgina/os/issues/22)).
7. **Backups: option B.** The deploy guide states the erasure window. Finalize prints the rotation commands; the release gate proves that after rotate-and-prune, a pre-deletion database with the new keyring cannot open the deleted workspace's sealed content.
8. **Member erasure:** delete passkeys, sessions and the display name; keep the user id in the chain and in assertions. Mark the legal question open. If counsel says ids must go, the fallback is a chain format that commits to `HMAC(per-person salt, userId)` with the salt in a deletable table (EDPB paragraph 52).

The invariant holds for all of it: every step that destroys a key or moves funds needs passkey assertions the signer verifies against its own registry, and the control plane can only remove authority (pause, cancel, disable) or trigger a step the signer already authorized.

## Limits

- Nothing here is runtime-observed. No code was run, no stack started, no OWS call made. OWS behaviour is from its type declarations and the earlier OWS research.
- Whether OWS `deleteWallet` removes the API key file, and whether OWS overwrites files before unlinking, is not known.
- File deletion on an SSD or copy-on-write file system does not guarantee the bytes are gone; the plan does not claim secure erasure of disk blocks, only of keys whose wrapping KEK is destroyed.
- The legal reading is not legal advice. The EDPB guidelines address blockchains; this audit log is a single-entity hash chain they treat as partly out of scope.
- The trusted-display gap ([#20](https://github.com/askgina/os/issues/20)) applies to every new envelope here: a compromised control plane can show one wallet set or destination and submit another. The signer's exact-set check and the allowlist-only sweep destination reduce what it can gain; the delay gives people time to notice, which works better with notifications ([#24](https://github.com/askgina/os/issues/24)).
- Multi-machine deployments ([#25](https://github.com/askgina/os/issues/25)) change backup and KEK custody; this report assumes the v0.1 Compose layout.
