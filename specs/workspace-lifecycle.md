# Clone, export and delete a workspace whose wallets hold assets

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-14
- Links: [Ticket #23](https://github.com/askgina/os/issues/23) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](./research/workspace-lifecycle.md) | [v0.1 ExecPlan](./agent-workspaces-v0.1.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

v0.1 can create a workspace and pause it. It cannot end one. A person who is done with a
workspace has no way to move its money out except through an agent, no way to stop its keys from
existing, and no record to take away. This plan adds the rest of the lifecycle:

- **Sweep** a wallet: a person moves the whole balance of one asset to an address the approvers
  already allowed, with passkeys at the workspace's admin threshold. No agent is needed and the
  wallet's caps do not apply.
- **Retire** a wallet and **remove** an agent: the agent loses its token at once; the wallet's key
  is destroyed by the signer after a delay, once enough approvers signed for it.
- **Delete** a workspace: the same, for every wallet at once, followed by shredding the
  workspace's data key and the keys of all its workflow runs, and a tombstone.
- **Export** a workspace: a template (configuration, no secrets) and a record (the opened audit
  log with its hash chain, intents, transactions and the signer's decision log), verifiable
  offline.
- **Clone** a workspace from a template: fresh wallets, fresh tokens, policies proposed for the
  new workspace's approvers to approve.

The rule from v0.1 stays: the signer decides whether people approved, and does only what they
approved. Destroying a key is treated like signing: the signer verifies the passkey assertions
itself, against its own approver registry, and enforces a delay the control plane cannot shorten.

Non-goals: copying or moving a key between workspaces; exporting a key over HTTP; a per-workspace
encrypted backup; erasing data from backups the operator keeps; operations that are not EVM
transfers; batching several assets into one passkey ceremony (waits for
[#19](https://github.com/askgina/os/issues/19)); repricing a stuck transaction
([#22](https://github.com/askgina/os/issues/22)).

Success means:

- An approver deletes a workspace from the UI. Until the delay ends, any member can cancel. After
  it, the signer refuses every request for that workspace, the OWS vault holds no file for its
  wallets, and no sealed column or workflow payload of that workspace can be opened.
- A sweep to an address outside the wallet's recipient allowlist (and not the workspace's
  treasury) is refused by the signer even when the control plane asks for it with valid
  assertions.
- After a deletion and a keyring rotation, a copy of the database taken before the deletion
  cannot be opened with the current keyring. The same copy opens with the old keyring: backups
  hold deleted data until their keyring copies expire, and the deploy guide says so.
- An exported record verifies offline, and editing any line of it makes verification fail.
- A clone has no key, intent, approval, transaction, audit entry or workflow run of its source.

## Progress

- [x] (2026-11-14 21:30Z) Research: what a workspace owns, what v0.1 can do, what the signer can and cannot see. See the report.
- [x] (2026-11-14 21:30Z) Draft this plan with recommended options; owner decisions listed under Risks and Open Questions.
- [ ] Owner decisions D1-D7 taken and recorded in the Decision Log.
- [ ] Milestone 1: protocol.
- [ ] Milestone 2: signer.
- [ ] Milestone 3: key store.
- [ ] Milestone 4: control plane, sweep, retire, delete, remove agent.
- [ ] Milestone 5: export and clone.
- [ ] Milestone 6: web UI.
- [ ] Milestone 7: release gates and documentation.
- [ ] Milestone 8: erasing a person (only if D6 says so).

## Surprises & Discoveries

- Observation: in v0.1 only agents can move funds. `Intent.agentId` is required and the policy
  must list the agent in `requesters`. A wallet whose agent is gone cannot be emptied at all.
  Evidence: `packages/protocol/src/intent.ts:80-94`, `packages/protocol/src/evaluate.ts:38-40`.
- Observation: the signer cannot see balances. It has no network path to a chain. "Refuse while
  assets remain" can only be advisory at the control plane.
  Evidence: report, finding 4.
- Observation: a signed transaction that was never mined stays valid after its key is destroyed,
  and nobody can replace it. Anyone with a copy can broadcast it later.
  Evidence: report, finding 5; `apps/signer/src/db.ts:68-76` keeps signed transactions in plaintext.
- Observation: a full backup set taken before a deletion restores the deleted workspace readable.
  The keyring is backed up "together" with the database (`deploy/README.md:60-62`), while the keys
  package says to keep it "out of backups that sit next to the database" (`packages/keys/README.md:72-73`).
  Evidence: report, finding 6.
- Observation: shredding a run key while its run is waiting makes the run retry forever.
  Evidence: `docs/threat-model.md:189-191`; report, finding 10.
- Observation: the signer's SQLite schema has no migration step; every table is
  `CREATE TABLE IF NOT EXISTS`. Adding columns needs one.
  Evidence: `apps/signer/src/db.ts:9-115`.

## Decision Log

Recommended decisions, pending the owner. Each names its open question (D1-D7) in Risks and
Open Questions.

- Decision (pending D1): deletion destroys wallet keys at the signer, after a delay the signer
  enforces, authorized by a `delete-workspace` envelope at the admin threshold that names the
  exact wallet set.
  Rationale: destroying a key with assets is irreversible, so it must meet the same bar as
  signing; the signer cannot check balances, so a delay and a free cancel are the protection.
  Date/Author: 2026-11-14 / delegated agent
- Decision (pending D2): `SIGNER_MIN_DESTROY_DELAY_SECONDS` defaults to 604800 (7 days).
  Rationale: long enough for a person to notice a request they did not mean; short enough to end
  a workspace within a week.
  Date/Author: 2026-11-14 / delegated agent
- Decision (pending D3): a new `sweep-wallet` envelope; its destination must be in the wallet's
  current recipient allowlist, or be the address of the same workspace's treasury.
  Rationale: emptying a wallet must not need an agent or a raised cap, and a sweep has no cap, so
  its destination must have been approved earlier.
  Date/Author: 2026-11-14 / delegated agent
- Decision (pending D4): wallet keys are exported only by `admin.ts export-wallet` on the signer
  host. No HTTP route.
  Rationale: over HTTP the control plane relays the recipient key; a passkey proves only a digest.
  Date/Author: 2026-11-14 / delegated agent
- Decision (pending D5): after each deletion the operator rotates the keyring; the deploy guide
  states that deleted data stays in backups until the keyring copies older than that rotation
  are destroyed.
  Rationale: a shredded key is gone only when the KEK that wrapped it is gone everywhere.
  Date/Author: 2026-11-14 / delegated agent
- Decision (pending D7): finalize waits while any transaction of the workspace is `signed`,
  `broadcast` or `stuck`.
  Rationale: finding 5 of the report.
  Date/Author: 2026-11-14 / delegated agent
- Decision: clone is a template at the control plane; no signer change; no key is ever copied.
  Rationale: report, finding 9 and options for clone.
  Date/Author: 2026-11-14 / delegated agent
- Decision: a deleted workspace leaves a tombstone (ids, statuses, timestamps, hashes, addresses,
  the audit chain, the signer's decision log, used nonces); names and labels are cleared;
  memberships, invites, approver mirrors and assertions are deleted.
  Rationale: used nonces and approval ids must stay to refuse replays; the chain stays verifiable
  without the shredded key; nothing readable about what people typed remains.
  Date/Author: 2026-11-14 / delegated agent

## Outcomes & Retrospective

- Outcome: none yet. Nothing is built.
  Evidence: none.
  Remaining: everything below.

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

- **Sweep**: one transaction that moves a caller-chosen amount of one asset out of a wallet to a
  destination the approvers allowed earlier.
- **Retire**: start the destruction of one wallet's key. During the delay the wallet signs
  nothing; it can be cancelled.
- **Held**: a wallet whose retirement was cancelled. Its key exists; it signs nothing until a new
  policy is approved for it.
- **Destroy**: the signer deletes the wallet's OWS wallet file and API key file and its sealed
  token. Irreversible on the live system.
- **Finalize**: the step after the delay that destroys keys and shreds data keys.
- **Tombstone**: what stays after finalize, so ids cannot be reused and replays stay refused.
- **Template**: an export of configuration only. **Record**: an export of history.

Current behavior (source-read; see the report for line numbers):

- `apps/server/src/db/schema.ts`: workspace-owned tables `workspaces`, `memberships`,
  `approver_credentials`, `invites`, `wallets`, `agents`, `approvals`, `approval_assertions`,
  `approval_rejections`, `intents`, `transactions`, `audit_events`, `nonce_reservations`.
  `agents.status` is `active` or `disabled`. `transactions.intent_id` is not null.
- `apps/server/src/directory/routes.ts:300-330` pauses through the signer; `700-720` disables an
  agent in the control plane only.
- `apps/server/src/directory/kinds.ts` registers the non-signing approval kinds
  (`set-policy`, `add-approver`, `remove-approver`, `set-admin-threshold`, `resume-workspace`);
  `apps/server/src/execution/intents.ts:956` registers `approve-intent`.
- `apps/server/src/execution/chains.ts:116-144` reads native and ERC-20 balances.
- `apps/server/src/audit.ts`: the per-workspace hash chain; details sealed with a salt.
- `packages/keys/src/data-key-store.ts`: `getOrCreate`, `get`, `rewrap`, `shred`; scopes `run`
  and `workspace`; `tenant_id` recorded per key. `packages/keys/src/cli.ts`: `rewrap`, `shred`.
- `packages/world/src/index.ts:55-65`: each run key is created with the workspace as tenant.
- `apps/signer/src/db.ts`: the signer's tables; no migrations; `secure_delete` off.
- `apps/signer/src/signer.ts`: `authorizedChange` (357-397) is the shape of every non-signing
  envelope; `sign` (710-828) is the signing rule; `pauseWorkspace` (461-470).
- `apps/signer/src/vault.ts`: `Vault` has `createWallet` and `signEvmTransaction` only.
- `apps/signer/src/admin.ts`: `enroll-approver`, `verify-log`.
- `packages/protocol/src/envelopes.ts`, `packages/protocol/src/signer/api.ts`: the contract.
- `packages/api/src/routes.ts`: the REST contract shared by UI, scripts and tests.
- `e2e/run.sh:61` runs `release-gates.spec.ts`; `:81` runs `browser.spec.ts`.

How the pieces fit together:

A person acts in the web UI. The control plane opens an approval request whose envelope is the
passkey challenge, collects assertions, and then a handler for that approval kind calls the
signer with the authorization. The signer verifies every assertion against its own approver
registry and threshold, records the envelope nonce as used, and applies the effect in one SQLite
transaction, writing a decision-log entry. This plan adds three envelope kinds that go through
exactly that path, three request-signature-only signer calls that only remove authority or run a
step already authorized, and a control-plane sweeper that drives deletion to its end.

Assumptions:

- The v0.1 Compose layout: one signer, one Postgres, one keyring file. Multi-machine custody is
  [#25](https://github.com/askgina/os/issues/25).
- `@open-wallet-standard/core` stays at 1.4.5. Its `deleteWallet`, `revokeApiKey`, `listApiKeys`
  and `exportWallet` are used as declared in its `index.d.ts`. If 1.4.5 behaves otherwise, the
  real-OWS test in Milestone 2 fails and the vault code changes, not the protocol.

## Plan of Work

### Milestone 1: protocol

Scope: the hashed structures and the signer contract. First, because every later milestone
depends on them and their digests are pinned.

Files and interfaces:

- `packages/protocol/src/envelopes.ts`: add
  - `WalletRef = z.strictObject({ walletId: WalletId, address: Address })`.
  - `SweepWalletEnvelope`: header plus `type: "sweep-wallet"`, `walletId`, `chainId: ChainId`,
    `asset: AssetRef`, `to: Address`, `maxFeeWei: PositiveAmount`. Refine: `to` is not the zero
    address; for an ERC-20 `asset`, `to !== asset`.
  - `RetireWalletEnvelope`: header plus `type: "retire-wallet"`, `wallet: WalletRef`,
    `destroyAfter: EpochSeconds`.
  - `DeleteWorkspaceEnvelope`: header plus `type: "delete-workspace"`,
    `wallets: z.array(WalletRef).max(256)` sorted by `walletId` without duplicates (may be empty),
    `destroyAfter: EpochSeconds`.
  - Add all three to the `Envelope` union. `destroyAfter > issuedAt` is checked by refine.
- `packages/protocol/src/signer/api.ts`:
  - Routes: `sweep` `POST /v1/wallets/:walletId/sweep`; `retireWallet`
    `POST /v1/wallets/:walletId/retire`; `cancelRetireWallet`
    `POST /v1/wallets/:walletId/retire/cancel`; `finalizeRetireWallet`
    `POST /v1/wallets/:walletId/retire/finalize`; `deleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete`; `cancelDeleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete/cancel`; `finalizeDeleteWorkspace`
    `POST /v1/workspaces/:workspaceId/delete/finalize`.
  - `SweepRequest = { authorization, amount: PositiveAmount, transaction: TransactionParams }`;
    response `SignResponse`.
  - `retireWallet` and `deleteWorkspace` take `AuthorizedRequest`. The cancel and finalize calls
    take `z.strictObject({ workspaceId })` (wallet routes) or no body (workspace routes).
  - `WorkspaceState` gains `state: "active" | "deleting" | "deleted"` and
    `destroyAfter: EpochSeconds.nullable()`. `WalletState` gains
    `state: "active" | "retiring" | "held" | "destroyed"` and `destroyAfter`.
  - `SignerErrorCode` gains `workspace_deleting`, `workspace_deleted`, `wallet_retired`,
    `wallet_set_mismatch`, `destroy_delay_out_of_range`, `destroy_not_due`,
    `sweep_destination_not_allowed`, all 403 except `destroy_not_due` (409).
- `packages/protocol/src/signer/client.ts`: one method per new route.
- `packages/protocol/test/lifecycle-envelopes.test.ts`: accept and reject cases for each schema;
  pinned digest vectors; an assertion over one kind does not verify as another kind.
- `docs/approval-protocol.md` §5 table rows and §11 vectors for the three kinds.

Work: follow the existing envelope style (strict objects, header spread, sorted sets via
`isSortedUnique`). Pin the vectors by computing them in the test from fixed inputs and comparing
with literal hex, as `packages/protocol/test/digests.test.ts` does.

Acceptance:

- CI job `test` (`bun run test`) passes `packages/protocol/test/lifecycle-envelopes.test.ts`,
  including: a `delete-workspace` envelope with unsorted wallets is rejected; a
  `sweep-wallet` with `to` equal to the zero address is rejected; the three pinned digests match.
- CI job `check` passes (`bun run check`, `bun run typecheck`).

### Milestone 2: signer

Scope: `apps/signer`. The irreversible steps live here.

Files and interfaces:

- `apps/signer/src/db.ts`:
  - Migrations by `PRAGMA user_version`. Version 1 is the v0.1 schema (a file with tables and
    `user_version = 0` is taken as version 1). Version 2:

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
  - `sweep(request)`: shaped like `sign`. Checks in order: envelope type and workspace; wallet
    exists, belongs to the workspace, `state = 'active'`; workspace `state = 'active'` (paused is
    allowed: a sweep is how a paused workspace is emptied); assertions at the **admin**
    threshold, admin TTL; `gas × maxFeePerGas ≤ envelope.maxFeeWei` and priority fee ≤ max fee;
    if the wallet has a policy, `envelope.maxFeeWei ≤ policy.fees.maxPerTxWei` and `chainId` is
    in `policy.chains`; destination rule: `to` is in the current policy's `recipients.addresses`
    when its mode is `allowlist`, or `to` is the address of the workspace's treasury wallet and
    the swept wallet is not that treasury; else `sweep_destination_not_allowed`. Inside the
    transaction: replay check, approvers still present, consume nonce, build the transfer (native
    `value = amount`; ERC-20 `transfer(to, amount)`), sign, `isSignedBy`, record approval
    `signed`, signature and spend. One approval, one signature.
  - `retireWallet(walletId, authorization)`: through `authorizedChange`. Checks:
    `envelope.wallet` equals the signer's wallet id and address; wallet state `active` or `held`;
    `destroyAfter − issuedAt` within the configured range. Apply: state `retiring`,
    `destroy_after`.
  - `cancelRetireWallet(walletId, workspaceId)`: request signature only. `retiring` → `held`.
    Decision `cancel-retire-wallet`.
  - `finalizeRetireWallet(walletId, workspaceId)`: request signature only. Refuses with
    `destroy_not_due` before `destroy_after`. Then `vault.destroyWallet`, and in one transaction:
    `sealed_credential = x''`, `state = 'destroyed'`, `destroyed_at`,
    `UPDATE signatures SET signed_transaction = '' WHERE wallet_id = ?`, decision
    `destroy-wallet`. Then `PRAGMA wal_checkpoint(TRUNCATE)`. A repeat on a destroyed wallet
    returns its state.
  - `deleteWorkspace(workspaceId, authorization)`: through `authorizedChange`. Checks: the
    envelope's wallet set equals the signer's wallets of this workspace whose state is not
    `destroyed` (`wallet_set_mismatch` otherwise); delay range; workspace state `active`. Apply:
    `paused = 1`, `state = 'deleting'`, `destroy_after`; every listed wallet `retiring` with the
    same `destroy_after`.
  - `cancelDeleteWorkspace(workspaceId)`: request signature only. `deleting` → `active` with
    `paused = 1` (resuming still needs `resume-workspace`); wallets that were set `retiring` by
    this deletion go back to `active`. Decision `cancel-delete-workspace`.
  - `finalizeDeleteWorkspace(workspaceId)`: request signature only. `destroy_not_due` before
    `destroy_after`. Destroy every wallet as above; `DELETE FROM approvers WHERE workspace_id`;
    `state = 'deleted'`; decision `delete-workspace`. Keep `used_nonces`, `approvals`, `spends`,
    `policies`, `decisions`.
  - Everywhere else: `sign`, `setPolicy`, `addApprover`, `removeApprover`, `setAdminThreshold`,
    `resumeWorkspace` refuse with `workspace_deleting` or `workspace_deleted` by workspace state,
    and `sign` refuses `wallet_retired` for a wallet not `active`. `setPolicy` on a `held`
    wallet sets it back to `active` (a new policy approved at the admin threshold is the way back).
    `createWallet` refuses in a workspace that is not `active`.
  - `createWorkspace` for an id that exists in state `deleted` answers `conflict`.
- `apps/signer/src/index.ts`: route the seven new contract routes.
- `apps/signer/src/admin.ts`: `export-wallet --workspace <ws> --wallet <wal> --out <path>`.
  Refuses a destroyed wallet; writes the mnemonic to `--out` with mode 0600 (refuses if the file
  exists); appends decision `export-wallet-by-operator`; prints one JSON line without the secret.
- Tests:
  - `apps/signer/test/lifecycle.test.ts` (test vault):
    sweep to an allowlisted address signs once and replays the same transaction; sweep to an
    address outside the allowlist, and to the treasury from the treasury, is refused; sweep below
    the admin threshold is refused; sweep of a `retiring` wallet is refused; retire then `sign`
    is refused with `wallet_retired`; finalize before `destroy_after` is `destroy_not_due`;
    finalize after it destroys the key (the test vault no longer has it) and a second finalize
    returns the same state; cancel makes the wallet `held`, `sign` still refused, a new policy
    makes it `active`; delete with a wallet missing from the envelope, or an extra one, is
    `wallet_set_mismatch`; delete with a delay below the minimum is
    `destroy_delay_out_of_range`; during `deleting`, `addApprover`, `setPolicy` and
    `resumeWorkspace` are refused; cancel leaves `paused`; after finalize every route for the
    workspace except `getWorkspace` and `listDecisions` is refused, `createWorkspace` with the
    same id is `conflict`, a reused envelope nonce is still `nonce_reused`, and `verify-log`
    passes.
  - `apps/signer/test/ows.test.ts`: with real OWS 1.4.5, `destroyWallet` leaves no file under
    `wallets/` or `keys/` naming the wallet, and a second call succeeds.
  - `apps/signer/test/admin.test.ts`: `export-wallet` writes a 0600 file whose mnemonic derives
    the wallet's address, refuses an existing `--out` and a destroyed wallet, and logs the
    decision.
  - `apps/signer/test/migrations.test.ts`: a SQLite file created with the v0.1 schema (copied
    into `apps/signer/test/fixtures/signer-v1.sql`) opens, migrates to version 2, and keeps its
    rows and decision-log head.

Acceptance:

- CI job `test` passes the four files above.
- CI jobs `stack (amd64)`, `stack (arm64)`, `stack (tls)` still pass (the signer image starts on
  a fresh volume at version 2).

### Milestone 3: key store

Scope: `packages/keys`. Shred every run key of one workspace.

Files and interfaces:

- `packages/keys/src/data-key-store.ts`:
  - In `migrateKeys`: `CREATE INDEX IF NOT EXISTS data_keys_tenant_idx ON os_keys.data_keys (scope, tenant_id) WHERE shredded_at IS NULL`.
  - `shredTenant(scope: KeyScope, tenantId: string): Promise<{ shredded: number }>`: one
    `UPDATE … SET kek_id = NULL, wrapped_key = NULL, shredded_at = now() WHERE scope = $1 AND tenant_id = $2 AND shredded_at IS NULL RETURNING key_id`;
    evict each returned id from the cache.
- `packages/keys/src/cli.ts`: `shred-tenant <run|workspace> <tenant id>`, exit 0 with a count
  (0 is not an error: a repeat finds nothing).
- `packages/keys/test/data-key-store.test.ts`, `packages/keys/test/cli.test.ts`: two tenants'
  run keys; shredding one tenant leaves the other readable; `get` of a shredded run throws
  `DataKeyUnavailableError`; `getOrCreate` of a shredded id does not mint a key; a repeat
  returns 0.

Acceptance:

- CI job `test` passes the cases above.

### Milestone 4: control plane, sweep, retire, delete, remove agent

Scope: `apps/server`, `packages/api`. Depends on Milestones 1 to 3.

Files and interfaces:

- `apps/server/src/db/migrations/0002_lifecycle.sql` and `apps/server/src/db/schema.ts`:
  - `workspaces.lifecycle text NOT NULL DEFAULT 'active'` (`active`, `deleting`, `deleted`),
    `workspaces.destroy_after timestamptz`, `workspaces.deleted_at timestamptz`.
  - `wallets.lifecycle text NOT NULL DEFAULT 'active'` (`active`, `retiring`, `held`,
    `destroyed`), `wallets.destroy_after timestamptz`.
  - `agents.status` admits `removed`.
  - `transactions.intent_id` becomes nullable; `transactions.kind text NOT NULL DEFAULT 'intent'`
    (`intent`, `sweep`), with `CHECK ((kind = 'intent') = (intent_id IS NOT NULL))`.
- `apps/server/src/lifecycle/kinds.ts`: approval kind handlers in `registerLifecycleKinds`,
  called at boot next to `registerDirectoryKinds` (`apps/server/src/directory/kinds.ts:416`) and
  `registerIntentKind` (`apps/server/src/execution/intents.ts:954`):
  - `sweep-wallet`: opening requires owner role and a wallet in `active` lifecycle; threshold is
    the workspace's admin threshold. The server does not pre-filter the destination (the web UI
    offers only allowed ones); the signer's refusal becomes the approval's `failure_code`, so the
    release gate can prove the signer enforces it. Applying: read the balance (`chains.balances`), compute the
    amount (native: `balance − gas × maxFeePerGas`, refused with `nothing_to_sweep` when not
    positive; ERC-20: `balanceOf`), reserve a nonce (`nonce_reservations`), call
    `signer.sweep`, insert a `transactions` row with `kind = 'sweep'`, broadcast and watch with
    the existing steps in `apps/server/src/execution/steps.ts`.
  - `retire-wallet`: opening requires owner role; the envelope's wallet is read from the signer
    (`getWallet`), never from the control plane's mirror. Applying: `signer.retireWallet`,
    mirror the state.
  - `delete-workspace`: opening requires owner role and a paused workspace; the envelope's
    wallet set is built from the signer's own answer (`getWallet` for each mirrored wallet, plus
    a check that the signer reports no other). Applying: `signer.deleteWorkspace`, mirror.
- `apps/server/src/lifecycle/preflight.ts`: `deletionPreflight(ctx, workspaceId)` returns per
  wallet the balances of native coin and every asset in its policy, `source: "control-plane"`,
  and blockers: `pending_approvals`, `unfinished_runs`, `unmined_transactions`,
  `nonzero_balance`. Advisory; the UI shows it on the request and on the approval card.
- `apps/server/src/lifecycle/finalize.ts`: `startLifecycleSweeper(ctx)`, started by
  `startBackground` (`apps/server/src/execution/index.ts`, called from `apps/server/src/main.ts:68`),
  every 60 seconds:
  1. For each wallet `retiring` and each workspace `deleting` whose `destroy_after` passed.
  2. Cancel pending approvals of the subject (status `cancelled`, `signer.revokeApproval`,
     resume outbox set to `needed` so the run ends). If a run of the workspace is not finished
     (`approvals.run_id` of rows not in a final status), skip this round.
  3. If a transaction of the subject is `signed`, `broadcast` or `stuck`, skip and keep the
     blocker visible (pending D7).
  4. Append the audit event (`wallet.destroyed` or `workspace.deleted`) unless the newest event
     for the subject already is that one.
  5. Call `signer.finalizeRetireWallet` or `signer.finalizeDeleteWorkspace`. `destroy_not_due`
     means the clocks differ: skip this round.
  6. For a workspace: `keys.shredTenant("run", workspaceId)`, then
     `keys.shred("workspace", workspaceId)`.
  7. Tombstone in one transaction: `workspaces.name = 'Deleted workspace'`,
     `lifecycle = 'deleted'`, `deleted_at`; `wallets.label = ''`, `lifecycle = 'destroyed'`;
     agents `status = 'removed'`, `name = 'Removed agent'`,
     `token_hash = 'removed:' || id`; delete `memberships`, `invites`, `approver_credentials`,
     `approval_assertions`, `approval_rejections`, `nonce_reservations` of the workspace.
  8. Log `lifecycle.finalized` with ids and counts, and print the keyring rotation commands
     once per workspace deletion (pending D5).
- `apps/server/src/lifecycle/routes.ts` and `packages/api/src/routes.ts`:
  - `getDeletionPreflight` `GET /api/v1/workspaces/:workspaceId/delete/preflight`.
  - `requestDeleteWorkspace` `POST /api/v1/workspaces/:workspaceId/delete`
    `{ destroyAfter }` → `ApprovalSummary`. Refused with `conflict` unless paused.
  - `cancelDeleteWorkspace` `POST /api/v1/workspaces/:workspaceId/delete/cancel`: any member.
  - `requestSweep` `POST /api/v1/workspaces/:workspaceId/wallets/:walletId/sweep`
    `{ chainId, asset, to, maxFeeWei }` → `ApprovalSummary`.
  - `requestRetireWallet`, `cancelRetireWallet` on
    `/api/v1/workspaces/:workspaceId/wallets/:walletId/retire[/cancel]`.
  - `removeAgent` `POST /api/v1/workspaces/:workspaceId/agents/:agentId/remove`: owner;
    `status = 'removed'`, pending intents of the agent cancelled and revoked at the signer. The
    wallet stays; the UI then offers sweep and retire.
  - The MCP gateway (`apps/server/src/mcp/gateway.ts`) treats `removed` like `disabled`; every
    route refuses a workspace whose lifecycle is not `active` with `conflict`, except pause, the
    cancel routes and reads.
- Tests, with the fake signer, the soft authenticator and the test chain:
  - `apps/server/test/lifecycle/delete.test.ts`: request, approve, cancel, request again,
    approve, advance the clock, sweeper finalizes; afterwards opening any sealed column of the
    workspace throws `DataKeyUnavailableError`, and so does reading a payload of any of its runs
    through the World; the audit chain still verifies and its last
    action is `workspace.deleted`; the run of a pending approval ended before shredding; an
    unmined transaction blocks finalize until it confirms; a crash between steps 5 and 6
    (simulated by throwing once) completes on the next round.
  - `apps/server/test/lifecycle/sweep.test.ts`: native sweep leaves less than
    `gas × maxFeePerGas` behind; ERC-20 sweep leaves zero; a disabled agent's wallet is swept.
  - `apps/server/test/lifecycle/agent.test.ts`: a removed agent's token gets 403 at the gateway;
    its pending intents end `cancelled` and are revoked at the signer.

Acceptance:

- CI job `test` passes the three files; `bun run build:workflows` still builds (the workflow
  bundle is unchanged).

### Milestone 5: export and clone

Scope: `apps/server/src/lifecycle/`. Independent of Milestones 2 to 4 except for the shared
schema; may run in parallel with Milestone 4.

Files and interfaces:

- `apps/server/src/lifecycle/template.ts`: `WorkspaceTemplate` (zod, strict):
  `{ format: "askgina.os/workspace-template/v1", name, adminThreshold, wallets: [{ ref, kind, label, agent: { name } | null, policy: PolicyTemplate | null }], members: [{ userId, role }] }`.
  `PolicyTemplate` is `WalletPolicy` without `v`, `workspaceId`, `walletId`, `revision`,
  `previousHash`, and with `requesters` as wallet `ref`s of template agents.
  `toTemplate(ctx, workspaceId)` and `instantiatePolicy(template, ids)` (revision 1, new ids).
- `apps/server/src/lifecycle/export.ts`: `writeRecord(ctx, workspaceId, sink)` streams JSON Lines:
  a header `{ format: "askgina.os/workspace-record/v1", workspaceId, exportedAt, auditHead: { seq, hash }, signerDecisionHead: { seq, hash } }`,
  then `audit` lines (chained fields, `salt`, opened `detail`), `intent`, `transaction`,
  `policy-revision` and `signer-decision` lines. Owner role and a passkey sign-in no older than
  300 seconds (`sessions.created_at`); appends `workspace.exported`.
- `apps/server/src/audit.ts`: export `auditEntryHash(fields)` and the sealed-detail digest so the
  verifier uses the same code.
- `apps/server/src/lifecycle/verify-record.ts`: `verifyRecord(lines)` and a CLI
  (`node apps/server/src/lifecycle/verify-record.ts <file>`) that recomputes every audit hash,
  every detail digest from `salt` and `detail`, the chain links, the head, and the signer
  decision chain; exit 0 when valid, 2 with the first broken line otherwise.
- `apps/server/src/lifecycle/clone.ts`: `cloneWorkspace(ctx, session, { sourceId | template, name, includeAgents, includeMembers })`:
  create the workspace through the existing directory path (the person cloning is its first
  approver at the signer), create the treasury and agents through the existing paths (new
  wallets, tokens shown once), open one `set-policy` approval per wallet with the instantiated
  policy, create invites for template members with their roles (same installation only; a
  template from elsewhere has its members dropped). The template's admin threshold is shown as a
  reminder, not applied, because it cannot exceed the number of approvers yet. Appends
  `workspace.cloned` with the source id (or the template digest) in its detail.
- Routes in `packages/api/src/routes.ts`: `exportTemplate`
  `GET /api/v1/workspaces/:workspaceId/export/template`; `exportRecord`
  `GET /api/v1/workspaces/:workspaceId/export/record`; `cloneWorkspace`
  `POST /api/v1/workspaces/:workspaceId/clone`; `importTemplate` `POST /api/v1/workspaces/import`.
- Tests: `apps/server/test/lifecycle/export.test.ts` (a record verifies; changing one byte of an
  audit detail, deleting the last line, or reordering two lines fails verification; no line
  contains an agent token, a session id, a sealed blob or a signed raw transaction);
  `apps/server/test/lifecycle/clone.test.ts` (the clone's wallets have new addresses; the
  signer holds no policy for them until the `set-policy` approvals are approved; the clone has no
  intents, approvals other than the policy proposals, transactions, or audit events other than
  its own; a template that names an address list keeps it; requesters point at the clone's
  agents).

Acceptance:

- CI job `test` passes both files.

### Milestone 6: web UI

Scope: `apps/web`.

Files and interfaces:

- `apps/web/src/routes/settings.tsx`: "Export" (template, record), "Clone", "Delete workspace"
  with the preflight, a `destroyAfter` picker defaulting to the signer minimum, and a visible
  countdown with "Cancel deletion" while `deleting`.
- `apps/web/src/routes/wallet.tsx`: "Empty this wallet" (one sweep request per asset with a
  balance), "Retire wallet", cancel.
- `apps/web/src/routes/agent.tsx`: "Remove agent".
- `apps/web/src/routes/approval.tsx`: cards for the three kinds. The delete and retire cards show
  every wallet id and full address from the envelope, the destroy time, and the balances labelled
  "read by the server; the signer cannot check balances". The sweep card shows asset, full
  destination address and that caps do not apply.
- `apps/web/dev/fixture-server.ts`: fixtures for the new routes.
- `apps/web/test/journey.e2e.ts`: journeys "delete with balance shown and cancel", "sweep a
  wallet", at the phone and desktop viewports used today.

Acceptance:

- CI job `ui` passes the new journeys (virtual authenticator, fixture server).

### Milestone 7: release gates and documentation

Scope: `e2e/`, `.github/workflows/ci.yml` (only if a job needs a new variable), `docs/`,
`deploy/README.md`.

Files and interfaces:

- `e2e/compose.e2e.yaml`: `SIGNER_MIN_DESTROY_DELAY_SECONDS: "0"` for the gate stack only.
- `e2e/test/lifecycle.spec.ts`, run by `e2e/run.sh` on the first stack after
  `release-gates.spec.ts`:
  1. "a wallet swept to its allowlisted address keeps only dust": native and ERC-20 on anvil.
  2. "the signer refuses a sweep to an address the approvers never allowed": request a sweep to
     an unlisted address through the API and approve it with the soft authenticator; the approval
     ends `failed` with `sweep_destination_not_allowed` from the signer, and the chain shows no
     transaction from the wallet.
  3. "a deleted workspace signs nothing and nothing it stored can be opened": create, propose,
     approve, plant markers, delete with `destroyAfter = now + 5`, wait for the sweeper; then
     `docker compose exec signer ls` shows no vault file for its wallets; the plaintext scanner
     (`packages/testkit/src/scan.ts`) finds no marker; the signer's SQLite, read with
     `docker compose exec signer node -e` and `node:sqlite`, shows the workspace `deleted`, its
     wallets `destroyed` with empty `sealed_credential`, and a last decision `delete-workspace`;
     `admin.ts verify-log` for the workspace exits 0.
  4. "cancelling a deletion keeps the keys and leaves the workspace paused".
  5. "a deletion waits for an unmined transaction": anvil automine off, approve, delete, the
     sweeper skips; mine; it finalizes.
  6. "after deletion and a keyring rotation, an old database copy cannot be opened": `pg_dump`
     before deletion; delete; rotate (`rotate-keyring.mjs add`, `cli.ts rewrap`,
     `prune --confirm-rewrapped`); restore the dump into a scratch database; opening a sealed
     column of the deleted workspace with the current keyring fails, and with the keyring copy
     saved before the rotation succeeds.
- `e2e/run.sh`: run `lifecycle.spec.ts` after `release-gates.spec.ts` on the first stack.
- `docs/approval-protocol.md`: §5 rows for `sweep-wallet`, `retire-wallet`,
  `delete-workspace`; §8 the sweep rule and the destroy rule; §11 vectors.
- `docs/threat-model.md`: a "Deleting and exporting" subsection with the table under "Threat
  model after this change" below; "Out of scope" drops lifecycle.
- `docs/architecture.md` "Where state lives": what a deleted workspace leaves.
- `deploy/README.md`: "Deleting a workspace, and what backups still hold": the erasure window;
  rotate after deletion; keep keyring backups on a stated retention; resolve the conflict with
  `packages/keys/README.md:72-73` in one direction.

Acceptance:

- CI jobs `stack (amd64)`, `stack (arm64)` pass `lifecycle.spec.ts` (all six tests). `stack
  (tls)` skips the first stack as today.
- CI job `check` passes (docs are Biome-formatted where applicable).

### Milestone 8: erasing a person (only if D6 chooses it)

Scope: installation-level. A person asks to be erased.

Files and interfaces:

- `apps/server/src/identity/erase.ts`, route `POST /api/v1/me/erase` and an operator command
  `node apps/server/src/identity/erase-cli.ts --user <id>`: refuse while the person is the last
  approver able to meet any workspace's thresholds (they must be replaced first through
  `remove-approver` approvals); remove memberships; revoke and delete `credentials`; delete
  `sessions`; set `users.display_name = 'Erased person'`; append `member.erased` to each
  workspace they belonged to. User ids stay in `audit_events.actor_id` and
  `approval_assertions`.
- `apps/server/test/identity/erase.test.ts`.

Acceptance:

- CI job `test` passes `erase.test.ts`: after erasure the person cannot sign in, their name
  appears nowhere in the `os` schema, and every audit chain still verifies.

## Interfaces and Dependencies

Local interfaces:

- `Signer.sweep(request: SweepRequest): Promise<SignResponse>`:
  - Inputs: a `sweep-wallet` authorization at the admin threshold; `amount` in base units;
    `TransactionParams`.
  - Outputs: the signed transfer, idempotent per approval id.
  - Failures: `envelope_mismatch`, `wallet_retired`, `workspace_deleting`, `workspace_deleted`,
    `sweep_destination_not_allowed`, `fee_cap_exceeded`, `insufficient_approvals`,
    `nonce_reused`, `approval_revoked`, `vault_error`.
- `Signer.retireWallet`, `Signer.deleteWorkspace(id, authorization): Promise<WalletState | WorkspaceState>`:
  - Failures: `wallet_set_mismatch`, `destroy_delay_out_of_range`, `conflict` (wrong state),
    the verification codes of `authorizedChange`.
- `Signer.cancelRetireWallet`, `Signer.cancelDeleteWorkspace`: request signature only; `conflict`
  when not in `retiring` or `deleting`.
- `Signer.finalizeRetireWallet`, `Signer.finalizeDeleteWorkspace`: request signature only;
  `destroy_not_due`; idempotent.
- `Vault.destroyWallet(walletId): void`: throws `VaultError("failed")` on anything but success or
  not-found.
- `DataKeyStore.shredTenant(scope, tenantId): Promise<{ shredded: number }>`.
- `deletionPreflight(ctx, workspaceId): Promise<DeletionPreflight>` (advisory).
- `writeRecord(ctx, workspaceId, sink)`, `verifyRecord(lines): { ok: boolean; brokenAt: number | null }`.
- `cloneWorkspace(ctx, session, input): Promise<{ workspaceId; approvals: ApprovalSummary[] }>`.

External dependencies:

- `@open-wallet-standard/core` 1.4.5:
  - Version/source checked: installed `index.d.ts` (`deleteWallet`, `exportWallet`,
    `listApiKeys`, `revokeApiKey`, `ApiKeyResult.id`).
  - Expected behavior: `deleteWallet` removes the wallet file; `revokeApiKey` removes the key
    file; `exportWallet(name, passphrase)` returns the mnemonic (OWS research, F7).
  - Failure handling: classified by `classifyOwsError`; "not found" on destroy is success.
- `node:sqlite` (Node 26): `PRAGMA secure_delete`, `PRAGMA user_version`,
  `PRAGMA wal_checkpoint(TRUNCATE)`, `ALTER TABLE … ADD COLUMN` with `CHECK` and a non-null
  default ([SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)).
- `viem` (as pinned): `encodeFunctionData` for the ERC-20 sweep, as in `buildTransaction`.
- Workflow 5.5.0 / `@workflow/world-postgres` 5.2.0: no API change; runs end through the
  existing outbox before keys are shredded.

## Threat model after this change

A compromised control plane (its process, or write access to its database):

| Can                                                                                                                                                            | Cannot                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask for a deletion, retirement or sweep, and show approvers a misleading card for it (the trusted-display gap, [#20](https://github.com/askgina/os/issues/20)) | Destroy a key without assertions at the admin threshold over an envelope naming that exact wallet set                                                            |
| Report false balances on the delete card, so approvers acknowledge a loss they would not have                                                                  | Destroy a key before `destroyAfter`, or set a delay below the signer's minimum                                                                                   |
| Cancel any deletion or retirement (only delays it; keys survive)                                                                                               | Make a cancelled deletion sign again: the workspace stays paused until `resume-workspace` is approved                                                            |
| Choose the amount of an approved sweep                                                                                                                         | Sweep to a destination outside the wallet's allowlist other than the workspace's own treasury; sweep twice under one approval; exceed the envelope's fee ceiling |
| Withhold or alter an export it produces; read every sealed value it could already read                                                                         | Export a wallet key: no route exists; only the signer host's admin CLI can                                                                                       |
| Put a fabricated policy in a clone's proposals                                                                                                                 | Make any clone policy effective without the clone's approvers' passkeys; give a clone an existing key                                                            |
| Leave runs unfinished or skip the sweeper, so deletion never completes                                                                                         | Revive a deleted workspace at the signer, reuse its approval ids or envelope nonces                                                                              |

What a successful attack can gain: with a misled approver, a sweep pays out only to an address
already on the wallet's allowlist or to the treasury, so the gain is bounded by what approvers
already allowed. A misled deletion destroys funds without moving them: sabotage, not theft, and
recoverable from the operator's backups until they expire.

The signer host and the operator's backups are unchanged from v0.1: whoever holds them holds the
wallets, including destroyed ones still in backups. A deleted workspace's sealed data stays
readable to whoever holds a pre-deletion database copy and a keyring copy from before the next
rotation.

## Concrete Steps

From the repository root, on a branch, once the owner says go:

    rg -n "resume-workspace" packages/protocol/src apps/signer/src apps/server/src   # every place a new kind must also be wired
    bun run check
    bun run typecheck
    git push   # CI runs `test`, `ui`, `stack (amd64|arm64|tls)`

Expected evidence in CI logs (jobs named as in `.github/workflows/ci.yml`):

    test   ✓ packages/protocol/test/lifecycle-envelopes.test.ts
    test   ✓ apps/signer/test/lifecycle.test.ts
    stack  ✓ lifecycle.spec.ts › a deleted workspace signs nothing and nothing it stored can be opened

Local runs of whole suites, builds or the stack wait for the owner's word, as in v0.1.

## Validation and Acceptance

Automated validation (all in CI):

- `bun run test`: the protocol, signer, keys and server tests named in Milestones 1 to 5 and 8.
- `bun run check`, `bun run typecheck`: clean.
- `ui` job: the two new journeys.
- `stack (amd64)`, `stack (arm64)`: `e2e/test/lifecycle.spec.ts`, six tests.

Manual or runtime validation:

- Start: `docker compose --profile dev up --build` with `SIGNER_MIN_DESTROY_DELAY_SECONDS=60`.
- Exercise: create a workspace and agent, fund the wallet, empty it with "Empty this wallet",
  pause, delete with the earliest time, wait.
- Observe: the countdown, then "Deleted"; `docker compose exec signer ls /data/vault/wallets`
  lists no file for the wallet; `node apps/signer/src/admin.ts verify-log --workspace <id>` exits
  0.

Regression checks:

- `release-gates.spec.ts` and `browser.spec.ts` unchanged and green: lifecycle adds states but
  an `active` workspace behaves as in v0.1.
- The restore gate ("a restored backup keeps wallets and waiting approvals, and refuses a spent
  one") still passes with a signer database at version 2.

## Idempotence and Recovery

- Migrations: `0002_lifecycle.sql` runs once under the existing advisory lock; the signer's
  `user_version` migration runs in one transaction and is skipped at version 2.
- Every signer lifecycle call is idempotent: replays of the same envelope return the state;
  finalize on a destroyed wallet or deleted workspace returns the state.
- The sweeper repeats every step safely: audit append checks the newest event; signer finalize is
  idempotent; `shredTenant` and `shred` are no-ops on tombstones; the tombstone transaction is
  conditional on `lifecycle = 'deleting'`.
- If the signer destroyed keys and the control plane crashed before shredding, the next round
  shreds. If the vault deletion succeeded and the SQLite transaction failed, the retry finds
  "not found" in OWS and completes.
- Backout: before the first deletion is finalized, reverting the branch is safe (the new columns
  are ignored by v0.1 code; the signer's added columns have defaults). After a finalize, keys are
  gone on the live system; recovery is restoring the backup set from before it, which also
  restores the deleted workspace.

## Rollout and Operations

- Config: `SIGNER_MIN_DESTROY_DELAY_SECONDS` (default 604800), `SIGNER_MAX_DESTROY_DELAY_SECONDS`
  (default 7776000). No control-plane variable; the UI reads the minimum from a new field in the
  signer's `getWorkspace` answer or from a fixed copy in config (choose the former in M2).
- Migration order: signer image first (it accepts v0.1 requests unchanged), then the server.
- Monitoring: log events `lifecycle.finalize_skipped` with the blocker code, `lifecycle.finalized`;
  signer decisions `delete-workspace`, `destroy-wallet`, `export-wallet-by-operator`.
- Operations doc: after a deletion, run the keyring rotation in `deploy/README.md` and note the
  date; deleted data leaves backups only when keyring copies older than that date are destroyed.
- Branch workflow: one branch, one PR per milestone or a stack, CI green per PR, as in v0.1.

## Risks and Open Questions

- Risk: a person deletes a workspace that still holds an asset the control plane did not read
  (an unlisted token, an NFT).
  Mitigation: the delete card says the balance list is partial and server-reported; the delay;
  keys remain in backups until they expire; the operator's `export-wallet` before restore.
- Risk: a signed, unmined transaction is broadcast after the key is gone.
  Mitigation: finalize waits for it (D7); signed raw transactions are blanked in the signer and
  the workspace key that seals `transactions.raw` is shredded; old backups still hold them.
- Risk: a compromised control plane stalls deletion forever by cancelling.
  Mitigation: visible state; the operator can run finalize from the signer host (add
  `admin.ts finalize-delete` only if this proves needed).
- Risk: the signer migration breaks an existing signer database.
  Mitigation: `migrations.test.ts` with a v0.1 fixture; release notes say "back up first".
- Open question D1 (owner): what deletion does to keys. Options: (a) signer destroys them after
  a delay, approved at the admin threshold (recommended); (b) destroy at once on approval;
  (c) never destroy; deletion is a permanent pause and tombstone.
- Open question D2 (owner): minimum delay. Options: 0; 72 hours; 7 days (recommended); 30 days.
- Open question D3 (owner): sweep destinations. Options: allowlist or own treasury
  (recommended); any address in the envelope; no sweep kind (raise caps with `set-policy`, then
  agent intents).
- Open question D4 (owner): key export. Options: none at all; signer admin CLI only
  (recommended); over HTTP encrypted to a recipient key in a passkey envelope.
- Open question D5 (owner): erasure from backups. Options: document only; rotate the keyring after
  each deletion with a stated keyring backup retention (recommended); a KEK per workspace.
- Open question D6 (owner and counsel): erasing a person under GDPR Article 17 while the audit
  chain keeps their user id. Options: erase names, passkeys and sessions and keep ids
  (recommended, Milestone 8, pending legal advice); change the chain to commit to
  `HMAC(per-person salt, userId)` and delete the salt on erasure; no erasure feature.
- Open question D7 (owner): finalize with an unmined transaction. Options: wait (recommended);
  allow after an explicit acknowledgment in the envelope.

## Artifacts and Notes

Evidence is in the report. Key lines:

    apps/signer/src/db.ts:37        sealed_credential BLOB NOT NULL
    apps/signer/src/db.ts:73        signed_transaction TEXT NOT NULL
    packages/protocol/src/evaluate.ts:38   if (!policy.requesters.includes(intent.agentId)) {
    apps/server/src/execution/workflow-runtime.ts:140   { [TENANT_START_OPTION]: input.workspaceId }
    deploy/README.md:60-61          back up postgres-data, server-secrets, signer-data, signer-secrets and db-secrets together
    packages/keys/README.md:72      keep it out of the database, out of backups that sit next to the database

## Revision Notes

- 2026-11-14: First draft, from the research report for ticket #23. Nothing built.
