<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [How should a signed transaction that is not mined be repriced under the approval it already has?](https://github.com/askgina/os/issues/22). **Map:** [After v0.1: wider approvals, more venues, more machines](https://github.com/askgina/os/issues/18). **Date:** 2026-11-14.
>
> Written by a research agent from source reading and primary documents only. Nothing in this report was run or observed at runtime: no transaction was signed, broadcast, dropped or replaced, and no Anvil instance was started. Each claim is tagged **[source]** with a file and line or a URL, or **[INFERENCE]** when it is reasoning from those sources. Upstream node code was read at the default branch on the date above (go-ethereum `master`, reth `main`, foundry `master`), not at a pinned release. The plan that follows from this report is [`specs/stuck-transaction-repricing.md`](../stuck-transaction-repricing.md).

# Repricing a stuck transaction under the approval it already has

## Question

> Today such a transaction is reported as `stuck` and blocks later nonces of that wallet on that chain. What may change under an existing approval (fees only, within the approved fee cap), who decides to reprice (automatic, the agent, a person), how are replacement and cancellation kept to exactly one mined transaction, and what does the signer need to record?

## Answer

- **What may change.** Only `maxFeePerGas` and `maxPriorityFeePerGas`. The account nonce, gas limit, `to`, `value`, `data` and chain stay exactly those of the first signature for the approval. The signer enforces this from its own record, not from the request: it rebuilds the transaction from the approved intent with the nonce and gas it stored, and compares the result with the stored signed transaction field by field. The bound is `gas × maxFeePerGas ≤ min(intent.maxFeeWei, current policy fees.maxPerTxWei)`, and both fee fields must rise over the previous attempt.
- **Why it stays one transaction.** Every attempt for one approval (the original, each replacement, and a cancellation) carries the same account nonce. A chain includes at most one transaction per sender and nonce, so at most one of them is mined. The signer pins the nonce; the control plane's nonce allocator must keep that nonce out of reach of other approvals while any attempt is live. v0.1 does not do the second part: its allocator ignores `stuck` transactions (finding F3).
- **Who decides.** Repricing is the same authority v0.1 already gives the control plane when it picks the first fees inside the approved ceiling. Recommended: the control plane reprices automatically on a fixed schedule; an approver can also press "Speed up" in the UI without a passkey; the agent can only read the attempts. This keeps the invariant: the signer still signs only the approved operation, and only the fee fields vary, inside the ceiling the person saw.
- **Cancel** is a zero-value transfer from the wallet to itself at the same nonce, with gas 21000 and higher fees. It is not the approved operation, so it needs its own passkey approval: a new `cancel-transaction` envelope that names the target approval, wallet, chain, account nonce and a fee ceiling. The signer verifies it like any other approval. Because the gas is 21000, a cancel can often pay a higher fee per gas than a replacement under the same ceiling.
- **Daily cap.** The spend is recorded once, at the first signature, keyed by approval id. A replacement adds nothing. A cancel that lands does not release the spend: the signer does not watch the chain and must not take the control plane's word that a cancel won. The amount leaves the rolling 24 hours on its own.
- **What the signer records.** A new table of attempts per approval (attempt number, kind, account nonce, gas, both fees, signed bytes, hash, time, and for a cancel the approval id that authorized it), plus decision-log entries `reprice` and `cancel-transaction`. Nothing else changes in the signer's schema.

## Findings

### F1. How v0.1 signs

1. One approval id gives at most one signature. A repeated request with the identical envelope returns the stored signed transaction, checked before any other rule and again inside the write transaction. **[source]** `apps/signer/src/signer.ts:344-350`, `:716-717`, `:756-758`.
2. The envelope nonce is recorded as used inside the same SQLite transaction as the signature. **[source]** `apps/signer/src/signer.ts:323-329`, `:764`; table `used_nonces`, `apps/signer/src/db.ts:51-57`.
3. The account nonce of the transaction is the caller's choice and may repeat across approvals, on purpose: a reset local chain counts from zero, and "replacing a transaction that never landed needs its nonce". **[source]** `apps/signer/src/signer.ts:765-768`; decision in `specs/agent-workspaces-v0.1.md:153-154`.
4. The fee rule is `gas × maxFeePerGas ≤ intent.maxFeeWei` and `maxPriorityFeePerGas ≤ maxFeePerGas`, checked before the critical section. **[source]** `apps/signer/src/signer.ts:747-751`; `docs/approval-protocol.md:261-262`, `:292-305`. The intent's comment already says "Nonce and gas fields may vary below it after approval". **[source]** `packages/protocol/src/intent.ts:89-90`.
5. The signer builds `to`, `value`, `data` and the chain from the intent and takes only `nonce`, `gas` and the two fee fields from the caller. **[source]** `apps/signer/src/signer.ts:677-708`; `packages/protocol/src/signer/api.ts:146-157`.
6. After the vault signs, `isSignedBy` re-serializes the parsed result and compares it byte for byte with the expected unsigned transaction, then checks the signer address and a low `s`. **[source]** `apps/signer/src/signer.ts:98-121`, `:794-799`.
7. The signer already stores the account nonce and chain of every signature (`signatures.tx_nonce`, `signatures.chain_id`), keyed by approval id. No rule reads them today. **[source]** `apps/signer/src/db.ts:68-76`; `apps/signer/src/signer.ts:803-813`.
8. The decision log records workspace, approval id, action, outcome and code; it has no free-form detail column, and its entries are hash-chained. **[source]** `apps/signer/src/decisions.ts:6-13`, `:27-41`.
9. The signer schema is created with `CREATE TABLE IF NOT EXISTS` only; there is no migration step. A new table is additive; a changed column or `CHECK` would need a table rebuild. **[source]** `apps/signer/src/db.ts:9-110`. Note `approvals.state` has `CHECK (state IN ('revoked', 'signed', 'applied'))`. **[source]** `apps/signer/src/db.ts:60-66`.

### F2. Spend, fees and the daily cap

1. The spend is inserted in the same transaction as the signature, with `approval_id` as the primary key, so one approval can never be counted twice. **[source]** `apps/signer/src/signer.ts:814-817`; `apps/signer/src/db.ts:78-87`.
2. A signed amount counts against the cap even if it never lands; the signer does not watch the chain. **[source]** `docs/threat-model.md:241-243`.
3. Fees are not part of the spend. **[source]** `packages/protocol/src/intent.ts:131-142`. The only fee bound in a policy is `fees.maxPerTxWei`, the largest `maxFeeWei` an intent may carry. **[source]** `packages/protocol/src/policy.ts:70-73`; check `over_fee_cap` in `packages/protocol/src/evaluate.ts`.
4. Consequence for repricing **[INFERENCE]**: a replacement under the same approval id cannot be counted twice and needs no new spend row. Releasing a spend when a cancel lands would require the signer to know which attempt was mined. Taking that from the control plane would let a compromised control plane report "the cancel won" when the payment won, release the spend, and sign past the daily cap.

### F3. How the control plane reserves nonces

1. `reserveNonce` takes a Postgres advisory lock per wallet and chain, then picks `max(pending count from the chain, highest nonce of this wallet's transactions in status signed or broadcast + 1, highest reservation + 1)`. A retry of the same approval reuses its reservation. **[source]** `apps/server/src/execution/intents.ts:641-697`.
2. `stuck` is not in that status list. **[source]** `apps/server/src/execution/intents.ts:672`. The reservation term does not hold the nonce either: `executeIntent` deletes the approval's `nonce_reservations` row in the same database transaction that inserts its `transactions` row (`apps/server/src/execution/intents.ts:758-779`, delete at `:777`). `releaseNonce` (`:699-701`, called at `:729`, `:748`, `:921`) is a second path for approvals that ended without a signature. So once a transaction is signed, only its `transactions.status` keeps its nonce out of the allocator's reach. **[source]**
3. Consequence **[INFERENCE]**: while the RPC node still holds the stuck transaction in its pool, `getTransactionCount(pending)` (`apps/server/src/execution/chains.ts:205-207`) counts it and the next approval gets N+1, which waits behind it, as the UI says. If the node has evicted it (geth drops non-executable transactions after `Lifetime`, 3 hours by default, F7.2), the pending count is N and the next approval is given N as well. Whichever of the two is mined first wins; if the new one wins, the stuck intent can never be mined, yet it stays `stuck` and is polled every 600 seconds for as long as the run lives (`apps/server/src/execution/intents.ts:70-71`, `:857-883`), because reconciliation only asks for a receipt by hash. The UI then tells people it "may still be included later" (`apps/web/src/lib/statuses.ts:18-19`), which is false once its nonce is used. The comment on the polling ("A stuck transaction is still valid and may be mined any time", `intents.ts:857-858`) holds only while the nonce is kept back, and the allocator does not keep it back.
4. The `rejected` path frees the nonce: a transaction the chain never accepted ends `rejected`, its intent `failed`. **[source]** `apps/server/src/execution/intents.ts:830-843`; test `apps/server/test/execution/hardening.test.ts:428-453`. **[INFERENCE]** The signed bytes stay valid until something else uses nonce N. If they were ever accepted by any node, they could still be mined later, and the intent would then have executed while reported `failed` ("nothing more will be sent for it", `apps/web/src/lib/statuses.ts:24`). The window is small because `rejected` requires the node to answer "unknown" after the reconcile timeout, but nothing reconciles it afterwards.

### F4. How v0.1 broadcasts and reconciles

1. `executeIntent` reserves a nonce, quotes fees, picks gas and fees with `chooseFees`, asks the signer, and stores one `transactions` row with the sealed raw transaction. **[source]** `apps/server/src/execution/intents.ts:708-780`.
2. `chooseFees`: `gas = estimate × 125 / 100`; `maxFeePerGas = min(2 × baseFee + tip, maxFeeWei / gas)`; refused when `maxFeeWei / gas < baseFee + tip`. **[source]** `apps/server/src/execution/intents.ts:611-633`. The quote is the latest block's `baseFeePerGas` and `eth_maxPriorityFeePerGas`, with 1 gwei as fallback. **[source]** `apps/server/src/execution/chains.ts:196-203`.
3. `followUpIntent`: a `signed` transaction is broadcast with backoff until the reconcile timeout; a `broadcast` transaction with no receipt is rebroadcast every 60 seconds and becomes `stuck` after `RECONCILE_TIMEOUT_SECONDS` (default 3600, range 30 to 604800); a `stuck` transaction is not rebroadcast and is polled every 600 seconds. **[source]** `apps/server/src/execution/intents.ts:66-71`, `:782-884`; `apps/server/src/config.ts:61-62`.
4. `broadcast` treats "already known" as success, and "nonce too low" as success only if the node has this exact hash. **[source]** `apps/server/src/execution/chains.ts:209-227`. **[INFERENCE]** After a replacement is mined, rebroadcasting the original gets "nonce too low" with an unknown hash and fails; reconciliation must look at every attempt's hash, not only the newest.
5. One `transactions` row per approval: primary key `approval_id`, one `hash`, one sealed `raw`, status one of `signed`, `broadcast`, `confirmed`, `reverted`, `stuck`, `rejected`. **[source]** `apps/server/src/db/schema.ts:398-430`.
6. Why a transaction gets stuck **[INFERENCE]**, from F4.2 and EIP-1559 (F7.4): the base fee rose above the signed `maxFeePerGas` (2× the base fee at signing is exceeded after about six consecutive full blocks at +12.5% each); the tip is too low for the builders in use; a lower nonce of the same wallet is not mined (a nonce gap); or the node evicted it. Only the first two are cured by a higher fee on the same transaction. A nonce gap is cured by repricing the lowest unmined nonce first.

### F5. How the workflow follows a transaction

1. One workflow run per approval: it waits for the decision by racing a hook against a sleep, executes, then loops `followUpStep` with a plain `sleep(waitSeconds)`. After execution the hook is no longer raced, so nothing can wake the run early. **[source]** `apps/server/workflows/approval.ts:38-48`, `:66-74`.
2. `executeStep.maxRetries = 12`; `followUpStep.maxRetries = 12`. **[source]** `apps/server/workflows/approval.ts:93`, `:109`.
3. Steps call implementations registered on `globalThis`; the run carries ids and codes only. **[source]** `apps/server/src/execution/steps.ts:1-46`; `apps/server/workflows/approval.ts:1-24`.
4. The engine can wake a run through its hook token `apr:<approvalId>:<runId>`. **[source]** `apps/server/src/execution/workflow-runtime.ts:144-154`.

### F6. How v0.1 reports a stuck transaction

1. API: `IntentStatus` includes `stuck` ("It can still be mined later"); `IntentDetail.transaction` carries one hash and one status. **[source]** `packages/api/src/dto.ts:255-277`, `:322-336`.
2. Web: badge "Not mined yet"; sentence "Later payments from this wallet on this network wait behind it." **[source]** `apps/web/src/components/common.tsx:167`, `:183`; `apps/web/src/lib/statuses.ts:18-19`, `:32-33`. The approval page shows the transaction status and one hash. **[source]** `apps/web/src/routes/approval.tsx:491-532`.
3. MCP: `get_intent` stops waiting on `stuck` as if final, and the tool text says a stuck transaction "can later become confirmed or reverted". The seven tools include no reprice or cancel. **[source]** `apps/server/src/mcp/gateway.ts:32-41`, `:65-76`.
4. Threat model and plan list repricing as not designed. **[source]** `docs/threat-model.md:245-247` and its "Out of scope for v0.1" list; `specs/agent-workspaces-v0.1.md:46`, `:494-495`.

### F7. Replacement rules and mempool behaviour

1. **go-ethereum.** A transaction with the same sender and nonce replaces the pooled one only if both its fee cap and its tip are strictly greater than the old ones and at least `old × (100 + PriceBump) / 100`. **[source]** [`core/txpool/legacypool/list.go`, `func (l *list) Add`](https://github.com/ethereum/go-ethereum/blob/master/core/txpool/legacypool/list.go). `PriceBump` defaults to 10. **[source]** [`core/txpool/legacypool/legacypool.go`, `DefaultConfig`](https://github.com/ethereum/go-ethereum/blob/master/core/txpool/legacypool/legacypool.go).
2. go-ethereum's `Lifetime` ("maximum amount of time an account can remain stale in the non-executable pool") defaults to 3 hours. **[source]** same `legacypool.go`. **[INFERENCE]** A transaction waiting behind a nonce gap is non-executable and can be dropped after that time; a stuck but executable transaction can also be evicted under pool pressure. Either way, "the node no longer has it" is normal, so a stuck transaction must be rebroadcast, not only polled.
3. **reth.** `DEFAULT_PRICE_BUMP = 10`, 100 for blob transactions. A replacement is underpriced when its max fee is below `ceil(old × (100 + bump) / 100)`, or, when both tips are non-zero, its tip is below the same bound. **[source]** [`crates/transaction-pool/src/config.rs`, `is_replacement_underpriced`](https://github.com/paradigmxyz/reth/blob/main/crates/transaction-pool/src/config.rs).
4. **EIP-1559.** The base fee changes by at most 1/8 per block (`BASE_FEE_MAX_CHANGE_DENOMINATOR = 8`). **[source]** [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559). A transaction is valid only when its nonce equals the sender's account nonce, which then increases by one, so two transactions with one sender and nonce can never both be included. **[source]** [Ethereum yellow paper, section 6](https://ethereum.github.io/yellowpaper/paper.pdf).
5. **Anvil.** A replacement needs only a strictly higher `max_fee_per_gas`; there is no percentage bump and no tip check. **[source]** [`crates/anvil/src/eth/pool/transactions.rs`](https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/pool/transactions.rs) (`ReplacementUnderpriced` in two places). Anvil refuses a transaction whose `maxFeePerGas` is below the current base fee at admission (`FeeCapTooLow`). **[source]** [`crates/anvil/src/eth/backend/mem/mod.rs`](https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/backend/mem/mod.rs). It exposes `anvil_dropTransaction`, `anvil_dropAllTransactions`, `anvil_removePoolTransactions`, `evm_setAutomine` and `anvil_setNextBlockBaseFeePerGas`. **[source]** [`crates/anvil/src/eth/api.rs`](https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/api.rs). **[INFERENCE]** Tests on Anvil therefore cannot prove the 10% rule; a unit test must, and Anvil tests must make transactions stuck with automine off or by dropping them, not by signing below the base fee.
6. **Cancel.** The common wallet practice is "send TO yourself", value 0, "the same nonce as the transaction that is still pending", with a priority fee at least 10% higher; cancellation "can only be attempted if the transaction is still pending"; and nonces are cleared "from the oldest pending transaction". **[source]** [MetaMask, How to speed up or cancel a pending transaction](https://support.metamask.io/manage-crypto/transactions/how-to-speed-up-or-cancel-a-pending-transaction/).

### F8. Test tooling already in the repo

1. viem 2.57.19 has `dropTransaction` (`anvil_dropTransaction`), `setAutomine` (`evm_setAutomine`), `mine`, `setNextBlockBaseFeePerGas` and `getTxpoolContent`. **[source]** `node_modules/.bun/viem@2.57.19+e401cb34621fadb3/node_modules/viem/actions/test/dropTransaction.ts:49`, `setAutomine.ts:40-44`, `setNextBlockBaseFeePerGas.ts:49`.
2. The server's execution tests already use a viem test client in `anvil` mode against the test chain. **[source]** `apps/server/test/execution/fixture.ts:19-25`.
3. Anvil runs from `ghcr.io/foundry-rs/foundry:stable@sha256:04375265…` with default automine, in Compose and in the test stack. **[source]** `compose.yaml:146-149`; `deploy/compose.test.yaml:21-23`. The Anvil version inside that digest was not checked.

## Options compared

### What may change after approval

| Option                                                                                              | Exactly one mined              | Person in the loop              | Cost                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1. Nothing; a stuck payment needs a new intent and a new approval at the same nonce                | Yes, if the allocator reuses N | Every time                      | Spend counted twice; the person must re-approve the same payment                                                                                                       |
| A2. Fee-only re-signature under the same approval, nonce and gas pinned by the signer (recommended) | Yes, by nonce                  | No, within the approved ceiling | New signer route and attempts table                                                                                                                                    |
| A3. Pre-signed fee ladder at first signature (for example 8 attempts at +12.5% each)                | Yes, by nonce                  | No                              | No new signer route, but the schedule is fixed at signing, cannot react to a lowered policy fee cap, and leaves every rung signed and stored even when the first lands |

A2 keeps the invariant in its plain form: the signer signs the approved operation and nothing else, and the only variable fields are the two the person's ceiling already bounds. A3 keeps it too but is rigid; A1 adds friction without adding safety.

### Who decides to reprice

| Option                                                                                        | Speed     | Abuse by a compromised control plane                                                             | Abuse by a prompt-injected agent      |
| --------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| B1. Control plane, automatically, on a fixed schedule (recommended)                           | Fast      | Can burn at most `maxFeeWei` per approval, which v0.1 already allows when it picks the first fee | None                                  |
| B2. An approver presses "Speed up" (session only, no passkey) (recommended in addition to B1) | On demand | Same as B1                                                                                       | None                                  |
| B3. An agent tool `reprice_intent`                                                            | On demand | Same as B1                                                                                       | Can push every payment to the ceiling |
| B4. A passkey approval per reprice                                                            | Slow      | None beyond v0.1                                                                                 | None                                  |

Fees within the approved ceiling are already the control plane's choice in v0.1 (F1.4, F4.2). B4 adds a ceremony for something the person already bounded.

### Cancel

| Option                                                                                           | Keeps "signs only what was approved"                    | Who can stop a payment          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------- |
| C1. No cancel; repricing only                                                                    | Yes                                                     | Nobody once broadcast           |
| C2. `cancel-transaction` envelope approved with passkeys at the wallet's threshold (recommended) | Yes: the cancel is itself approved                      | The same people who approved it |
| C3. Cancel with the request signature only, like revoke and pause                                | No: the signer signs a self-transfer no person approved | The control plane               |

C3 is tempting because a cancel moves no asset and only removes an effect. But it gives a compromised control plane a new power: stop a payment that is already public and that anyone could otherwise rebroadcast. v0.1 does not give it that power (`docs/threat-model.md:96-105`). C2 needs a person, which is right for an action that changes the outcome of an approval.

### Daily-cap accounting after a cancel lands

| Option                                                                    | Safe against a compromised control plane                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D1. Keep the spend; it leaves the 24-hour window on its own (recommended) | Yes                                                                                                        |
| D2. Release on the control plane's report                                 | No (F2.4)                                                                                                  |
| D3. Release after the signer checks the chain itself                      | Only if the signer's RPC is trusted; adds an outbound network path to the signer, which v0.1 does not have |

### Where "one nonce per approval" is enforced

| Option                                                                                                                                               | Effect                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1. The signer pins every attempt to the approval's stored nonce; the control plane keeps the nonce reserved while any attempt is live (recommended) | Exactly one of the approval's attempts can be mined. Another approval can still be given the same nonce by a compromised control plane, which voids both, a denial of service it already has by not broadcasting. |
| E2. E1 plus a signer rule: no first signature at a (wallet, chain, nonce) that another approval already holds                                        | Breaks the v0.1 reasons for repeatable nonces (reset local chain, rejected transaction) and adds no safety the cap does not already give                                                                          |

## Recommendation

This is a recommendation, not a decision.

1. Add one signer operation, `reprice`, authenticated by the request signature only. It takes the approval id, the original `intent` and its `approve-intent` envelope (so the signer can check `envelopeChallenge` against the stored `approvals.envelope_digest` and read `maxFeeWei` from an intent whose hash the passkeys covered), the attempt number it expects to create, and the two new fee fields. The signer rebuilds the transaction from the intent with the stored nonce and gas, refuses unless it equals the stored original in every field but the two fees, refuses unless both fees are strictly higher than the latest attempt's and the product stays under `min(intent.maxFeeWei, policy.fees.maxPerTxWei)`, signs, and stores the attempt.
2. Add one envelope kind, `cancel-transaction`, approved with passkeys at the wallet policy's threshold and TTL. It names the target approval, wallet, chain, account nonce and a `maxFeeWei` no larger than the policy's fee cap. The signer signs `{ to: wallet address, value: 0, data: empty, gas: 21000 }` at the stored nonce with fees above the latest attempt's, and stores it as an attempt of the target approval.
3. Keep the spend as recorded at the first signature. Release nothing.
4. In the control plane: hold the nonce while any attempt is live (add `stuck` to the allocator's statuses); reprice automatically when the wallet's mined nonce equals this transaction's nonce and the latest attempt is unmined after a configurable delay; rebroadcast the newest attempt while unmined; reconcile across every attempt's hash and detect a nonce consumed by a transaction that is none of ours. Do this inside the existing follow-up step, and let "Speed up" and cancels act through their own route and approval run, so the workflow body does not change and runs already in flight replay as recorded (F5.1; `specs/agent-workspaces-v0.1.md:144-145` records a replay divergence from a workflow-body change).
5. Report every attempt in the API, the web page and `get_intent`, with a plain reason (`fee_too_low`, `waiting_behind_nonce`, `fee_ceiling_reached`). Give the agent no tool to reprice or cancel.
6. Pausing a workspace stops repricing (it is a new signature for an outgoing payment) but not cancelling (a cancel only removes an effect, and it carries its own passkey approval).

## Limits

- Nothing was run. Anvil behaviour is from foundry `master` source, not from the binary in the pinned image digest. go-ethereum and reth rules are from their default branches.
- Besu, Nethermind and Erigon replacement rules were not read. Besu's are known to differ in edge cases ([hyperledger/besu#2529](https://github.com/hyperledger/besu/issues/2529), title only). L2 sequencers (OP Stack, Arbitrum) and private order-flow endpoints have their own mempool rules; none was read.
- The eviction behaviour in F3.3 and F7.2 is inferred from default configuration, not observed.
- Whether a workflow hook created before execution can still be resumed during the follow-up loop is inferred from the hook's lifetime being the run's lifetime; it was not tested.
- Trusted display (ticket #20) is out of scope here. A cancel approval inherits the same gap as every approval: a compromised control plane can show one target and ask for another. The signer's checks bound what that can cost (one cancel fee, inside the policy's fee cap).
