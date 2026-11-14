# Approval protocol, version 1

This document is normative. It is precise enough to write a second verifier from. The reference
implementation is [`packages/protocol/src/`](../packages/protocol/src/). Where this document and
that code disagree, the code is what runs; please report the difference as a bug.

The words MUST, MUST NOT and SHOULD have their RFC 2119 meanings.

## 1. Primitives

Source: [`primitives.ts`](../packages/protocol/src/primitives.ts).

| Name             | Encoding                                                                                                                                                                                         | Example                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Identifier       | A prefix, `_`, then a ULID in lowercase Crockford base32 (26 characters from `0-9a-hjkmnp-tv-z`). Prefixes: `ws` workspace, `usr` user, `agt` agent, `wal` wallet, `int` intent, `apr` approval. | `wal_01jd0000000000000000000003`             |
| `Address`        | `0x` and 40 lowercase hex digits. Checksummed (EIP-55) forms are rejected; they are for display only.                                                                                            | `0x1111111111111111111111111111111111111111` |
| `Hex`            | `0x` and an even number of lowercase hex digits. `0x` is the empty byte string.                                                                                                                  | `0xa9059cbb…`                                |
| `Hex32`          | `0x` and 64 lowercase hex digits.                                                                                                                                                                | a transaction hash                           |
| `Digest`         | 64 lowercase hex digits, no prefix. A SHA-256 output.                                                                                                                                            | `52d18224…9da3`                              |
| `ChainId`        | CAIP-2 `eip155:` and a decimal number from 1, at most 15 digits (so it is exact as a JavaScript number), no leading zero.                                                                        | `eip155:8453`                                |
| `Amount`         | A base-unit integer as a decimal string (`0`, or no leading zero, at most 78 digits), at most 2^256 − 1. Strings, so no JSON number ever rounds it.                                              | `"250000000000000000"`                       |
| `PositiveAmount` | An `Amount` that is not `"0"`.                                                                                                                                                                   |                                              |
| `EpochSeconds`   | A JSON integer of seconds since the Unix epoch, from 0 to 32503680000.                                                                                                                           | `1700000000`                                 |
| `Base64Url`      | Unpadded base64url text (`A-Z a-z 0-9 - _`).                                                                                                                                                     |                                              |
| `Nonce`          | Exactly 16 random bytes as unpadded base64url (22 characters).                                                                                                                                   | `AAAAAAAAAAAAAAAAAAAAAA`                     |
| `AssetRef`       | The string `"native"` for the chain's coin, or an ERC-20 contract `Address`.                                                                                                                     |                                              |

**Sets.** Hashed structures store sets as JSON arrays sorted in strictly ascending order by
plain string comparison (UTF-16 code units, as JavaScript `<` compares). Strict order also
forbids duplicates. A set in any other order is invalid, not re-sorted. This gives one set one
hash. `normalizePolicy()` in [`policy.ts`](../packages/protocol/src/policy.ts) produces the
accepted order.

**Strict objects.** Every structure in this document is a closed object. An unknown member
makes the whole value invalid. The one exception is noted in section 5.

`PROTOCOL_VERSION` is `1`. Every hashed structure carries it as `v`.

## 2. Canonical JSON and digests

Source: [`canonical.ts`](../packages/protocol/src/canonical.ts).

Canonical JSON is RFC 8785 (JSON Canonicalization Scheme): object members sorted by UTF-16 code
units of their names, no whitespace, RFC 8785 string escaping and number form. All protocol
values are strings, integers below 2^53, booleans, `null`, arrays and objects, so number
formatting never meets a fraction or an exponent.

Every digest is:

```text
digest(tag, value) = SHA-256( UTF-8( tag || "\n" || canonicalJson(value) ) )
```

`"\n"` is one line-feed byte (0x0A). The tags separate the kinds of structure, so a digest of one
kind can never stand in for another kind:

| Tag                       | Used for                                              |
| ------------------------- | ----------------------------------------------------- |
| `askgina.os/v1/intent`    | `intentHash(intent)`                                  |
| `askgina.os/v1/policy`    | `policyHash(policy)`                                  |
| `askgina.os/v1/authorize` | `envelopeChallenge(envelope)`, the WebAuthn challenge |
| `askgina.os/v1/audit`     | audit log entries                                     |
| `askgina.os/v1/sweep`     | `sweepHash(sweep)`                                    |

`intentHash`, `policyHash` and `sweepHash` are the digest as a lowercase hex `Digest`.
`envelopeChallenge` is the raw 32 bytes.

A value MUST pass its schema before it is hashed. Hashing an unvalidated value can produce a
digest that no verifier will ever reproduce.

## 3. Intent

Source: [`intent.ts`](../packages/protocol/src/intent.ts). An intent is one operation an agent
asks one wallet to perform. It is immutable: change any field and it is a different intent with
a different hash.

| Field         | Type                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`           | `1`                                   | Protocol version.                                                                                                                                                                                                                                                                                                                                                         |
| `id`          | `int_…`                               | The intent's identifier.                                                                                                                                                                                                                                                                                                                                                  |
| `workspaceId` | `ws_…`                                | The workspace.                                                                                                                                                                                                                                                                                                                                                            |
| `agentId`     | `agt_…`                               | The agent that proposed it.                                                                                                                                                                                                                                                                                                                                               |
| `walletId`    | `wal_…`                               | The wallet that would act.                                                                                                                                                                                                                                                                                                                                                |
| `chainId`     | `ChainId`                             | The chain the transaction is for.                                                                                                                                                                                                                                                                                                                                         |
| `operation`   | one of three, below                   | What happens.                                                                                                                                                                                                                                                                                                                                                             |
| `maxFeeWei`   | `PositiveAmount`                      | Ceiling on `gas × maxFeePerGas` of the signed transaction.                                                                                                                                                                                                                                                                                                                |
| `memo`        | string, at most 280 UTF-16 code units | The agent's stated reason. It is hashed, so the text a person read is the text that was approved. It MUST NOT contain U+0000–U+001F, U+007F–U+009F, U+2028, U+2029, U+200E, U+200F, U+061C, U+202A–U+202E or U+2066–U+2069 (control characters, line separators and bidirectional marks and overrides, which could make a card show something other than what is stored). |
| `createdAt`   | `EpochSeconds`                        | When it was made.                                                                                                                                                                                                                                                                                                                                                         |

Operations, discriminated by `type`:

| `type`               | Fields                                                             | Meaning                                   |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `evm.transfer`       | `to: Address`, `valueWei: PositiveAmount`                          | Send the native coin.                     |
| `evm.erc20.transfer` | `token: Address`, `to: Address`, `amount: PositiveAmount`          | Call `transfer(to, amount)` on the token. |
| `evm.call`           | `to: Address`, `valueWei: Amount`, `data: Hex` of at least 4 bytes | Call a contract with raw calldata.        |

No address in an operation may be the zero address, and an `evm.erc20.transfer` may not send a
token to the token's own contract: both lose the funds and are easy to miss on an approval card.

**Spend.** `intentSpend(intent)` is what the intent moves out of the wallet, without fees:
`(native, valueWei)` for `evm.transfer` and `evm.call`; `(token, amount)` for
`evm.erc20.transfer`.

## 4. Wallet policy

Source: [`policy.ts`](../packages/protocol/src/policy.ts). The signer holds the authoritative
copy and enforces it when it signs.

| Field                  | Type                                                                                              | Meaning                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                    | `1`                                                                                               |                                                                                                                                                                                                                                                                              |
| `workspaceId`          | `ws_…`                                                                                            |                                                                                                                                                                                                                                                                              |
| `walletId`             | `wal_…`                                                                                           |                                                                                                                                                                                                                                                                              |
| `revision`             | integer ≥ 1                                                                                       | Revision number.                                                                                                                                                                                                                                                             |
| `previousHash`         | `Digest` or `null`                                                                                | `null` if and only if `revision` is 1. Otherwise the `policyHash` of the revision this one replaces. The revisions form a hash chain.                                                                                                                                        |
| `chains`               | sorted set of `ChainId`, at most 32                                                               | Chains the wallet may act on.                                                                                                                                                                                                                                                |
| `requesters`           | sorted set of `agt_…`, at most 64                                                                 | Agents that may propose from this wallet.                                                                                                                                                                                                                                    |
| `assets`               | array of `AssetLimit`, at most 128, sorted by the key `chainId + "\|" + asset`, unique            | Caps. An asset with no entry cannot leave the wallet.                                                                                                                                                                                                                        |
| `recipients`           | `{ "mode": "any" }` or `{ "mode": "allowlist", "addresses": sorted set of Address, at most 256 }` | Who may receive transfers. Does not apply to contract-call targets.                                                                                                                                                                                                          |
| `contractCalls`        | `{ "mode": "deny" }` or `{ "mode": "allowlist", "targets": sorted set of Address, at most 256 }`  | Contracts an `evm.call` may target. A token that has an `AssetLimit` may not also be a target: a raw `transfer` call to it would move the token with no cap.                                                                                                                 |
| `fees.maxPerTxWei`     | `PositiveAmount`                                                                                  | Largest `maxFeeWei` an intent may carry.                                                                                                                                                                                                                                     |
| `approvals.threshold`  | integer 1–16                                                                                      | How many different people must approve each transaction. The signer refuses a policy whose threshold exceeds the workspace's `adminThreshold` (`policy_invalid`), because policies are approved at the admin threshold and could otherwise lower it again with fewer people. |
| `approvals.ttlSeconds` | integer 60–86400                                                                                  | Longest time an `approve-intent` envelope may stay valid.                                                                                                                                                                                                                    |

`AssetLimit` is `{ chainId, asset: AssetRef, maxPerTx: PositiveAmount, maxPerDay: PositiveAmount }`.
`maxPerDay` covers any rolling 24 hours. Each limit's `chainId` MUST be in `chains`, and
`maxPerTx` MUST NOT exceed `maxPerDay`.

## 5. Envelopes and authorizations

Source: [`envelopes.ts`](../packages/protocol/src/envelopes.ts). An envelope states one thing a
person authorizes. Its digest is the WebAuthn challenge, so an assertion over one envelope cannot
be moved to any other: not to another intent, wallet, policy, workspace, expiry or kind.

Every envelope has this header:

| Field         | Type           | Meaning                                                                             |
| ------------- | -------------- | ----------------------------------------------------------------------------------- |
| `v`           | `1`            |                                                                                     |
| `type`        | string, below  | Which kind of envelope.                                                             |
| `approvalId`  | `apr_…`        | The control plane's approval request. The signer acts at most once per approval id. |
| `workspaceId` | `ws_…`         |                                                                                     |
| `nonce`       | `Nonce`        | Single use. The signer records it when it acts and refuses to see it again.         |
| `issuedAt`    | `EpochSeconds` |                                                                                     |
| `expiresAt`   | `EpochSeconds` | MUST be greater than `issuedAt`.                                                    |

The kinds and their extra fields:

| `type`                | Extra fields                                                                      | Authorizes                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve-intent`      | `intentHash: Digest`, `walletId`, `agentId`, `chainId`, `policyHash: Digest`      | Sign exactly one transaction for exactly one intent under exactly one policy revision.                                                                   |
| `set-policy`          | `walletId`, `policyHash: Digest`, `previousPolicyHash: Digest \| null`            | Replace a wallet's policy. `previousPolicyHash` is `null` only for the wallet's first policy.                                                            |
| `add-approver`        | `userId`, `credentialId: Base64Url`, `publicKey: Base64Url` (the COSE public key) | Let one more passkey approve for this workspace.                                                                                                         |
| `remove-approver`     | `userId`, `credentialId: Base64Url`                                               | Stop one passkey from approving for this workspace.                                                                                                      |
| `set-admin-threshold` | `adminThreshold`: integer 1–16                                                    | Change how many people must approve changes to approvers and policies. Never below any wallet's current `approvals.threshold` (`threshold_unreachable`). |
| `resume-workspace`    | none                                                                              | Let a paused workspace sign again. Pausing needs no envelope, because it only removes authority.                                                         |
| `sweep-wallet`        | `walletId`, `chainId`, `sweepHash: Digest`                                        | Sign exactly one transaction that moves the sweep below out of the wallet, with no agent and no cap. Approved at the workspace's `adminThreshold`.       |

A **sweep** (source: [`sweep.ts`](../packages/protocol/src/sweep.ts)) is the structure a
`sweep-wallet` envelope binds by its hash. Like an intent it is immutable.

| Field         | Type             | Meaning                                                              |
| ------------- | ---------------- | -------------------------------------------------------------------- |
| `v`           | `1`              | Protocol version.                                                    |
| `workspaceId` | `ws_…`           | The workspace.                                                       |
| `walletId`    | `wal_…`          | The wallet to empty.                                                 |
| `chainId`     | `ChainId`        | The chain the transaction is for.                                    |
| `asset`       | `AssetRef`       | The native coin, or the ERC-20 contract whose `transfer` is called.  |
| `amount`      | `PositiveAmount` | Base units to move.                                                  |
| `to`          | `Address`        | The destination. Not the zero address, and not the `asset` contract. |
| `maxFeeWei`   | `PositiveAmount` | Ceiling on `gas × maxFeePerGas` of the signed transaction.           |

The amount, the destination and the fee ceiling are therefore covered by the passkey, but none of
them appears in the envelope itself: the control plane stores the envelope unencrypted, and keeps
the sweep sealed.

```text
challenge = digest("askgina.os/v1/authorize", envelope)    (32 bytes)
```

The challenge MUST be given to WebAuthn as those 32 bytes. With `@simplewebauthn/server`, pass a
`Uint8Array`: a string is treated as UTF-8 and base64url-encoded again, and the signer could
then never recompute what the browser signed (finding 3 of
[`specs/research/passkey-assertion-bound-to-one-approval.md`](../specs/research/passkey-assertion-bound-to-one-approval.md)).

An **assertion** is `{ userId, credentialId, response }`. `response` is a WebAuthn
authentication response in the JSON form `@simplewebauthn/browser` returns
(`AssertionResponse`): `id`, `rawId`, `type: "public-key"`, `response.clientDataJSON`,
`response.authenticatorData`, `response.signature`, optional `response.userHandle`, and
`clientExtensionResults`. Unknown members of `response` are kept, because the signature covers
`clientDataJSON` and `authenticatorData`, not this wrapper. This is the one non-strict object.

An **authorization** is `{ envelope, assertions }` with 1 to 16 assertions.

An **approver credential**, as the signer stores it, is `{ userId, credentialId, publicKey }`.

## 6. Verifying an authorization

Source: [`webauthn/verify-authorization.ts`](../packages/protocol/src/webauthn/verify-authorization.ts).

Inputs: the authorization; the workspace's approver credentials **from the verifier's own
records**; the relying party (RP ID and the exact allowed origins, from configuration, never from
the request); the threshold; the longest lifetime this kind of envelope may have; the verifier's
clock `now`.

Checks, in this order. The first failure ends verification with its code.

1. `issuedAt > now + 30` → `envelope_not_yet_valid` (30 seconds of allowed clock skew).
2. `now >= expiresAt` → `envelope_expired`.
3. `expiresAt − issuedAt > maxTtlSeconds` → `envelope_ttl_too_long`.
4. Recompute the challenge from the envelope. Nothing the caller says about the challenge is
   used. Then, for each assertion in order:
   1. Find the approver whose `credentialId` and `userId` both equal the assertion's. None →
      `approver_unknown`.
   2. If `response.id` differs from that `credentialId`, or this person already has a verified
      assertion in this authorization → `assertion_invalid`.
   3. Verify the WebAuthn response against the recomputed challenge, the allowed origins, the
      RP ID, the stored public key, with user verification required. Failure →
      `assertion_invalid`.
5. Fewer distinct people than the threshold → `insufficient_approvals`.

Every assertion must pass. One unknown approver or one bad signature fails the whole
authorization, so removing a person invalidates the pending approvals they took part in.

The sign counter is not used (it is passed as 0). Synced passkeys report a counter of 0 forever,
and with a counter of 0 an identical assertion verifies twice. **Verification does not prevent
replay.** The acting party MUST record the envelope's `nonce` as used, atomically with acting on
it.

## 7. Policy evaluation

Source: [`evaluate.ts`](../packages/protocol/src/evaluate.ts).
`evaluateIntent(policy, intent, spent)` is pure and deterministic. `spent(chainId, asset)` returns
what the wallet already signed for that asset on that chain in the last 24 hours. The signer runs
it with its own ledger and its answer is final. The control plane runs the same function only to
tell an agent early that a proposal cannot pass.

Rules, in this order. The first that fails decides:

1. `policy.walletId ≠ intent.walletId` or `policy.workspaceId ≠ intent.workspaceId` →
   `wallet_mismatch`.
2. `intent.agentId` not in `requesters` → `requester_not_allowed`.
3. `intent.chainId` not in `chains` → `chain_not_allowed`.
4. `maxFeeWei > fees.maxPerTxWei` → `over_fee_cap`.
5. For `evm.call`: `contractCalls.mode` is not `allowlist`, or `to` is not in `targets` →
   `contract_call_not_allowed`. For the two transfers: `recipients.mode` is `allowlist` and
   `to` is not in `addresses` → `recipient_not_allowed`.
6. Compute the spend. If its amount is 0 (only possible for an `evm.call` that sends no coin),
   allow. Per-asset caps cannot see what such a call moves, which is why rule 5 denies calls to
   any contract that is not allowlisted.
7. No `AssetLimit` for `(chainId, asset)` → `asset_not_allowed`.
8. `amount > maxPerTx` → `over_per_tx_cap`.
9. `spent(chainId, asset) + amount > maxPerDay` → `over_daily_cap`.
10. Otherwise allow, with the spend `(chainId, asset, amount)`.

## 8. The signing rule

The signer's HTTP contract is [`signer/api.ts`](../packages/protocol/src/signer/api.ts). A sign
request (`POST /v1/sign`) carries `{ intent, authorization, transaction }`. The plan
([`specs/agent-workspaces-v0.1.md`](../specs/agent-workspaces-v0.1.md), Milestone 2) fixes these
checks, in order. Every refusal is returned with its code. A refusal is recorded in the
workspace's decision log when the request passed step 1 and names a workspace the signer knows;
requests with a bad request signature or a malformed body, and requests naming an unknown
workspace or wallet (`not_found`), are only logged to the signer's stdout.

1. The request signature (section 10) and the body's schema.
2. Idempotency. If this approval id was already signed with an identical envelope, return the
   stored signed transaction. If the envelope differs → `conflict`.
3. The restore fence. If the signer holds a fence and `envelope.issuedAt < fence + 30` →
   `envelope_fenced` (see below).
4. The envelope is `approve-intent`. Its workspace, wallet, agent and chain equal the intent's
   and the wallet's. `intentHash(intent)` equals `envelope.intentHash`. Otherwise
   `intent_mismatch` or `envelope_mismatch`.
5. The workspace is not paused (`workspace_paused`). The approval is not revoked
   (`approval_revoked`). Because step 2 comes first, a repeat of an approval already signed
   returns the stored transaction even while paused: pausing stops new signatures, it does not
   recall one that exists.
6. The wallet has a policy (`policy_missing`), and its hash equals `envelope.policyHash`
   (`policy_changed`).
7. Section 6 passes, with the approvers from the signer's own table, the policy's
   `approvals.threshold`, and a lifetime no longer than the policy's `approvals.ttlSeconds`.
8. `gas × maxFeePerGas ≤ intent.maxFeeWei`, and `maxPriorityFeePerGas ≤ maxFeePerGas`
   (`fee_cap_exceeded`).
9. In one database transaction with nothing awaited inside it: the fence is checked again; the
   nonce is unused (`nonce_reused`); `evaluateIntent` against the ledger of the last 24 hours
   passes (`policy_denied`, with the rule's code as `detail`); record the nonce and the spend;
   build the EIP-1559 transaction from the intent; sign it; check that the signature recovers to
   the wallet's address over exactly that transaction and has a low `s` (EIP-2), so an approval
   is never spent on a transaction nodes would reject; store the signed transaction.

The signer builds `to`, `value`, `data` and the chain id of the transaction from the intent
itself. It never signs bytes it was handed.

**At most once.** For one approval id the signer produces at most one signature. A repeated
request returns the same signed transaction (step 2). A different envelope reusing a nonce is
refused (step 9). Because the nonce is recorded in the same transaction as the signature, two
concurrent requests cannot both pass. "At most once" is about signatures, not about the chain:
the signed transaction may still never be mined.

**The restore fence.** "At most once" holds only while the signer keeps its record of used
nonces and signatures. A signer database restored from a backup has forgotten everything after
the backup, so an approval used after the backup would pass step 2 and step 9 again. The fence
is a time the signer keeps in its own database. The operator sets it on the signer host as part
of every restore (`node src/admin.ts fence`, which sets it to the host's clock and never moves it
back), and the signer sets it itself when it opens a database file other than the one it last
recorded. From then on the signer refuses every envelope whose `issuedAt` is earlier than the
fence plus 30 seconds, for every kind, with `envelope_fenced`. Every envelope used before the
restore was verified before it, and section 6 refuses an `issuedAt` more than 30 seconds ahead of
the signer's clock, so no envelope of the lost timeline passes. Approvals that were waiting at
the restore must be proposed again. Each move of the fence is recorded in every workspace's
decision log (`fence-set-by-operator` or `fence-set-on-new-database-file`). The control plane
cannot set or move it.

**Sweeps.** `POST /v1/wallets/:walletId/sweep` carries `{ sweep, authorization, transaction }`
with a `sweep-wallet` envelope. It follows the steps above with these differences: in step 4 the
envelope's workspace, wallet and chain equal the sweep's and the path's, and
`sweepHash(sweep)` equals `envelope.sweepHash` (`envelope_mismatch`); step 5 does not apply, so a
paused workspace can still be emptied (resuming it first would let its agents sign again); steps
6 and 7 are replaced by the destination rule and section 6 at the workspace's `adminThreshold`
with the signer's longest admin lifetime; step 8 uses `sweep.maxFeeWei`. The destination rule,
from the signer's own records only: `to` is on the wallet's current recipient allowlist (mode
`allowlist`), or `to` is the address of a `treasury` wallet of the same workspace other than the
swept wallet; anything else, including the wallet's own address, → `sweep_destination_not_allowed`.
A policy whose recipients are `any` allows no destination by itself. When the wallet has a policy,
`sweep.chainId` must be in its `chains` and `sweep.maxFeeWei` must not exceed `fees.maxPerTxWei`
(`policy_denied` with `chain_not_allowed` or `over_fee_cap`); its caps do not apply. Inside the
transaction the admin threshold, the approvers and the destination rule are checked again. The
signer builds the transaction itself: native `value = amount` to `to`, or `transfer(to, amount)`
sent to the token contract. The sweep is recorded as a spend of the wallet.

The other envelope kinds (`set-policy`, `add-approver`, `remove-approver`,
`set-admin-threshold`, `resume-workspace`) follow the same shape, including the fence, verified
with the workspace's `adminThreshold` instead of the policy's threshold. Pausing a workspace and
revoking an approval need only the request signature, because they only remove authority. A
revocation (`POST /v1/approvals/:id/revoke` with `{ workspaceId }`) is recorded in that
workspace's decision log. `GET /v1/approvals/:id` reports `unknown`, `revoked`, `signed` (with
the transaction hash, for an intent or a sweep) or `applied`.

There is no HTTP route that adds an approver without assertions from existing approvers. When
every passkey of a workspace is lost, the operator enrolls a new one with the signer's admin
command line on the signer host, which records `enroll-approver-by-operator` in the decision log.
Host access is the root of trust.

## 9. What may vary after approval

Only these four fields of the signed transaction are chosen after approval
(`TransactionParams`):

| Field                  | Type             | Bound                                       |
| ---------------------- | ---------------- | ------------------------------------------- |
| `nonce`                | integer ≥ 0      | none from the protocol; the chain orders it |
| `gas`                  | `PositiveAmount` | `gas × maxFeePerGas ≤ intent.maxFeeWei`     |
| `maxFeePerGas`         | `PositiveAmount` | same product bound                          |
| `maxPriorityFeePerGas` | `Amount`         | `≤ maxFeePerGas`                            |

Everything else is fixed by the intent, and the intent is fixed by its hash inside the approved
envelope. The fee ceiling `maxFeeWei` is part of the intent, so the approver saw it. For a sweep,
read `sweep` for `intent`: the bound is `gas × maxFeePerGas ≤ sweep.maxFeeWei`.

## 10. Request signatures between control plane and signer

Source: [`signer/request-signature.ts`](../packages/protocol/src/signer/request-signature.ts).
Every signer request except `GET /healthz` carries two headers:

- `x-signer-timestamp`: seconds since the Unix epoch.
- `x-signer-signature`: 64 lowercase hex digits,

```text
HMAC-SHA256( secret,
  UPPERCASE(method) || "\n" || pathWithQuery || "\n" || decimal(timestamp) || "\n" || hex(SHA-256(body)) )
```

`pathWithQuery` is the path and query exactly as sent. The secret is shared by both services and
MUST be at least 32 bytes. The verifier rejects a timestamp more than 60 seconds from its clock,
a malformed signature, and compares in constant time.

What this proves: the request came from a holder of the secret and was not altered. What it does
not do:

- It does not authorize anything that adds authority. Signing, setting a policy, adding an
  approver, changing the threshold and resuming all need passkey assertions that the signer
  verifies itself.
- It does not stop a replay within the 60-second window. Single use comes from the envelope's
  nonce and the approval id.

## 11. Test vectors

These come from [`packages/protocol/test/digests.test.ts`](../packages/protocol/test/digests.test.ts)
and its fixtures. Each was reproduced independently with OpenSSL when this document was written:

```sh
printf '%s\n%s' "askgina.os/v1/intent" '<intent JSON>' | openssl dgst -sha256
printf '%s\n%s' "askgina.os/v1/authorize" '<envelope JSON>' | openssl dgst -sha256 -binary | basenc --base64url | tr -d '='
```

Intent JSON (canonical):

```json
{
  "agentId": "agt_01jd0000000000000000000002",
  "chainId": "eip155:8453",
  "createdAt": 1700000000,
  "id": "int_01jd0000000000000000000004",
  "maxFeeWei": "1000000000000000",
  "memo": "pay invoice 42",
  "operation": {
    "to": "0x1111111111111111111111111111111111111111",
    "type": "evm.transfer",
    "valueWei": "250000000000000000"
  },
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

`intentHash` = `52d1822482a0fe3dc28883d06413ec38fe1efe50aba28c51167af733e24f9da3`

Policy JSON (canonical):

```json
{
  "approvals": { "threshold": 1, "ttlSeconds": 3600 },
  "assets": [
    {
      "asset": "native",
      "chainId": "eip155:8453",
      "maxPerDay": "5000000000000000000",
      "maxPerTx": "1000000000000000000"
    }
  ],
  "chains": ["eip155:8453"],
  "contractCalls": { "mode": "deny" },
  "fees": { "maxPerTxWei": "10000000000000000" },
  "previousHash": null,
  "recipients": { "mode": "any" },
  "requesters": ["agt_01jd0000000000000000000002"],
  "revision": 1,
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

`policyHash` = `968a11eb9c37f06f745249bfc4a94d48b8aa8b4ed6a3ebbc7673b888970668b5`

The same policy JSON under the intent tag hashes to
`e690d76b4c9e3a0bb2a01f86834fb4923cbb7b8645ae192d4611455bb756b3c4`, showing that the tag
separates otherwise equal inputs.

`approve-intent` envelope JSON (canonical):

```json
{
  "agentId": "agt_01jd0000000000000000000002",
  "approvalId": "apr_01jd0000000000000000000005",
  "chainId": "eip155:8453",
  "expiresAt": 1700000600,
  "intentHash": "52d1822482a0fe3dc28883d06413ec38fe1efe50aba28c51167af733e24f9da3",
  "issuedAt": 1700000000,
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "policyHash": "968a11eb9c37f06f745249bfc4a94d48b8aa8b4ed6a3ebbc7673b888970668b5",
  "type": "approve-intent",
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

Challenge (base64url) = `SoAiEpNpEeP2ex9Y_3B7aWINGGXHZFbp3OvzZU6dC80`

Sweep JSON (canonical), under the tag `askgina.os/v1/sweep`:

```json
{
  "amount": "250000000000000000",
  "asset": "native",
  "chainId": "eip155:8453",
  "maxFeeWei": "1000000000000000",
  "to": "0x1111111111111111111111111111111111111111",
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

`sweepHash` = `aa3f2f4c50ee481b88aaf98c610125b769c5508ab8d6bac13f731c50bccad674`

`sweep-wallet` envelope JSON (canonical):

```json
{
  "approvalId": "apr_01jd0000000000000000000005",
  "chainId": "eip155:8453",
  "expiresAt": 1700000600,
  "issuedAt": 1700000000,
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "sweepHash": "aa3f2f4c50ee481b88aaf98c610125b769c5508ab8d6bac13f731c50bccad674",
  "type": "sweep-wallet",
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

Challenge (base64url) = `lgZRKMxucwdO2AFLyWBfmAc4oANInAkJObl_azLac0Q`

## 12. Versioning

`v` is `1` in every hashed structure, and the domain tags carry `v1`. Any change to the shape or
meaning of something that is hashed (an intent, a policy, an envelope, an audit entry) is a new
version, never an edit in place (the rule stated on `PROTOCOL_VERSION` in
[`primitives.ts`](../packages/protocol/src/primitives.ts)). Existing digests then keep their
meaning. A version 1 verifier never accepts a structure of another version, because every schema
requires `v` to be exactly `1`. Changes that hash nothing, such as a new signer error code, are
not version changes. Neither is a new kind of envelope with its own structure under its own tag,
as `sweep-wallet` was: every existing digest and test vector keeps its value, and a verifier that
does not know the kind refuses it as an invalid envelope.
