<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [How can one approval cover many actions without weakening the signer's check?](https://github.com/askgina/os/issues/19). **Date:** 2026-11-14.
>
> **Map:** [After v0.1: wider approvals, more venues, more machines](https://github.com/askgina/os/issues/18).
>
> Written by a research agent from source code and documentation only. Nothing was built, run or deployed for this report, so no claim below is runtime-observed. Every claim carries a tag: `[source: path:line]` for this repository at commit `61dd59c`, a link for an outside primary source, or `[INFERENCE]` for a conclusion drawn from those sources. Outside repositories were read as shallow clones at the commits listed under "Sources".
>
> The draft plan built on this report is [`specs/approval-mandates.md`](../approval-mandates.md).

# Approval mandates: one passkey approval for a bounded series of actions

## Question

> v0.1 approves one action at a time. A mandate such as "up to 100 USDC per trade, 500 a day, until Friday" needs a signed, bounded, revocable grant that the signer itself enforces. How is it shown to the person, what exactly do they sign, how is it counted and revoked, and how does it differ from raising the wallet policy's auto-approve limits?

## Answer

- **It can be done without weakening the signer's check.** People sign, with their passkeys, a new envelope kind `grant-mandate`. Its digest commits to a complete mandate: one wallet, one agent, a recipient allowlist, per-asset caps per action, per rolling window and in total, a maximum number of uses, a fee ceiling per action, and a start and end time. The signer verifies those assertions against its own approver table, stores the mandate, and from then on signs an intent from that agent without a new passkey only when the intent fits both the mandate and the wallet's live policy. [INFERENCE, from F1 to F4]
- **How it is shown.** One card states the grant as a sentence, then the worst case ("at most 1,000 USDC can leave this wallet under this approval"), each cap, the number of uses, every recipient in full, the agent, the wallet, the fee per action, the end time in the viewer's time zone, and that anything outside goes to the inbox as today. The technical details show the canonical mandate, its hash, the envelope and the challenge, as the intent card does now. [INFERENCE, modelled on `apps/web/src/routes/approval.tsx:224-376`]
- **How it is counted.** In the signer's own SQLite, in the same write transaction as each signature, exactly as the daily cap is counted today. Each use is its own approval id and records its intent id, so a use signs at most once and an intent is used at most once. The wallet's daily cap still counts every mandated spend. [INFERENCE, from F2 and F4]
- **How it is revoked.** Revoking needs only the request signature, because it removes authority, like pausing and revoking an approval today. Pausing the workspace stops mandates as well. A mandate also ends at its end time, when its uses or total run out, and when an approver whose passkey granted it is removed. [INFERENCE, from F6]
- **How it differs from "raising the auto-approve limits".** v0.1 has no auto-approve limits. Every signature needs passkey assertions; a policy's threshold is at least 1; the caps are ceilings on approved transactions, not an allowance that needs no approval. [source: packages/protocol/src/policy.ts:76; apps/signer/src/signer.ts:719, 740-745] An auto-approve tier added to the policy would be permanent, wallet-wide, blind to which agent asks, and could only be narrowed with passkeys at the admin threshold. A mandate is time-boxed, bound to one agent, counted, listed, and revoked in one click. Both would be enforced by the signer. [INFERENCE]
- **What it costs in trust.** A compromised control plane, or a stolen agent token, can spend a live mandate's remaining budget without any person, but only to its allowlisted recipients and within its caps. One misleading grant card can now obtain a whole mandate rather than one transaction, so the trusted-display gap ([ticket 20](https://github.com/askgina/os/issues/20)) weighs more. [INFERENCE]
- **"Per trade" is not enforceable on raw contract calls.** The signer cannot measure what calldata moves, so the first version should cover native and ERC-20 transfers only. Trading mandates need typed operations that the signer encodes and measures itself ([ticket 21](https://github.com/askgina/os/issues/21)). [source: packages/protocol/src/evaluate.ts:63-66; INFERENCE]
- **Prior art.** ERC-7715 with ERC-7710, ERC-7579 session modules, EIP-7702 delegation and Coinbase Spend Permissions all assume a smart account or give the agent a key; none fits server-held EOA keys today. Secure Payment Confirmation has no mandate construct at all. AP2's open mandates are the closest model, and their constraint set is worth borrowing. [sources in F10]

## Findings

### F1. v0.1 policy, caps and who approves

- A wallet policy holds `chains`, `requesters`, per-asset `AssetLimit` caps (`maxPerTx`, `maxPerDay` over any rolling 24 hours), `recipients` (`any` or an allowlist), `contractCalls` (`deny` or an allowlist), `fees.maxPerTxWei`, and `approvals.threshold` with `approvals.ttlSeconds`. [source: packages/protocol/src/policy.ts:24-31, 54-80]
- `approvals.threshold` is an integer from 1 to 16. There is no value that means "no approval needed". [source: packages/protocol/src/policy.ts:76]
- The signer's only signing route refuses any envelope that is not `approve-intent`, then verifies the assertions with the policy's threshold. [source: apps/signer/src/signer.ts:719, 740-745] So every signature in v0.1 has passkey assertions behind it.
- A policy changes only through a `set-policy` envelope at the workspace's admin threshold, and a wallet's threshold may not exceed the admin threshold. [source: apps/signer/src/signer.ts:357-394, 619-675, 646]
- Consequence: the ticket's phrase "raising the wallet policy's auto-approve limits" describes something v0.1 does not have. It is compared below as Option A, an auto-approve tier that would have to be added. [INFERENCE]

### F2. How spending is counted, and why counting is race-free

- The signer keeps one `spends` row per signed approval: wallet, chain, asset, amount, time. [source: apps/signer/src/db.ts:79-87]
- `spentSince` sums a wallet's rows newer than now minus 86,400 seconds per `chainId|asset`. [source: apps/signer/src/signer.ts:53, 192-203] `evaluateIntent` refuses when that sum plus the new amount exceeds `maxPerDay`. [source: packages/protocol/src/evaluate.ts:75-77]
- The decision runs inside `transaction()`, which opens with `BEGIN IMMEDIATE` and takes a synchronous callback, so nothing interleaves between reading the ledger and recording the spend, in this process or another one sharing the file. [source: apps/signer/src/db.ts:113-126] Inside it the signer re-checks pause, policy hash and approvers, consumes the envelope nonce, evaluates, signs, checks the signature, and records `approvals`, `signatures` and `spends`. [source: apps/signer/src/signer.ts:755-830]
- At most once: a repeat with an identical envelope returns the stored transaction; any other envelope under the same approval id is `conflict`; a reused nonce is `nonce_reused`. [source: apps/signer/src/signer.ts:323-329, 344-350]
- A signed amount counts against the cap even if the transaction is never mined, because the signer does not watch the chain. [source: docs/threat-model.md:241]
- The control plane runs the same `evaluateIntent` early against the spend the signer reports, only to refuse hopeless proposals before a person is asked. [source: apps/server/src/execution/intents.ts:375-385; packages/protocol/src/evaluate.ts:25-29]

### F3. What a passkey signs today, and what it proves

- Every envelope carries `approvalId`, `workspaceId`, a single-use `nonce`, `issuedAt` and `expiresAt`. There are six kinds. [source: packages/protocol/src/envelopes.ts:22-31, 90-98]
- The WebAuthn challenge is `SHA-256("askgina.os/v1/authorize" || "\n" || RFC 8785 JSON of the envelope)`. [source: packages/protocol/src/envelopes.ts:107-109; packages/protocol/src/canonical.ts]
- `approve-intent` binds `intentHash`, `walletId`, `agentId`, `chainId` and `policyHash`. [source: packages/protocol/src/envelopes.ts:34-42]
- The verifier recomputes the challenge, checks the lifetime against a maximum, matches each assertion to the verifier's own approver records, requires user verification, and counts distinct people. The sign counter is not used, so the caller must consume the nonce. [source: packages/protocol/src/webauthn/verify-authorization.ts:55-56, 98]
- An assertion proves a person's authenticator signed a digest, not that the person saw the right details. A compromised control plane can show one thing and submit another. [source: docs/threat-model.md:195-214]
- The approval page for an intent shows one sentence, the amount, the full recipient, the wallet, the agent, the fee ceiling, the simulation, the memo marked as the agent's own words, and where the amount sits against the per-transaction and 24-hour caps. [source: apps/web/src/routes/approval.tsx:224-307, 331-376]

### F4. The unit of "at most once" is the approval id, in both services

- Signer: `approvals`, `signatures` and `spends` are all keyed by `approval_id`. [source: apps/signer/src/db.ts:60-87]
- Control plane: one `approvals` row per request, with a non-null `envelope`. [source: apps/server/src/db/schema.ts:277-313, 290] `transactions` is keyed by approval id. [source: apps/server/src/db/schema.ts:398-405] The account nonce is reserved per approval id. [source: apps/server/src/execution/intents.ts:648-698] One workflow run per approval waits, executes and follows up. [source: apps/server/workflows/approval.ts:30-75]
- The workflow already handles a row that is `approved` when the run starts: `settle` returns `approved` and `execute` runs at once. [source: apps/server/workflows/approval.ts:45-62]
- Consequence: if each mandated action is its own approval id, on a row that is created already approved, the whole execution path is reused unchanged: nonce reservation, signer retries, crash recovery, broadcast and follow-up. A separate "execution" table would duplicate all of it. [INFERENCE]

### F5. What caps can and cannot measure

- `intentSpend` returns the native value for `evm.transfer` and `evm.call`, and the token amount for `evm.erc20.transfer`. [source: packages/protocol/src/intent.ts:132-142]
- A contract call that sends no native coin is allowed without any cap check; only the call allowlist limits it. [source: packages/protocol/src/evaluate.ts:49-53, 63-66]
- The approval card warns that a raw call "may move any asset the contract can reach". [source: apps/web/src/routes/approval.tsx:245] The threat model says an allowlisted contract that holds or can pull the wallet's tokens is outside the caps. [source: docs/threat-model.md:56-60]
- Consequence: "100 USDC per trade" through a DEX router is a raw call, and the signer cannot count it. A mandate over raw calls would be unbounded in whatever the call moves. A trading mandate needs an operation type whose input amount and recipient the signer encodes into calldata itself, so it can count it. [INFERENCE]

### F6. Revoking, pausing and removing people today

- Pausing a workspace needs only the request signature; resuming needs assertions at the admin threshold. [source: apps/signer/src/signer.ts:461-485]
- Revoking an approval id records a `revoked` row; an id that was already signed cannot be revoked. A repeat of a signed approval returns the stored transaction even while paused. [source: apps/signer/src/signer.ts:834-852; docs/approval-protocol.md, section 8, step 4]
- Removing an approver invalidates pending authorizations they took part in, because signing re-verifies against the current approvers, also inside the transaction. [source: apps/signer/src/signer.ts:316-321, 763] A change that was already applied, such as a policy, stays.
- Disabling an agent is a control-plane change only; the signer does not know an agent's status. [source: apps/server/src/directory/routes.ts:700-720] Today that is harmless, because a person still approves each intent. With mandates it is not, so disabling an agent must revoke its mandates at the signer. [INFERENCE]
- Consequence: nothing in v0.1 would end a standing grant when the person who granted it is removed. A mandate needs that rule explicitly. [INFERENCE]

### F7. The signer's storage can only grow by new tables

- `openDatabase` runs `CREATE TABLE IF NOT EXISTS` for every table; there is no schema version and no migration step. [source: apps/signer/src/db.ts:9-109]
- Consequence: new tables are safe on an existing signer file; changing the keys or constraints of an existing table has no upgrade path yet. Mandate state should live in new tables, joined to `approvals` and `spends` by approval id. [INFERENCE]
- The control plane has numbered Drizzle migrations. [source: apps/server/src/db/migrations/0001_directory_hardening.sql; apps/server/package.json `db:generate`]

### F8. The agent's surface

- An agent has exactly seven MCP tools, and a release gate asserts the list. [source: apps/server/src/mcp/gateway.ts:65-73; specs/agent-workspaces-v0.1.md:461]
- The propose tools return `intentId`, `status`, `approvalUrl` and `expiresAt`, and tell the agent a person must approve first. [source: apps/server/src/mcp/gateway.ts:75-76]
- `whoami` reports each usable wallet's chains, limits, recipient rule, call rule and approvals needed. [source: apps/server/src/mcp/gateway.ts:162-200]
- At most 20 proposals per agent may wait for people at once. [source: apps/server/src/execution/intents.ts:73]
- Consequence: an agent can learn which mandates it holds and whether an action ran under one from the outputs of `whoami`, the propose tools and `get_intent`, with no eighth tool. [INFERENCE]

### F9. The protocol's versioning rule

- Any change to the shape or meaning of a hashed structure is a new version; a new signer error code is not. [source: docs/approval-protocol.md:419-427]
- The envelope union is strict and discriminated by `type`, so a verifier that does not know a kind refuses it. [source: packages/protocol/src/envelopes.ts:90-102]
- Consequence: a new structure (`Mandate`, with its own domain tag) and a new envelope kind (`grant-mandate`) can be added under version 1 without changing any existing digest. The pinned test vectors prove that. [INFERENCE; vectors in packages/protocol/test/digests.test.ts]

### F10. Prior art, and how each fits keys held by a server

- **ERC-7715** (Draft, created 2024-05-24, requires ERC-4337 and ERC-7710). A dapp calls `wallet_requestExecutionPermissions` with typed permissions (for example `native-token-allowance`) and rules (for example `expiry`); `isAdjustmentAllowed` lets the wallet attenuate a request; the response carries a `context` and a `delegationManager`; the dapp redeems through ERC-7710 `redeemDelegations`. "Wallets MUST correctly enforce permissions" and "MUST clearly display the permissions". [source: [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715), Specification and Security Considerations] Enforcement is by a smart-contract account and a delegation manager. **Fit: no.** The wallets here are EOAs in OWS, and the signer signs no typed data or user operations by design. [source: specs/agent-workspaces-v0.1.md, Decision Log, "EVM only"] **Borrow:** allowance plus expiry as the vocabulary, and attenuation: the person may lower what was asked before signing. [INFERENCE]
- **ERC-7710** (Draft, requires ERC-1271 and ERC-7579): the on-chain redemption interface ERC-7715 depends on. [source: [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710)] Fit: as above.
- **Session keys, ERC-7579 Smart Sessions** ([erc7579/smartsessions@f5aaf86](https://github.com/erc7579/smartsessions/tree/f5aaf86)). A session is a separate key, validated by a smart-account module, with policies such as `ERC20SpendingLimitPolicy`, `UsageLimitPolicy`, `TimeFramePolicy`, `ValueLimitPolicy` and `ContractWhitelistPolicy`. [source: smartsessions `contracts/DataTypes.sol:56-64`, `contracts/external/policies/`] **Fit: no.** Giving the agent a session key puts key material in the agent, which v0.1 rules out. Keeping the session key in the signer reduces to a signer-enforced mandate plus a contract deployment. On-chain policies would bound a compromised signer only if the account's root key were held elsewhere. [INFERENCE]
- **EIP-7702** (Final). A type `0x04` transaction carries authorizations signed over `keccak(0x05 || rlp([chain_id, address, nonce]))`; the account's code becomes the delegation indicator `0xef0100 || address` and persists. A poorly written delegate "can allow a malicious actor to take near complete control over a signer's EOA". [source: [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702), Specification, "Persistence of code delegation", Security Considerations] The EOA key keeps full authority: it can sign plain transactions and re-delegate, so a permission contract set by 7702 binds callers other than the key holder, not the signer. An OWS token can sign 7702 authorizations; the v0.1 signer refuses everything except transactions it builds. [source: specs/research/ows-node-sdk-in-an-isolated-signer.md:30; docs/approval-protocol.md, section 8] **Fit: no;** keep refusing 7702 authorizations. [INFERENCE]
- **Coinbase Spend Permissions** ([coinbase/spend-permissions@e0004e6](https://github.com/coinbase/spend-permissions/tree/e0004e6)). `SpendPermission { account, spender, token, allowance, period, start, end, salt, extraData }`; periods reset at fixed boundaries `start + n * period`; the account or the spender may revoke. [source: `src/SpendPermissionManager.sol:29-48, 397-410, 511, 690-705`] **Fit: no** (needs a Coinbase Smart Wallet). **Borrow:** the shape is almost the mandate proposed here. Its fixed periods differ from v0.1's rolling 24 hours. [INFERENCE]
- **Secure Payment Confirmation** (W3C Candidate Recommendation Draft, 13 October 2026). The browser shows its own dialog with `payeeName`, `payeeOrigin`, `total` and the instrument, writes them into `clientDataJSON` as `type: "payment.get"`, and the relying party verifies they match what should have been shown. [source: [SPC](https://www.w3.org/TR/secure-payment-confirmation/)] The specification and its requirements document define no mandate, recurring or standing-grant construct (searched for "mandate", "recurring", "subscription", "delegat"). [source: same; [requirements.md](https://github.com/w3c/secure-payment-confirmation/blob/main/requirements.md)] Browser support: Chrome and Edge 95 and later; not Firefox or Safari. [source: [@mdn/browser-compat-data 8.1.9](https://github.com/mdn/browser-compat-data), `api.PaymentRequest.PaymentRequest.secure_payment_confirmation_method`] The currency must be a well-formed three-letter code, so `USDC` would throw a `RangeError`. [source: [Payment Request API](https://www.w3.org/TR/payment-request/), "check and canonicalize amount"] **Fit: no** for mandates: it confirms one payment total, and showing a standing grant as one "total" would mislead. It belongs to the trusted-display ticket. [INFERENCE]
- **AP2, Agent Payments Protocol v0.2** ([google-agentic-commerce/AP2@e1ea56d](https://github.com/google-agentic-commerce/AP2/tree/e1ea56d)). In "Human Not Present" mode a user signs open mandates of constraints; the agent signs closed mandates with its own key, named in the open mandate's `cnf` claim; `exp` should be "the smallest value that will allow the Shopping Agent to complete the assigned task"; the Trusted Surface that collects consent MUST be non-agentic. [source: [AP2 specification](https://ap2-protocol.org/ap2/specification/), "Modes"] Open Payment Mandate constraints include agent recurrence (`frequency`, `max_occurrences`), allowed payees, amount range, budget, and execution date. For the budget, "the requested amount plus the total sum of amounts from previously closed Payment Mandates MUST be less than or equal to `max`. After approval, the amount MUST be added to the accumulated total". [source: AP2 `docs/ap2/payment_mandate.md:29-45, 47-70, 192-209`] **Fit: closest in concept** (open mandate = the mandate here; closed mandate = an intent), but in AP2 the verifiers keep the counters and the agent holds a key. Here the signer is verifier and counter keeper, the agent holds no key, and the control plane authenticates the agent with a bearer token. **Borrow:** the constraint set, the shortest-expiry advice, payee allowlists, and the rule that consent is collected on a non-agentic surface. [INFERENCE]

## Options compared

|                                             | A. Auto-approve tier in the policy                      | B. Signer-enforced mandate                                                    | C. Batch approval of listed intents             | D. Agent-held session key, on-chain rules   | E. Control plane enforces, signer trusts its grant |
| ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| What a person signs                         | a policy with "no approval below X"                     | one `grant-mandate` envelope over a full mandate                              | one envelope over a list of exact intent hashes | a session-key grant (ERC-7715 or 7702)      | a grant the control plane later relays             |
| Keeps "the signer decides a human approved" | yes, but the approval is permanent and wallet-wide      | yes: the grant is passkey-verified by the signer, each use checked against it | yes, strictly: only listed intents              | the chain decides, not the signer           | **no**                                             |
| Fits server-held EOA keys                   | yes                                                     | yes                                                                           | yes                                             | no (smart account, or a key in the agent)   | yes                                                |
| One agent only                              | no (any listed requester)                               | yes                                                                           | yes                                             | yes                                         | depends                                            |
| Time limit, use count                       | no                                                      | yes                                                                           | per intent                                      | yes                                         | depends                                            |
| Stolen agent token can                      | spend below X anywhere the policy allows, forever       | spend the mandate's budget to its allowlist until it ends                     | nothing new                                     | spend the session's budget                  | anything the grant says                            |
| Compromised control plane can               | same as the token, any agent                            | same as the token                                                             | only what was listed                            | n/a (enforced on chain)                     | everything                                         |
| Revoke                                      | passkeys at the admin threshold                         | one request, no passkey                                                       | per approval, as today                          | an on-chain transaction                     | control plane only                                 |
| Serves "the agent decides later"            | yes                                                     | yes                                                                           | no: actions must be known in advance            | yes                                         | yes                                                |
| Size of change                              | policy shape change (new policy version), evaluator, UI | new structure, envelope kind, 4 signer routes, 3 tables, one kind of use      | new envelope kind, small                        | contracts, bundler path, typed-data signing | small, and wrong                                   |

[INFERENCE: the table summarizes F1 to F10.]

## Recommendation

This is a recommendation, not a decision. The owner decisions it depends on are listed in the plan's Decision Log.

Build Option B, and keep Option C as a separate, smaller follow-up if exact pre-known batches (payroll, a list of invoices) turn out to matter.

1. **A `Mandate` structure**, hashed under its own tag `askgina.os/v1/mandate`, with: `id` (`mnd_…`), `workspaceId`, `walletId`, `agentId`; `assets`, each `{ chainId, asset, maxPerAction, maxPerWindow, maxTotal }`; `windowSeconds` (rolling, 1 hour to 7 days); `recipients`, a non-empty allowlist; `maxUses`; `maxFeePerActionWei`; `notBefore`, `notAfter`; and `purpose`, the person's own words. Contract calls are not representable in it. [INFERENCE]
2. **A `grant-mandate` envelope** with the usual header plus `mandateId`, `walletId`, `agentId` and `mandateHash`. The challenge is the envelope digest, as for every kind. Verified by the signer at the workspace's admin threshold, because a standing grant adds authority the way a policy does; for a single-person workspace that is the same person and the same one tap. [INFERENCE; threshold is owner decision D1 in the plan]
3. **Grant-time checks at the signer:** the agent is a requester of the wallet's policy; every asset has a policy limit and the mandate's caps do not exceed it; every recipient is allowed by the policy; the fee ceiling does not exceed the policy's; the lifetime does not exceed a signer ceiling (`SIGNER_MAX_MANDATE_SECONDS`, default 7 days); the wallet has fewer than 16 live mandates. These turn an impossible grant into a clear refusal. The bound at use time is the live policy. [INFERENCE]
4. **A use** is a new signer route, `POST /v1/mandates/:mandateId/sign`, with `{ approvalId, intent, transaction }` and no assertions. In one `BEGIN IMMEDIATE` transaction with nothing awaited, the signer: returns the stored transaction for a repeat; checks the workspace is not paused, the mandate is not revoked, now is inside `[notBefore, notAfter)`, and the people who granted it still meet the admin threshold; refuses an intent id already used; evaluates the live policy against the 24-hour ledger; evaluates the mandate against its own usage; checks the fee; builds, signs and checks the transaction; and records `approvals`, `signatures`, `spends` and a new `mandate_uses` row. [INFERENCE, following F2 and F4]
5. **Counters** are derived from `mandate_uses` joined to `spends`: uses, total per asset, and per asset inside the rolling window. Nothing is ever refunded, because only the control plane could claim a transaction failed, and it is not trusted. [INFERENCE]
6. **Ending a mandate:** `POST /v1/mandates/:mandateId/revoke` with the request signature only; workspace pause; reaching `notAfter`, `maxUses` or `maxTotal`; removing an approver whose passkey granted it (in the same transaction as the removal); disabling the agent (the control plane revokes); and, for the operator on the signer host, `admin revoke-mandate`. There is no resume: a new grant replaces an ended mandate. [INFERENCE]
7. **Difference from the policy, stated to people:** the policy is the wallet's outer limit and needs a passkey per transaction; a mandate is a narrower, temporary advance approval for one agent inside it. Mandated spending counts against the policy's daily cap. Lowering the policy narrows every mandate at once; raising it widens none. [INFERENCE]
8. **Agent reporting:** `whoami` lists the agent's live mandates with remaining budget; the propose tools pick a covering mandate automatically, or the one named in an optional `mandateId` input, and report `authorizedBy: "mandate"` with the `mandateId` and no approval link; `get_intent` and `list_intents` carry the same fields. The tool list stays at seven. When no mandate covers a proposal it goes to the inbox as today. [INFERENCE]
9. **UI:** a grant card on the approval page; an "Approved in advance" section on the wallet page and the agent page with usage meters, time left and a Revoke button; a mandate page listing the intents that ran under it; each such intent marked "approved in advance" with a link to its mandate. [INFERENCE]

## Limits

- Nothing here was run. The design is derived from reading this repository, the standards and the cited repositories. No prototype exists.
- The UI wording was not tested with people. Whether a worst-case figure is understood as intended is unknown.
- The external standards are drafts or recent: ERC-7715 and ERC-7710 are Drafts, SPC is a Candidate Recommendation Draft, AP2 is v0.2. Their details can change.
- On-chain enforcement as defence against a compromised signer host was not designed. It would need smart accounts whose root key is not held by the same signer, which is a different custody model.
- The signer's single-process SQLite is assumed. A signer spread over several machines ([ticket 25](https://github.com/askgina/os/issues/25)) would need the same serialization for mandate counters as for the daily cap.
- Restoring an older signer volume forgets uses made since that backup, so a restored mandate could be spent again. The plan revokes all mandates after a restore; this was not tested.
- The signer's clock decides `notAfter`. A clock that is wrong extends or shortens mandates.

## Sources

Repository files at `61dd59c`, as tagged above. Outside sources, read on 2026-11-14:

- [ERC-7715: Request Permissions from Wallets](https://eips.ethereum.org/EIPS/eip-7715) (Draft) and its [source](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md).
- [ERC-7710: Smart Contract Delegation](https://eips.ethereum.org/EIPS/eip-7710) (Draft).
- [EIP-7702: Set Code for EOAs](https://eips.ethereum.org/EIPS/eip-7702) (Final).
- [erc7579/smartsessions](https://github.com/erc7579/smartsessions) at `f5aaf86`.
- [coinbase/spend-permissions](https://github.com/coinbase/spend-permissions) at `e0004e6`.
- [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/), CRD 13 October 2026; [requirements.md](https://github.com/w3c/secure-payment-confirmation/blob/main/requirements.md); [Payment Request API](https://www.w3.org/TR/payment-request/), CRD 22 June 2026.
- [@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.9 (2026-11-12).
- [AP2 specification](https://ap2-protocol.org/ap2/specification/) v0.2 and [google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2) at `e1ea56d`, `docs/ap2/payment_mandate.md`.
