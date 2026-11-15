# Approval protocol, version 1

This document is normative. It is precise enough to write a second verifier from. The reference
implementation is [`packages/protocol/src/`](../packages/protocol/src/). Where this document and
that code disagree, the code is what runs; please report the difference as a bug.

The words MUST, MUST NOT and SHOULD have their RFC 2119 meanings.

## 1. Primitives

Source: [`primitives.ts`](../packages/protocol/src/primitives.ts).

| Name             | Encoding                                                                                                                                                                                                                                                                        | Example                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Identifier       | A prefix, `_`, then a ULID in lowercase Crockford base32 (26 characters from `0-9a-hjkmnp-tv-z`). Prefixes: `ws` workspace, `usr` user, `agt` agent, `wal` wallet, `int` intent, `apr` approval, `mnd` mandate, `ndl` notification delivery (control plane only, never signed). | `wal_01jd0000000000000000000003`             |
| `Address`        | `0x` and 40 lowercase hex digits. Checksummed (EIP-55) forms are rejected; they are for display only.                                                                                                                                                                           | `0x1111111111111111111111111111111111111111` |
| `Hex`            | `0x` and an even number of lowercase hex digits. `0x` is the empty byte string.                                                                                                                                                                                                 | `0xa9059cbb…`                                |
| `Hex32`          | `0x` and 64 lowercase hex digits.                                                                                                                                                                                                                                               | a transaction hash                           |
| `Digest`         | 64 lowercase hex digits, no prefix. A SHA-256 output.                                                                                                                                                                                                                           | `52d18224…9da3`                              |
| `ChainId`        | CAIP-2 `eip155:` and a decimal number from 1, at most 15 digits (so it is exact as a JavaScript number), no leading zero.                                                                                                                                                       | `eip155:8453`                                |
| `Amount`         | A base-unit integer as a decimal string (`0`, or no leading zero, at most 78 digits), at most 2^256 − 1. Strings, so no JSON number ever rounds it.                                                                                                                             | `"250000000000000000"`                       |
| `PositiveAmount` | An `Amount` that is not `"0"`.                                                                                                                                                                                                                                                  |                                              |
| `EpochSeconds`   | A JSON integer of seconds since the Unix epoch, from 0 to 32503680000.                                                                                                                                                                                                          | `1700000000`                                 |
| `Base64Url`      | Unpadded base64url text (`A-Z a-z 0-9 - _`).                                                                                                                                                                                                                                    |                                              |
| `Nonce`          | Exactly 16 random bytes as unpadded base64url (22 characters).                                                                                                                                                                                                                  | `AAAAAAAAAAAAAAAAAAAAAA`                     |
| `AssetRef`       | The string `"native"` for the chain's coin, or an ERC-20 contract `Address`.                                                                                                                                                                                                    |                                              |

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

| Tag                         | Used for                                                               |
| --------------------------- | ---------------------------------------------------------------------- |
| `askgina.os/v1/intent`      | `intentHash(intent)`                                                   |
| `askgina.os/v1/policy`      | `policyHash(policy)`                                                   |
| `askgina.os/v1/authorize`   | `envelopeChallenge(envelope)`, the WebAuthn challenge                  |
| `askgina.os/v1/audit`       | audit log entries                                                      |
| `askgina.os/v1/sweep`       | `sweepHash(sweep)`                                                     |
| `askgina.os/v1/possession`  | `possessionChallenge(input)`, the possession step's WebAuthn challenge |
| `askgina.os/v1/mandate`     | `mandateHash(mandate)`                                                 |
| `askgina.os/v1/mandate-use` | `mandateUseDigest(input)`, the signer's record of one use of a mandate |

`intentHash`, `policyHash`, `sweepHash`, `mandateHash` and `mandateUseDigest` are the digest as a
lowercase hex `Digest`.
`envelopeChallenge` and `possessionChallenge` are the raw 32 bytes. `possessionChallenge`
hashes `{ v: 1, approvalId, credentialId, nonce }`, where `nonce` is 16 random bytes the signer
issues for an approver change's possession step and accepts in one answer
([`confirmation.ts`](../packages/protocol/src/confirmation.ts)). `mandateUseDigest` hashes
`{ v: 1, approvalId, mandateId, intentHash }`, the signer's record of one use of a mandate
(section 8, "Mandates").

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

| `type`                | Extra fields                                                                      | Authorizes                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approve-intent`      | `intentHash: Digest`, `walletId`, `agentId`, `chainId`, `policyHash: Digest`      | Sign exactly one transaction for exactly one intent under exactly one policy revision.                                                                                   |
| `set-policy`          | `walletId`, `policyHash: Digest`, `previousPolicyHash: Digest \| null`            | Replace a wallet's policy. `previousPolicyHash` is `null` only for the wallet's first policy.                                                                            |
| `add-approver`        | `userId`, `credentialId: Base64Url`, `publicKey: Base64Url` (the COSE public key) | Let one more passkey approve for this workspace.                                                                                                                         |
| `remove-approver`     | `userId`, `credentialId: Base64Url`                                               | Stop one passkey from approving for this workspace.                                                                                                                      |
| `set-admin-threshold` | `adminThreshold`: integer 1–16                                                    | Change how many people must approve changes to approvers and policies. Never below any wallet's current `approvals.threshold` (`threshold_unreachable`).                 |
| `resume-workspace`    | none                                                                              | Let a paused workspace sign again. Pausing needs no envelope, because it only removes authority.                                                                         |
| `sweep-wallet`        | `walletId`, `chainId`, `sweepHash: Digest`                                        | Sign exactly one transaction that moves the sweep below out of the wallet, with no agent and no cap. Approved at the workspace's `adminThreshold`.                       |
| `grant-mandate`       | `mandateId: mnd_…`, `walletId`, `agentId`, `mandateHash: Digest`                  | Let one agent transfer from one wallet within the mandate below, with no passkey per payment, until it ends or is revoked. Approved at the workspace's `adminThreshold`. |

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

A **mandate** (source: [`mandate.ts`](../packages/protocol/src/mandate.ts)) is the structure a
`grant-mandate` envelope binds by its hash. People approve it once; from then on the signer signs
the agent's transfers that fit it with no passkey per payment, until it ends or is revoked
(section 8, "Mandates"). Like an intent it is immutable.

| Field                | Type                                                                                      | Meaning                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `v`                  | `1`                                                                                       | Protocol version.                                                                                    |
| `id`                 | `mnd_…`                                                                                   | The mandate's identifier.                                                                            |
| `workspaceId`        | `ws_…`                                                                                    | The workspace.                                                                                       |
| `walletId`           | `wal_…`                                                                                   | The one wallet payments come from.                                                                   |
| `agentId`            | `agt_…`                                                                                   | The one agent whose intents may be signed under it.                                                  |
| `assets`             | array of `MandateAssetLimit`, 1 to 16, sorted by the key `chainId + "\|" + asset`, unique | What may leave the wallet, and how much.                                                             |
| `windowSeconds`      | integer 3600–604800                                                                       | The rolling span over which `maxPerWindow` is counted.                                               |
| `recipients`         | sorted set of `Address`, 1 to 64                                                          | The only addresses a payment may go to. Not the zero address.                                        |
| `maxUses`            | integer 1–10000                                                                           | Most payments over the mandate's life.                                                               |
| `maxFeePerActionWei` | `PositiveAmount`                                                                          | Largest `maxFeeWei` an intent under it may carry.                                                    |
| `notBefore`          | `EpochSeconds`                                                                            | The first second a payment may be signed under it.                                                   |
| `notAfter`           | `EpochSeconds`                                                                            | The first second none may. Greater than `notBefore`, and at most 2592000 seconds (30 days) after it. |
| `purpose`            | string, the rules of an intent's `memo`                                                   | The granting person's stated reason. Hashed, so the text approved is the text stored.                |

`MandateAssetLimit` is `{ chainId, asset: AssetRef, maxPerAction: PositiveAmount,
maxPerWindow: PositiveAmount, maxTotal: PositiveAmount }`, with
`maxPerAction ≤ maxPerWindow ≤ maxTotal` and `asset` not the zero address. There is no operation
field: an asset `native` permits `evm.transfer` of the chain's coin, a token address permits
`evm.erc20.transfer` of that token, and `evm.call` is never permitted, not even with no value,
because the signer cannot measure what calldata moves. `normalizeMandate()` produces the accepted
order of `assets` and `recipients`.

**Worst case.** `mandateWorstCase(mandate)` is, per asset, `min(maxTotal, maxUses ×
maxPerAction)`: the most the mandate lets leave the wallet. The wallet's policy bounds it further
to its 24-hour cap per day (section 7), and fees add at most `maxUses × maxFeePerActionWei`. The
confirmation page shows it for every asset (section 10).

Like a sweep, the mandate's caps, recipients and purpose are covered by the passkey but do not
appear in the envelope: the control plane keeps the mandate sealed.

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
records**; the relying party (RP ID and the exact origins of the confirmation page, from
configuration, never from the request); the threshold; the longest lifetime this kind of envelope
may have; the verifier's clock `now`.

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
   3. Decode `clientDataJSON`. If it cannot be read as a JSON object, if `crossOrigin` is
      `true`, or if it has a `topOrigin` member at all → `assertion_invalid`. The assertion was
      then made inside a frame of another page, and that page chose what the person saw.
   4. Verify the WebAuthn response against the recomputed challenge, type `webauthn.get`, the
      allowed origins, the RP ID, the stored public key, with user verification required.
      Failure → `assertion_invalid`.
5. Fewer distinct people than the threshold → `insufficient_approvals`.

Every assertion must pass. One unknown approver or one bad signature fails the whole
authorization, so removing a person invalidates the pending approvals they took part in.

**The origin rule.** The allowed origins are the confirmation page's, and only those: in this
repository exactly one, `APPROVE_ORIGIN` (the signer's `SIGNER_APPROVAL_ORIGIN`). A verifier
MUST NOT allow the origin of any page the control plane serves, `PUBLIC_ORIGIN` included: the
control plane chooses what its own pages show, so an assertion made there proves nothing about
what the person saw. So an assertion counts only when the browser made it top-level at the
confirmation page's origin, as a `webauthn.get`. The signer applies this rule when it signs or
applies (section 8) and when it accepts an assertion on the confirmation page (section 10); the
control plane applies it again to the assertions it collects. The signer refuses to start when
the confirmation page's origin equals the control plane's (`SIGNER_RETURN_ORIGIN`) or when its
host is not the RP ID or a name under it.

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

### Mandates

Source: [`mandate.ts`](../packages/protocol/src/mandate.ts).
`evaluateMandate(mandate, intent, usage)` is pure and deterministic, like `evaluateIntent`.
`usage` is the signer's own count for this mandate: `uses`, every use so far;
`total(chainId, asset)`, everything moved in that asset under it; `inWindow(chainId, asset)`, what
moved in that asset under it in the last `windowSeconds`. It checks neither time nor the wallet's
policy. The signer runs `evaluateIntent` as well and signs only when both allow, so the policy
stays the outer limit: lowering the policy narrows every mandate at once, raising it widens none,
and mandated spending counts against the policy's 24-hour cap.

Rules, in this order. The first that fails decides:

1. `intent.workspaceId ≠ mandate.workspaceId` or `intent.walletId ≠ mandate.walletId` →
   `mandate_wallet_mismatch`.
2. `intent.agentId ≠ mandate.agentId` → `mandate_agent_mismatch`.
3. The operation is `evm.call`, whatever its value → `mandate_operation_not_allowed`.
4. Compute the spend. No `MandateAssetLimit` for `(chainId, asset)` → `mandate_asset_not_allowed`.
5. The operation's `to` is not in `recipients` → `mandate_recipient_not_allowed`.
6. `maxFeeWei > maxFeePerActionWei` → `mandate_over_fee_cap`.
7. `uses + 1 > maxUses` → `mandate_uses_exhausted`.
8. `amount > maxPerAction` → `mandate_over_per_action_cap`.
9. `inWindow(chainId, asset) + amount > maxPerWindow` → `mandate_over_window_cap`.
10. `total(chainId, asset) + amount > maxTotal` → `mandate_over_total_cap`.
11. Otherwise allow, with the spend `(chainId, asset, amount)`.

The signer adds one code of its own, `mandate_grant_below_threshold` (section 8, "Mandates").

`mandateTimeState(mandate, now)` is `not_yet_valid` when `now < notBefore`, `expired` when
`now ≥ notAfter`, and `live` otherwise.

**Grant-time checks.** `checkMandateAgainstPolicy(mandate, policy, { now, maxSeconds })` is `null`
or the first reason, in this order, that the mandate cannot be granted. Each rule is checked for
every asset before the next rule. The control plane calls it early to tell a person; the signer
calls it with its own policy, its clock and its own lifetime ceiling, and its answer is final.

1. `policy.walletId ≠ mandate.walletId` or `policy.workspaceId ≠ mandate.workspaceId` →
   `wallet_mismatch`.
2. `mandate.agentId` not in `requesters` → `requester_not_allowed`.
3. An asset's `chainId` not in `chains` → `chain_not_allowed`.
4. An asset with no policy `AssetLimit` → `asset_not_allowed`.
5. An asset's `maxPerAction > maxPerTx` → `over_per_tx_cap`.
6. `windowSeconds ≤ 86400` and an asset's `maxPerWindow > maxPerDay` → `over_daily_cap`. A
   longer window may hold more than one day's cap; the policy's 24-hour cap still applies to
   every use.
7. `recipients.mode` is `allowlist` and a mandate recipient is not in `addresses` →
   `recipient_not_allowed`.
8. `maxFeePerActionWei > fees.maxPerTxWei` → `over_fee_cap`.
9. `notAfter ≤ now` → `already_expired`.
10. `notAfter − max(now, notBefore) > maxSeconds` → `lifetime_too_long`.

The signer adds `too_many_live_mandates` (section 8, "Mandates"). The reasons together are
`MANDATE_GRANT_REFUSALS`.

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
revoking an approval need only the request signature, because they only remove authority.
`add-approver` has one more check: the signer applies it only when the confirmation of that
exact envelope (same approval id, same envelope digest) records that the person being added
proved on the confirmation page that they hold the new key (section 10, "The possession step").
Otherwise it refuses with `possession_unproven`, even when every assertion is valid. A
revocation (`POST /v1/approvals/:id/revoke` with `{ workspaceId }`) is recorded in that
workspace's decision log. `GET /v1/approvals/:id` reports `unknown`, `revoked`, `signed` (with
the transaction hash, for an intent or a sweep) or `applied`.

There is no HTTP route that adds an approver without assertions from existing approvers. When
every passkey of a workspace is lost, the operator enrolls a new one with the signer's admin
command line on the signer host, which records `enroll-approver-by-operator` in the decision log.
Host access is the root of trust. That command has no possession step: the operator enrolls the
exact key typed on the host.

### Mandates

Five routes, all in the control scope (section 10), serve mandates
([`signer/api.ts`](../packages/protocol/src/signer/api.ts)):

| Route                                 | Body                                  | Answer                         |
| ------------------------------------- | ------------------------------------- | ------------------------------ |
| `PUT /v1/mandates/:mandateId`         | `{ mandate, authorization }`          | `MandateState`                 |
| `GET /v1/mandates/:mandateId`         | none                                  | `MandateState`                 |
| `GET /v1/wallets/:walletId/mandates`  | none                                  | `{ mandates: MandateState[] }` |
| `POST /v1/mandates/:mandateId/revoke` | `{ workspaceId }`                     | `MandateState`                 |
| `POST /v1/mandates/:mandateId/sign`   | `{ approvalId, intent, transaction }` | `SignResponse`                 |

**Granting.** A grant carries a `grant-mandate` envelope and follows the shape of the other
envelope kinds above: the same idempotency, the same restore fence, section 6 at the workspace's
`adminThreshold` with the signer's longest admin lifetime, and the nonce recorded in the same
database transaction that stores the mandate. In place of steps 4 and 6:

- The path's id, `envelope.mandateId` and `mandate.id` are equal; the envelope's workspace,
  wallet and agent are the mandate's; the wallet belongs to that workspace; and
  `mandateHash(mandate)` equals `envelope.mandateHash`. Otherwise `envelope_mismatch`.
- The wallet has a policy (`policy_missing`).
- `checkMandateAgainstPolicy` (section 7) passes with the signer's current policy, its clock and
  its own lifetime ceiling, `SIGNER_MAX_MANDATE_SECONDS` (by default 604800, seven days).
  Otherwise `mandate_invalid`, with the reason as `detail`.
- The wallet has fewer live mandates than `SIGNER_MAX_LIVE_MANDATES_PER_WALLET` (by default 16).
  Otherwise `mandate_invalid` with `too_many_live_mandates`.
- No mandate with this id exists under another grant (`conflict`).

The signer stores the mandate and the people whose assertions granted it. A repeat of the same
grant returns the stored state.

**Signing under a mandate.** `POST /v1/mandates/:mandateId/sign` carries
`{ approvalId, intent, transaction }` and no assertion: people approved the mandate already.
`approvalId` is the control plane's id for this one use. All of these run in one database
transaction with nothing awaited inside it, in this order, and the first failure decides:

1. The request signature (section 10) and the body's schema.
2. The mandate, its wallet and its workspace exist (`not_found`).
3. Idempotency. If this approval id was revoked → `approval_revoked`. If it was signed as a use
   with the same `mandateUseDigest({ approvalId, mandateId, intentHash: intentHash(intent) })`,
   return the stored signed transaction. Any other record of this approval id → `conflict`.
4. The workspace is not paused (`workspace_paused`).
5. The mandate is not revoked (`mandate_revoked`), and `mandateTimeState` by the signer's clock is
   `live` (`mandate_not_yet_valid`, `mandate_expired`).
6. The people who granted it are at least the workspace's current `adminThreshold`. Otherwise
   `mandate_denied` with `mandate_grant_below_threshold`: raising the threshold stops the uses of
   every mandate granted by fewer people.
7. The intent was never signed under a mandate before (`conflict`).
8. The wallet has a policy (`policy_missing`), and `evaluateIntent` against the ledger of the last
   24 hours allows the intent (`policy_denied`, with the rule's code as `detail`).
9. `evaluateMandate` against the signer's own count of this mandate's uses allows it
   (`mandate_denied`, with the rule's code as `detail`).
10. `gas × maxFeePerGas ≤ intent.maxFeeWei`, and `maxPriorityFeePerGas ≤ maxFeePerGas`
    (`fee_cap_exceeded`).
11. Build, sign and check the transaction exactly as for an approved intent (step 9 above), and
    record the use: an approval row whose envelope digest is the use's `mandateUseDigest`, the
    signed transaction, the spend and the use.

Every use counts, also one whose transaction the network never includes: only the control plane
could report that, and it is not trusted. `GET /v1/approvals/:id` reports a use as `signed`, with
its transaction hash.

**Revoking.** `POST /v1/mandates/:mandateId/revoke` needs only the request signature, because it
only removes authority. A mandate of another workspace is `not_found`, and revoking twice changes
nothing. A revoked mandate stays revoked: there is no resume, and a new grant replaces it. The
signer also revokes mandates itself, each in the same database transaction as its cause and each
recorded in the decision log:

- When `remove-approver` applies, every mandate the removed credential took part in granting
  (`grantor_removed`).
- When the restore fence is set, every live mandate (`operator`). The uses counted after the
  backup are forgotten, so the restored counts would let more leave the wallet than people
  approved. Grant them again.
- When the operator revokes one on the signer host with the admin command line (`operator`).

**State.** `MandateState` is the mandate and its hash, the grant's approval id and time, who
granted it, the revocation time and reason, the number of uses, and per asset what moved under it
in total and in the current window. Its `status` is computed when the signer answers: `revoked`;
otherwise `not_yet_valid` or `expired` by the clock; otherwise `exhausted` when `maxUses` uses were
made or every asset reached its `maxTotal`; otherwise `active`.

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

A use of a mandate has no envelope of its own: the agent chooses the intent, and the intent is
bound by the mandate the people approved (section 7, "Mandates") and by the wallet's policy. Its
`maxFeeWei` is at most the mandate's `maxFeePerActionWei`, and the four fields above keep their
bounds.

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

### Two secrets, two scopes

Each signer route belongs to one scope (`scope` in `signerRoutes`,
[`signer/api.ts`](../packages/protocol/src/signer/api.ts)), and a request is authentic only
under its own scope's secret:

| Scope     | Secret                                      | Held by               | Routes                                                                                                                                                        |
| --------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control` | `signer-request-secret`                     | the server            | every route except the four below and `GET /healthz`                                                                                                          |
| `confirm` | `confirm-request-secret`, at least 32 bytes | the `approve` service | `GET /v1/confirm/:approvalId`, `POST /v1/confirm/:approvalId/assertions`, `GET /v1/confirm/:approvalId/possession`, `POST /v1/confirm/:approvalId/possession` |
| unsigned  | none                                        | anyone on the network | `GET /healthz`                                                                                                                                                |

A request signed with the other scope's secret is `unauthenticated` (401). The two secrets must
differ; the signer refuses to start when they do not.

### The confirmation routes

The confirmation page ([`apps/approve`](../apps/approve)) shows one approval as the signer holds
it and collects passkey assertions over its envelope. For an approver change it also takes the
possession step of the person being added. Six signer routes serve it:

| Route                                         | Scope   | Body and answer                                                                                                                |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/approvals/:approvalId/confirmation` | control | `{ envelope, subject }` → `{ path: "/a/<approvalId>#<token>" }`                                                                |
| `GET /v1/approvals/:approvalId/assertions`    | control | → `{ assertions: Assertion[] }`, each with the signer's own `userId`                                                           |
| `GET /v1/confirm/:approvalId`                 | confirm | header `x-confirm-token` → `ConfirmationView`                                                                                  |
| `POST /v1/confirm/:approvalId/assertions`     | confirm | header `x-confirm-token`, `{ response: AssertionResponse }` → `{ collected, required, returnUrl }`                             |
| `GET /v1/confirm/:approvalId/possession`      | confirm | header `x-confirm-token` → `{ rpId, challenge, allowCredentials: [the envelope's credentialId], userVerification, timeoutMs }` |
| `POST /v1/confirm/:approvalId/possession`     | confirm | header `x-confirm-token`, `{ response: AssertionResponse }` → `{ fingerprint }`                                                |

Rules:

- The subject is what the envelope names by its hash: `{ kind: "approve-intent", intent }`,
  `{ kind: "set-policy", policy }`, `{ kind: "sweep-wallet", sweep }`,
  `{ kind: "grant-mandate", mandate }`, or `{ kind: "envelope-only" }` for the kinds whose
  envelope carries everything. The signer refuses one that does not hash to the envelope's value
  or names another workspace, wallet, agent or mandate id (`checkSubject` in
  [`confirmation.ts`](../packages/protocol/src/confirmation.ts)). The view of a grant shows the
  agent, the wallet, every asset's cap per payment, per window and in total with its worst case
  and the wallet's own limits, every recipient, the number of payments, the fee ceilings, the
  absolute start and end times, and the purpose as text nobody checked.
- The token is 16 random bytes in base64url. The signer stores only its SHA-256 and compares in
  constant time; a wrong token is `not_found`. Opening the same approval again issues a new token
  and ends the old one. The token travels in the link's fragment and in the `x-confirm-token`
  header, never in a path or a query, so no server or proxy log records it.
- The view is rendered by the signer from its own records: the stored subject, its current
  policy, its 24-hour ledger, its approver registry, and the operator's chain and token labels.
  Its `state` is `open`, `complete`, `expired`, `revoked`, `used` or `superseded`. `superseded`
  means the signer would refuse to act on it however many people approve: it was issued before
  the restore fence (`envelope_fenced`); for a payment the wallet's policy is no longer the one it
  names, and for a policy change another revision applied first (`policy_missing`,
  `policy_changed`); for a mandate grant the wallet has no policy, or the mandate no longer passes
  `checkMandateAgainstPolicy` with the signer's current policy, clock and lifetime ceiling
  (`policy_missing`, `mandate_invalid` with the reason). The state is computed each time, so a
  grant reopens if the policy is edited back to admit it; the cap on live mandates does not make
  a grant superseded, because it only waits for a mandate to end. Opening a confirmation in that
  state is refused with the same code.
- A submitted assertion must come from an approver of the workspace and pass section 6's checks
  for one assertion: made top-level at `APPROVE_ORIGIN`, as a `webauthn.get`, over the
  envelope's digest. A second one by the same person is `conflict`, unless their first was made
  with a passkey that no longer approves; any state but `open` is `confirmation_closed`; more
  than 64 submissions with a valid token are `rate_limited`.
- An assertion stored here adds no authority by itself. The control plane collects it, checks it
  again, and sends it in an authorization, which the signer verifies again when it acts
  (section 6). This page is the only place an approval is made: the control plane has no route
  that takes one.

**The possession step.** Before anyone may approve an `add-approver` request, the person being
added proves on the confirmation page that they hold the key the envelope carries. Rules:

- Only `add-approver` has the step. For any other kind both possession routes answer
  `not_found`.
- The step is open while the request is `open` or `complete`; in any other state it is
  `confirmation_closed`. `complete` covers approvals collected before the step existed: the
  signer still refuses to apply them until the step is done.
- The challenge is `possessionChallenge({ approvalId, credentialId, nonce })` (section 2), where
  `credentialId` is the envelope's and `nonce` is 16 random bytes. The signer makes one nonce per
  request when the page first asks for it, keeps it unchanged until an answer uses it, then
  deletes it. An answer to a used or absent challenge is `assertion_invalid`.
- The answer must come from the envelope's credential (its `id` equal to the envelope's
  `credentialId`) and verify against the envelope's `publicKey` under section 6's checks: made
  top-level at `APPROVE_ORIGIN`, as a `webauthn.get`, with user verification. Otherwise it is
  `assertion_invalid`.
- Answers count toward the same 64 submissions as approvals (`rate_limited`).
- A proven answer sets the confirmation's proof once and returns `keyFingerprint(publicKey)`:
  the first 80 bits of SHA-256 over the key's bytes in Crockford base32, as
  `XXXX-XXXX-XXXX-XXXX`. The view of the request shows the same fingerprint as its "Key
  fingerprint" line, so the person being added can read theirs to the approvers over a call or
  in person, and the approvers compare it.
- Until the proof, the view carries the warning `possession_unproven`, and an approval submitted
  on `POST /v1/confirm/:approvalId/assertions` is `possession_unproven` (409). The signer checks
  the proof again when it applies the change (section 8).

The step proves that whoever answered holds the key. It does not prove that the key belongs to
the person named: a WebAuthn signature does not cover the credential id, so whoever holds a key
that was put in the envelope under the named person's credential id can answer. Only the
fingerprint comparison catches that ([`threat-model.md`](./threat-model.md#limits)).

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

Possession challenge input JSON (canonical), under the tag `askgina.os/v1/possession`, for
`possessionChallenge({ approvalId: "apr_01jd0000000000000000000005", credentialId: "Y3JlZC1h", nonce: "AAAAAAAAAAAAAAAAAAAAAA" })`:

```json
{
  "approvalId": "apr_01jd0000000000000000000005",
  "credentialId": "Y3JlZC1h",
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "v": 1
}
```

Challenge (base64url) = `7voVoMiWeZwDat_WCB8R-xOqaIfjygPAYO7xmCsm8ec`

Mandate JSON (canonical), under the tag `askgina.os/v1/mandate`, in USDC base units (six
decimals): 100 per payment, 500 in any 24 hours, 1,000 in total, 20 payments, for 604000 seconds:

```json
{
  "agentId": "agt_01jd0000000000000000000002",
  "assets": [
    {
      "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "chainId": "eip155:8453",
      "maxPerAction": "100000000",
      "maxPerWindow": "500000000",
      "maxTotal": "1000000000"
    }
  ],
  "id": "mnd_01jd0000000000000000000006",
  "maxFeePerActionWei": "2000000000000000",
  "maxUses": 20,
  "notAfter": 1700604000,
  "notBefore": 1700000000,
  "purpose": "pay supplier invoices this week",
  "recipients": [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333"
  ],
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "windowSeconds": 86400,
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

`mandateHash` = `368a65426f5e33c8fa92c281a9a2d600328b39635fea2d60e67400c5cb65d7d4`

Its worst case is `min(1000000000, 20 × 100000000) = 1000000000` base units, 1,000 USDC.

`grant-mandate` envelope JSON (canonical):

```json
{
  "agentId": "agt_01jd0000000000000000000002",
  "approvalId": "apr_01jd0000000000000000000005",
  "expiresAt": 1700000600,
  "issuedAt": 1700000000,
  "mandateHash": "368a65426f5e33c8fa92c281a9a2d600328b39635fea2d60e67400c5cb65d7d4",
  "mandateId": "mnd_01jd0000000000000000000006",
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "type": "grant-mandate",
  "v": 1,
  "walletId": "wal_01jd0000000000000000000003",
  "workspaceId": "ws_01jd0000000000000000000001"
}
```

Challenge (base64url) = `TjkhTXhNOAPy5fq2YK8479_qPLBCg1DFmvX1g0zX55c`

Mandate use JSON (canonical), under the tag `askgina.os/v1/mandate-use`, for the intent above
used under this mandate with the approval id `apr_01jd0000000000000000000005`:

```json
{
  "approvalId": "apr_01jd0000000000000000000005",
  "intentHash": "52d1822482a0fe3dc28883d06413ec38fe1efe50aba28c51167af733e24f9da3",
  "mandateId": "mnd_01jd0000000000000000000006",
  "v": 1
}
```

`mandateUseDigest` = `96fe14af43d24b9388d45b9f7a478c48a1d37c944056f9b5319ddad6bd990cd7`

## 12. Versioning

`v` is `1` in every hashed structure, and the domain tags carry `v1`. Any change to the shape or
meaning of something that is hashed (an intent, a policy, an envelope, an audit entry) is a new
version, never an edit in place (the rule stated on `PROTOCOL_VERSION` in
[`primitives.ts`](../packages/protocol/src/primitives.ts)). Existing digests then keep their
meaning. A version 1 verifier never accepts a structure of another version, because every schema
requires `v` to be exactly `1`. Changes that hash nothing, such as a new signer error code, are
not version changes. Neither is a new kind of envelope with its own structure under its own tag,
as `sweep-wallet` was: every existing digest and test vector keeps its value, and a verifier that
does not know the kind refuses it as an invalid envelope. Nor is a new structure under a new
tag, as the possession challenge (`askgina.os/v1/possession`) was: it changes no existing
digest, and its tag keeps a possession challenge from ever standing in for an envelope's
challenge, or an envelope's for it. Mandates were added the same way: the `Mandate` structure
under `askgina.os/v1/mandate`, the `grant-mandate` envelope kind, and the use digest under
`askgina.os/v1/mandate-use`. No existing digest or test vector changed, and a signer that does
not know `grant-mandate` refuses it as an invalid envelope.
