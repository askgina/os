# Reprice or cancel a stuck transaction under the approval it already has

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-14
- Links: [Ticket #22](https://github.com/askgina/os/issues/22) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](./research/stuck-transaction-repricing.md) | [v0.1 ExecPlan](./agent-workspaces-v0.1.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

Nothing in this plan is built. Every claim about v0.1 behaviour comes from source reading recorded in the research report; nothing was run.

## Purpose / Big Picture

In v0.1 a payment that a person approved, that the signer signed and that the control plane broadcast can sit unmined: the base fee rose above its fee cap, its tip is too low, or the node dropped it. It is reported as `stuck`, and every later payment from that wallet on that chain waits behind it. Nobody can do anything about it except wait.

After this change:

- The control plane raises the fee of a stuck payment by itself, on a fixed schedule, inside the fee ceiling the person approved. The signer signs each higher-fee copy only after checking, from its own records, that nothing changed except the two fee fields and that the account nonce is the one it signed first. Every copy shares one nonce, so at most one of them can be mined.
- An approver can press "Speed up" to reprice now instead of waiting for the schedule.
- An approver can ask to cancel a payment that is still unmined. Cancelling is a new passkey approval, `cancel-transaction`. When it is approved the signer signs a zero-value transfer from the wallet to itself at the same nonce, with a higher fee, and the payment can then never be mined.
- People and agents see every attempt (first, higher fee, cancellation), its fee and hash, which one was mined, and a plain reason when a payment is still stuck.

Success means:

- A payment made unmineable on a local chain (automine off, base fee raised above its fee cap) is repriced automatically and ends `confirmed`, and the wallet's account nonce rises by exactly one.
- A payment that an approver cancels with a passkey ends `voided`: the recipient's balance is unchanged and the wallet's nonce rises by exactly one.
- The signer refuses every reprice that changes anything but the two fee fields, that does not raise both, that exceeds `min(intent.maxFeeWei, policy fees.maxPerTxWei)`, or that names an approval it never signed. These refusals appear in its decision log.
- The daily-cap ledger is unchanged by any reprice or cancel.
- Out of scope: changing the gas limit, legacy (type 0) or blob transactions, L2-specific fee fields, private order flow, a signer that watches the chain, an agent tool that reprices or cancels, and the trusted-display gap (ticket #20).

## Progress

- [x] (2026-11-14 21:34Z) Research current behavior and relevant code paths: [report](./research/stuck-transaction-repricing.md).
- [x] (2026-11-14 21:34Z) Define the implementation approach and validation plan (this document, Draft).
- [ ] Owner decisions listed under `Risks and Open Questions` taken.
- [ ] Milestone 1: protocol and contract.
- [ ] Milestone 2: signer attempts, reprice and cancel.
- [ ] Milestone 3: control plane nonce holding, reconciliation and automatic repricing.
- [ ] Milestone 4: cancel approval kind, speed-up route, API, web and MCP reporting.
- [ ] Milestone 5: real-stack release gate and documents.
- [ ] Run validation in CI and record run ids here.

## Surprises & Discoveries

- Observation: the v0.1 nonce allocator ignores `stuck` transactions. If the RPC node has dropped a stuck transaction, the next approval of the same wallet is given the same nonce, and if that one is mined the stuck intent stays `stuck` forever while the UI says it "may still be included later".
  Evidence: `apps/server/src/execution/intents.ts:665-674` (status list `signed`, `broadcast`); `:777` (the approval's `nonce_reservations` row is deleted in the same database transaction that stores its `transactions` row, so the reservation term of `reserveNonce` no longer holds a signed nonce); `:857-883` (stuck is only polled by hash); `apps/web/src/lib/statuses.ts:18-19`. Report F3.
- Observation: a `rejected` transaction frees its nonce although its signed bytes stay valid until that nonce is used; nothing reconciles it afterwards.
  Evidence: `apps/server/src/execution/intents.ts:830-843`; report F3.4.
- Observation: Anvil accepts a replacement with any strictly higher `maxFeePerGas`, with no 10% bump and no tip check, and refuses a transaction below the current base fee at admission. Tests on Anvil cannot prove the go-ethereum and reth replacement rule.
  Evidence: report F7.5 (foundry `crates/anvil/src/eth/pool/transactions.rs`, `backend/mem/mod.rs`).
- Observation: the signer already stores `tx_nonce` and `chain_id` per signature, so pinning the nonce needs no schema change to `signatures`.
  Evidence: `apps/signer/src/db.ts:68-76`.
- Observation: changing the workflow body risks diverging the replay of runs already in flight; the v0.1 plan records one such failure for attributes.
  Evidence: `specs/agent-workspaces-v0.1.md:144-145`. This plan therefore leaves `apps/server/workflows/approval.ts` unchanged.

## Decision Log

- Decision: owner decisions 1 to 5 are taken as recommended: (1) automatic repricing plus an approver's "Speed up" without a passkey, no agent tool; (2) a cancel is a `cancel-transaction` envelope at the wallet policy's threshold; (3) a 24-hour reprice window; (4) a landed cancel does not release daily-cap spend; (5) new envelope kinds are additive in protocol v1. The cancel is approved on the signer's confirmation page (ticket 20, built after this plan was drafted).
  Rationale: owner's answers in one form.
  Date/Author: 2026-11-15 / Eric Juta

- Decision: only `maxFeePerGas` and `maxPriorityFeePerGas` change under an existing approval. The nonce, gas limit, `to`, `value`, `data` and chain are those of the first signature, taken from the signer's own record.
  Rationale: the person approved an operation and a fee ceiling (`intent.maxFeeWei`). Raising the fee inside that ceiling is what v0.1 already lets the control plane choose at first signing. Keeping the nonce is what makes every attempt mutually exclusive on chain.
  Date/Author: 2026-11-14 / research agent (recommendation; owner decision 1 pending for who may trigger it).
- Decision: the fee ceiling for a reprice is `min(intent.maxFeeWei, current policy fees.maxPerTxWei)`.
  Rationale: a policy that lowered the fee cap after signing should also cap later fees. The rest of the current policy is not re-evaluated: refusing a reprice would not stop the already-signed original from being mined.
  Date/Author: 2026-11-14 / research agent.
- Decision: the signer requires both fee fields to be strictly higher than the latest attempt's; the percentage bump (default 12) is the control plane's setting, not the signer's.
  Rationale: "strictly higher" bounds the number of useful signatures and stops pointless ones. The percentage is a mempool rule that differs by client (10 in go-ethereum and reth, none in Anvil, report F7) and belongs to chain access.
  Date/Author: 2026-11-14 / research agent.
- Decision: attempts are capped per approval (`SIGNER_MAX_TX_ATTEMPTS`, default 16 including the first) and repricing without a person is allowed for a window after the first signature (`SIGNER_REPRICE_WINDOW_SECONDS`, default 86400).
  Rationale: bound storage and lingering authority. After the window a person decides, by cancelling. Owner decision 3 may change the window.
  Date/Author: 2026-11-14 / research agent.
- Decision: a cancel is a new envelope kind, `cancel-transaction`, approved with passkeys at the wallet policy's threshold and TTL.
  Rationale: a self-transfer is not the operation the person approved, so the signer may sign it only on a new approval. Owner decision 2.
  Date/Author: 2026-11-14 / research agent.
- Decision: once a cancel attempt exists for an approval, every later attempt is a cancel. A reprice after a cancel rebuilds the self-transfer under the cancel's own fee ceiling.
  Rationale: a reprice must never turn a cancellation back into the payment.
  Date/Author: 2026-11-14 / research agent.
- Decision: no spend is added or released by a reprice or a cancel.
  Rationale: the spend is keyed by approval id and recorded at the first signature; releasing it on the control plane's word would let a compromised control plane exceed the daily cap (report F2.4). Owner decision 4.
  Date/Author: 2026-11-14 / research agent.
- Decision: a reprice request carries the original `intent` and its `approve-intent` envelope, without assertions. The signer checks that the envelope's challenge equals `approvals.envelope_digest` for that approval id and that `intentHash(intent)` equals `envelope.intentHash`.
  Rationale: this binds the request to the exact approval the passkeys covered and gives the signer `maxFeeWei` for every row, including rows signed before this change, without storing new data on `signatures`.
  Date/Author: 2026-11-14 / research agent.
- Decision: pausing a workspace blocks reprices but not cancels.
  Rationale: pause stops new signatures for outgoing payments. A cancel moves no asset and carries its own passkey approval.
  Date/Author: 2026-11-14 / research agent.
- Decision: the signer does not enforce a unique account nonce per (wallet, chain) across approvals.
  Rationale: v0.1's reasons stand (reset local chain, rejected transaction; `specs/agent-workspaces-v0.1.md:153-154`). Two approvals at one nonce void each other, which is denial of service a compromised control plane already has by not broadcasting.
  Date/Author: 2026-11-14 / research agent.
- Decision: the workflow body `apps/server/workflows/approval.ts` stays unchanged. Automatic repricing runs inside the existing `followUp` step; "Speed up" and cancels act through an HTTP route and a separate approval run, serialized by a Postgres advisory lock and the signer's attempt number.
  Rationale: runs already in the follow-up loop replay their recorded events; a changed loop could diverge (Surprises).
  Date/Author: 2026-11-14 / research agent.
- Decision: the agent gets no tool to reprice or cancel; `get_intent` reports the attempts.
  Rationale: a prompt-injected agent could push every payment to its fee ceiling; nothing an agent needs requires it. Owner decision 1.
  Date/Author: 2026-11-14 / research agent.

## Outcomes & Retrospective

- Outcome: research done and plan drafted; nothing built.
  Evidence: [research report](./research/stuck-transaction-repricing.md).
  Remaining: every milestone; owner decisions 1 to 5.

## Context and Orientation

Terms used here:

- **Account nonce.** A per-sender counter on an EVM chain. A transaction is valid only when its nonce equals the sender's current count, which then rises by one. Two transactions with the same sender and nonce can never both be mined.
- **Envelope nonce.** A different thing: the single-use value inside an approval envelope that the signer records so an approval is acted on once (`packages/protocol/src/envelopes.ts:22-31`).
- **Attempt.** One signed transaction for an approval. Attempt 0 is the first signature. Attempts 1 and up are replacements (`reprice`) or a cancellation (`cancel`). All attempts of one approval share one account nonce.
- **Replacement rule.** A node accepts a transaction with an already-pooled sender and nonce only if its fees are higher by a margin: 10% on both fee cap and tip in go-ethereum and reth defaults; any higher fee cap in Anvil (report F7).
- **Cancel.** A transfer of value 0 from the wallet to itself, gas 21000, at the stuck transaction's nonce, with higher fees.

Relevant repo rules:

- Read the applicable `AGENTS.md` chain before changing files (`AGENTS.md`: Wayfinder tickets in GitHub Issues, ExecPlans under `specs/`).
- No local builds, full test suites or `e2e/run.sh` on a workstation; CI runs them (the `ci` workflow: jobs `check`, `test`, `ui`, `stack` amd64, arm64 and tls, `.github/workflows/ci.yml`). Single-file tests, `tsc` and Biome are allowed locally.
- Anything hashed (intent, policy, envelope) is versioned: a change to its shape or meaning is a new protocol version (`docs/approval-protocol.md` section 12; owner decision 5).
- The signer never trusts the control plane on whether a person approved, and builds every transaction from the approved intent (`docs/threat-model.md:96-105`).

Current behavior:

- Signer (`apps/signer/src/signer.ts`): `sign` acts once per approval id (`:710-828`); repeats return the stored transaction (`:716-717`); the caller chooses the account nonce (`:765-768`); fee rule `gas × maxFeePerGas ≤ maxFeeWei`, tip ≤ fee cap (`:747-751`); records `approvals`, `signatures` (with `tx_nonce`, `chain_id`), `spends`, `used_nonces` and a decision (`:800-818`). Schema in `apps/signer/src/db.ts`. HTTP routing in `apps/signer/src/index.ts`. Config in `apps/signer/src/config.ts`.
- Protocol (`packages/protocol/src`): `envelopes.ts` (six envelope kinds), `signer/api.ts` (routes, `TransactionParams`, `SignRequest`, `ApprovalState`, `SignerErrorCode`), `signer/client.ts` (HMAC client).
- Control plane (`apps/server/src/execution/intents.ts`): `reserveNonce` (`:641-697`), `chooseFees` (`:611-633`), `executeIntent` (`:708-780`), `followUpIntent` (`:782-884`), `approveIntentKind` (`:886-937`). Chain access in `apps/server/src/execution/chains.ts` (`fees`, `pendingNonce`, `broadcast`, `known`, `receipt`). Tables `transactions` and `nonce_reservations` in `apps/server/src/db/schema.ts:398-480`; migrations in `apps/server/src/db/migrations/` (latest `0001_directory_hardening.sql`). Config `RECONCILE_TIMEOUT_SECONDS` in `apps/server/src/config.ts:61-62`.
- Workflow (`apps/server/workflows/approval.ts`): one run per approval; after execution it loops `followUpStep` with plain `sleep` (`:66-74`).
- API contract (`packages/api/src/dto.ts`): `IntentStatus` (`:262-277`), `IntentDetail.transaction` with one hash (`:322-336`), `ApprovalKind` (`:359-367`), `ApprovalSubject` (`:392-424`). Routes in `packages/api/src/routes.ts`; server routes in `apps/server/src/execution/routes.ts`.
- Web (`apps/web/src`): status words in `lib/statuses.ts`, badges in `components/common.tsx:160-185`, the transaction block on `routes/approval.tsx:491-532`; fixture server `apps/web/dev/fixture-server.ts`; journey test `apps/web/test/journey.e2e.ts`.
- MCP (`apps/server/src/mcp/gateway.ts`): seven tools (`:65-73`); `stuck` ends a `get_intent` wait (`:32-41`).
- Tests: signer `apps/signer/test/*.test.ts` (harness `harness.ts`); server `apps/server/test/execution/*.test.ts` with an Anvil test client (`fixture.ts:19-25`); release gates `e2e/test/release-gates.spec.ts` with `chainAdmin` (Anvil test client on `E2E_ANVIL_URL`).

How the relevant pieces fit together:

- An agent proposes over MCP; the approvals engine (`apps/server/src/execution/approvals.ts`) opens an `approve-intent` approval with an envelope; people add passkey assertions; the workflow run executes: `executeIntent` reserves a nonce, picks fees, calls `POST /v1/sign`, stores the sealed raw transaction; then the run's `followUp` step broadcasts and polls receipts until final or `stuck`. The signer holds its own SQLite ledger and decision log and is reachable only from the control plane over the signing network, with an HMAC request signature.

Assumptions:

- One RPC endpoint per chain (`config.chains[].rpcUrl`). If it is a load-balanced pool with inconsistent mempools, rebroadcasting the newest attempt every 60 seconds covers it; reconciliation by every attempt's hash does not depend on which node saw what.
- `ChainConfig.confirmations` (default 1, `apps/server/src/config.ts:15`) is the depth at which an outcome is final. A chain with deeper reorgs needs a larger value; this plan does not change it.
- The workflow hook created before execution is not needed after it, because this plan does not wake the follow-up loop.

## Plan of Work

The work goes from the outside in: first the hashed and wire contracts, then the signer that enforces them, then the control plane that uses them, then reporting, then the end-to-end gate.

### Milestone 1: Protocol and contract

Scope: define what a reprice and a cancel are on the wire, so the signer and the control plane can be built against one contract. First because everything else depends on it.

Files and interfaces:

- `packages/protocol/src/envelopes.ts`: add `CancelTransactionEnvelope` to the `Envelope` union.
- `packages/protocol/src/signer/api.ts`: routes `reprice` and `cancelTransaction`; schemas `RepriceRequest`, `CancelTransactionRequest`, `TransactionAttempt`, `AttemptResponse`; extend `ApprovalState`; new error codes.
- `packages/protocol/src/signer/client.ts`: methods `reprice`, `cancelTransaction`.
- `packages/protocol/test/schemas.test.ts`, `digests.test.ts`, `signer-client.test.ts`: new cases.
- `docs/approval-protocol.md`: sections 5, 8, 9, 11, 12.

Work:

1. `CancelTransactionEnvelope = z.strictObject({ ...envelopeHeader, type: z.literal("cancel-transaction"), targetApprovalId: ApprovalId, walletId: WalletId, chainId: ChainId, txNonce: z.number().int().min(0), maxFeeWei: PositiveAmount })`. Add a refine that `targetApprovalId !== approvalId`. Its challenge is `digest("askgina.os/v1/authorize", envelope)` like every envelope (owner decision 5 decides whether this stays `v: 1`).
2. `signerRoutes.reprice = { method: "POST", path: "/v1/approvals/:approvalId/reprice" }` and `signerRoutes.cancelTransaction = { method: "POST", path: "/v1/approvals/:approvalId/cancel" }`. In both, `:approvalId` is the target approval (the one that was signed).
3. `RepriceRequest = z.strictObject({ intent: Intent, envelope: ApproveIntentEnvelope, attempt: z.number().int().min(1), maxFeePerGas: PositiveAmount, maxPriorityFeePerGas: Amount })`. `attempt` is the number the caller expects to create (latest + 1).
4. `CancelTransactionRequest = z.strictObject({ authorization: Authorization, attempt: z.number().int().min(1), maxFeePerGas: PositiveAmount, maxPriorityFeePerGas: Amount })`, carrying a `cancel-transaction` envelope.
5. `TransactionAttempt = z.strictObject({ attempt: z.number().int().min(0), kind: z.enum(["original", "reprice", "cancel"]), transactionHash: Hex32, maxFeePerGas: PositiveAmount, maxPriorityFeePerGas: Amount, gas: PositiveAmount, signedAt: EpochSeconds })`. `AttemptResponse = z.strictObject({ approvalId: ApprovalId, walletId: WalletId, from: Address, attempt: TransactionAttempt, signedTransaction: Hex })`.
6. `ApprovalState` gains `attempts: z.array(TransactionAttempt)`: every attempt for a `signed` approval; for an `applied` cancel approval, the one attempt it produced; otherwise empty.
7. New `SignerErrorCode` values, all 403: `fee_not_raised`, `attempts_exhausted`, `reprice_window_closed`. Reuse `conflict` (409) for a wrong `attempt` number, `not_found` for an approval with no signature, `envelope_mismatch`, `intent_mismatch`, `fee_cap_exceeded`, `workspace_paused`, `nonce_reused`, `insufficient_approvals` as their names say.
8. Document in `docs/approval-protocol.md`: the new envelope kind (section 5); the reprice and cancel rules in the order the signer checks them (new section 8a, text as in Milestone 2); section 9 "what may vary" gains "after the first signature, only the two fee fields, and only upward"; a test vector for a `cancel-transaction` envelope challenge (section 11); the versioning note (section 12).

Acceptance:

- CI job `test` runs `bun run test`, which includes `packages/protocol/test/*.test.ts`; expect new cases to pass: "a cancel-transaction envelope with targetApprovalId equal to approvalId is invalid", "the cancel-transaction challenge matches its vector", "RepriceRequest refuses unknown members", "the client signs reprice and cancel requests like every other route".
- CI job `check` (`bun run check`, `bun run typecheck`) passes.

### Milestone 2: Signer attempts, reprice and cancel

Scope: the signer enforces every rule of this plan from its own state. Second because the control plane must not be able to work around it.

Files and interfaces:

- `apps/signer/src/db.ts`: new table `signature_attempts`.
- `apps/signer/src/signer.ts`: `reprice`, `cancelTransaction`, `attemptsOf`, changes to `getApproval`.
- `apps/signer/src/index.ts`: route both operations.
- `apps/signer/src/config.ts`: `SIGNER_MAX_TX_ATTEMPTS`, `SIGNER_REPRICE_WINDOW_SECONDS`.
- `apps/signer/test/repricing.test.ts`: new.

Work:

1.  Schema, additive (`CREATE TABLE IF NOT EXISTS`, so existing signer databases gain it on start):

        CREATE TABLE IF NOT EXISTS signature_attempts (
          approval_id TEXT NOT NULL REFERENCES signatures(approval_id),
          attempt INTEGER NOT NULL CHECK (attempt >= 1),
          kind TEXT NOT NULL CHECK (kind IN ('reprice', 'cancel')),
          tx_nonce INTEGER NOT NULL,
          gas TEXT NOT NULL,
          max_fee_per_gas TEXT NOT NULL,
          max_priority_fee_per_gas TEXT NOT NULL,
          -- The ceiling this attempt was checked against: min(intent, policy) for a reprice of
          -- the payment, the cancel envelope's maxFeeWei for a cancel and its reprices.
          fee_ceiling_wei TEXT NOT NULL,
          -- The cancel-transaction approval that first turned this approval into a cancel.
          cancel_approval_id TEXT REFERENCES approvals(approval_id),
          signed_transaction TEXT NOT NULL,
          transaction_hash TEXT NOT NULL,
          signed_at INTEGER NOT NULL,
          PRIMARY KEY (approval_id, attempt)
        ) STRICT;

    Attempt 0 stays the `signatures` row; its fee fields and gas are read by parsing `signatures.signed_transaction` with viem `parseTransaction`.
2. `attemptsOf(approvalId)`: attempt 0 from `signatures` plus rows of `signature_attempts` ordered by `attempt`. `latestAttempt` is the last.
3. `reprice(approvalId, request)` inside `decide(workspaceId, approvalId, "reprice", ...)`:
   1. `request.envelope.approvalId === approvalId`, type `approve-intent`; the `approvals` row exists with state `signed` and `envelope_digest === envelopeDigest(request.envelope)`, else `not_found` or `conflict`; `intentHash(request.intent) === request.envelope.intentHash`, else `intent_mismatch`.
   2. Workspace not paused (`workspace_paused`). `now − signatures.signed_at ≤ SIGNER_REPRICE_WINDOW_SECONDS`, else `reprice_window_closed`.
   3. In `transaction(db, ...)`: if a row with `attempt = request.attempt` exists with the same two fees, return it (replay); if it exists with other fees, or `request.attempt !== latest.attempt + 1`, `conflict`. If `request.attempt ≥ SIGNER_MAX_TX_ATTEMPTS`, `attempts_exhausted`.
   4. Both fees strictly above the latest attempt's, else `fee_not_raised`; tip ≤ fee cap, else `fee_cap_exceeded`.
   5. If the latest attempt is a cancel: rebuild `{ chainId, nonce, to: wallet.address, value: 0n, gas: 21000n, fees }` and require `21000 × maxFeePerGas ≤ latest.fee_ceiling_wei`; kind `cancel`, same `cancel_approval_id`. Otherwise: rebuild with `buildTransaction(intent, { nonce: signatures.tx_nonce, gas: attempt-0 gas, fees })`; require that every field of the rebuilt transaction except the two fees equals the parsed attempt 0 (else `internal`, logged; it cannot happen unless the store was altered); require `gas × maxFeePerGas ≤ min(intent.maxFeeWei, currentPolicy.fees.maxPerTxWei)`, else `fee_cap_exceeded`; kind `reprice`.
   6. Sign with the vault, check `isSignedBy`, insert the attempt, `allow()`. No `spends` row, no `used_nonces` row.
4. `cancelTransaction(approvalId, request)` inside `decide(workspaceId, cancelEnvelope.approvalId, "cancel-transaction", ...)`:
   1. Envelope type `cancel-transaction`, `targetApprovalId === approvalId`, workspace equal; the target has a `signatures` row whose `wallet_id`, `chain_id` and `tx_nonce` equal the envelope's, else `envelope_mismatch`.
   2. `priorOutcome(envelope, "applied") === "replay"` returns the stored cancel attempt.
   3. Wallet has a policy; `envelope.maxFeeWei ≤ policy.fees.maxPerTxWei`, else `fee_cap_exceeded`.
   4. `verify(authorization, workspaceId, policy.approvals.threshold, min(policy.approvals.ttlSeconds, maxIntentTtlSeconds))`. Paused workspaces are allowed (Decision Log).
   5. In `transaction(db, ...)`: replay check again; `assertApproversStillPresent`; `consumeNonce(envelope)`; attempt number rules as in 3.3 and 3.4; `21000 × maxFeePerGas ≤ envelope.maxFeeWei`; build the self-transfer; sign; `isSignedBy`; insert attempt with kind `cancel`, `cancel_approval_id = envelope.approvalId`, `fee_ceiling_wei = envelope.maxFeeWei`; `recordApproval(envelope, "applied")`; `allow()`. No spend change.
   6. A cancel when the latest attempt is already a cancel is allowed (a second person may raise its ceiling); it follows the same rules.
5. `getApproval`: fill `attempts` from `attemptsOf`; for an `applied` approval id that appears as `cancel_approval_id`, return that attempt and its hash as `transactionHash`.
6. Config: `SIGNER_MAX_TX_ATTEMPTS` integer 2 to 64, default 16; `SIGNER_REPRICE_WINDOW_SECONDS` integer 0 to 604800, default 86400 (0 turns automatic repricing off at the signer).

Acceptance (file `apps/signer/test/repricing.test.ts`, run by CI job `test`):

- "a reprice changes only the two fee fields: nonce, gas, to, value, data and chain equal the first signature" (parse both signed transactions).
- "refuses a reprice that does not raise both fees" (`fee_not_raised`).
- "refuses a reprice above the intent's fee ceiling, and above a policy fee cap lowered after signing" (`fee_cap_exceeded`).
- "refuses a reprice for an approval never signed, a revoked one, a different envelope, or a different intent" (`not_found`, `conflict`, `intent_mismatch`).
- "a repeated reprice returns the stored attempt; another reprice for the same attempt number is a conflict".
- "two concurrent reprices for one attempt number sign once" (`Promise.all`).
- "refuses beyond SIGNER_MAX_TX_ATTEMPTS and after SIGNER_REPRICE_WINDOW_SECONDS".
- "refuses a reprice while the workspace is paused; a cancel still signs".
- "a cancel signs a zero-value self-transfer at the approval's nonce with gas 21000, only with passkeys at the wallet threshold; refuses a wrong txNonce, a maxFeeWei above the policy cap, and a reused envelope nonce".
- "after a cancel, a reprice rebuilds the self-transfer, never the payment".
- "no reprice or cancel changes the spend ledger" (`getWallet().spent` before and after).
- "every allowed and refused reprice and cancel is in the decision log, and verify-log passes".
- "an attempt the vault signs wrongly is refused and nothing is recorded" (stub vault, same pattern as `apps/signer/test/hardening.test.ts`).

### Milestone 3: Control plane nonce holding, reconciliation and automatic repricing

Scope: the control plane keeps the nonce held, follows every attempt, and reprices on a schedule. Third because it calls the signer of Milestone 2.

Files and interfaces:

- `apps/server/src/db/schema.ts` and a generated migration `apps/server/src/db/migrations/0002_transaction_attempts.sql` (`bun run db:generate` in `apps/server`).
- `apps/server/src/execution/repricing.ts`: new; pure `nextFees`, and `repriceNow`.
- `apps/server/src/execution/intents.ts`: `reserveNonce`, `followUpIntent`, `intentDetail`.
- `apps/server/src/execution/chains.ts`: `latestNonce(chainId, address, blockTag)`.
- `apps/server/src/config.ts`: `REPRICE_AUTO`, `REPRICE_AFTER_SECONDS`, `REPRICE_BUMP_PERCENT`.
- `apps/server/test/execution/repricing.test.ts`: new, against Anvil.

Work:

1. Schema:
   - New table `os.transaction_attempts`: `approval_id` (references `transactions.approval_id`), `attempt` integer ≥ 1, `kind` (`reprice` | `cancel`), `hash`, `raw` bytea sealed at location `transactions.raw:<approvalId>:<attempt>`, `max_fee_per_gas` text, `max_priority_fee_per_gas` text, `gas` text, `cancel_approval_id` nullable, `created_at`; primary key `(approval_id, attempt)`. Attempt 0 stays in `transactions` (its `hash` and `raw`).
   - `transactions`: new columns `latest_attempt integer not null default 0`, `mined_attempt integer`, `stuck_reason text` (`fee_too_low` | `waiting_behind_nonce` | `fee_ceiling_reached` | `reprice_window_closed`), `last_broadcast_at timestamptz`. Status type gains `cancelled` (a cancel attempt was mined) and `superseded` (the nonce was used by a transaction that is none of ours).
   - `IntentStatusColumn` gains `voided`.
2. `reserveNonce`: count `stuck` with `signed` and `broadcast` (`intents.ts:672`). A nonce is free again only after `rejected` with `latest_attempt = 0` (v0.1 behaviour).
3. `nextFees({ latest, gas, ceilingWei, quote, bumpPercent })` in `repricing.ts`, pure: `tip = max(ceilDiv(latest.tip × (100 + bump), 100), latest.tip + 1, quote.tip)`; `fee = max(ceilDiv(latest.fee × (100 + bump), 100), latest.fee + 1, 2 × quote.baseFee + tip)`; if `gas × fee > ceilingWei` then `fee = ceilingWei / gas`; return `{ kind: "ceiling_reached" }` when `fee < ceilDiv(latest.fee × (100 + bump), 100)` or `fee < tip`; otherwise `{ kind: "fees", maxFeePerGas: fee, maxPriorityFeePerGas: tip }`. For a cancel, `gas = 21000` and the ceiling is the cancel's `maxFeeWei`; for the payment, `min(intent.maxFeeWei, mirrored policy fees.maxPerTxWei)`.
4. `repriceNow(ctx, approvalId, actor)` in `repricing.ts`: under `pg_advisory_xact_lock(hashtextextended('reprice:' || approvalId, 0))`, read the attempts, quote fees, call `nextFees`, call `ctx.signer.reprice` with `attempt = latest + 1` and the intent and envelope from `approvals.envelope`, store the attempt row and `latest_attempt`, write audit event `transaction.repriced` (actor `system` or the user), then broadcast it. Signer `conflict` means another caller won: re-read and return. `reprice_window_closed`, `attempts_exhausted`, `fee_cap_exceeded` set `stuck_reason` and stop automatic repricing for this approval.
5. `followUpIntent` for `broadcast` and `stuck`:
   1. Read the receipt of every attempt's hash (newest first). A receipt at `confirmations` depth ends it: mark `mined_attempt`; the transaction status becomes `confirmed` or `reverted` for attempt kinds `original` and `reprice`, `cancelled` for kind `cancel`; the intent becomes `confirmed`, `reverted` or `voided`.
   2. If no receipt: `latestNonce(chain, address, head − confirmations + 1)`. Greater than this nonce means the nonce was used by something else: status `superseded`, intent `failed` with `failureCode = "nonce_used_elsewhere"`. Less than this nonce means a lower nonce is unmined: `stuck_reason = waiting_behind_nonce`, no reprice.
   3. Equal: if `REPRICE_AUTO` and the latest attempt is older than `REPRICE_AFTER_SECONDS`, call `repriceNow(…, "system")`. Rebroadcast the newest attempt every `REBROADCAST_SECONDS` in both `broadcast` and `stuck` (v0.1 only rebroadcast in `broadcast`).
   4. `stuck` keeps its v0.1 meaning (not mined within `RECONCILE_TIMEOUT_SECONDS` of the first signature) and now carries `stuck_reason`. While stuck, the wait is `min(STUCK_POLL_SECONDS, time until the next automatic reprice is due)`.
   5. `chains.broadcast` stays as is; a "nonce too low" for an older attempt is expected once another attempt is mined and is resolved by step 1.
6. Config in `apps/server/src/config.ts`: `REPRICE_AUTO` boolean, default `true` (owner decision 1); `REPRICE_AFTER_SECONDS` integer 15 to 86400, default 180; `REPRICE_BUMP_PERCENT` integer 10 to 100, default 12.

Acceptance (file `apps/server/test/execution/repricing.test.ts`, run by CI job `test` against the test stack's Anvil):

- "a payment that cannot be mined is repriced and mined once": `anvil.setAutomine(false)`; approve and execute; follow up to `broadcast`; `anvil.setNextBlockBaseFeePerGas` above the attempt's fee cap; `anvil.mine`; receipt missing; advance the test clock past `REPRICE_AFTER_SECONDS`; follow up creates attempt 1; set base fee back; `anvil.mine`; follow up ends `confirmed` with `mined_attempt = 1`; `getTransactionCount` rose by one; recipient balance rose once.
- "the original mined after a replacement was signed ends confirmed once": after attempt 1, `anvil.dropTransaction(attempt1Hash)`, send attempt 0's raw, mine; ends `confirmed` with `mined_attempt = 0`.
- "a dropped transaction is rebroadcast while stuck": `anvil.dropTransaction`, follow up, `anvil.getTxpoolContent` holds the newest attempt.
- "a stuck transaction keeps its nonce: the next approval of the wallet gets the next nonce after the node dropped it" (regression for the v0.1 allocator).
- "a payment waiting behind a lower unmined nonce is not repriced" (`stuck_reason = waiting_behind_nonce`, no attempt row).
- "at the fee ceiling repricing stops and says so" (`stuck_reason = fee_ceiling_reached`).
- "a nonce used by another transaction ends superseded": `anvil.impersonateAccount` the wallet and send a self-transfer at the nonce; mine; intent `failed`, `nonce_used_elsewhere`.
- Unit, same file: "nextFees raises both fields by the bump, lifts a zero tip to at least 1 wei, and reports the ceiling".

### Milestone 4: Cancel approval kind, speed-up route, API, web and MCP reporting

Scope: give people the two actions and show everyone what happened. Fourth because it presents the behaviour of Milestones 2 and 3.

Files and interfaces:

- `packages/api/src/dto.ts`, `packages/api/src/routes.ts`: contract changes.
- `apps/server/src/execution/cancel.ts`: new `cancelTransactionKind()` handler; registered in `apps/server/src/execution/index.ts`.
- `apps/server/src/execution/routes.ts`: `speedUpIntent`, `requestCancelIntent`.
- `apps/server/src/mcp/gateway.ts`: `get_intent` output and tool text.
- `apps/web/src/routes/approval.tsx`, `apps/web/src/lib/statuses.ts`, `apps/web/src/components/common.tsx`, `apps/web/dev/fixture-server.ts`, `apps/web/test/journey.e2e.ts`, `apps/web/test/statuses.test.ts`.

Work:

1. Contract: `IntentStatus` gains `voided`. `IntentDetail.transaction` gains `attempts: TransactionAttemptView[]` (`attempt`, `kind`, `hash`, `maxFeePerGas`, `maxPriorityFeePerGas`, `status: "pending" | "mined" | "not_mined"`, `explorerUrl`), `minedAttempt`, `stuckReason`, `canSpeedUp`, `canCancel`; `hash` is the mined attempt's hash, else the newest; status enum gains `cancelled`, `superseded`. `ApprovalKind` gains `cancel-transaction`; `ApprovalSubject` gains `{ kind: "cancel-transaction", intentId, targetApprovalId, txNonce, maxFeeWei }`. Routes: `speedUpIntent: POST /api/v1/intents/:intentId/speed-up` returning `IntentDetail`; `requestCancelIntent: POST /api/v1/intents/:intentId/cancel-transaction` returning `ApprovalSummary`.
2. `speedUpIntent`: `requireMember(ctx, session, workspaceId, "approver")`; refuse unless the transaction is `broadcast` or `stuck`, the nonce is the next to mine, and the latest attempt is not already at the ceiling; then `repriceNow(ctx, approvalId, user)`. Two clicks race on the advisory lock and the signer's attempt number; the second returns the same detail.
3. `requestCancelIntent`: approver role; transaction `broadcast` or `stuck`; opens a `cancel-transaction` approval through the engine with `subjectId = intentId`, `threshold = wallet policy threshold`, envelope `{ targetApprovalId, walletId, chainId, txNonce, maxFeeWei }` with `maxFeeWei = mirrored policy fees.maxPerTxWei`, expiry from the policy TTL. One open cancel per intent: a second request returns the open one.
4. `cancelTransactionKind()`: `title` "Cancel payment: <title of the intent>"; `describe` shows the payment, its nonce, the attempts so far and the fee ceiling; `execute` quotes fees, picks the first fee pair above the latest attempt with `nextFees` (gas 21000, ceiling `maxFeeWei`), calls `ctx.signer.cancelTransaction`, stores the attempt on the target's `transaction_attempts`, broadcasts it, writes audit `transaction.cancel_signed`. A signer `conflict` (an automatic reprice won the attempt number) re-reads and retries inside the step. No follow-up of its own: the target's run reconciles.
5. MCP: `get_intent` returns the attempts and `stuckReason`; `TERMINAL` gains `voided`; `APPROVAL_NOTE` says a stuck transaction may be repriced or cancelled by people and can still become `confirmed`, `reverted` or `voided`. `MCP_TOOL_NAMES` is unchanged.
6. Web: `intentSentence.voided` "A person cancelled it after it was sent. A zero-value transaction took its place. Nothing moved; a network fee was paid."; `stuck` sentence names the reason; `transactionSentence` gains `cancelled` and `superseded`; badge label `voided` "Cancelled on chain". The approval page lists attempts (kind, fee per gas in gwei, hash link, mined or not), shows "Speed up" when `canSpeedUp` and "Cancel payment" when `canCancel`, and says plainly that a cancel is an attempt that fails if the payment is mined first. The cancel approval card renders like every approval card and goes through the passkey ceremony.
7. Fixture server: an intent with two attempts, a speed-up endpoint, and a cancel approval.

Acceptance:

- `apps/server/test/execution/repricing.test.ts` (CI `test`) gains: "a cancel approved with a passkey ends voided, the recipient is unchanged, and the spend still counts" (`ctx.signer.getWallet().spent`); "speed-up needs an approver, and two concurrent clicks create one attempt"; "a second cancel request returns the open one".
- `apps/server/test/execution/mcp.test.ts` (CI `test`): "get_intent shows every attempt and the agent has still exactly seven tools".
- `apps/web/test/statuses.test.ts` (CI `test`): every new status has a sentence and a label (the typed records already fail the type check otherwise).
- `apps/web/test/journey.e2e.ts` (CI `ui`): step "a stuck payment shows its attempts, speeds up, and a cancel goes through a passkey", with screenshots at the three viewports the journey already uses.

### Milestone 5: Real-stack release gate and documents

Scope: prove the whole path on the real stack and bring the documents in line.

Files and interfaces:

- `e2e/test/release-gates.spec.ts`: two new gates.
- `docs/threat-model.md`, `docs/architecture.md`, `docs/approval-protocol.md`, `README.md` (status words only if it lists them), `specs/agent-workspaces-v0.1.md` (Revision Notes pointing here).

Work:

1. Gate "a stuck payment is repriced under its approval and mined exactly once": with `chainAdmin` (Anvil test client on `E2E_ANVIL_URL`), turn automine off, approve a payment with the software passkey, raise the next base fee above its fee cap, wait for an automatic reprice (the e2e stack sets `REPRICE_AFTER_SECONDS=15`), restore the base fee, mine, and assert one confirmed transaction, the nonce up by one, and two attempts in `GET /api/v1/intents/:id`.
2. Gate "a cancelled payment moves nothing": same setup, request a cancel, approve it with the passkey, mine, assert `voided`, recipient unchanged, nonce up by one.
3. Threat model: replace "Repricing under an existing approval is not designed" (`docs/threat-model.md:245-247`) with the section of this plan, update "Code execution in the control plane" and "Out of scope".

Acceptance:

- CI job `stack` (amd64, arm64, tls) passes both new gates through `./e2e/run.sh`.
- `bun run check` passes on the edited Markdown (Biome formats only code; the docs are reviewed by reading).

## Interfaces and Dependencies

Local interfaces:

- `SignerCore.reprice(approvalId: ApprovalId, request: RepriceRequest): Promise<AttemptResponse>`:
  - Inputs: target approval id; the original intent and `approve-intent` envelope; the attempt number to create; two fee fields as decimal strings.
  - Outputs: the new (or replayed) attempt and its signed bytes.
  - Failures: `not_found`, `conflict` (409), `intent_mismatch`, `workspace_paused`, `reprice_window_closed`, `attempts_exhausted`, `fee_not_raised`, `fee_cap_exceeded`, `vault_error` (500, retryable), `internal`. Every refusal for a known workspace is a decision-log entry with action `reprice`.
- `SignerCore.cancelTransaction(approvalId: ApprovalId, request: CancelTransactionRequest): Promise<AttemptResponse>`:
  - Inputs: target approval id; an authorization over a `cancel-transaction` envelope; attempt number; fees.
  - Outputs: the cancel attempt.
  - Failures: as above plus `envelope_mismatch`, `envelope_expired`, `nonce_reused`, `insufficient_approvals`, `assertion_invalid`, `approver_unknown`, `policy_missing`. Decision-log action `cancel-transaction`, approval id of the cancel approval.
- `SignerClient.reprice`, `SignerClient.cancelTransaction` (`packages/protocol/src/signer/client.ts`): HMAC-signed `POST`s; parse `AttemptResponse`; throw `SignerError` with the code.
- `nextFees(input): { kind: "fees"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { kind: "ceiling_reached" }` (`apps/server/src/execution/repricing.ts`): pure, bigint only.
- `repriceNow(ctx: AppContext, approvalId: ApprovalId, actor: { type: "system" } | { type: "user"; id: UserId }): Promise<"repriced" | "lost_race" | "not_due" | StuckReason>`.
- `ChainAccess.latestNonce(chainId: ChainId, address: Address, blockNumber: bigint): Promise<number>`: `getTransactionCount` at that block; throws `ChainError("rpc_unavailable")` on RPC failure, never returns a guess.

External dependencies:

- `viem` 2.57.19 (`apps/server/package.json:28`, `apps/signer/package.json:25`):
  - Version/source checked: `node_modules/.bun/viem@2.57.19+e401cb34621fadb3`.
  - Expected behavior: `parseTransaction` and `serializeTransaction` for EIP-1559; test actions `setAutomine` (`evm_setAutomine`), `mine`, `dropTransaction` (`anvil_dropTransaction`), `setNextBlockBaseFeePerGas`, `getTxpoolContent`, `impersonateAccount`.
  - Failure handling: an RPC error is `ChainError`, never read as "missing".
- Anvil in `ghcr.io/foundry-rs/foundry:stable@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46` (`compose.yaml:146-149`, `deploy/compose.test.yaml:21-23`):
  - Version/source checked: foundry `master` source only (report F7.5); the version in the digest is not checked.
  - Expected behavior: replacement needs a strictly higher `maxFeePerGas`; admission refuses a fee cap below the current base fee; `anvil_dropTransaction` removes one pooled transaction. Whether the miner skips a pooled transaction whose fee cap is below a raised base fee is not checked; if it does not, the first server test keeps automine off and simply does not mine until after the reprice.
  - Failure handling: tests that need the 10% rule are unit tests of `nextFees`, not Anvil tests.
- Node replacement rules (go-ethereum `legacypool`, reth `transaction-pool`), report F7.1 to F7.3: `REPRICE_BUMP_PERCENT` default 12 exceeds their 10.

## Concrete Steps

From the branch checkout's repository root:

    rg -n "\"signed\", \"broadcast\"" apps/server/src/execution/intents.ts
    rg -n "stuck" packages/api/src apps/server/src apps/web/src
    (cd apps/server && bun run db:generate)
    bunx vitest run apps/signer/test/repricing.test.ts
    bunx vitest run packages/protocol/test/schemas.test.ts packages/protocol/test/digests.test.ts
    bun run --filter @askgina/os-signer typecheck
    bun run check

`apps/server/test/execution/repricing.test.ts`, the web journey and the release gates need the test stack (Postgres, Anvil) and run in CI only.

Expected evidence:

    ✓ apps/signer/test/repricing.test.ts (13 tests)
    ✓ apps/server/test/execution/repricing.test.ts (11 tests)
    ✓ e2e release gates: "a stuck payment is repriced under its approval and mined exactly once"

## Validation and Acceptance

Automated validation:

- CI `check`: `bun run check` and `bun run typecheck` pass.
- CI `test`: the protocol, signer, server and web cases named in Milestones 1 to 4 pass, with the existing count plus the new ones.
- CI `ui`: the journey step for attempts, speed-up and cancel passes.
- CI `stack` (amd64, arm64, tls): both new release gates pass.

Manual or runtime validation:

- Start: `docker compose --profile dev up` from the repository root, as in the README quickstart.
- Exercise: `cast rpc evm_setAutomine false` against the dev Anvil, have the scripted agent propose a payment, approve it, `cast rpc anvil_setNextBlockBaseFeePerGas <above its fee cap>`, `cast rpc evm_mine`, wait for `REPRICE_AFTER_SECONDS`, restore the base fee, `cast rpc evm_mine`.
- Observe: the approval page lists two attempts and marks the second mined; the signer's decision log (`verify-log` on the signer host) shows one `sign` and one `reprice`; `cast nonce <wallet>` rose by one.

Regression checks:

- Every existing signer test, including "lets a new approval use an account nonce again, but never re-signs for one approval" (`apps/signer/test/signing.test.ts:228`), still passes: the first signature's rules do not change.
- "keeps rebroadcasting, then ends a transaction the chain never took and frees its nonce" (`apps/server/test/execution/hardening.test.ts:428`) still passes: `rejected` with no later attempt still frees the nonce.
- "never calls a transaction stuck during an RPC outage, and confirms a stuck one later" (`hardening.test.ts:477`) still passes.
- The release gate "a crash after the approval and before the broadcast still ends in exactly one transaction" still passes.

## Idempotence and Recovery

- The signer schema change is `CREATE TABLE IF NOT EXISTS`; starting a new signer on an old database adds the table and nothing else. Starting an old signer on a new database ignores the table, so a rollback of the signer image is safe; attempts made meanwhile stay recorded and their transactions stay valid.
- Migration `0002_transaction_attempts.sql` only adds a table, nullable columns and columns with defaults; it is safe to apply once by the server's migrator. Backing it out after use would lose attempt rows; instead, set `REPRICE_AUTO=false` and `SIGNER_REPRICE_WINDOW_SECONDS=0` to stop new reprices while keeping the record.
- `repriceNow` is idempotent: the advisory lock serializes callers and the signer's attempt number makes a retry of the same request return the same attempt. A crash after the signer signed and before the attempt row was stored is recovered on the next call: the signer answers `conflict` for `latest + 1` with different fees, so `repriceNow` reads the attempts (with their fees) from `getApproval`, repeats the reprice request for the missing attempt with exactly those fees, which the signer answers as a replay with the signed bytes, and stores it before continuing.
- A cancel approval's execute step retries like `executeStep` (12 retries); a repeated request with the same envelope returns the stored cancel attempt.
- Backout of the whole feature: `REPRICE_AUTO=false`, `SIGNER_REPRICE_WINDOW_SECONDS=0`, and hide the two UI actions behind `canSpeedUp` and `canCancel` returning false. Reconciliation across attempts stays on, because attempts already signed may still be mined.

## Rollout and Operations

- Feature flags/config/env vars: server `REPRICE_AUTO` (default `true`), `REPRICE_AFTER_SECONDS` (180), `REPRICE_BUMP_PERCENT` (12); signer `SIGNER_MAX_TX_ATTEMPTS` (16), `SIGNER_REPRICE_WINDOW_SECONDS` (86400). Add them to `compose.yaml`, `deploy/README.md` and the e2e Compose overlay (`e2e/compose.e2e.yaml`, `REPRICE_AFTER_SECONDS=15`).
- Migration/backfill steps: server migration 0002 runs on boot as today; signer table is created on start. Deploy the signer first, then the server: an old server never calls the new routes; a new server against an old signer gets 404 on reprice, logs it, does not reprice, and keeps reconciling the first attempt as v0.1 does until the signer is upgraded.
- Monitoring/alerts/logs: signer decision-log actions `reprice` and `cancel-transaction` with outcome and code; server log lines `transaction repriced` (approval id, attempt, no fees in plaintext logs beyond what the chain shows) and audit events `transaction.repriced`, `transaction.cancel_signed`; healthy is few reprices per payment (typically 0 or 1) and no `attempts_exhausted`.
- PR/branch workflow: one branch per milestone or one stacked series; each PR green on all six CI jobs before merge; no public flip implied.

## Risks and Open Questions

- Risk: the control plane, if compromised, can burn fees up to the approved ceiling on every approval by repricing.
  Mitigation: the ceiling is the person's own `maxFeeWei`, already spendable in v0.1 at first signing; policy `fees.maxPerTxWei` bounds it; the decision log shows every reprice.
- Risk: an older attempt is mined by a node that never saw the newer ones; or, after a cancel, the payment is mined first.
  Mitigation: all attempts are one operation or its cancel at one nonce, so at most one lands; reconciliation reads every hash; the UI says a cancel is an attempt, not a guarantee.
- Risk: a reorg swaps which attempt is mined (payment versus cancel) before `confirmations`.
  Mitigation: an outcome is final only at `confirmations` depth (v0.1 rule); operators of chains with deep reorgs raise it.
- Risk: replacement rules differ on Besu, Nethermind, L2 sequencers and private relays (report Limits).
  Mitigation: the signer requires only "strictly higher"; the bump is configurable; a refused replacement leaves the earlier attempt valid.
- Risk: a reprice happens after an approver was removed or the policy changed, without a new passkey.
  Mitigation: a reprice can change only fees, under the lower of the two ceilings, inside a window; the person can cancel with a passkey.
- Risk: a cancel approval is shown for one payment and approved for another (trusted-display gap, ticket #20).
  Mitigation: the signer checks the target's wallet, chain and nonce; the cost is one cancel fee within the policy cap; nothing moves.
- Open question (owner decision 1): who may trigger a reprice. Recommended: automatic by the control plane plus an approver's "Speed up" without a passkey; no agent tool. This plan is written for that; `REPRICE_AUTO` and the speed-up route are the switches.
  Owner/next step: owner.
- Open question (owner decision 2): how a cancel is authorized. Recommended: a `cancel-transaction` envelope at the wallet policy's threshold. Milestones 1, 2 and 4 depend on it.
  Owner/next step: owner.
- Open question (owner decision 3): how long the control plane may reprice without a person. Recommended: 24 hours after the first signature (`SIGNER_REPRICE_WINDOW_SECONDS=86400`).
  Owner/next step: owner.
- Open question (owner decision 4): whether a landed cancel releases the daily-cap spend. Recommended: no; it ages out of the 24-hour window.
  Owner/next step: owner.
- Open question (owner decision 5): whether a new envelope kind is additive within protocol v1 or requires v2. Recommended: additive in v1, because no existing structure changes shape or meaning and a v1 verifier that does not know the kind refuses it; record the clarification in `docs/approval-protocol.md` section 12.
  Owner/next step: owner.

### Threat model after this change

A compromised control plane (code execution in the server) **can**:

- Choose when and how far to raise fees, up to `min(intent.maxFeeWei, policy fees.maxPerTxWei)`, for any approval it holds, within `SIGNER_REPRICE_WINDOW_SECONDS` and `SIGNER_MAX_TX_ATTEMPTS`. Cost: up to the approved fee ceiling per approval, as in v0.1.
- Obtain up to `SIGNER_MAX_TX_ATTEMPTS − 1` extra signatures of an approved operation, all at its one nonce. At most one can be mined.
- Show a misleading cancel card and obtain a passkey cancel of a different unmined payment in the same workspace. Effect: that payment does not happen; cost: one cancel fee within the policy cap.
- Withhold broadcasts, or give a second approval the same nonce so that both void each other (both already possible in v0.1).

It **cannot**:

- Change the nonce, gas limit, recipient, value, calldata or chain of an approved operation; the signer rebuilds every attempt from its own record and the approved intent.
- Get any signature of an approved operation at a second nonce, so the operation can never be mined twice.
- Get a reprice of an approval the signer never signed, or of an approval with a different envelope or intent.
- Get a cancel without passkey assertions from current approvers at the wallet's threshold.
- Turn a cancel back into the payment: after a cancel attempt, the signer builds only self-transfers.
- Add or release daily-cap spend, or raise fees above the lower of the intent's and the policy's ceiling.
- Reprice while the workspace is paused.

The invariant holds: the signer decides from its own state that people approved the operation (or its cancel), and signs only that operation, varying only the two fee fields under the ceiling they approved.

## Artifacts and Notes

The two rules this plan rests on, from source:

    go-ethereum core/txpool/legacypool/list.go, list.Add:
      if old.GasFeeCapCmp(tx) >= 0 || old.GasTipCapCmp(tx) >= 0 { return false, nil }
      thresholdFeeCap = oldFC * (100 + priceBump) / 100; thresholdTip = oldTip * (100 + priceBump) / 100
    legacypool.go DefaultConfig: PriceBump: 10, Lifetime: 3 * time.Hour

    apps/server/src/execution/intents.ts:665-674 (v0.1 allocator):
      inArray(transactions.status, ["signed", "broadcast"])   // stuck is not held

## Revision Notes

- 2026-11-14: Draft created from the research report for ticket #22. Nothing built.
