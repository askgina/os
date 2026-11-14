# @askgina/os-signer

The signer holds every wallet key of a deployment and decides, on its own, whether to sign. It is a small HTTP service on an internal network that only the control plane can reach.

The control plane can ask the signer for things. It cannot make it sign. Every operation that adds authority (signing a transaction, changing a policy, adding an approver, lowering or raising a threshold, resuming a paused workspace) must carry passkey assertions over a statement of that exact operation (an _envelope_). The signer recomputes the envelope's digest, checks each assertion against its own registry of approvers, and acts at most once per approval and per nonce.

The contract is [`packages/protocol/src/signer/api.ts`](../../packages/protocol/src/signer/api.ts). The design and its reasons are in [the ExecPlan](../../specs/agent-workspaces-v0.1.md), Milestone 2.

## What it trusts

- **Its own SQLite file** (`$SIGNER_DATA_DIR/signer.sqlite`): workspaces, approvers, wallet policies with their hash chain, used nonces, signed transactions, the spend ledger and the decision log.
- **Its vault** (`$SIGNER_DATA_DIR/vault`): an [Open Wallet Standard](https://github.com/open-wallet-standard/core) key store, one wallet with its own mnemonic per wallet id. OWS is used only to keep keys encrypted and sign; it enforces nothing. The signer builds every transaction itself from the approved intent (`to`, `value`, `data`, the chain; ERC-20 calldata is encoded here), so it never signs bytes a caller handed it.
- **The request-signing secret**, shared with the control plane. It proves a request came from the control plane within the last minute. Pausing a workspace and revoking an approval need only that, because they only remove authority.
- **The relying party** (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`). Assertions from any other origin or RP ID are refused.

It does **not** trust the control plane's database, its idea of who is an approver, or anything it says about a challenge. A compromised control plane can withhold requests and can show a person one operation while asking them to approve another; the per-wallet caps the signer enforces bound what that can cost.

## Signing

`POST /v1/sign`, in this order; every refusal is returned with its code, and every refusal after step 1 for a workspace the signer knows is recorded in that workspace's decision log (see "Decision log"):

1. Request signature and schema.
2. Idempotency: the same approval id with the same envelope returns the stored transaction; a different envelope is `conflict`.
3. The envelope is `approve-intent` and matches the intent's workspace, wallet, agent and chain; `intentHash(intent)` equals the envelope's.
4. The workspace is not paused; the approval is not revoked. Step 2 comes first on purpose: a repeat of an approval that was already signed returns the stored transaction even while the workspace is paused. Pausing stops new signatures; it does not recall one that exists.
5. The wallet has a policy and its hash equals the envelope's.
6. Passkey assertions from the signer's own approvers, at the policy's threshold, within the policy's lifetime (and `SIGNER_MAX_INTENT_TTL_SECONDS`).
7. `gas × maxFeePerGas ≤ maxFeeWei` and `maxPriorityFeePerGas ≤ maxFeePerGas`.
8. One SQLite transaction with no `await` inside: the envelope nonce is unused, the policy allows the intent against the last 24 hours of signed spends, the vault's signature recovers to the wallet's address over exactly the transaction the signer built, then the nonce, the spend, the signed transaction and the decision are stored together.

There is no route for messages, typed data, raw hashes or EIP-7702 authorizations. Any path or method the contract does not name answers 404.

## Refusal codes

| Code                     | HTTP | Meaning                                                                                                                                            |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`        | 400  | The body or a path parameter does not match the contract.                                                                                          |
| `unauthenticated`        | 401  | The request signature is missing, wrong, or more than 60 seconds from the signer's clock.                                                          |
| `not_found`              | 404  | Unknown route, workspace, wallet or approver.                                                                                                      |
| `conflict`               | 409  | An id already exists with different content, or an approval already acted on cannot change.                                                        |
| `workspace_paused`       | 403  | The workspace is paused; nothing signs until a passkey-approved resume.                                                                            |
| `approval_revoked`       | 403  | The approval id was revoked; it will never sign or apply.                                                                                          |
| `envelope_mismatch`      | 403  | The envelope is the wrong kind, or names another workspace, wallet, agent, chain or policy.                                                        |
| `envelope_expired`       | 403  | The envelope's `expiresAt` has passed.                                                                                                             |
| `envelope_not_yet_valid` | 403  | The envelope is dated more than 30 seconds in the future.                                                                                          |
| `envelope_ttl_too_long`  | 403  | The envelope lives longer than the policy or the signer's ceiling allows.                                                                          |
| `nonce_reused`           | 403  | The envelope's nonce was already used by another approval.                                                                                         |
| `intent_mismatch`        | 403  | The intent is not the one that was approved (any field changed).                                                                                   |
| `policy_missing`         | 403  | The wallet has no policy yet, so it signs nothing.                                                                                                 |
| `policy_changed`         | 403  | The wallet's policy is no longer the revision the approval or change was made against.                                                             |
| `policy_denied`          | 403  | The policy refuses the intent; `detail` carries the reason (for example `over_daily_cap`).                                                         |
| `policy_invalid`         | 403  | A new policy is not the next revision of the hash chain.                                                                                           |
| `fee_cap_exceeded`       | 403  | The fee would exceed the approved ceiling, or the priority fee exceeds the max fee.                                                                |
| `insufficient_approvals` | 403  | Fewer different approvers signed than the threshold requires.                                                                                      |
| `assertion_invalid`      | 403  | An assertion does not verify for this envelope, origin, RP ID or user verification.                                                                |
| `approver_unknown`       | 403  | An assertion comes from a passkey that is not (or no longer) an approver of the workspace.                                                         |
| `threshold_unreachable`  | 403  | The change would leave a threshold that the remaining approvers cannot meet, or would lower the admin threshold below a wallet's policy threshold. |
| `vault_error`            | 500  | The key store failed, or a wallet was requested while the owner passphrase file is absent.                                                         |
| `internal`               | 500  | Anything else. Nothing about it is returned; the log has the failing route.                                                                        |

## Configuration

| Variable                        | Meaning                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SIGNER_PORT`                   | Listener port (default 8787).                                                                      |
| `SIGNER_DATA_DIR`               | Holds `signer.sqlite` and `vault/`.                                                                |
| `SIGNER_HMAC_SECRET_FILE`       | Base64 file, at least 32 bytes: the request-signing secret shared with the control plane.          |
| `SIGNER_KEY_FILE`               | Base64 file, exactly 32 bytes: seals the per-wallet OWS tokens stored in SQLite.                   |
| `SIGNER_VAULT_PASSPHRASE_FILE`  | The OWS owner passphrase, read only when a wallet is created. Absent: existing wallets still sign. |
| `WEBAUTHN_RP_ID`                | The relying party ID passkeys were registered under.                                               |
| `WEBAUTHN_ORIGINS`              | Comma-separated exact origins of the approval page.                                                |
| `SIGNER_MAX_INTENT_TTL_SECONDS` | Ceiling on an intent approval's lifetime (default 3600).                                           |
| `SIGNER_MAX_ADMIN_TTL_SECONDS`  | Ceiling on other envelopes' lifetime (default 86400).                                              |

The signer refuses to start when a secret is missing or malformed, runs with umask 077, and on SIGTERM finishes requests in flight before closing the database.

```sh
node src/main.ts
```

## Admin CLI

Runs on the signer host, with the same environment, against the same SQLite file:

```sh
node src/admin.ts enroll-approver --workspace ws_… --user usr_… \
  --credential-id <base64url> --public-key <base64url COSE key>
node src/admin.ts verify-log --workspace ws_…
```

Each command prints one JSON line. `enroll-approver` adds exactly the passkey typed on the command line as an approver of the workspace, in one transaction with an `enroll-approver-by-operator` entry in the decision log; it refuses an unknown workspace (`not_found`) or a credential already enrolled (`conflict`). It is how a workspace whose people lost every passkey regains control; its wallets are untouched. There is no HTTP route for this: anything relayed over HTTP passes through the control plane, which could swap in its own key. **Host access is the root of trust:** whoever can run this command on the signer host can add an approver, so treat shell access to that host as signing authority.

`verify-log` recomputes the workspace's decision-log hash chain and compares its end with the head stored on the workspace row, which every append updates in the same transaction. It detects damaged, edited or deleted rows, including the newest ones. The chain is not keyed, so someone who can write the SQLite file can rewrite every row and the head consistently; it does not detect that.

## Decision log

Recorded, per workspace: every allowed change (workspace creation, wallets, policies, approvers, thresholds, pause, resume, signatures, revocations, operator enrollment) and every refusal of a request that passed the request signature and the body's schema and names a workspace the signer knows. Not recorded: requests with a missing or bad request signature, malformed bodies or paths, requests for workspaces, wallets or approvals the signer does not know (`not_found`), and refusals before a workspace is resolved. Those appear only as one JSON line on the signer's stdout with the route and code.

## Back up

Back up `SIGNER_DATA_DIR` (the SQLite file and the vault together), `SIGNER_KEY_FILE` and the owner passphrase.

- The vault alone holds every wallet's mnemonic, encrypted under the owner passphrase.
- The SQLite file holds the sealed OWS tokens, the policies, the approvers and the used nonces. Restoring an older copy would forget nonces that were used since; restore the latest.
- Without `SIGNER_KEY_FILE` the stored tokens cannot be opened; the passphrase can still recover the wallets from the vault.
- Read access to the vault plus a token is the wallet's key. Keep the volume readable by the signer's user only.
