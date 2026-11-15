# @askgina/os-signer

The signer holds every wallet key of a deployment and decides, on its own, whether to sign. It is a small HTTP service on internal networks that only the control plane and the keyless `approve` service (which serves the confirmation page) can reach.

The control plane can ask the signer for things. It cannot make it sign. Every operation that adds authority (signing a transaction, changing a policy, adding an approver, lowering or raising a threshold, resuming a paused workspace) must carry passkey assertions over a statement of that exact operation (an _envelope_). The signer recomputes the envelope's digest, checks each assertion against its own registry of approvers, and acts at most once per approval and per nonce.

The contract is [`packages/protocol/src/signer/api.ts`](../../packages/protocol/src/signer/api.ts). The design and its reasons are in [the ExecPlan](../../specs/agent-workspaces-v0.1.md), Milestone 2.

## What it trusts

- **Its own SQLite file** (`$SIGNER_DATA_DIR/signer.sqlite`): workspaces, approvers, wallet policies with their hash chain, used nonces, signed transactions, the spend ledger, the decision log, the restore fence, open confirmations with the assertions made on them, and the possession challenges of approver changes (table `possession_challenges`). Its schema version is `PRAGMA user_version`, now 4 (version 4 added `possession_challenges`); the signer migrates it in one transaction when it opens the file, and refuses to open a file written by a newer signer (`SchemaTooNewError`, logged as `schema_too_new`).
- **Its vault** (`$SIGNER_DATA_DIR/vault`): an [Open Wallet Standard](https://github.com/open-wallet-standard/core) key store, one wallet with its own mnemonic per wallet id. OWS is used only to keep keys encrypted and sign; it enforces nothing. The signer builds every transaction itself from the approved intent (`to`, `value`, `data`, the chain; ERC-20 calldata is encoded here), so it never signs bytes a caller handed it.
- **Two request-signing secrets**, one per scope. The control plane's (`SIGNER_HMAC_SECRET_FILE`) proves a request came from the control plane within the last minute; it reaches every route except the four confirm routes. The `approve` service's (`SIGNER_CONFIRM_SECRET_FILE`) reaches only those four, so a compromised confirmation page cannot sign, apply or read anything else. Pausing a workspace and revoking an approval need only the control plane's secret, because they only remove authority.
- **The relying party** (`WEBAUTHN_RP_ID`, `SIGNER_APPROVAL_ORIGIN`). An assertion counts only when the browser made it on the confirmation page: at `SIGNER_APPROVAL_ORIGIN` exactly, top-level (not in a frame: no `crossOrigin: true`, no `topOrigin`), as a `webauthn.get`, under `WEBAUTHN_RP_ID`. The same rule holds when the signer signs, when it applies an admin change, and when it accepts an assertion on a confirmation route. An assertion made on any page the control plane serves is refused with `assertion_invalid`. No setting widens this: the earlier `WEBAUTHN_ORIGINS`, which let the control plane's own page approve, was removed (`specs/trusted-display.md`, milestone 3).
- **The operator's label files** (`SIGNER_CHAINS_FILE`, `SIGNER_ASSETS_FILE`): chain names, native coins, token symbols and decimals shown on the confirmation page. They change what a person reads, never what is signed.

It does **not** trust the control plane's database, its idea of who is an approver, or anything it says about a challenge. A compromised control plane can withhold requests, mislead a person in its own pages, and link them to the confirmation page of another request, but the page shows what the signer holds and only an approval made there counts. A compromised `approve` service, or the proxy in front of it, can show a false view on that page and relay an approval over another digest: for a payment the per-wallet caps bound what that can cost; a sweep is bounded by where it may go; a misled change of policy or approvers is not bounded (see "Limits" in [`docs/threat-model.md`](../../docs/threat-model.md)).

## Signing

`POST /v1/sign`, in this order; every refusal is returned with its code, and every refusal after step 1 for a workspace the signer knows is recorded in that workspace's decision log (see "Decision log"):

1. Request signature and schema.
2. Idempotency: the same approval id with the same envelope returns the stored transaction; a different envelope is `conflict`.
3. The restore fence (see "Restoring"): an envelope issued before the fence plus 30 seconds is `envelope_fenced`.
4. The envelope is `approve-intent` and matches the intent's workspace, wallet, agent and chain; `intentHash(intent)` equals the envelope's.
5. The workspace is not paused; the approval is not revoked. Step 2 comes first on purpose: a repeat of an approval that was already signed returns the stored transaction even while the workspace is paused. Pausing stops new signatures; it does not recall one that exists.
6. The wallet has a policy and its hash equals the envelope's.
7. Passkey assertions from the signer's own approvers, at the policy's threshold, within the policy's lifetime (and `SIGNER_MAX_INTENT_TTL_SECONDS`).
8. `gas × maxFeePerGas ≤ maxFeeWei` and `maxPriorityFeePerGas ≤ maxFeePerGas`.
9. One SQLite transaction with no `await` inside: the fence again, the envelope nonce is unused, the policy allows the intent against the last 24 hours of signed spends, the vault's signature recovers to the wallet's address over exactly the transaction the signer built, then the nonce, the spend, the signed transaction and the decision are stored together.

`POST /v1/wallets/:walletId/sweep` signs a person's `sweep-wallet` approval the same way, with no agent and no wallet cap: the envelope binds `sweepHash(sweep)`; assertions are checked at the workspace's admin threshold; a paused workspace can be swept; and the destination must be on the wallet's current recipient allowlist or be a treasury wallet of the same workspace (`sweep_destination_not_allowed` otherwise). The signer builds the native transfer or the ERC-20 `transfer(to, amount)` itself and signs once per approval.

There is no route for messages, typed data, raw hashes or EIP-7702 authorizations. Any path or method the contract does not name answers 404.

## Confirmation pages

The confirmation page lets a person read an approval as the signer holds it and approve it there, on its own origin, so the control plane cannot show one operation and collect a passkey assertion for another (`specs/trusted-display.md`). It is the only place an approval is made, for every envelope kind. Six routes, in `confirmations.ts`:

- `POST /v1/approvals/:approvalId/confirmation` (control scope) opens it with `{ envelope, subject }`, where the subject is the intent, the policy or the sweep whose hash the envelope names, or `envelope-only`. The signer checks that the subject is exactly what the envelope names (`intent_mismatch`, `envelope_mismatch`), that the workspace and wallet exist, that the envelope has not expired, that the approval was not revoked (`approval_revoked`) or used (`confirmation_closed`), and that it could still act on it: not fenced (`envelope_fenced`), and for a payment or a policy change the wallet's policy is still the one it names (`policy_missing`, `policy_changed`). It stores both and answers `{ path: "/a/<approvalId>#<token>" }` with a fresh 16-byte token, keeping only its SHA-256. Opening again with the same envelope issues a new token and the old link stops working; another envelope for the same approval is `conflict`.
- `GET /v1/confirm/:approvalId` (confirm scope, token in `x-confirm-token`) returns the view: its state (`open`, `complete`, `expired`, `revoked`, `used` or `superseded`), the lines `renderConfirmation` builds from the stored envelope and subject and the signer's own records (wallet label and address, current policy, 24-hour spend in the payment's asset, admin threshold, treasury wallets, the operator's labels), the approvals collected and required, and the WebAuthn options: the envelope's digest as challenge, the passkeys of approvers who have not approved yet, user verification required. A wrong token is `not_found`.
- `POST /v1/confirm/:approvalId/assertions` (confirm scope) takes `{ response }`, one assertion. More than 64 submissions per approval are `rate_limited`. The state must be `open` (`confirmation_closed`); the passkey must be one of the workspace's approvers (`approver_unknown`); the browser must have made the assertion at `SIGNER_APPROVAL_ORIGIN`, top-level, as a `webauthn.get` (`assertion_invalid`); one per person (`conflict`). It answers `{ collected, required, returnUrl }`.
- `GET /v1/approvals/:approvalId/assertions` (control scope) lists the stored assertions of people who are still approvers with the same passkey, with the signer's own user id for each. The control plane sends them back to sign or apply, and the signer verifies them again there.
- `GET /v1/confirm/:approvalId/possession` (confirm scope, token in `x-confirm-token`) returns the possession step of an `add-approver` request: the WebAuthn options with `possessionChallenge({ approvalId, credentialId, nonce })` as challenge, the envelope's credential id as the only allowed passkey, user verification required. The nonce is 16 random bytes in table `possession_challenges`, made on the first request and kept until an answer uses it. Any other kind of request is `not_found`; a request that is not `open` or `complete` is `confirmation_closed`.
- `POST /v1/confirm/:approvalId/possession` (confirm scope) takes `{ response }`, the person being added's answer. It counts toward the same 64 submissions. The answer must come from the envelope's credential and verify against the envelope's public key, made at `SIGNER_APPROVAL_ORIGIN`, top-level, as a `webauthn.get` (`assertion_invalid`); an answer to a used or absent challenge is also `assertion_invalid`. On success the signer deletes the nonce, records `possession_proven_at` on the confirmation (the first proof stays), and answers `{ fingerprint }`, the key's fingerprint for the person to read to the approvers.

Until the proof, the view of an `add-approver` request carries the warning `possession_unproven`, `POST /v1/confirm/:approvalId/assertions` refuses an approval of it with `possession_unproven`, and `POST /v1/workspaces/:workspaceId/approvers` refuses to apply it with `possession_unproven` unless the confirmation of that exact envelope records the proof. The operator's `enroll-approver` has no such step.

A payment needs its policy's threshold; every other kind needs the admin threshold. Confirmations and possession proofs add no authority, so they are logged to stdout (`confirmation.opened`, `confirmation.assertion` and `confirmation.possession` with outcome and code, `confirmation.rate_limited`), not to the decision log; a refusal to apply an `add-approver` with `possession_unproven` is in the decision log like every other refusal. Nothing in a log line carries a token, an intent or an assertion.

## Refusal codes

| Code                            | HTTP | Meaning                                                                                                                                            |
| ------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`               | 400  | The body or a path parameter does not match the contract.                                                                                          |
| `unauthenticated`               | 401  | The request signature is missing, wrong, or more than 60 seconds from the signer's clock.                                                          |
| `not_found`                     | 404  | Unknown route, workspace, wallet or approver.                                                                                                      |
| `conflict`                      | 409  | An id already exists with different content, or an approval already acted on cannot change.                                                        |
| `confirmation_closed`           | 409  | The approval can no longer collect assertions: revoked, used, expired, superseded or complete.                                                     |
| `possession_unproven`           | 409  | The person being added has not proven on the confirmation page that they hold the passkey an approver change adds.                                 |
| `rate_limited`                  | 429  | More than 64 assertions were submitted for one confirmation.                                                                                       |
| `workspace_paused`              | 403  | The workspace is paused; nothing signs until a passkey-approved resume.                                                                            |
| `approval_revoked`              | 403  | The approval id was revoked; it will never sign or apply.                                                                                          |
| `envelope_mismatch`             | 403  | The envelope is the wrong kind, or names another workspace, wallet, agent, chain or policy.                                                        |
| `envelope_expired`              | 403  | The envelope's `expiresAt` has passed.                                                                                                             |
| `envelope_not_yet_valid`        | 403  | The envelope is dated more than 30 seconds in the future.                                                                                          |
| `envelope_ttl_too_long`         | 403  | The envelope lives longer than the policy or the signer's ceiling allows.                                                                          |
| `envelope_fenced`               | 403  | The envelope was issued before the restore fence (plus 30 seconds); propose it again.                                                              |
| `nonce_reused`                  | 403  | The envelope's nonce was already used by another approval.                                                                                         |
| `intent_mismatch`               | 403  | The intent is not the one that was approved (any field changed).                                                                                   |
| `policy_missing`                | 403  | The wallet has no policy yet, so it signs nothing.                                                                                                 |
| `policy_changed`                | 403  | The wallet's policy is no longer the revision the approval or change was made against.                                                             |
| `policy_denied`                 | 403  | The policy refuses the intent; `detail` carries the reason (for example `over_daily_cap`).                                                         |
| `policy_invalid`                | 403  | A new policy is not the next revision of the hash chain.                                                                                           |
| `fee_cap_exceeded`              | 403  | The fee would exceed the approved ceiling, or the priority fee exceeds the max fee.                                                                |
| `insufficient_approvals`        | 403  | Fewer different approvers signed than the threshold requires.                                                                                      |
| `assertion_invalid`             | 403  | An assertion does not verify for this envelope, origin, RP ID or user verification.                                                                |
| `approver_unknown`              | 403  | An assertion comes from a passkey that is not (or no longer) an approver of the workspace.                                                         |
| `threshold_unreachable`         | 403  | The change would leave a threshold that the remaining approvers cannot meet, or would lower the admin threshold below a wallet's policy threshold. |
| `sweep_destination_not_allowed` | 403  | A sweep's destination is neither on the wallet's recipient allowlist nor a treasury wallet of the same workspace.                                  |
| `vault_error`                   | 500  | The key store failed, or a wallet was requested while the owner passphrase file is absent.                                                         |
| `internal`                      | 500  | Anything else. Nothing about it is returned; the log has the failing route.                                                                        |

## Configuration

| Variable                        | Meaning                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNER_PORT`                   | Listener port (default 8787).                                                                                                       |
| `SIGNER_DATA_DIR`               | Holds `signer.sqlite` and `vault/`.                                                                                                 |
| `SIGNER_HMAC_SECRET_FILE`       | Base64 file, at least 32 bytes: the request-signing secret shared with the control plane.                                           |
| `SIGNER_CONFIRM_SECRET_FILE`    | Base64 file, at least 32 bytes, not the request secret: shared with the `approve` service.                                          |
| `SIGNER_KEY_FILE`               | Base64 file, exactly 32 bytes: seals the per-wallet OWS tokens stored in SQLite.                                                    |
| `SIGNER_VAULT_PASSPHRASE_FILE`  | The OWS owner passphrase, read only when a wallet is created. Absent: existing wallets still sign.                                  |
| `WEBAUTHN_RP_ID`                | The relying party ID passkeys were registered under.                                                                                |
| `SIGNER_APPROVAL_ORIGIN`        | The confirmation page's exact origin, the only one an approval may be made at: a host under `WEBAUTHN_RP_ID` or another port on it. |
| `SIGNER_RETURN_ORIGIN`          | The control plane's origin, where the confirmation page sends people afterwards.                                                    |
| `SIGNER_CHAINS_FILE`            | The control plane's chains file; the signer reads each chain's id, `name` and `nativeSymbol`.                                       |
| `SIGNER_ASSETS_FILE`            | JSON array of `{ chainId, asset, symbol, decimals }` for the tokens the page names.                                                 |
| `SIGNER_MAX_INTENT_TTL_SECONDS` | Ceiling on an intent approval's lifetime (default 86400).                                                                           |
| `SIGNER_MAX_ADMIN_TTL_SECONDS`  | Ceiling on other envelopes' lifetime (default 86400).                                                                               |

`WEBAUTHN_ORIGINS` is no longer read; remove it from an older environment. The signer refuses to start when a secret is missing or malformed, when the confirm secret equals the request secret, when `SIGNER_APPROVAL_ORIGIN` is not under the RP ID or equals `SIGNER_RETURN_ORIGIN` (the control plane's origin), or when a label file has a name or symbol that could pass for something else (symbols `^[A-Za-z0-9.]{1,11}$`, chain names printable ASCII up to 40 characters, decimals 0 to 36). It runs with umask 077, and on SIGTERM finishes requests in flight before closing the database.

```sh
node src/main.ts
```

## Admin CLI

Runs on the signer host, with the same environment, against the same SQLite file:

```sh
node src/admin.ts enroll-approver --workspace ws_… --user usr_… \
  --credential-id <base64url> --public-key <base64url COSE key>
node src/admin.ts verify-log --workspace ws_…
node src/admin.ts fence
```

Each command prints one JSON line. `enroll-approver` adds exactly the passkey typed on the command line as an approver of the workspace, in one transaction with an `enroll-approver-by-operator` entry in the decision log; it refuses an unknown workspace (`not_found`) or a credential already enrolled (`conflict`). It is how a workspace whose people lost every passkey regains control; its wallets are untouched. There is no HTTP route for this: anything relayed over HTTP passes through the control plane, which could swap in its own key. **Host access is the root of trust:** whoever can run this command on the signer host can add an approver, so treat shell access to that host as signing authority.

`fence` sets the restore fence to the host's clock (it never moves it back) and records `fence-set-by-operator` in every workspace's decision log. It prints `{"ok":true,"action":"fence-set-by-operator","fenceAt":…}`. Run it after every restore, before the signer serves.

`verify-log` recomputes the workspace's decision-log hash chain and compares its end with the head stored on the workspace row, which every append updates in the same transaction. It detects damaged, edited or deleted rows, including the newest ones. The chain is not keyed, so someone who can write the SQLite file can rewrite every row and the head consistently; it does not detect that.

## Decision log

Recorded, per workspace: every allowed change (workspace creation, wallets, policies, approvers, thresholds, pause, resume, signatures, sweeps, revocations, operator enrollment, restore fences) and every refusal of a request that passed the request signature and the body's schema and names a workspace the signer knows. Not recorded: requests with a missing or bad request signature, malformed bodies or paths, requests for workspaces, wallets or approvals the signer does not know (`not_found`), and refusals before a workspace is resolved. Those appear only as one JSON line on the signer's stdout with the route and code.

## Back up

Back up `SIGNER_DATA_DIR` (the SQLite file and the vault together), `SIGNER_KEY_FILE` and the owner passphrase.

- The vault alone holds every wallet's mnemonic, encrypted under the owner passphrase.
- The SQLite file holds the sealed OWS tokens, the policies, the approvers and the used nonces. Restoring an older copy forgets nonces that were used since.
- Without `SIGNER_KEY_FILE` the stored tokens cannot be opened; the passphrase can still recover the wallets from the vault.
- Read access to the vault plus a token is the wallet's key. Keep the volume readable by the signer's user only.

## Restoring

Every restore is fenced, because nothing in a backup says whether a payment happened after it. Run `node src/admin.ts fence` before the signer serves. From then on the signer refuses every envelope issued before the fence plus 30 seconds (`envelope_fenced`), so an approval used after the backup cannot be signed again; approvals waiting at the restore must be proposed again. An approval this database already signed still returns its stored transaction.

The signer also records which file its database is (inode and creation time) and fences by itself when it opens another one: a copy, an extracted archive, a move to another host. It logs `restore fence set` with `reason: new_database_file` and records `fence-set-on-new-database-file`. It cannot tell a restore that rolls the same file back in place (a disk snapshot), so the operator's step stays. The first start on a v0.1 file fences once, because no file was recorded.
