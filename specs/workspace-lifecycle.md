# Clone, export and delete a workspace whose wallets hold assets

- Branch: main (private), one milestone at a time
- Status: In progress (owner decisions taken 2026-11-15; Milestone 1 built, CI pending)
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-15
- Links: [Ticket #23](https://github.com/askgina/os/issues/23) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](./research/workspace-lifecycle.md) | [v0.1 ExecPlan](./agent-workspaces-v0.1.md) | [Trusted display](./trusted-display.md) | [Mandates](./approval-mandates.md) | [Notifications](./approval-notifications.md) | [Stuck transactions](./stuck-transaction-repricing.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

A workspace can be created, paused, and its wallets emptied by a person (the sweep, built). It
cannot be ended. A person who is done with a workspace has no way to stop its keys from existing,
and no record to take away. This plan adds the rest of the lifecycle:

- **Sweep** a wallet (built, see `Progress`): a person moves the whole balance of one asset to an
  address the approvers already allowed, with passkeys at the workspace's admin threshold. No
  agent is needed and the wallet's caps do not apply.
- **Retire** a wallet: the wallet signs nothing from the moment people approve it, its mandates
  end, and the signer destroys its key after a delay the control plane cannot shorten.
- **Delete** a workspace: the same, for every wallet at once, followed by shredding the
  workspace's data key and the keys of all its workflow runs, and a tombstone.
- **Export** a workspace: a template (configuration, no secrets) and a record (the opened audit
  log with its hash chain, intents, transactions, mandates and their uses, and the signer's
  decision log), verifiable offline.
- **Clone** a workspace from a template: fresh wallets, fresh tokens, policies proposed for the
  new workspace's approvers to approve. No mandate is carried over.

Disabling an agent is already final and already ends its mandates (built with mandates). This
plan adds only that disabling also cancels the agent's waiting payment requests (see D12).

The rule from v0.1 stays: the signer decides whether people approved, and does only what they
approved. Destroying a key is treated like signing: people approve it on the signer's own
confirmation page, which shows the exact wallets and the destroy time from the signer's records;
the signer verifies the passkey assertions itself, against its own approver registry, and
enforces a delay the control plane cannot shorten.

Non-goals: copying or moving a key between workspaces; exporting a key over HTTP; a per-workspace
encrypted backup; erasing data from backups the operator keeps; operations that are not EVM
transfers; batching several assets into one sweep approval (mandates cover agent payments, not
sweeps); repricing or cancelling a stuck transaction (its own plan,
[#22](https://github.com/askgina/os/issues/22), being built).

Success means:

- An approver deletes a workspace from the UI and approves it on the signer's confirmation page,
  which lists every wallet and address and the destroy time. Until the delay ends, any member can
  cancel. After it, the signer refuses every request for that workspace, the OWS vault holds no
  file for its wallets, no mandate of it is live, and no sealed column or workflow payload of that
  workspace can be opened.
- After a deletion and a keyring rotation, a copy of the database taken before the deletion
  cannot be opened with the current keyring. The same copy opens with the old keyring: backups
  hold deleted data until their keyring copies expire, and the deploy guide says so.
- An exported record verifies offline, and editing any line of it makes verification fail.
- A clone has no key, intent, approval, mandate, transaction, audit entry or workflow run of its
  source.

## Progress

- [x] (2026-11-14 21:30Z) Research: what a workspace owns, what v0.1 can do, what the signer can and cannot see. See the report.
- [x] (2026-11-14 21:30Z) Draft this plan with recommended options; owner decisions listed under Risks and Open Questions.
- [x] (2026-11-15) Owner decisions D1-D12 taken and recorded in the Decision Log. D3 by the owner (2026-11-14): allowlist or own treasury. D1, D2 and D4-D12 by the lead under Eric's delegation ("delegate to you on decisions like a CTO"), each the recommended option. D6 still owes counsel review, flagged for Eric.
- [x] (2026-11-14) The sweep, built ahead of the milestones as a fix to v0.1 (a wallet whose agent was removed or disabled could not be emptied): the `Sweep` structure and `sweep-wallet` envelope (protocol), `POST /v1/wallets/:walletId/sweep` (signer), the `sweep-wallet` approval kind and `requestSweep` route on the shared signing path (server, `apps/server/src/execution/sweeps.ts`, `transactions.ts`), "Empty this wallet" and the sweep approval card (web), and a release gate. Proven locally, one file at a time: `packages/protocol/test/digests.test.ts`, `schemas.test.ts`, `signer-client.test.ts`; `apps/signer/test/sweep.test.ts`; `packages/api/test/api.test.ts`; `apps/server/test/execution/sweep.test.ts` on Anvil; `apps/web/test/sweep.test.ts`. Retire, delete, export and clone are not built.
- [ ] The sweep in CI: the release gate "a person empties a disabled agent's wallet to the treasury while paused, and the signer refuses any other destination" in `e2e/test/release-gates.spec.ts` (`stack (amd64)`, `stack (arm64)`), and the `ui` job with the new card. Written and type-checked, not run. No browser journey covers the card yet.
- [x] (2026-11-15) Re-checked against main (`2911c20`). The sweep is proven in CI: its release gate (`e2e/test/release-gates.spec.ts:686`) passed in `stack (amd64)` of run 43710836888 on `98cc6a1`, all six jobs green, and the `ui` journey now covers the sweep card (`apps/web/test/journey.e2e.ts:445-466`). Trusted display, the v0.1 defect fixes, mandates and notifications landed since the draft; the milestones below are rewritten for them, D3 is delivered, D8-D12 are new. Nothing else of this plan is built.
- [x] (2026-11-15) Milestone 1: protocol. Local checks only, CI pending. `retire-wallet` and `delete-workspace` envelopes with `WalletRef` and `walletsToDestroy`; their confirmation views and the warnings `keys_destroyed`, `balances_unchecked`; six signer routes and client methods; lifecycle `state` and `destroyAfter` on `WorkspaceState` and `WalletState`, `minDestroyDelaySeconds`; six error codes; `docs/approval-protocol.md` §5, §8, §10, §11, §12. Proven locally, one file at a time: `packages/protocol` `tsc --noEmit`; `test/lifecycle-envelopes.test.ts` (23), `confirmation.test.ts` (59), `signer-client.test.ts` (23), `digests.test.ts` (150), `verify-authorization.test.ts` (35), `schemas.test.ts` (54); `tsc --noEmit` clean in `apps/signer`, `apps/approve`, `apps/server`, `apps/web`, `e2e`, `packages/api`; `apps/approve/test/app.test.ts`, `apps/signer/test/confirmations.test.ts`, `apps/signer/test/governance.test.ts` pass. Compile-keeping edits outside the protocol are listed under `Surprises & Discoveries`.
- [x] (2026-11-15) Milestone 2: signer. Local checks only, CI pending. Schema version 7
      (`apps/signer/src/db.ts`, with `secure_delete` on); `apps/signer/src/lifecycle.ts`
      (`createLifecycleOperations`: retire, cancel and finalize of a wallet, delete, cancel and
      finalize of a workspace, `exportWalletByOperator`, and `refusal`, the lifecycle rules shared by
      applying and the confirmation page); `SIGNER_MIN_DESTROY_DELAY_SECONDS` (default 604800, 0 to 7776000) and `SIGNER_MAX_DESTROY_DELAY_SECONDS` (default 7776000, 1 to 31536000, at least the
      minimum; an empty value is unset); `Vault.destroyWallet`, `exportOwsWalletSecret`;
      `admin.ts export-wallet`; the six routes; every refusal of the plan; the Milestone 1
      placeholders replaced. Proven locally, one file at a time: `apps/signer` and `apps/server`
      `tsc --noEmit`; `apps/signer/test/lifecycle.test.ts` (9, the version 6 to 7 migration
      included), `confirmations.test.ts` (17), `admin.test.ts` (5), `ows.test.ts` (2, real OWS
      1.4.5), `config.test.ts` (8), and unchanged in behavior `fence` (10), `mandates` (16),
      `repricing` (17), `signing` (32), `sweep` (7), `governance` (15), `hardening` (8),
      `possession` (6). Not run: the release gates (`stack`), which start the signer image at
      version 7.
- [ ] Milestone 3: key store. Not started (left for the next agent).
- [ ] Milestone 4: control plane, sweep, retire, delete, remove agent.
- [ ] Milestone 5: export and clone.
- [ ] Milestone 6: web UI.
- [ ] Milestone 7: release gates and documentation.
- [ ] Milestone 8: erasing a person (in scope by D6; counsel review still owed).

## Surprises & Discoveries

- Observation: in v0.1 only agents can move funds. `Intent.agentId` is required and the policy
  must list the agent in `requesters`. A wallet whose agent is gone cannot be emptied at all.
  Evidence: `packages/protocol/src/intent.ts:80-94`, `packages/protocol/src/evaluate.ts:38-40`.
  Update (2026-11-15): resolved by the sweep (`sweep-wallet`), proven in CI.
- Observation: the signer cannot see balances. It has no network path to a chain. "Refuse while
  assets remain" can only be advisory at the control plane.
  Evidence: report, finding 4.
- Observation: a signed transaction that was never mined stays valid after its key is destroyed,
  and nobody can replace it. Anyone with a copy can broadcast it later.
  Evidence: report, finding 5; `apps/signer/src/db.ts:71-80` keeps signed transactions in plaintext.
  Update (2026-11-15): a transaction the control plane marks `rejected` ("never accepted and no
  longer offered: its nonce is free again", `apps/server/src/execution/transactions.ts:306-310`)
  is also still valid until another transaction uses its nonce; see D7.
- Observation: a full backup set taken before a deletion restores the deleted workspace readable.
  Evidence: report, finding 6.
  Update (2026-11-15): the contradiction the draft found is gone. `deploy/README.md:118-134` and
  `packages/keys/README.md:72-75` now agree: back up the database and the keyring together, from
  the same moment, encrypted, and apart if you can. Milestone 7 only adds the erasure window.
- Observation: shredding a run key while its run is waiting makes the run retry forever.
  Evidence: `docs/threat-model.md:497-499`; report, finding 10.
- Observation: the signer's SQLite schema has no migration step; every table is
  `CREATE TABLE IF NOT EXISTS`. Adding columns needs one.
  Evidence: `apps/signer/src/db.ts:9-115` (as drafted).
  Update (2026-11-14): the restore fence added `PRAGMA user_version` migrations.
  Update (2026-11-15): main is at version 5 (2 restore fence, 3 confirmation pages, 4 possession
  challenges, 5 mandates; `apps/signer/src/db.ts:205-206`), and stuck-transaction repricing, being
  built, takes version 6. Milestone 2's lifecycle columns take the next free version: 7 if
  repricing lands first.
- Observation: an envelope is stored unencrypted in `approvals.envelope`, and the release gates
  scan the database for recipient addresses in the clear. A `sweep-wallet` envelope that carried
  `to` and `amount` as fields, as Milestone 1 first drafted it, would put a destination and an
  amount at rest in plaintext.
  Evidence: `apps/server/src/db/schema.ts:319-320`, `approvals.envelope` ("Identifiers, hashes and
  times only"); `e2e/test/release-gates.spec.ts:629`, "what an agent typed is in no column of the
  database in the clear".
- Observation (2026-11-15): a disabled agent is already final. No route turns it back on, and
  `rotateAgentToken` refuses it (`apps/server/src/directory/routes.ts:676-680`). Disabling now
  revokes the agent's mandates at the signer and cancels its waiting `grant-mandate` requests
  (`routes.ts:701-746`, `apps/server/src/execution/mandates.ts:574-611`; gate
  `release-gates.spec.ts:1428`). It does not cancel the agent's waiting payment requests. A
  separate `removed` status, as drafted, adds nothing; see D12.
- Observation (2026-11-15): the signer now keeps plaintext that people or agents typed, outside
  the workspace key: each confirmation's envelope and subject (an intent with its memo, a policy,
  a sweep, a mandate) in `confirmations`, the assertions made on the page in
  `confirmation_assertions`, and each mandate's canonical JSON, purpose included, in
  `mandates.mandate` (`apps/signer/src/db.ts:117-202`). Shredding the workspace key leaves all of
  it readable on the signer host. The mandate tables are append-only by design ("Nothing is ever
  deleted from these tables", `db.ts:160-166`). See D9.
- Observation (2026-11-15): approvals are no longer made in the web app. Every envelope kind is
  approved on the signer's confirmation page (`APPROVE_ORIGIN`, served by the keyless `approve`
  service), whose lines and warnings the signer renders from its own records
  (`packages/protocol/src/confirmation.ts`, `renderConfirmation`). The trusted-display gap the
  draft's threat model listed for deletion is closed for everything the signer knows: the wallet
  set, addresses and destroy time. Balances stay outside it.
- Observation (2026-11-15): `appendAudit` locks the workspace row `FOR NO KEY UPDATE`
  (`apps/server/src/audit.ts:55-70`). A `FOR UPDATE` taken after inserting rows that refer to
  the workspace deadlocked concurrent proposals. The tombstone transaction in Milestone 4 must
  append its audit event first and must not take a stronger lock on `workspaces`.
- Observation (2026-11-15): stuck-transaction repricing landed on main (`8be9bd5`): the signer is
  at schema version 6 (`signature_attempts`, whose rows carry `signed_transaction` and no
  `wallet_id`), the `cancel-transaction` envelope exists, and the server's migrations run to
  `0007_transaction_attempts.sql`. So Milestone 2 takes signer version 7 and Milestone 4 the
  server migration `0008`; Milestones 2 and 4 below say so.
  Evidence: `apps/signer/src/db.ts:214-241`, `apps/server/src/db/migrations/`.
- Observation (2026-11-15): Milestone 1 cannot land alone without touching the signer and the
  `approve` page. `SignerErrorCode` is exhausted by `MESSAGES` in `apps/signer/src/errors.ts` and
  `REFUSAL_TEXT` in `apps/approve/public/approve.js` (type-checked JS); `ConfirmationWarning` by
  `WARNING_TEXT` there; `RenderInput` is built in `apps/signer/src/confirmations.ts` and
  `apps/approve/test/app.test.ts`; and the strict `WorkspaceState` and `WalletState` the client
  parses need the signer to send the new fields. Compile-keeping edits made with Milestone 1, for
  Milestone 2 to replace or keep:
  - `apps/signer/src/errors.ts`: a fixed message for each of the six new codes.
  - `apps/signer/src/signer.ts`: `workspaceState` reports `state: "active"`, `destroyAfter: null`
    and `minDestroyDelaySeconds` from a constant `MIN_DESTROY_DELAY_SECONDS = 604_800` (the D2
    default); `walletState` reports `state: "active"`, `destroyAfter: null`. Milestone 2 reads
    both from the new columns and the constant from `SIGNER_MIN_DESTROY_DELAY_SECONDS`.
  - `apps/signer/src/confirmations.ts`: `RenderInput.wallets` is the signer's record of each
    wallet `walletsToDestroy(envelope)` lists, when held in the envelope's workspace. The signer
    already opens and renders a confirmation for the two new kinds (at the admin threshold, as
    `rulesFor` gives every kind without a policy); what it lacks is their `superseded` rule.
  - `apps/approve/public/approve.js`: text for `keys_destroyed`, `balances_unchecked` and the six
    codes (Milestone 6 may reword); `apps/approve/test/app.test.ts`: `wallets: []`.
    Update (2026-11-15, Milestone 2): the signer's placeholders are replaced. The messages in
    `errors.ts` stay as written; `workspaceState` and `walletState` read the version 7 columns
    and `SIGNER_MIN_DESTROY_DELAY_SECONDS`; `RenderInput.wallets` was already the real record;
    `supersededBy` gains the lifecycle rules through `SignerRecords.lifecycleRefusal`.
- Observation (2026-11-15, Milestone 2): cancelling a deletion cannot put "every wallet back to
  `active`" as drafted: a `held` wallet would then sign again after `resume-workspace` without
  the new policy `held` requires, and no passkey approves a cancel. Version 7 therefore adds
  `wallets.state_before_delete` (`active` or `held`): applying a deletion records what it found,
  a wallet already `retiring` on its own recorded as `held`, and cancelling restores exactly
  that. `docs/approval-protocol.md` §8 ("back to `active`") needs this wording.
  Evidence: `apps/signer/src/lifecycle.ts` (`deleteWorkspace`, `cancelDeleteWorkspace`),
  `lifecycle.test.ts` "pauses and stops every change while it waits".
- Observation (2026-11-15, Milestone 2): every approval is made on the confirmation page, so
  "opening a confirmation is refused while `deleting`" would also block the `cancel-transaction`
  D7 relies on. The signer opens a `cancel-transaction` confirmation while the deletion waits,
  and nothing else; `docs/approval-protocol.md` §8 lists opening a confirmation without that
  exception. Revoking an approval and pausing stay allowed while `deleting` (they remove
  authority); a `deleted` workspace answers only `getWorkspace`, `listDecisions`, a repeat of
  its finalize and a repeat of its own deletion envelope.
- Observation (2026-11-15, Milestone 2): details the plan left open, as built.
  - `cancelRetireWallet` is `workspace_deleting` while the workspace is being deleted (the
    deletion decides for every wallet); `setPolicy` is `wallet_retired` for a `retiring` or
    `destroyed` wallet and makes a `held` one `active`; `retireWallet` on a `retiring` or
    `destroyed` wallet is `wallet_retired` (protocol §8), and `conflict` is kept for cancel and
    finalize in the wrong state.
  - A repeat of a signed approval (`sign`, `sweep`, a mandate use, a reprice, a cancel) still
    returns what was signed while the wallet is `retiring`; once its key is destroyed the signed
    bytes are emptied and the repeat is `wallet_retired`. `getApproval` of such an approval keeps
    `transactionHash` and reports `attempts: []`.
  - Decision log: applying records `retire-wallet` or `delete-workspace` under the approval id;
    `cancel-retire-wallet`, `cancel-delete-workspace`, `destroy-wallet` and
    `export-wallet-by-operator` carry no approval id; finalizing a deletion records one
    `destroy-wallet` per key, then `delete-workspace` with no approval id. Mandates ended by D8
    are `revoke-mandate-on-retire` and `revoke-mandate-on-delete`, reason `requested`.
  - Finalize deletes the key from the vault inside the write transaction, after re-reading the
    state, then empties the rows; a vault failure rolls the rows back, and a key already gone
    counts as deleted, so the next finalize completes (`lifecycle.test.ts`, "a key store that
    fails or crashes mid-destroy"). `PRAGMA wal_checkpoint(TRUNCATE)` runs after the commit.
  - OWS names its files by UUID; each API key file holds its own encrypted copy of the wallet's
    secret, so `destroyWallet` revokes every key named after the wallet before deleting the
    wallet (`ows.test.ts`).
  - Tests that wind a database file back to an older version now also drop the version 7
    columns (`DROP_VERSION_7` in `apps/signer/test/harness.ts`): `ALTER TABLE … ADD COLUMN`
    cannot run twice.
  - Compose and `.env.example` do not pass the two delay settings yet, so the defaults apply;
    the signer treats an empty value as unset, so wiring them as `${VAR:-}` is safe.

## Decision Log

Every owner decision is taken. Each names its question (D1-D12) in Risks and Open Questions.

- Decision: D1, D2 and D4-D12 are taken with the recommended option each, by the lead under the
  owner's delegation ("delegate to you on decisions like a CTO"); D3 was taken by the owner on
  2026-11-14. Each entry below states its option. D6 is taken for engineering, and still owes the
  counsel review it named; that review is flagged for Eric and does not block Milestones 1 to 7.
  Rationale: the owner asked for the remaining epics to be completed with decisions delegated;
  the recommended options were each argued in this plan and its research report.
  Date/Author: 2026-11-15 / lead, under Eric's delegation
- Decision (D1, taken 2026-11-15, option a): deletion destroys wallet keys at the signer, after
  a delay the signer enforces, authorized by a `delete-workspace` envelope at the admin threshold
  that names the exact wallet set, approved on the signer's confirmation page.
  Rationale: destroying a key with assets is irreversible, so it must meet the same bar as
  signing; the signer cannot check balances, so a delay and a free cancel are the protection.
  Date/Author: 2026-11-14 / delegated agent; confirmation page added 2026-11-15; taken by the
  lead 2026-11-15
- Decision (D2, taken 2026-11-15): `SIGNER_MIN_DESTROY_DELAY_SECONDS` defaults to 604800 (7 days).
  Rationale: long enough for a person to notice a request they did not mean; short enough to end
  a workspace within a week.
  Date/Author: 2026-11-14 / delegated agent; taken by the lead 2026-11-15
- Decision (D3, taken by the owner 2026-11-14, built): a new `sweep-wallet` envelope; its
  destination must be in the wallet's current recipient allowlist, or be the address of a
  treasury wallet of the same workspace other than the swept one.
  Rationale: emptying a wallet must not need an agent or a raised cap, and a sweep has no cap, so
  its destination must have been approved earlier.
  Date/Author: 2026-11-14 / delegated agent
- Decision: the envelope binds a hashed `Sweep` (`v`, `workspaceId`, `walletId`, `chainId`,
  `asset`, `amount`, `to`, `maxFeeWei`; tag `askgina.os/v1/sweep`) by `sweepHash`, with
  `walletId` and `chainId` beside it, as `approve-intent` binds an intent. The amount is in the
  approved structure, not chosen by the control plane after approval: the server reads the
  balance when the request opens (all of a token, or the native coin less the fee ceiling) and the
  person approves that exact amount. `SweepRequest` is `{ sweep, authorization, transaction }`.
  Rationale: the amount and destination are covered by the passkey but stay out of the plaintext
  envelope column (see `Surprises & Discoveries`); a changed amount or destination is refused
  with `envelope_mismatch`. Every existing digest and vector is unchanged.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: a paused workspace can be swept (confirmed by the owner's lead, 2026-11-14). The
  sweep is approved at the admin threshold with the admin lifetime; when the wallet has a policy,
  its chains and fee ceiling still apply and its caps do not. The sweep is recorded as a spend.
  Rationale: resuming a paused workspace to empty it would let its agents sign again.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: the sweep reuses the intent's signing path. `apps/server/src/execution/transactions.ts`
  holds nonce reservation, fee choice, the single signer call, storing the transaction, broadcast
  and follow-up; `approve-intent` and `sweep-wallet` each supply how to ask the signer.
  `transactions.intent_id` became nullable (`0002_sweep_transactions.sql`) instead of adding a
  `kind` column: the approval row already says which kind signed it.
  Rationale: one implementation of "one approval, one transaction"; no duplicated broadcast or
  reconciliation.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: the control plane does not pre-filter a sweep's destination; the request opens, and
  the signer's refusal ends it as `failed` with `sweep_destination_not_allowed`. The approval card
  says beforehand when the destination is neither allowed nor the treasury, and the wallet page
  offers only allowed destinations.
  Rationale: the release gate can then show the signer enforces the rule.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision (D4, taken 2026-11-15): wallet keys are exported only by `admin.ts export-wallet` on
  the signer host. No HTTP route.
  Rationale: over HTTP the control plane relays the recipient key; a passkey proves only a digest.
  Date/Author: 2026-11-14 / delegated agent; taken by the lead 2026-11-15
- Decision (D5, taken 2026-11-15): after each deletion the operator rotates the keyring; the
  deploy guide states the keyring backup retention and that deleted data stays in backups until
  the keyring copies older than that rotation are destroyed.
  Rationale: a shredded key is gone only when the KEK that wrapped it is gone everywhere.
  Date/Author: 2026-11-14 / delegated agent; taken by the lead 2026-11-15
- Decision (D6, taken 2026-11-15 for engineering; counsel review owed): erasing a person erases
  their name, passkeys, sessions, push subscriptions and notification settings (preferences and
  quiet hours) and keeps their user id in audit chains, assertions, deliveries and the signer's
  history. Milestone 8 is in scope.
  Rationale: the notification data is personal and easy to delete; the audit chain stays
  verifiable without a format change. Whether keeping the id satisfies GDPR Article 17 is for
  counsel; the review is flagged for Eric and does not block Milestones 1 to 7.
  Date/Author: 2026-11-15 / lead, under Eric's delegation
- Decision (D7, taken 2026-11-15): finalize waits while any transaction of the subject is
  `signed`, `broadcast` or `stuck`, and while one is `rejected` and no later transaction of its
  wallet on its chain has used its nonce. People clear a stuck one with its `cancel-transaction`
  approval (built), which is allowed while paused and while the wallet is retiring.
  Rationale: finding 5 of the report; a `rejected` transaction is still valid until its nonce is
  used, so it can still be mined.
  Date/Author: 2026-11-14 / delegated agent; cancel path added and taken by the lead 2026-11-15
- Decision: clone is a template at the control plane; no signer change; no key is ever copied.
  Rationale: report, finding 9 and options for clone.
  Date/Author: 2026-11-14 / delegated agent
- Decision: a deleted workspace leaves a tombstone (ids, statuses, timestamps, hashes, addresses,
  the audit chain, the signer's decision log, used nonces, mandate ids with their hashes, times
  and counts); names and labels are cleared; memberships, invites, approver mirrors, assertions,
  notification preferences and undelivered notifications are removed.
  Rationale: used nonces and approval ids must stay to refuse replays; the chain stays verifiable
  without the shredded key; nothing readable about what people typed remains.
  Date/Author: 2026-11-14 / delegated agent; mandates and notifications added 2026-11-15
- Decision (D8, taken 2026-11-15): applying a `retire-wallet` or `delete-workspace` approval
  revokes, in the same signer transaction, every live mandate of the wallet or workspace with
  reason `requested`, and the control plane cancels waiting `grant-mandate` requests for them. A
  cancelled retirement or deletion does not bring a mandate back.
  Rationale: a mandate signs without a person, so it must end when people decide to end the
  wallet, not a week later; reusing `requested` avoids rebuilding a SQLite table whose `CHECK`
  lists the reasons.
  Date/Author: 2026-11-15 / PlanRefreshLifecycle; taken by the lead 2026-11-15
- Decision (D9, taken 2026-11-15): finalize deletes the workspace's rows in `confirmations`,
  `confirmation_assertions` and `possession_challenges`, and blanks `mandates.mandate`, keeping
  mandate ids, hashes, times, revocations and `mandate_uses`, with `secure_delete` on.
  Rationale: after the workspace key is shredded these are the only readable copies of memos and
  purposes; ids and hashes are enough for replay refusal and the decision log.
  Date/Author: 2026-11-15 / PlanRefreshLifecycle; taken by the lead 2026-11-15
- Decision (D10, taken 2026-11-15): the notification outbox announces a scheduled retirement or
  deletion when its approval is applied, and again 24 hours before `destroyAfter`.
  Rationale: the delay protects only if someone notices; the outbox, Web Push and the signed
  webhook exist now.
  Date/Author: 2026-11-15 / PlanRefreshLifecycle; taken by the lead 2026-11-15
- Decision (D11, taken 2026-11-15): a template carries the workspace's notification content
  level (`notification_detail`) and no mandate; a record carries every mandate and use, opened;
  neither carries push subscriptions, notification preferences, quiet hours or the delivery log.
  Rationale: mandates are authority and must be granted again by the clone's people; the
  per-person settings belong to a person, not to a workspace.
  Date/Author: 2026-11-15 / PlanRefreshLifecycle; taken by the lead 2026-11-15
- Decision (D12, taken 2026-11-15): no `removed` agent status. "Remove agent" is the existing
  disable, which additionally cancels the agent's waiting payment (`approve-intent`) requests and
  revokes them at the signer.
  Rationale: disabled is already final and already ends mandates; a second status would mean two
  names for one state.
  Date/Author: 2026-11-15 / PlanRefreshLifecycle; taken by the lead 2026-11-15
- Decision: Milestone 1's contract details, beyond the drafted shapes.
  `walletsToDestroy(envelope)` gives the `WalletRef`s an envelope schedules for destruction (one,
  every listed, or none), for the renderer and the signer alike. `RenderInput.wallets` is the
  signer's `SignerWalletRecord` (`walletId`, `label`, `address`) of each listed wallet it holds
  in the envelope's workspace; a listed wallet without a record, or held at another address, is
  shown with "the signer will refuse this". The two warnings are added only when at least one
  wallet is listed (a deletion of an empty workspace loses nothing).
  `WorkspaceState.destroyAfter` is null exactly while `active`, and `WalletState.destroyAfter` is
  set exactly while `retiring` or `destroyed`, both checked by refine: cancelling clears it, and
  a held wallet has no destroy time. The wallet cancel and finalize bodies are
  `RetireWalletStepRequest` (`{ workspaceId }`); the workspace ones send `{}` as `pauseWorkspace`
  does. `destroy_not_due` sits with the 409 codes.
  Rationale: one helper keeps the renderer and the signer reading the same wallet list; the
  refines make a state that contradicts itself a parse failure at the control plane, as
  `MandateState`'s do.
  Date/Author: 2026-11-15 / LifecycleM1

## Outcomes & Retrospective

- Outcome (2026-11-14): the sweep is built and passes its unit and Anvil tests locally (see
  `Progress`). Its release gate and the UI job need CI.
  Remaining: retire, delete, remove agent, export, clone, and Milestones 3, 5 to 8.
- Outcome (2026-11-15): the sweep is proven in CI (run 43710836888, `stack (amd64)`, gate at
  `release-gates.spec.ts:686`), and the `ui` journey covers its card. Delivered by other plans
  since the draft: the signer's migration mechanism (restore fence), approval on the signer's
  confirmation page (trusted display), and disabling an agent ending its mandates (mandates).
  Evidence: CI run 43710836888 (six jobs green); `specs/trusted-display.md`,
  `specs/approval-mandates.md`.
  Remaining: retire, delete, export, clone, the disable extension (D12), and Milestones 1 to 8 as
  rewritten below.
- Outcome (2026-11-15): owner decisions D1-D12 are taken (D6 owes counsel review), and
  Milestone 1 is built: the two envelopes, their confirmation views, the signer contract and the
  protocol document, with compile-keeping edits in the signer and the `approve` page. Local
  checks only (see `Progress`); CI has not run it.
  Remaining: Milestone 1 in CI; Milestones 2 to 8.

## Context and Orientation

Relevant repo rules:

- Read `AGENTS.md` at the repository root before changing files.
- TypeScript strict, ESM, erasable syntax only; relative imports carry `.ts`; every dependency
  pinned exactly (`specs/agent-workspaces-v0.1.md:186-192`).
- No `console.*`; log identifiers, codes and counts only. Errors crossing a step, a response or
  a log line carry a stable code and a fixed message.
- Local builds, whole test suites and coverage run in CI only, unless the owner names the command.
- `bun run check`, `bun run typecheck` and `bun run test` must pass before a commit (in CI).

Terms used here, beyond those in the v0.1 plan (`specs/agent-workspaces-v0.1.md:194-208`):

- **Sweep**: one transaction that moves the whole balance of one asset out of a wallet to a
  destination the approvers allowed earlier. Built.
- **Confirmation page**: the page on `APPROVE_ORIGIN`, served by the keyless `approve` service,
  where people approve every envelope with a passkey. The signer renders what it says.
- **Mandate**: a bounded, time-limited approval in advance that lets one agent pay listed
  recipients from one wallet without a person each time. Only the signer counts its uses.
- **Retire**: start the destruction of one wallet's key. During the delay the wallet signs
  nothing; it can be cancelled.
- **Held**: a wallet whose retirement was cancelled. Its key exists; it signs nothing until a new
  policy is approved for it.
- **Destroy**: the signer deletes the wallet's OWS wallet file and API key file and its sealed
  token. Irreversible on the live system.
- **Finalize**: the step after the delay that destroys keys and shreds data keys.
- **Tombstone**: what stays after finalize, so ids cannot be reused and replays stay refused.
- **Template**: an export of configuration only. **Record**: an export of history.

Current behavior on main (`2911c20`), source-read:

- `apps/server/src/db/schema.ts`: workspace-owned tables `workspaces` (with `paused`,
  `notification_detail`, the audit head), `memberships`, `approver_credentials`, `invites`,
  `wallets`, `agents`, `approvals` (kinds include `mandate-use`; sealed `detail` and
  `confirmation`), `approval_assertions`, `approval_rejections`, `mandates` (mirror, sealed
  `mandate`), `intents`, `transactions` (`intent_id` nullable; status adds `rejected`),
  `audit_events`, `nonce_reservations`, `notification_deliveries` (outbox, per workspace and
  approval), `notification_preferences` (per person and workspace). Per person, not per
  workspace: `users` (with `quiet_hours`), `credentials`, `sessions`, `ceremonies`,
  `push_subscriptions`. Migrations `0000` to `0006` exist (`0006_push_subscriptions.sql`).
  `agents.status` is `active` or `disabled`.
- `apps/server/src/directory/routes.ts:301-325` pauses through the signer; `701-746` disables an
  agent, then `revokeAgentMandates` (`apps/server/src/execution/mandates.ts:574-611`) cancels its
  waiting `grant-mandate` requests and revokes its mandates at the signer. Waiting
  `approve-intent` requests of the agent are left as they are.
- Approval kinds: `apps/server/src/directory/kinds.ts:427` registers `set-policy`,
  `add-approver`, `remove-approver`, `set-admin-threshold`, `resume-workspace`;
  `apps/server/src/execution/index.ts:30-38` registers `approve-intent` (`intents.ts:799`),
  `sweep-wallet` (`sweeps.ts:259`) and the mandate kinds (`mandates.ts:525`). Each handler
  (`apps/server/src/approvals/kinds.ts:92-130`) supplies `confirmationSubject`, the structure the
  signer's confirmation page shows; kinds whose envelope carries everything return
  `envelope-only`.
- `apps/server/src/execution/index.ts:133-160` (`startBackground`, called from
  `apps/server/src/main.ts:68`) runs one sweeper every 3 seconds (`SWEEP_INTERVAL_MS`): it wakes
  and recovers approval runs and delivers due notifications (`deliverDueNotifications`).
- `apps/server/src/notify/outbox.ts`: a delivery is dropped with `approval_ended` once its
  approval ended (`:216`), so cancelling a deletion's pending approvals also silences their
  notifications.
- `apps/server/src/execution/chains.ts:116`: `balances` reads native and ERC-20 balances.
- `apps/server/src/audit.ts:55-112`: the per-workspace hash chain; details sealed with a salt;
  workspace row locked `FOR NO KEY UPDATE`. `entryHash` (`:43`) is module-private; `verifyAudit`
  (`:131`) is exported.
- `apps/server/src/execution/approvals.ts:250` (`cancel`): ends a pending request and wakes its
  run; it does not revoke the approval id at the signer.
- `packages/keys/src/data-key-store.ts`: `getOrCreate`, `get` (`:173`), `rewrap` (`:208`),
  `shred` (`:264`); scopes `run` and `workspace`; `tenant_id` recorded per key. No
  `shredTenant`. `packages/keys/src/cli.ts`: `rewrap`, `shred`.
- `packages/world/src/index.ts:55-65`: each run key is created with the workspace as tenant
  (`apps/server/src/execution/workflow-runtime.ts:140`).
- `apps/signer/src/db.ts`: the signer's tables at schema version 5, with `PRAGMA user_version`
  migrations (`:204-250`); `secure_delete` is not set.
- `apps/signer/src/signer.ts` (line numbers at `2911c20`): `authorizedChange` (`:430`) is the
  shape of every non-signing envelope; `pauseWorkspace` (`:533`); `resumeWorkspace` (`:544`);
  `sign` (`:886`); `assertSweepAllowed` (`:974`) and `sweep` (`:996`); `revokeApproval`
  (`:1073`). Every envelope is checked against the restore fence (`envelope_fenced`).
- `apps/signer/src/mandates.ts`: grant, sign under, revoke; `revokeMandatesOnFence`,
  `revokeWorkspaceMandatesByOperator`; revocation reasons `requested`, `grantor_removed`,
  `operator`. A grant is not refused while the workspace is paused.
- `apps/signer/src/confirmations.ts`: opens a confirmation per approval, keeps its envelope and
  subject, renders it with `renderConfirmation`, marks it `superseded` when the signer would
  refuse it anyway.
- `apps/signer/src/vault.ts`: `Vault` has `createWallet` and `signEvmTransaction` only.
- `apps/signer/src/admin.ts`: `enroll-approver`, `verify-log`, `fence`, `list-mandates`,
  `revoke-mandate`.
- `packages/protocol/src/envelopes.ts`: nine envelope kinds, `sweep-wallet` and `grant-mandate`
  included. `packages/protocol/src/signer/api.ts`: routes with a `control` or `confirm` scope;
  `WorkspaceState` and `WalletState` have no lifecycle state.
- `packages/protocol/src/confirmation.ts`: `ConfirmationSubject`, `ConfirmationWarning`,
  `renderConfirmation`.
- `packages/api/src/routes.ts`: the REST contract shared by UI, scripts and tests (`requestSweep`
  at `:265`).
- `e2e/run.sh:67` runs `release-gates.spec.ts`; `:87` runs `browser.spec.ts`.
- Landed since the re-check (`8be9bd5`): stuck-transaction repricing
  ([#22](https://github.com/askgina/os/issues/22)): signer schema version 6 with the table
  `signature_attempts`, the `cancel-transaction` envelope, and server migration
  `0007_transaction_attempts.sql`.
- Built by Milestone 1 (2026-11-15, CI pending): the `retire-wallet` and `delete-workspace`
  envelopes, `WalletRef`, `walletsToDestroy`, their confirmation views, the six lifecycle routes
  in `signerRoutes` and `SignerClient`, the lifecycle fields of `WorkspaceState` and
  `WalletState`, and six error codes. The signer does not serve the routes yet and reports every
  workspace and wallet `active`.

How the pieces fit together:

A person acts in the web UI. The control plane opens an approval request, and the signer opens a
confirmation for it holding the envelope and its subject. People approve on the confirmation page
on `APPROVE_ORIGIN`; the control plane collects the assertions from the signer, and a handler for
that approval kind calls the signer with the authorization. The signer verifies every assertion
against its own approver registry and threshold, checks the restore fence, records the envelope
nonce as used, and applies the effect in one SQLite transaction, writing a decision-log entry.
This plan adds two envelope kinds that go through exactly that path, four request-signature-only
signer calls that only remove authority or run a step already authorized, and a lifecycle step
in the control plane's sweeper that drives deletion to its end.

Assumptions:

- The Compose layout on main: one signer, one `approve` service, one Postgres, one keyring file.
  Multi-machine custody is [#25](https://github.com/askgina/os/issues/25).
- `@open-wallet-standard/core` stays at 1.4.5. Its `deleteWallet`, `revokeApiKey`, `listApiKeys`
  and `exportWallet` are used as declared in its `index.d.ts`. If 1.4.5 behaves otherwise, the
  real-OWS test in Milestone 2 fails and the vault code changes, not the protocol.
- Stuck-transaction repricing landed first (signer version 6, server migration `0007`), so
  Milestone 2 takes signer version 7 and Milestone 4 takes server migration `0008`.

## Plan of Work

The sweep parts of Milestones 1, 2, 4, 6 and 7 are delivered (see `Progress`) and removed from
the text below. What remains is retire, delete, export, clone, the disable extension, and person
erasure if chosen.

### Milestone 1: protocol

Scope: the hashed structures, the confirmation view and the signer contract. First, because every
later milestone depends on them and their digests are pinned.

Delivered: `Sweep`, `sweepHash`, `SweepWalletEnvelope`, the `sweep` route and
`sweep_destination_not_allowed` (with the sweep). Built 2026-11-15, CI pending: everything below,
with the details recorded in the Decision Log ("Milestone 1's contract details"): the confirmation
input is `RenderInput.wallets: SignerWalletRecord[]`, the helper `walletsToDestroy`, the wallet
step body `RetireWalletStepRequest`, and refines tying `destroyAfter` to the lifecycle state.

Files and interfaces:

- `packages/protocol/src/envelopes.ts`: add
  - `WalletRef = z.strictObject({ walletId: WalletId, address: Address })`.
  - `RetireWalletEnvelope`: header plus `type: "retire-wallet"`, `wallet: WalletRef`,
    `destroyAfter: EpochSeconds`.
  - `DeleteWorkspaceEnvelope`: header plus `type: "delete-workspace"`,
    `wallets: z.array(WalletRef).max(256)` sorted by `walletId` without duplicates (may be empty),
    `destroyAfter: EpochSeconds`.
  - Add both to the `Envelope` union. `destroyAfter > issuedAt` is checked by refine.
- `packages/protocol/src/confirmation.ts`:
  - Both kinds are `envelope-only` subjects (add them to the `envelope-only` case of
    `matchSubject`).
  - `renderConfirmation`: titles "Retire a wallet" and "Delete this workspace"; one `address`
    line per wallet with its id, the signer's wallet label as an `unchecked` line, the destroy
    time as text. `RenderInput` gains the signer's records of the listed wallets.
  - `ConfirmationWarning` gains `keys_destroyed` (what is left in these wallets is lost after the
    destroy time) and `balances_unchecked` (the signer cannot see balances), in that order before
    the existing ones.
- `packages/protocol/src/signer/api.ts`, all `control` scope:
  - Routes: `retireWallet` `POST /v1/wallets/:walletId/retire`; `cancelRetireWallet`
    `POST /v1/wallets/:walletId/retire/cancel`; `finalizeRetireWallet`
    `POST /v1/wallets/:walletId/retire/finalize`; `deleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete`; `cancelDeleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete/cancel`; `finalizeDeleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete/finalize`.
  - `retireWallet` and `deleteWorkspace` take `AuthorizedRequest`. The cancel and finalize calls
    take `z.strictObject({ workspaceId })` (wallet routes) or no body (workspace routes).
  - `WorkspaceState` gains `state: "active" | "deleting" | "deleted"`,
    `destroyAfter: EpochSeconds.nullable()` and `minDestroyDelaySeconds`. `WalletState` gains
    `state: "active" | "retiring" | "held" | "destroyed"` and `destroyAfter`.
  - `SignerErrorCode` gains `workspace_deleting`, `workspace_deleted`, `wallet_retired`,
    `wallet_set_mismatch`, `destroy_delay_out_of_range` (all 403) and `destroy_not_due` (409).
- `packages/protocol/src/signer/client.ts`: one method per new route.
- `packages/protocol/test/lifecycle-envelopes.test.ts`: accept and reject cases for each schema;
  pinned digest vectors; an assertion over one kind does not verify as another kind.
- `packages/protocol/test/confirmation.test.ts` (extend): both kinds render every wallet and the
  two warnings.
- `docs/approval-protocol.md` §5 table rows, §8 the destroy rule, §10 the new routes, §11 vectors.

Work: follow the existing envelope style (strict objects, header spread, sorted sets via
`isSortedUnique`). Pin the vectors by computing them in the test from fixed inputs and comparing
with literal hex, as `packages/protocol/test/digests.test.ts` does. If stuck-transaction
repricing's envelope lands first, append after `cancel-transaction`.

Acceptance:

- CI job `test` (`bun run test`) passes `packages/protocol/test/lifecycle-envelopes.test.ts`,
  including: a `delete-workspace` envelope with unsorted wallets is rejected; a `retire-wallet`
  with `destroyAfter ≤ issuedAt` is rejected; the two pinned digests match; every existing vector
  is unchanged.
- CI job `check` passes (`bun run check`, `bun run typecheck`).

### Milestone 2: signer

Scope: `apps/signer`. The irreversible steps live here.

Delivered: `PRAGMA user_version` migrations (restore fence) and `sweep` (with the sweep).

Files and interfaces:

- `apps/signer/src/db.ts`:
  - Schema version 7 (repricing took 6):

    ```sql
    ALTER TABLE workspaces ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
      CHECK (state IN ('active', 'deleting', 'deleted'));
    ALTER TABLE workspaces ADD COLUMN destroy_after INTEGER;
    ALTER TABLE wallets ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
      CHECK (state IN ('active', 'retiring', 'held', 'destroyed'));
    ALTER TABLE wallets ADD COLUMN destroy_after INTEGER;
    ALTER TABLE wallets ADD COLUMN destroyed_at INTEGER;
    ```
  - `PRAGMA secure_delete = ON` in `openDatabase`.
- `apps/signer/src/config.ts`: `SIGNER_MIN_DESTROY_DELAY_SECONDS` (integer, 0 to 7776000,
  default 604800) and `SIGNER_MAX_DESTROY_DELAY_SECONDS` (default 7776000, 90 days).
- `apps/signer/src/vault.ts`:
  - `Vault.destroyWallet(walletId: WalletId): void`. `OwsVault`: for every entry of
    `ows.listApiKeys(vaultPath)` whose name is the wallet id, `ows.revokeApiKey(id, vaultPath)`;
    then `ows.deleteWallet(walletId, vaultPath)`. A "not found" from either is success, so a
    repeat is safe. The test vault deletes its map entry.
  - `exportOwsWalletSecret(options: { vaultPath; passphraseFile }, walletId): string`, a
    module function, not a `Vault` method, so nothing reachable over HTTP can call it.
- `apps/signer/src/signer.ts`:
  - `retireWallet(walletId, authorization)`: through `authorizedChange` (so the restore fence
    applies). Checks: `envelope.wallet` equals the signer's wallet id and address; wallet state
    `active` or `held`; `destroyAfter − issuedAt` within the configured range. Apply: state
    `retiring`, `destroy_after`; revoke every live mandate of the wallet with reason `requested`
    (D8).
  - `cancelRetireWallet(walletId, workspaceId)`: request signature only. `retiring` → `held`,
    `destroy_after` cleared (a held wallet has no destroy time in `WalletState`). Decision
    `cancel-retire-wallet`. Mandates stay revoked.
  - `finalizeRetireWallet(walletId, workspaceId)`: request signature only. Refuses with
    `destroy_not_due` before `destroy_after`. Then `vault.destroyWallet`, and in one transaction:
    `sealed_credential = x''`, `state = 'destroyed'`, `destroyed_at`,
    `UPDATE signatures SET signed_transaction = '' WHERE wallet_id = ?` and
    `UPDATE signature_attempts SET signed_transaction = '' WHERE approval_id IN (SELECT approval_id FROM signatures WHERE wallet_id = ?)`,
    decision `destroy-wallet`. Then `PRAGMA wal_checkpoint(TRUNCATE)`. A repeat on a destroyed
    wallet returns its state.
  - `deleteWorkspace(workspaceId, authorization)`: through `authorizedChange`. Checks: the
    envelope's wallet set equals the signer's wallets of this workspace whose state is not
    `destroyed` (`wallet_set_mismatch` otherwise); delay range; workspace state `active`. Apply:
    `paused = 1`, `state = 'deleting'`, `destroy_after`; every listed wallet `retiring` with the
    same `destroy_after`; every live mandate of the workspace revoked with reason `requested`.
  - `cancelDeleteWorkspace(workspaceId)`: request signature only. `deleting` → `active` with
    `paused = 1` (resuming still needs `resume-workspace`) and `destroy_after` cleared; wallets
    that were set `retiring` by this deletion go back to `active`, their `destroy_after` cleared.
    Decision `cancel-delete-workspace`.
  - `finalizeDeleteWorkspace(workspaceId)`: request signature only. `destroy_not_due` before
    `destroy_after`. Destroy every wallet as above; `DELETE FROM approvers WHERE workspace_id`;
    delete the workspace's `possession_challenges`, `confirmation_assertions` and
    `confirmations`; `UPDATE mandates SET mandate = ''` for the workspace (D9); `state =
    'deleted'`; decision `delete-workspace`. Keep `used_nonces`, `approvals`, `spends`,
    `policies`, `decisions`, mandate ids, hashes, times, `mandate_grantors` and `mandate_uses`.
  - Everywhere else: `sign`, `sweep`, `signUnderMandate`, `grantMandate`, `setPolicy`,
    `addApprover`, `removeApprover`, `setAdminThreshold`, `resumeWorkspace` and
    `openConfirmation` refuse with `workspace_deleting` or `workspace_deleted` by workspace state;
    `sign`, `sweep`, `signUnderMandate` and `grantMandate` refuse `wallet_retired` for a wallet not
    `active`. Repricing and `cancel-transaction` refuse for a destroyed wallet only, so a stuck
    transaction can still be cleared during the delay (D7). `setPolicy` on a `held` wallet sets
    it back to `active`. `createWallet` refuses in a workspace that is not `active`. A
    confirmation of another kind that is open when a retirement or deletion applies shows
    `superseded`.
  - `createWorkspace` for an id that exists in state `deleted` answers `conflict`.
  - Replace the Milestone 1 compile-keeping edits (`Surprises & Discoveries`): `workspaceState`
    and `walletState` read `state` and `destroy_after`; `minDestroyDelaySeconds` comes from
    `SIGNER_MIN_DESTROY_DELAY_SECONDS`; `supersededBy` in `apps/signer/src/confirmations.ts`
    gains the retire and delete rules (`envelope_mismatch`, `wallet_retired`,
    `wallet_set_mismatch`).
- `apps/signer/src/index.ts`: route the six new contract routes.
- `apps/signer/src/admin.ts`: `export-wallet --workspace <ws> --wallet <wal> --out <path>`.
  Refuses a destroyed wallet; writes the mnemonic to `--out` with mode 0600 (refuses if the file
  exists); appends decision `export-wallet-by-operator`; prints one JSON line without the secret.
- Tests:
  - `apps/signer/test/lifecycle.test.ts` (test vault): retire then `sign`, `sweep` and
    `signUnderMandate` are refused with `wallet_retired`; retiring revokes the wallet's live
    mandates with reason `requested` and no other wallet's; finalize before `destroy_after` is
    `destroy_not_due`; finalize after it destroys the key (the test vault no longer has it) and a
    second finalize returns the same state; cancel makes the wallet `held`, `sign` still refused,
    a new policy makes it `active`, the mandate stays revoked; delete with a wallet missing from
    the envelope, or an extra one, is `wallet_set_mismatch`; delete with a delay below the minimum
    is `destroy_delay_out_of_range`; a `delete-workspace` envelope issued before the restore fence
    is `envelope_fenced`; during `deleting`, `addApprover`, `setPolicy`, `grantMandate` and
    `resumeWorkspace` are refused; cancel leaves `paused`; after finalize every route for the
    workspace except `getWorkspace` and `listDecisions` is refused, the workspace has no
    confirmation rows and blank mandate texts, `createWorkspace` with the same id is `conflict`, a
    reused envelope nonce is still `nonce_reused`, and `verify-log` passes.
  - `apps/signer/test/confirmations.test.ts`: the confirmation of a `delete-workspace` envelope
    lists the signer's wallets and shows `superseded` once the wallet set changed.
  - `apps/signer/test/ows.test.ts`: with real OWS 1.4.5, `destroyWallet` leaves no file under
    `wallets/` or `keys/` naming the wallet, and a second call succeeds.
  - `apps/signer/test/admin.test.ts`: `export-wallet` writes a 0600 file whose mnemonic derives
    the wallet's address, refuses an existing `--out` and a destroyed wallet, and logs the
    decision.
  - The migration: a database at the previous version opens, migrates, and keeps its rows and
    decision-log head, tested the way `apps/signer/test/fence.test.ts` and
    `apps/signer/test/mandates.test.ts` test theirs.

Acceptance:

- CI job `test` passes the files above.
- CI jobs `stack (amd64)`, `stack (arm64)`, `stack (tls)` still pass (the signer image starts on
  a fresh volume at the new version).

### Milestone 3: key store

Scope: `packages/keys`. Shred every run key of one workspace. Unchanged since the draft; nothing
of it is built.

Files and interfaces:

- `packages/keys/src/data-key-store.ts`:
  - In `migrateKeys`: `CREATE INDEX IF NOT EXISTS data_keys_tenant_idx ON os_keys.data_keys (scope, tenant_id) WHERE shredded_at IS NULL`.
  - `shredTenant(scope: KeyScope, tenantId: string): Promise<{ shredded: number }>`: one
    `UPDATE … SET kek_id = NULL, wrapped_key = NULL, shredded_at = now() WHERE scope = $1 AND tenant_id = $2 AND shredded_at IS NULL RETURNING key_id`;
    evict each returned id from the cache. [unconfirmed] the tombstone columns are exactly these;
    follow what `shred` (`:264`) writes.
- `packages/keys/src/cli.ts`: `shred-tenant <run|workspace> <tenant id>`, exit 0 with a count
  (0 is not an error: a repeat finds nothing).
- `packages/keys/test/data-key-store.test.ts`, `packages/keys/test/cli.test.ts`: two tenants'
  run keys; shredding one tenant leaves the other readable; `get` of a shredded run throws
  `DataKeyUnavailableError`; `getOrCreate` of a shredded id does not mint a key; a repeat
  returns 0.

Acceptance:

- CI job `test` passes the cases above.

### Milestone 4: control plane, retire, delete, disable

Scope: `apps/server`, `packages/api`. Depends on Milestones 1 to 3.

Delivered: the `sweep-wallet` kind, `requestSweep`, nullable `transactions.intent_id` (with the
sweep); disabling an agent revokes its mandates and cancels its waiting grants (with mandates).

Files and interfaces:

- `apps/server/src/db/migrations/0008_lifecycle.sql` (`0007` is repricing's) and
  `apps/server/src/db/schema.ts`:
  - `workspaces.lifecycle text NOT NULL DEFAULT 'active'` (`active`, `deleting`, `deleted`),
    `workspaces.destroy_after timestamptz`, `workspaces.deleted_at timestamptz`.
  - `wallets.lifecycle text NOT NULL DEFAULT 'active'` (`active`, `retiring`, `held`,
    `destroyed`), `wallets.destroy_after timestamptz`.
  - `NotificationEvent` gains `lifecycle.scheduled` and `lifecycle.due_soon` (D10), keyed to the
    retire or delete approval's id like every outbox row.
- `apps/server/src/lifecycle/kinds.ts`: approval kind handlers in `registerLifecycleKinds`,
  called from `registerExecution` (`apps/server/src/execution/index.ts:30-38`) next to the
  others. Both use `confirmationSubject: envelopeOnly` as the directory kinds do.
  - `retire-wallet`: opening requires owner role; the envelope's wallet is read from the signer
    (`getWallet`), never from the control plane's mirror. Applying: `signer.retireWallet`, mirror
    the state, cancel waiting `grant-mandate` and `sweep-wallet` requests for the wallet, mark the
    wallet's mandate mirrors ended, append `wallet.retiring`, write the D10 outbox rows.
  - `delete-workspace`: opening requires owner role and a paused workspace; the envelope's
    wallet set is built from the signer's own answer (`getWallet` for each mirrored wallet, plus a
    check that the signer reports no other). Applying: `signer.deleteWorkspace`, mirror, cancel
    every waiting request of the workspace except itself, mark mandate mirrors ended, append
    `workspace.deleting`, write the D10 outbox rows.
  - The mandate mirror already maps the signer's `requested` to `MandateEndedReason` `revoked`
    (`apps/server/src/execution/mandates.ts:121`, `packages/api/src/dto.ts:410-417`); no new
    reason is needed.
- `apps/server/src/directory/routes.ts` `disableAgent` (D12): also cancel the agent's waiting
  `approve-intent` requests (`ctx.approvals.cancel`, then `signer.revokeApproval`, because
  `cancel` alone does not revoke at the signer), in the same best-effort step that revokes its
  mandates.
- `apps/server/src/lifecycle/preflight.ts`: `deletionPreflight(ctx, workspaceId)` returns per
  wallet the balances of native coin and every asset in its policy, `source: "control-plane"`,
  and blockers: `pending_approvals`, `unfinished_runs` (mandate uses included),
  `unmined_transactions` (a `rejected` one whose nonce is unused included, D7),
  `nonzero_balance`. Advisory; the web approval page shows it.
- `apps/server/src/lifecycle/finalize.ts`: `finalizeDue(ctx)`, called from the existing
  sweeper in `apps/server/src/execution/index.ts` and throttled to once a minute:
  1. For each wallet `retiring` and each workspace `deleting` whose `destroy_after` passed.
  2. Cancel pending approvals of the subject (status `cancelled`, `signer.revokeApproval`,
     resume outbox set to `needed` so the run ends). If a run of the workspace is not finished
     (`approvals.run_id` of rows not in a final status, `mandate-use` rows included), skip this
     round.
  3. If a transaction of the subject is `signed`, `broadcast` or `stuck`, or is `rejected` and no
     later transaction of its wallet on its chain has used its nonce, skip and keep the blocker
     visible (D7).
  4. Append the audit event (`wallet.destroyed` or `workspace.deleted`) unless the newest event
     for the subject already is that one.
  5. Call `signer.finalizeRetireWallet` or `signer.finalizeDeleteWorkspace`. `destroy_not_due`
     means the clocks differ: skip this round.
  6. For a workspace: `keys.shredTenant("run", workspaceId)`, then
     `keys.shred("workspace", workspaceId)`.
  7. Tombstone in one transaction, audit append first (it takes the workspace row
     `FOR NO KEY UPDATE`; nothing here may take `FOR UPDATE`): `workspaces.name = 'Deleted
     workspace'`, `lifecycle = 'deleted'`, `deleted_at`; `wallets.label = ''`,
     `lifecycle = 'destroyed'`; agents `status = 'disabled'`, `name = 'Removed agent'`,
     `token_hash = 'removed:' || id`; delete `memberships`, `invites`, `approver_credentials`,
     `approval_assertions`, `approval_rejections`, `nonce_reservations` and
     `notification_preferences` of the workspace; set every `notification_deliveries` row of the
     workspace still `pending` to `dropped` with `last_code = 'workspace_deleted'`.
  8. Log `lifecycle.finalized` with ids and counts, and print the keyring rotation commands
     once per workspace deletion (D5).
- `apps/server/src/lifecycle/routes.ts` and `packages/api/src/routes.ts`:
  - `getDeletionPreflight` `GET /api/v1/workspaces/:workspaceId/delete/preflight`.
  - `requestDeleteWorkspace` `POST /api/v1/workspaces/:workspaceId/delete`
    `{ destroyAfter }` → `ApprovalSummary`. Refused with `conflict` unless paused.
  - `cancelDeleteWorkspace` `POST /api/v1/workspaces/:workspaceId/delete/cancel`: any member.
  - `requestRetireWallet`, `cancelRetireWallet` on
    `/api/v1/workspaces/:workspaceId/wallets/:walletId/retire[/cancel]`.
  - Every route refuses a workspace whose lifecycle is not `active` with `conflict`, except
    pause, the cancel routes, notification settings and reads. The MCP gateway already refuses a
    disabled agent (`apps/server/src/mcp/gateway.ts:454`); it also refuses every agent of a
    workspace that is not `active`.
- Tests, with the fake signer, the soft authenticator and the test chain:
  - `apps/server/test/lifecycle/delete.test.ts`: request, approve, cancel, request again,
    approve, advance the clock, sweeper finalizes; afterwards opening any sealed column of the
    workspace throws `DataKeyUnavailableError`, and so does reading a payload of any of its runs
    through the World; the audit chain still verifies and its last action is
    `workspace.deleted`; the run of a pending approval ended before shredding; an unmined
    transaction blocks finalize until it confirms; a live mandate is revoked when the deletion is
    applied, not at finalize; no `pending` delivery of the workspace remains; a crash between
    steps 5 and 6 (simulated by throwing once) completes on the next round; a proposal racing the
    tombstone does not deadlock.
  - `apps/server/test/lifecycle/retire.test.ts`: retire, cancel to `held`, new policy back to
    `active`; retire again and finalize.
  - `apps/server/test/directory/directory.test.ts` (extend): disabling cancels the agent's
    waiting payment requests and revokes them at the signer.

Acceptance:

- CI job `test` passes the files above; `bun run build:workflows` still builds (the workflow
  bundle is unchanged).

### Milestone 5: export and clone

Scope: `apps/server/src/lifecycle/`. Independent of Milestones 2 to 4 except for the shared
schema; may run in parallel with Milestone 4. Nothing of it is built.

Files and interfaces:

- `apps/server/src/lifecycle/template.ts`: `WorkspaceTemplate` (zod, strict):
  `{ format: "askgina.os/workspace-template/v1", name, adminThreshold, notificationDetail, wallets: [{ ref, kind, label, agent: { name } | null, policy: PolicyTemplate | null }], members: [{ userId, role }] }`.
  `PolicyTemplate` is `WalletPolicy` without `v`, `workspaceId`, `walletId`, `revision`,
  `previousHash`, and with `requesters` as wallet `ref`s of template agents. No mandate (D11).
  `toTemplate(ctx, workspaceId)` and `instantiatePolicy(template, ids)` (revision 1, new ids).
- `apps/server/src/lifecycle/export.ts`: `writeRecord(ctx, workspaceId, sink)` streams JSON Lines:
  a header `{ format: "askgina.os/workspace-record/v1", workspaceId, exportedAt, auditHead: { seq, hash }, signerDecisionHead: { seq, hash } }`,
  then `audit` lines (chained fields, `salt`, opened `detail`), `intent`, `transaction`,
  `policy-revision`, `mandate` (opened, with its status and counts from the signer) and
  `signer-decision` lines. Owner role and a passkey sign-in no older than 300 seconds
  (`sessions.created_at`); appends `workspace.exported`.
- `apps/server/src/audit.ts`: export `entryHash` and the sealed-detail digest so the verifier uses
  the same code.
- `apps/server/src/lifecycle/verify-record.ts`: `verifyRecord(lines)` and a CLI
  (`node apps/server/src/lifecycle/verify-record.ts <file>`) that recomputes every audit hash,
  every detail digest from `salt` and `detail`, the chain links, the head, every mandate hash, and
  the signer decision chain; exit 0 when valid, 2 with the first broken line otherwise.
- `apps/server/src/lifecycle/clone.ts`: `cloneWorkspace(ctx, session, { sourceId | template, name, includeAgents, includeMembers })`:
  create the workspace through the existing directory path (the person cloning is its first
  approver at the signer), create the treasury and agents through the existing paths (new
  wallets, tokens shown once), open one `set-policy` approval per wallet with the instantiated
  policy, set the notification content level, create invites for template members with their
  roles (same installation only; a template from elsewhere has its members dropped). The
  template's admin threshold is shown as a reminder, not applied, because it cannot exceed the
  number of approvers yet. Appends `workspace.cloned` with the source id (or the template digest)
  in its detail.
- Routes in `packages/api/src/routes.ts`: `exportTemplate`
  `GET /api/v1/workspaces/:workspaceId/export/template`; `exportRecord`
  `GET /api/v1/workspaces/:workspaceId/export/record`; `cloneWorkspace`
  `POST /api/v1/workspaces/:workspaceId/clone`; `importTemplate` `POST /api/v1/workspaces/import`.
- Tests: `apps/server/test/lifecycle/export.test.ts` (a record verifies; changing one byte of an
  audit detail, deleting the last line, or reordering two lines fails verification; no line
  contains an agent token, a session id, a sealed blob, a confirmation link token, a push
  endpoint or a signed raw transaction);
  `apps/server/test/lifecycle/clone.test.ts` (the clone's wallets have new addresses; the
  signer holds no policy and no mandate for them until people approve; the clone has no
  intents, approvals other than the policy proposals, transactions, mandates, or audit events
  other than its own; a template that names an address list keeps it; requesters point at the
  clone's agents).

Acceptance:

- CI job `test` passes both files.

### Milestone 6: web UI and confirmation page

Scope: `apps/web`, `apps/approve`.

Delivered: "Empty this wallet" and the sweep approval card (with the sweep).

Files and interfaces:

- `apps/web/src/routes/settings.tsx`: "Export" (template, record), "Clone", "Delete workspace"
  with the preflight, a `destroyAfter` picker defaulting to the signer minimum (from
  `WorkspaceState.minDestroyDelaySeconds`), and a visible countdown with "Cancel deletion" while
  `deleting`.
- `apps/web/src/routes/wallet.tsx`: "Retire wallet", cancel.
- `apps/web/src/routes/agent.tsx`: the disable dialog says waiting payment requests end too.
- `apps/web/src/routes/approval.tsx`: descriptions for the two kinds, with the balances labelled
  "read by the server; the signer cannot check balances", and the link to the confirmation page.
- `apps/approve/public/approve.js`: text for `keys_destroyed` and `balances_unchecked`.
- `apps/web/src/lib/codes.ts`: text for the new signer error codes.
- `apps/web/dev/fixture-server.ts` and `apps/web/dev/confirm/`: fixtures for the new routes and
  the two confirmation views.
- `apps/web/test/journey.e2e.ts`: journeys "delete with balance shown, confirm, and cancel" and
  "retire a wallet", at the phone and desktop viewports used today.

Acceptance:

- CI job `ui` passes the new journeys (virtual authenticator, fixture server).
- `apps/approve` tests pass in CI job `test` with the two warnings.

### Milestone 7: release gates and documentation

Scope: `e2e/`, `.github/workflows/ci.yml` (only if a job needs a new variable), `docs/`,
`deploy/README.md`.

Delivered: the sweep gates (the draft's tests 1 and 2), by
`release-gates.spec.ts:686` with the signer's and server's sweep tests.

Files and interfaces:

- `e2e/compose.e2e.yaml`: `SIGNER_MIN_DESTROY_DELAY_SECONDS: "0"` for the gate stack only.
- `e2e/test/lifecycle.spec.ts`, run by `e2e/run.sh` on the first stack after
  `release-gates.spec.ts`:
  1. "a deleted workspace signs nothing and nothing it stored can be opened": create, propose,
     approve on the confirmation page, grant a mandate, plant markers, delete with
     `destroyAfter = now + 5`, wait for the sweeper; then `docker compose exec signer ls` shows
     no vault file for its wallets; the plaintext scanner (`packages/testkit/src/scan.ts`) finds
     no marker in Postgres or in the signer's SQLite; the signer's SQLite, read with
     `docker compose exec signer node -e` and `node:sqlite`, shows the workspace `deleted`, its
     wallets `destroyed` with empty `sealed_credential`, its mandate revoked with a blank text,
     no confirmation rows, and a last decision `delete-workspace`; `admin.ts verify-log` for the
     workspace exits 0.
  2. "approving a deletion ends its mandates at once, and cancelling keeps the keys and leaves the
     workspace paused".
  3. "a deletion waits for an unmined transaction": anvil automine off, approve, delete, the
     sweeper skips; mine; it finalizes.
  4. "after deletion and a keyring rotation, an old database copy cannot be opened": `pg_dump`
     before deletion; delete; rotate (`rotate-keyring.mjs add`, `cli.ts rewrap`,
     `prune --confirm-rewrapped`); restore the dump into a scratch database; opening a sealed
     column of the deleted workspace with the current keyring fails, and with the keyring copy
     saved before the rotation succeeds.
  5. "a scheduled deletion is announced to the webhook, signed, with no sealed content" (D10).
- `e2e/run.sh`: run `lifecycle.spec.ts` after `release-gates.spec.ts` on the first stack.
- `docs/approval-protocol.md`: §5 rows for `retire-wallet` and `delete-workspace`; §8 the destroy
  rule; §10 the routes; §11 vectors.
- `docs/threat-model.md`: a "Deleting and exporting" subsection with the table under "Threat
  model after this change" below; "Out of scope for v0.1" (`:631-632`) drops the lifecycle item.
- `docs/architecture.md` "Where state lives" (`:282-305`): what a deleted workspace leaves, in
  each store.
- `deploy/README.md` "Backups and restoring": the erasure window; rotate after deletion; keep
  keyring backups on a stated retention; a restore after a deletion brings the workspace back
  and is fenced like every restore.

Acceptance:

- CI jobs `stack (amd64)`, `stack (arm64)` pass `lifecycle.spec.ts` (all its tests). `stack
  (tls)` skips the first stack as today.
- CI job `check` passes (docs are Biome-formatted where applicable).

### Milestone 8: erasing a person (D6)

Scope: installation-level. A person asks to be erased. In scope by D6; its counsel review is
still owed and flagged for Eric, and its outcome may change what is kept, not Milestones 1 to 7.

Files and interfaces:

- `apps/server/src/identity/erase.ts`, route `POST /api/v1/me/erase` and an operator command
  `node apps/server/src/identity/erase-cli.ts --user <id>`: refuse while the person is the last
  approver able to meet any workspace's thresholds (they must be replaced first through
  `remove-approver` approvals, which also end every mandate they granted); remove memberships;
  revoke and delete `credentials`; delete `sessions`, `push_subscriptions` and
  `notification_preferences`; set `users.quiet_hours = NULL` and `users.display_name = 'Erased
  person'`; drop their `pending` deliveries; append `member.erased` to each workspace they
  belonged to. User ids stay in `audit_events.actor_id`, `approval_assertions`,
  `notification_deliveries.user_id`, and at the signer in `approvers` history, `mandate_grantors`
  and `confirmation_assertions` until those confirmations end.
- `apps/server/test/identity/erase.test.ts`.

Acceptance:

- CI job `test` passes `erase.test.ts`: after erasure the person cannot sign in, their name
  appears nowhere in the `os` schema, no push subscription of theirs remains, and every audit
  chain still verifies.

## Interfaces and Dependencies

Local interfaces:

- `Signer.sweep(walletId, request: SweepRequest): Promise<SignResponse>`: built. This plan adds
  the refusals `wallet_retired`, `workspace_deleting`, `workspace_deleted`.
- `Signer.retireWallet`, `Signer.deleteWorkspace(id, authorization): Promise<WalletState | WorkspaceState>`:
  - Failures: `wallet_set_mismatch`, `destroy_delay_out_of_range`, `envelope_fenced`,
    `conflict` (wrong state), the verification codes of `authorizedChange`.
- `Signer.cancelRetireWallet`, `Signer.cancelDeleteWorkspace`: request signature only; `conflict`
  when not in `retiring` or `deleting`.
- `Signer.finalizeRetireWallet`, `Signer.finalizeDeleteWorkspace`: request signature only;
  `destroy_not_due`; idempotent.
- `Vault.destroyWallet(walletId): void`: throws `VaultError("failed")` on anything but success or
  not-found.
- `renderConfirmation(input)`: renders `retire-wallet` and `delete-workspace` from the envelope
  and the signer's wallet records.
- `DataKeyStore.shredTenant(scope, tenantId): Promise<{ shredded: number }>`.
- `deletionPreflight(ctx, workspaceId): Promise<DeletionPreflight>` (advisory).
- `finalizeDue(ctx): Promise<{ finalized: number; skipped: number }>`.
- `writeRecord(ctx, workspaceId, sink)`, `verifyRecord(lines): { ok: boolean; brokenAt: number | null }`.
- `cloneWorkspace(ctx, session, input): Promise<{ workspaceId; approvals: ApprovalSummary[] }>`.

Dependencies on other plans:

- Trusted display (built): both new kinds are approved on the confirmation page.
- Mandates (built): retire and delete revoke mandates; the record exports them.
- Notifications (built, Ready for Review): D10 adds two events to its outbox.
- Stuck-transaction repricing (built, `8be9bd5`): signer schema version 6 and
  `cancel-transaction`, the way out of a D7 blocker; its `signature_attempts` table is blanked at
  finalize.
- Beyond one machine ([#25](https://github.com/askgina/os/issues/25), draft): the keyring and
  backup custody behind D5.

External dependencies:

- `@open-wallet-standard/core` 1.4.5:
  - Version/source checked: installed `index.d.ts` (`deleteWallet`, `exportWallet`,
    `listApiKeys`, `revokeApiKey`, `ApiKeyResult.id`), as read for the report on 2026-11-14.
  - Expected behavior: `deleteWallet` removes the wallet file; `revokeApiKey` removes the key
    file; `exportWallet(name, passphrase)` returns the mnemonic (OWS research, F7).
  - Failure handling: classified by `classifyOwsError`; "not found" on destroy is success.
- `node:sqlite` (Node 26): `PRAGMA secure_delete`, `PRAGMA user_version`,
  `PRAGMA wal_checkpoint(TRUNCATE)`, `ALTER TABLE … ADD COLUMN` with `CHECK` and a non-null
  default ([SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)).
- Workflow 5.5.0 / `@workflow/world-postgres` 5.2.0: no API change; runs end through the
  existing outbox before keys are shredded. Versions re-read in `apps/server/package.json` on
  2026-11-15.

## Threat model after this change

A compromised control plane (its process, or write access to its database):

| Can                                                                                          | Cannot                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask for a deletion or retirement people did not want, and describe it falsely in the web app | Make the confirmation page show another wallet set, address or destroy time than the envelope people sign: the signer renders it from its own records                        |
| Report false balances in the web app, so approvers acknowledge a loss they would not have    | Destroy a key without assertions at the admin threshold over an envelope naming that exact wallet set; destroy before `destroyAfter`; set a delay below the signer's minimum |
| Cancel any deletion or retirement (only delays it; keys survive)                             | Make a cancelled deletion sign again: the workspace stays paused until `resume-workspace` is approved; revive a mandate the deletion revoked                                 |
| Skip the disable extension or the cancel of waiting requests                                 | Keep a mandate of a retiring or deleting wallet signing: the signer revokes it in the transaction that applies the approval                                                  |
| Withhold or alter an export it produces; read every sealed value it could already read       | Export a wallet key: no route exists; only the signer host's admin CLI can                                                                                                   |
| Put a fabricated policy in a clone's proposals                                               | Make any clone policy effective without the clone's approvers' passkeys; give a clone an existing key or mandate                                                             |
| Leave runs unfinished or skip the sweeper, so deletion never completes                       | Revive a deleted workspace at the signer, reuse its approval ids or envelope nonces                                                                                          |

What a successful attack can gain: a misled deletion destroys funds without moving them:
sabotage, not theft, and recoverable from the operator's backups until they expire. The sweep's
bound is unchanged: it pays only to an allowlisted address or the workspace's treasury.

The signer host and the operator's backups are unchanged from v0.1: whoever holds them holds the
wallets, including destroyed ones still in backups. A deleted workspace's sealed data stays
readable to whoever holds a pre-deletion database copy and a keyring copy from before the next
rotation; its confirmation subjects and mandate texts stay readable in pre-deletion signer
backups.

## Concrete Steps

From the repository root, on main, one milestone at a time (the owner delegated the go,
2026-11-15):

    rg -n "resume-workspace|grant-mandate" packages/protocol/src apps/signer/src apps/server/src apps/approve apps/web/src   # every place a new kind must also be wired
    bun run check
    bun run typecheck
    git push   # CI runs `check`, `test`, `ui`, `stack (amd64|arm64|tls)`

Expected evidence in CI logs (jobs named as in `.github/workflows/ci.yml`):

    test   ✓ packages/protocol/test/lifecycle-envelopes.test.ts
    test   ✓ apps/signer/test/lifecycle.test.ts
    stack  ✓ lifecycle.spec.ts › a deleted workspace signs nothing and nothing it stored can be opened

Local runs of whole suites, builds or the stack wait for the owner's word, as in v0.1.

## Validation and Acceptance

Automated validation (all in CI):

- `bun run test`: the protocol, signer, keys, approve and server tests named in Milestones 1 to 6
  and 8.
- `bun run check`, `bun run typecheck`: clean.
- `ui` job: the two new journeys.
- `stack (amd64)`, `stack (arm64)`: `e2e/test/lifecycle.spec.ts`.

Manual or runtime validation:

- Start: `docker compose --profile dev up --build` with `SIGNER_MIN_DESTROY_DELAY_SECONDS=60`.
- Exercise: create a workspace and agent, grant a mandate, fund the wallet, empty it with "Empty
  this wallet", pause, delete with the earliest time and approve on the confirmation page, wait.
- Observe: the confirmation page lists the wallet and the destroy time; the mandate shows
  revoked at once; the countdown, then "Deleted"; `docker compose exec signer ls
  /data/vault/wallets` lists no file for the wallet; `node apps/signer/src/admin.ts verify-log
  --workspace <id>` exits 0.

Regression checks:

- `release-gates.spec.ts` and `browser.spec.ts` unchanged and green: lifecycle adds states but
  an `active` workspace behaves as on main.
- The restore gate ("a restored and fenced backup keeps wallets, refuses an approval used after
  the backup and every approval issued before the restore, and signs a new proposal",
  `release-gates.spec.ts:753`) and "the operator's restore fence ends every live mandate"
  (`:1741`) still pass with a signer database at the new version.
- The sweep gate (`:686`) and "disabling an agent revokes its mandates at the signer and cancels
  its waiting grants" (`:1428`) still pass.

## Idempotence and Recovery

- Migrations: the lifecycle server migration runs once under the existing advisory lock; the
  signer's `user_version` migration runs in the open transaction and is skipped once applied.
- Every signer lifecycle call is idempotent: replays of the same envelope return the state;
  finalize on a destroyed wallet or deleted workspace returns the state.
- The sweeper repeats every step safely: audit append checks the newest event; signer finalize is
  idempotent; `shredTenant` and `shred` are no-ops on tombstones; the tombstone transaction is
  conditional on `lifecycle = 'deleting'`.
- If the signer destroyed keys and the control plane crashed before shredding, the next round
  shreds. If the vault deletion succeeded and the SQLite transaction failed, the retry finds
  "not found" in OWS and completes.
- A restore of a backup taken during the delay brings back a `deleting` workspace whose
  countdown continues: finalize needs no envelope, so the restore fence does not stop it. Cancel
  it if the restore was meant to undo the deletion.
- Backout: before the first deletion is finalized, reverting the branch is safe (the new columns
  are ignored by older code; the signer's added columns have defaults). An older signer refuses
  a database at a newer version (`SchemaTooNewError`), so roll back the signer only together
  with its data volume from before the upgrade. After a finalize, keys are gone on the live
  system; recovery is restoring the backup set from before it, fenced, which also restores the
  deleted workspace and ends its mandates.

## Rollout and Operations

- Config: `SIGNER_MIN_DESTROY_DELAY_SECONDS` (default 604800), `SIGNER_MAX_DESTROY_DELAY_SECONDS`
  (default 7776000). No control-plane variable; the UI reads the minimum from
  `WorkspaceState.minDestroyDelaySeconds`.
- Migration order: signer and `approve` images first (the signer accepts older requests
  unchanged; the page needs the two warnings), then the server.
- Monitoring: log events `lifecycle.finalize_skipped` with the blocker code, `lifecycle.finalized`;
  signer decisions `retire-wallet`, `delete-workspace`, `destroy-wallet`,
  `export-wallet-by-operator`, and the mandate revocations.
- Operations doc: after a deletion, run the keyring rotation in `deploy/README.md` and note the
  date; deleted data leaves backups only when keyring copies older than that date are destroyed.
- Branch workflow: one branch, one PR per milestone or a stack, CI green per PR, as in v0.1.

## Risks and Open Questions

- Risk: a person deletes a workspace that still holds an asset the control plane did not read
  (an unlisted token, an NFT).
  Mitigation: the confirmation page says the signer cannot see balances; the web app says its
  balance list is partial and server-reported; the delay and its notifications (D10); keys remain
  in backups until they expire; the operator's `export-wallet` before restore.
- Risk: a signed, unmined transaction is broadcast after the key is gone.
  Mitigation: finalize waits for it (D7); signed raw transactions are blanked in the signer and
  the workspace key that seals `transactions.raw` is shredded; old backups still hold them. A
  `rejected` transaction whose nonce no later transaction used stays valid too; see D7.
- Risk: a compromised control plane stalls deletion forever by cancelling.
  Mitigation: visible state; the operator can run finalize from the signer host (add
  `admin.ts finalize-delete` only if this proves needed).
- Risk: the signer migration breaks an existing signer database.
  Mitigation: migration test from the previous version; release notes say "back up first".
- Risk: the signer's clock decides `destroyAfter`, as it decides mandate windows and the restore
  fence. A clock running ahead destroys early.
  Mitigation: the deploy guide's clock section already applies; the delay's minimum dwarfs any
  plausible drift.
- Risk: the tombstone transaction deadlocks with a concurrent proposal, as `FOR UPDATE` did.
  Mitigation: append the audit event first, take no stronger lock (Milestone 4 step 7); test it.

Every owner question below is answered. D3 by the owner (2026-11-14); the others by the lead under
Eric's delegation (2026-11-15), each with the option this plan recommended. Rejected options are
kept for the record.

- Question D1 (owner): what deletion does to keys. Answered (2026-11-15): (a) the signer
  destroys them after a delay it enforces, approved at the admin threshold on the confirmation
  page; irreversible acts need the signing bar and a window to notice. Not chosen: (b) destroy
  at once on approval; (c) never destroy, deletion as a permanent pause and tombstone.
- Question D2 (owner): minimum delay. Answered (2026-11-15): 7 days
  (`SIGNER_MIN_DESTROY_DELAY_SECONDS=604800`); notifications now reach people, and a week matches
  the mandate window chosen for #19. Not chosen: 0, 72 hours, 30 days.
- Question D3 (owner): sweep destinations. Answered (2026-11-14): allowlist or own treasury.
  Built and proven in CI.
- Question D4 (owner): key export. Answered (2026-11-15): signer admin CLI only
  (`admin.ts export-wallet`); it adds no power the host lacks and fits next to `fence` and
  `revoke-mandate`. Not chosen: no export at all; over HTTP encrypted to a recipient key in a
  passkey envelope.
- Question D5 (owner): erasure from backups. Answered (2026-11-15): rotate the keyring after each
  deletion, with a stated keyring backup retention in the deploy guide; the only option that ends
  the window without a keyring format change. Not chosen: document only; a KEK per workspace. The
  docs contradiction it was also about is resolved on main.
- Question D6 (owner and counsel): erasing a person under GDPR Article 17 while the audit chain
  keeps their user id. Answered for engineering (2026-11-15): erase names, passkeys, sessions,
  push subscriptions and notification settings (preferences and quiet hours), and keep ids;
  Milestone 8 is in scope. Counsel review is still owed and flagged for Eric. Not chosen: commit
  the chain to `HMAC(per-person salt, userId)` and delete the salt on erasure; no erasure
  feature.
- Question D7 (owner): finalize with an unmined transaction. Answered (2026-11-15): wait, also for
  a `rejected` transaction until a later one has used its nonce, since it can still be mined;
  repricing's `cancel-transaction` (built) clears a stuck one while paused, so waiting no longer
  means waiting forever. Not chosen: allow after an explicit acknowledgment in the envelope.
- Question D8 (owner): mandates on retire and delete. Answered (2026-11-15): revoke when the
  approval is applied, reason `requested`; a mandate signs without a person, so it must end when
  people decide, and no table rebuild is needed. Not chosen: revoke at finalize; a new reason
  such as `wallet_retired`.
- Question D9 (owner): signer-side plaintext at finalize. Answered (2026-11-15): delete the
  confirmation rows and blank mandate texts, keeping ids, hashes and counts; they are the last
  readable copies of what people and agents typed. Not chosen: keep them; delete the mandate rows
  too (breaks the append-only rule the counts rely on).
- Question D10 (owner): notify during the delay. Answered (2026-11-15): when the retirement or
  deletion is applied, and 24 hours before it finalizes; the delay protects only if someone
  notices. Not chosen: only the existing `approval.opened`; a daily reminder.
- Question D11 (owner): what clone and export carry of the new state. Answered (2026-11-15): the
  template carries the notification content level and no mandate; the record carries mandates and
  their uses. Authority is granted again, history is exported. Not chosen: clone mandates as
  proposals; leave mandates out of the record.
- Question D12 (owner): removing an agent. Answered (2026-11-15): disable is removal, and it also
  cancels the agent's waiting payment requests and revokes them at the signer; disabled is
  already final and already ends mandates. Not chosen: a separate `removed` status.

## Artifacts and Notes

Evidence on main (`2911c20`). Key lines:

    apps/signer/src/db.ts:40                sealed_credential BLOB NOT NULL
    apps/signer/src/db.ts:76                signed_transaction TEXT NOT NULL
    apps/signer/src/db.ts:205-206           const MIGRATIONS = [VERSION_1 … VERSION_5]; SCHEMA_VERSION = MIGRATIONS.length
    apps/server/src/execution/mandates.ts:590   for (const grant of waiting) await ctx.approvals.cancel(grant.id);
    apps/server/src/execution/workflow-runtime.ts:140   { [TENANT_START_OPTION]: input.workspaceId }
    apps/server/src/execution/transactions.ts:307   // Never accepted and no longer offered: its nonce is free again for this wallet.
    deploy/README.md:120-121                Back up postgres-data, server-secrets, signer-data, signer-secrets and db-secrets together, from the same moment
    packages/keys/README.md:72-75           A backup needs both the database and the keyring from the same moment … store the two archives encrypted, and apart if you can

    CI run 43710836888 (98cc6a1), stack (amd64):
      ✓ 19 test/release-gates.spec.ts:686:1 › a person empties a disabled agent's wallet to the treasury while paused, and the signer refuses any other destination (7.3s)

## Revision Notes

- 2026-11-14: First draft, from the research report for ticket #23. Nothing built.
- 2026-11-14: The sweep built as a v0.1 fix, with D3 taken. It differs from Milestones 1, 2 and 4
  as drafted: the envelope binds a hashed `Sweep` that includes the amount (no caller-chosen
  amount, no `to` in the plaintext envelope); `transactions.intent_id` is nullable instead of a
  `kind` column; the signer's migrations start at version 2 for the restore fence. The milestone
  text above still describes retire, delete, export and clone as drafted.
- 2026-11-15: Re-checked against main (`2911c20`) after trusted display, the v0.1 defect fixes,
  mandates and notifications landed. The sweep is proven in CI and its parts are removed from
  Milestones 1, 2, 4, 6 and 7. Retire and delete are approved on the signer's confirmation page
  (new subject handling and warnings in Milestone 1, `approve` text in Milestone 6). The signer
  version moves to the next free one (7 after repricing's 6) and the server migration to the next
  free number (`0007`). Retire and delete revoke mandates; finalize removes signer-side
  confirmations and blanks mandate texts; the tombstone drops undelivered notifications and
  per-workspace notification preferences; person erasure covers push subscriptions, preferences
  and quiet hours; the record exports mandates. "Remove agent" is folded into disable. The
  lifecycle step runs from the existing 3-second sweeper; the tombstone respects the
  `FOR NO KEY UPDATE` audit lock. Threat model, context, line references, validation and risks
  updated. D3 marked answered; D8-D12 added. Nothing of retire, delete, export or clone is built.
- 2026-11-15: Owner decisions D1, D2 and D4-D12 taken by the lead under Eric's delegation, each
  the recommended option (D6 owes counsel review, flagged for Eric); Decision Log, Progress and
  the open questions rewritten as answered. Milestone text follows the taken options: Milestone 8
  is in scope, D7 also waits for a `rejected` transaction whose nonce is unused, D10's webhook
  gate is unconditional. Main moved: repricing landed, so the signer migration is version 7 and
  the server migration `0008`, and finalize blanks `signature_attempts`. Milestone 1 built
  (local checks only, CI pending), with compile-keeping edits in `apps/signer` and
  `apps/approve` listed under `Surprises & Discoveries`.
