# Sign Hyperliquid orders that the signer builds from an approved intent

- Branch: none yet
- Status: Ready for Review (Milestones 1 to 6 built 2026-11-15, green in CI run 43742600902; the
  manual testnet proof is open because no funded testnet account exists). Milestone 7,
  Hyperliquid mainnet (owner decision D2, decided 2026-11-16: mainnet is supported), is open;
  see `Progress`.
- Owner(s): the repository owner
- Created: 2026-11-14
- Last Updated: 2026-11-16
- Links: [Issue #21](https://github.com/askgina/os/issues/21) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](research/non-evm-operations.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

After this change an agent can propose an order on Hyperliquid testnet, for example "buy 0.01
BTC perpetual at a limit of 65,000 USD, immediate or cancel, because the funding rate turned".
The proposal waits in the approval inbox. A member opens the signer's confirmation page on
`APPROVE_ORIGIN`, which the signer renders from the intent and its own records (market, side,
size, limit price, notional against the caps, time in force, reduce-only, the agent's right to
cancel, the submit window), and approves there with a passkey. The signer checks that approval
itself, checks the wallet's venue rules (allowed markets, per-order and daily notional caps,
allowed time-in-force), builds the Hyperliquid order action from the intent's fields with its
own code, picks the action's nonce and expiry itself, signs exactly one action, and never signs
another order for that approval. The control plane submits it, follows it by a client order id
derived from the approval id, and lets the agent cancel it. Money reaches Hyperliquid by a v0.1
USDC transfer to the Hyperliquid bridge and comes back by a passkey-approved withdrawal to the
wallet's own address.

This is the first operation in the project that is not an EVM transaction. It proves the
general rule from the research report: the signer never accepts typed data, a message or bytes
from the caller; it builds the venue's signed object from an approved intent. The same shape
later carries Polymarket, Solana and signer-built swaps.

The plan was first built for Hyperliquid testnet only. On 2026-11-16 the owner decided D2:
mainnet venue support ships (Milestone 7). The same path then serves `hyperliquid:mainnet`.
Turning a venue on takes two steps and no flag: the operator lists it in the server's
`VENUES_FILE`, and a person approves with a passkey a wallet policy whose venue rules name that
network. The signer signs for the network the approved policy names and nothing else. Using a
venue is up to the person who runs the workspace. A real mainnet order with real funds has
never been placed; mainnet is exercised only against the fake venue in mainnet mode.

This plan is written for the research report's recommended options. Each choice that waits on
the owner is marked **(depends on owner decision Dn)** and listed in the `Decision Log`.

Non-goals, each out of scope for this plan: spot markets and HIP-3 DEXs;
trigger (stop-loss, take-profit) orders, TWAP, modify and batch orders; leverage and margin-mode
changes; builder codes; API (agent) wallets; subaccounts and vaults; `usdSend`, `spotSend`,
`sendAsset`, `vaultTransfer`, `approveAgent`, `approveBuilderFee`, `scheduleCancel`; Polymarket;
Solana; signer-built EVM swaps (a separate ticket); trading mandates, that is orders signed
under an approval in advance (ticket 19 built mandates for native and ERC-20 transfers only and
left trading mandates to this ticket; this plan keeps them out, **(D7 (a), taken 2026-11-15)**);
repricing and cancelling stuck EVM transactions (ticket 22, built on main at `61d0326`; EVM only).

Success means:

- The signer reproduces the Hyperliquid Python SDK's own signing vectors byte for byte, through
  the test vault and through the real OWS 1.4.5 vault, in the CI `test` job.
- In the CI `stack` job, against a fake Hyperliquid service that recovers the signer with an
  independent encoder: an agent's order proposal, after one passkey approval on the signer's
  confirmation page, becomes exactly one accepted order; a resubmission is refused by the
  venue's nonce rule; an order past its submit window is refused; a cancel by client order id
  succeeds; a withdrawal goes only to the wallet's own address.
- The confirmation page shows every field of the order that changes what is signed, built by
  the signer, and no notification (webhook or Web Push) carries any of them.
- The signer still has no route that accepts typed data, messages, actions or hashes, and the
  MCP tool list is exactly eight tools (today's seven plus `propose_order`).
- Out of scope and stated: the venue's own state (positions, leverage, liquidations) is reported
  by the control plane and is not verified by anyone in this system.

## Progress

- [x] (2026-11-14 21:44Z) Research current behavior and relevant code paths
      ([research report](research/non-evm-operations.md)).
- [x] (2026-11-14 21:44Z) Define the implementation approach and validation plan (this file).
- [x] (2026-11-15) Re-checked against main at `98cc6a1` (trusted display, v0.1 defect fixes,
      mandates and notifications landed); owner decisions are now D1 to D9.
- [x] (2026-11-15) Owner decisions D1 and D3 to D9 taken by the lead agent under the repository owner's delegation,
      each as the recommended option (see `Decision Log`). D2 (mainnet)
      stays open with the owner; until the owner answers, venues are testnet only and a mainnet venue is
      refused at boot. (D2 decided 2026-11-16 by the owner: mainnet is supported; see Milestone 7.)
- [x] (2026-11-15) Milestone 1: protocol shapes, venue policy and evaluation, the order and
      withdrawal confirmation view, the four deny codes, `docs/approval-protocol.md` §1, §3, §4,
      §5, §7, §11 (three vectors, reproduced with OpenSSL) and §12. Local checks only, CI
      pending: `tsc --noEmit` clean in `packages/protocol`, `packages/api`, `apps/signer`,
      `apps/server`, `apps/web`, `apps/approve` and `e2e`; protocol `digests`, `schemas`,
      `evaluate`, `mandate`, `confirmation`, `signer-client`, `lifecycle-envelopes` and
      `verify-authorization` tests, signer `confirmations`, `signing` and `mandates` tests and
      the approve `app` test pass, each file alone; Biome clean on the changed files.
- [x] (2026-11-15) Milestone 2: the Hyperliquid encoder in the signer, proven against the SDK
      vectors. `apps/signer/src/venues/msgpack.ts`, `apps/signer/src/venues/hyperliquid.ts`,
      `apps/signer/test/vectors/hyperliquid-python-sdk.json` (SDK commit `2fdb18f9`, test lines
      21-126 and the testnet withdrawal at 202-212, plus an `expiresAfter` order and cancel
      generated once outside the repository, command and output in the file),
      `apps/signer/test/hyperliquid-encoding.test.ts`, `@msgpack/msgpack` 3.1.3 in
      `packages/testkit` (see Surprises). Local checks only, CI pending: `tsc --noEmit` clean in
      `apps/signer` and `packages/testkit`; `hyperliquid-encoding.test.ts` passes alone (35
      tests: the connection id `0x0fcbeda5…2908`, every SDK `r`, `s`, `v` signed with viem, the
      generated vectors byte for byte, 1,000 generated order and cancel actions and every length
      form equal to `@msgpack/msgpack`, the refusals, the pinned cloid of
      `apr_01jd0000000000000000000005`, `0xe5da13111af22225733abeac5ca991ba`, computed with
      OpenSSL, and `nextNonce`); Biome clean on the changed files.
- [x] (2026-11-15) Milestone 3: the vault's typed-data method, proven with real OWS.
      `Vault.signHyperliquid` (OWS and test vault), `payloadDigest` and `eip712Json` in
      `venues/hyperliquid.ts`, `isTypedSignedBy` in `apps/signer/src/signer.ts`. Local checks
      only, CI pending: `ows.test.ts` passes alone (6 tests): OWS 1.4.5, with the SDK's key
      imported, reproduces the GTC order signatures with and without a cloid on both networks,
      the generated `expiresAfter` order (both networks) and cancel (testnet), and the SDK's
      testnet withdrawal; a mainnet withdrawal recovers to the wallet; each signature passes
      `isTypedSignedBy` over viem's digest; the owner passphrase and another wallet's token are
      refused. `hardening.test.ts` passes alone (10 tests, including `isTypedSignedBy` refusing
      another key, another connection id or network, a high `s` and malformed values); the
      vault's other users, `lifecycle`, `repricing`, `signing`, `sweep` and `mandates`, pass,
      each file alone. Not yet shown: "records nothing and answers `vault_error`" for a bad
      venue signature, because no route calls `signHyperliquid` before Milestone 4.
- [x] (2026-11-15) Milestone 4: the signer's venue routes and records. `POST /v1/venue/sign`
      (`signVenue`, orders and withdrawals) and `POST /v1/venue/orders/:approvalId/cancel`
      (`cancelVenueOrder(approvalId, workspaceId)`), both scope `control`;
      `apps/signer/src/venue-signing.ts` (decision-log actions `sign-venue`,
      `cancel-venue-order`); signer schema version 8 (`venue_nonces`, `venue_signatures`,
      `venue_cancels`); `HyperliquidRequest`, `SignVenueRequest`/`Response`,
      `CancelVenueOrderRequest`/`Response`, `WalletState.venueSpent`, `ApprovalState.cloid`;
      `docs/approval-protocol.md` §8 "Venue orders". Local checks only, CI pending: `tsc --noEmit`
      clean in `apps/signer`, `packages/protocol`, `apps/server`, `apps/approve` and `e2e`;
      `venue-signing.test.ts` (15 tests) and `hardening.test.ts` (14) pass alone, as do the
      signer's `signing`, `lifecycle`, `repricing`, `mandates`, `fence`, `confirmations`,
      `sweep`, `governance`, `possession`, `tls`, `admin` and `hyperliquid-encoding` tests and
      the protocol `signer-client` and `lifecycle-envelopes` tests, each file alone; Biome clean
      on the changed files.
- [x] (2026-11-15) Milestone 5: control plane: venue client, MCP tool, approval card, follow-up.
  - [x] (2026-11-15) Server half. `VENUES_FILE` (`apps/server/src/config.ts`, `VenueConfig`; a
        `hyperliquid:mainnet` entry or an `api.hyperliquid.xyz` URL stops the boot naming D2,
        superseded by Milestone 7);
        `apps/server/src/execution/venues/hyperliquid.ts` (`createHyperliquidClient`: `meta`,
        `orderStatus`, `post`, `accountValue`; 10-second timeout; an unreadable or lost answer is
        `VenueError` `venue_unreachable`, never a refusal); `apps/server/src/execution/orders.ts`
        (`proposeOrder`, `proposeVenueWithdrawal`, the signer call and sealed `venue_orders` row,
        the follow-up, `cancelVenueOrder`, `cancelIntentOrOrder`, `reconcileOpenOrders` in the
        sweeper every 5 minutes, `venueHooks` passed to `registerIntentKind`); migration
        `0011_venue_orders`; MCP `propose_order` (eight tools), `intentView.order`,
        `whoami.venues`, `propose_transfer` with a venue network (withdrawal, `asset: "usdc"`),
        `cancel_intent` on a posted order; `POST /api/v1/intents/:intentId/cancel-order`
        (`cancelOrder`, owners and approvers, no passkey); the approval subject's `venue`
        section; `PushFacts.operation` (D8); a draft naming mainnet is refused (superseded by
        Milestone 7); workspace
        templates carry `venues`. DTOs in `packages/api`: `IntentStatus` + `submitted`,
        `placed`, `filled`, `partially_filled`; `IntentDisplay` = `TransferDisplay` |
        `OrderDisplay`; `IntentSummary.chainId: Network`, `IntentSummary.order:
        VenueOrderView | null`; `ApprovalSubject["approve-intent"].venue`; `PolicyDraft.venues`.
        Local checks only, CI pending: `tsc --noEmit` clean in `apps/server`, `packages/api` and
        `apps/web`; `orders.test.ts` (9 tests, against the testkit's `FakeHyperliquid` served on
        loopback, which recovers the signer itself), `mcp`, `engine`, `cancel`, `mandates`,
        `repricing`, `confirmation`, `directory`, `export`, `clone`, notify `content` and `push`
        tests and the `packages/api` tests pass, each file alone; Biome clean on the changed
        files.
  - [x] (2026-11-15) What the server and web halves left. The wallet page's venue section:
        `WalletDetail.venue` (optional `VenueAccount` in `packages/api`: `network`, the
        signer's `spentTodayUsd6` from `WalletState.venueSpent`, the policy's
        `maxNotionalPerDayUsd6` or null, and `reported`: account value, withdrawable, positions
        and resting orders as the venue answered, null when it could not be read or answered
        what cannot be shown), filled by `walletVenueAccount` in `orders.ts` for the configured
        venue the policy has rules for, or else one the wallet has orders on, and absent
        otherwise; the client gained `accountState`, `openOrders` (the venue documents no
        `cloid` there, so resting orders show its order id) and `withdrawalNonces`;
        `VenueAccountCard` in `apps/web/src/components/venue.tsx` shows the signer's count
        against the cap, then the venue's report under "Reported by Hyperliquid through this
        server, not verified by the signer."; the fixture server and the order journey (a
        step on the wallet page with the order resting, and none after its cancel). The
        withdrawal after a lost answer is looked up in the venue's ledger before any repost
        (see Surprises); the testkit's fake answers `openOrders` and
        `userNonFundingLedgerUpdates`. The approve page test renders an order view's lines and
        the words of `market_not_in_policy` and `venue_rules_missing`. Local checks only, CI
        pending: `tsc --noEmit` clean in `apps/server`, `packages/api`, `apps/web`,
        `apps/approve` and `packages/testkit`; `orders.test.ts` (13 tests; the lost-withdrawal
        test fails without the fix, ending `failed`), `directory.test.ts` (32), the testkit's
        `fake-hyperliquid.test.ts` (19) and the approve `app.test.ts` (11) pass, each file
        alone; the web journeys pass on phone-light (4/4) and phone-wide-font (4/4); Biome
        clean on the changed files. Not run: phone-dark and desktop journeys.
- [x] (2026-11-15) Milestone 6: fake venue, release gates, documentation.
  - [x] (2026-11-15) The fake venue (`packages/testkit/src/fake-hyperliquid.ts`, its HTTP entry
        `e2e/src/fake-hyperliquid.mts`, overlay `e2e/compose.venue.yaml`) and its wiring:
        `e2e/run.sh` runs `e2e/test/venue.spec.ts` on a third, fresh stack
        (`<project>-venue`, `E2E_VENUE=1`) after the lifecycle gates, in the default run only
        (CI `stack` amd64 and arm64; not TLS, split or a variant); `compose.yaml` passes
        `VENUES_FILE` through (empty: no venue) and `.env.example` documents it. Gates written:
        exactly eight tools and only the testnet venue in `whoami`; an IOC order approved on the
        signer's page (market, index, side, size, limit price, notional, time in force, the
        memo as unchecked) becomes one accepted request whose signer, recovered by the fake and
        again in the test, is the wallet, whose body is byte for byte the signer's
        `venue_signatures.request`, and the intent ends `filled`; a resting GTC order is
        cancelled by the agent while the workspace is paused, no passkey used, the cancel the
        only other request and byte for byte `venue_cancels.request`; refusals before any
        approval (market, order type, per-order cap, mainnet order, mainnet policy draft; the
        two mainnet refusals superseded by Milestone 7); a
        live mandate still leaves an order to a person and the signer logs no `sign-venue`
        (D7); a request whose 5-second window passed while the server was cut off from the
        venue is never posted and ends `expired`; a server killed after signing and before
        posting sends exactly one request after restart. Local checks only, nothing run
        against a stack, CI pending: `tsc --noEmit` clean in `e2e`; `bash -n e2e/run.sh`; the
        plain, e2e, venue, replicas, OpenBao, TLS and both split Compose combinations parse;
        Biome clean on the changed files. Left: the replay, daily-cap, plaintext, signer-network
        and mainnet-boot gates, the webhook order gate, the withdrawal gate and the documents.
  - [x] (2026-11-15) The remaining gates, appended to `e2e/test/venue.spec.ts` (helpers in
        `e2e/src/venue.ts`): a signed order re-posted byte for byte is refused for its nonce and
        the venue keeps one filled order; the daily cap (a `Closer` wallet, 25 USD an order, 30
        a day) refuses an order over it before anyone is asked, while a reduce-only order is not
        counted (the signer's page shows "19.5 USD of 30 USD" and says so), fills, and leaves
        room for a 10.4 USD order; the wallet page shows the signer's count and the fake's
        resting order by its venue order id, and no order once the agent cancels it; a
        withdrawal to another address or under a policy without withdrawals is refused before
        anyone is asked, and one to the wallet's own address is signed by the wallet, byte for
        byte the signer's, taken by the venue to that address, and ends `confirmed`; an order's
        `approval.opened` webhook body has exactly the keys of any other approval and none of
        the order's memo, size or price (D8); the signer neither resolves nor reaches the fake
        (by name or address) nor `https://example.com/`, which the server does reach, and from
        the signing network `/v1/sign-typed-data`, `/v1/sign-hash` and
        `/v1/venue/sign-action` answer 404 while `/v1/venue/sign` answers 401; a throwaway
        server (`compose run --rm --no-deps`) with a mainnet network or the
        `api.hyperliquid.xyz` host in its venues file exits 1 with "Hyperliquid mainnet is
        refused", and with the testnet venue gets past its venues to the database (the
        control; this gate is superseded by Milestone 7); the memos and the `r` and `s` of
        every posted order and withdrawal are in no
        column of Postgres (control: the workspace name is) and no `venue_orders.request` holds
        readable JSON. `deploy/split/control.compose.yaml` passes `VENUES_FILE` through by
        `extends` (checked with `docker compose config`). Local checks only, nothing run against
        a stack, CI pending: `tsc --noEmit` clean in `e2e`; Biome clean; every Compose
        combination parses. Left: the documents.
- [ ] Manual testnet proof (D6; not CI; needs a funded testnet account). Still not done. D2 was
      decided on 2026-11-16 without it, so the gap is a risk carried into mainnet (see
      `Risks and Open Questions`).
- [x] (2026-11-16) Milestone 7: Hyperliquid mainnet (D2 decided 2026-11-16). Each line is
      ticked only with its evidence. Commit `2e8460b`; green in CI on `7ac59b7`. The manual
      line at the end stays open.
  - [x] Signer: signs a venue intent for the network the wallet's passkey-approved policy names,
        including `hyperliquid:mainnet` under a mainnet policy; `SIGNABLE_VENUE_NETWORKS` and
        its check deleted; an intent whose network differs from the policy's is refused
        `venue_not_allowed` (unit test, both directions).
  - [x] Server: `VENUES_FILE` takes at most two entries, at most one per network, either
        network; the boot stops only when `api.hyperliquid.xyz` is not paired with
        `hyperliquid:mainnet` or `api.hyperliquid-testnet.xyz` with `hyperliquid:testnet`; any
        other host is accepted with either network; config tests for each case.
  - [x] Server and API: a policy draft whose `venues.hyperliquid.network` is not configured is
        refused `invalid_request`, code `venue_not_configured`; `WorkspaceDetail.venueNetworks`
        in `packages/api` lists the configured networks (testnet first, empty without a venues
        file); directory tests.
  - [x] Web: the wallet rules editor offers Hyperliquid only for configured networks and lets
        the person choose the network when both are configured; journey.
  - [x] Release gates: a second fake venue in mainnet mode; a mainnet order approved under a
        mainnet policy becomes one accepted request recovered to the wallet with `source` "a";
        a cross-network intent is refused before anyone is asked; the pairing boot gate
        replaces the mainnet-boot gate. First run was CI: `venue.spec.ts` gates 5 and 6 and
        the boot gate passed in `stack (amd64)` and `stack (arm64)`.
  - [x] Documents: `README.md`, `deploy/README.md`, `docs/threat-model.md`,
        `docs/architecture.md` describe mainnet as supported and name its unproven parts.
  - [x] Green in CI: <https://github.com/askgina/os/actions/runs/43842629503> on `7ac59b7`,
        twelve jobs (check, test, ui, packages, k8s, k8s-ha, stack amd64, arm64, tls, split,
        replicas, openbao).
  - [ ] Manual, not CI: a real mainnet order with real funds. Not done; needs the owner at the
        phone and a funded mainnet account.

## Surprises & Discoveries

- Observation: Polymarket CLOB V2 (live 2026-04-28) removed `expiration` and `nonce` from the
  signed order, and its exchange has no per-order on-chain cancel; the user can only pause the
  whole account, effective after `userPauseBlockInterval` blocks (default 100).
  Evidence: <https://docs.polymarket.com/v2-migration>, "EIP-712 Order type";
  `Polymarket/ctf-exchange-v2@ccc0596` `src/exchange/mixins/UserPausable.sol:11-38`.
  Consequence: a Polymarket signature cannot be bounded in time by the signer. Hyperliquid's
  `expiresAfter` can.
- Observation: OWS 1.4.5 signs EIP-712 for any `eip155:<n>` chain argument and checks the
  domain's `chainId` against it, so Hyperliquid's L1 domain (`chainId` 1337) needs the chain
  argument `eip155:1337`. Its EIP-712 encoder is hand-written: decimal `uint` strings must fit
  `u128`, and values are not checked against the declared width.
  Evidence: OWS `ows/crates/ows-lib/src/key_ops.rs:256-330`, `ows/crates/ows-signer/src/eip712.rs:237-372`.
- Observation: OWS's `hyperliquid` alias is HyperEVM (`eip155:999`), unrelated to HyperCore
  order signing. Evidence: OWS `docs/07-supported-chains.md:65`.
- Observation: the Hyperliquid testnet faucet pays only addresses that have deposited on
  mainnet. Evidence: <https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet.md>.
- Observation: an order's `grouping: {"p": n}` charges a priority fee from the account's staking
  balance; the signer must fix `grouping` to `"na"`.
  Evidence: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees.md>.
- Observation: deregistered Hyperliquid API wallets may have their nonce state pruned, after
  which "previously signed actions can be replayed".
  Evidence: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets.md>.
  Consequence: this plan signs with the wallet's own key and approves no API wallet.
- Observation (2026-11-15 re-check): the control plane's hand-copied list of policy codes that
  the first version told Milestone 1 to replace is gone. Mandates Milestone 3 (`b55508e`)
  replaced it with `POLICY_DENY_CODES.includes(code) || MANDATE_DENY_CODES.includes(code)`
  (`apps/server/src/execution/intents.ts:786-789` at `98cc6a1`, in `abandonIntent`), so new
  codes added to `POLICY_DENY_CODES` (`packages/protocol/src/evaluate.ts:5-15`) are classified
  `denied` without further work. What is still needed: the four new codes must be added to that
  array, and the web app's plain-language map (`apps/web/src/lib/codes.ts:59`, typed
  `Record<string, string>`, so not checked by the compiler) needs a sentence for each.
- Observation (2026-11-15 re-check): approvals are no longer made on the control plane's pages.
  Trusted display (`specs/trusted-display.md`) moved every approval to the signer's confirmation
  page; the view is built by the pure `renderConfirmation` in
  `packages/protocol/src/confirmation.ts` from the envelope, its subject and the signer's
  records, and the `approve` service (`apps/approve`) only shows its lines. So the order "card"
  this plan described for `apps/web/src/routes/approval.tsx` is now a case of
  `renderOperation` in the protocol package, and every hashed subject this plan adds must have
  one.
- Observation (2026-11-15 re-check): mandate evaluation assumes an EVM intent.
  `evaluateMandate` (`packages/protocol/src/mandate.ts:294`) refuses `evm.call` and then reads
  `operation.to` and `intent.maxFeeWei` for every other operation; a venue intent has neither.
  Widening `Intent` without an explicit refusal there would not compile, which is the safe
  failure, but the refusal must be written.
- Observation (Milestone 1, 2026-11-15): widening `Intent` did break consumers that read EVM
  fields from a parsed intent, as the plan expected, in more places than it listed: the control
  plane's `readIntent` and `propose` (`apps/server/src/execution/intents.ts`), repricing
  (`repricing.ts`), the web app's fixture server and two pages that show `maxFeeWei`
  (`approval.tsx`, `payment.tsx`, through `IntentDetail.intent` in `packages/api`), and one
  release gate. Each was narrowed to `EvmIntent` (the control plane parses stored intents with
  `EvmIntent.parse`, so it refuses a venue intent until Milestone 5 handles one) or guarded with
  `"maxFeeWei" in intent`. `SignRequest`, `SignUnderMandateRequest` and `RepriceRequest` were
  narrowed to `EvmIntent` in this milestone rather than in Milestone 4, so `/v1/sign`, a mandate
  use and a reprice refuse a venue intent as `invalid_request` from now on.
  Evidence: `tsc --noEmit` in each workspace before and after.
- Observation (Milestone 1): the plan's coin pattern `^[A-Z0-9]{1,16}$` cannot name Hyperliquid's
  lower-case-prefixed perpetuals (for example `kPEPE`); such a market cannot be put in a policy.
  This only narrows what can be traded. Not changed; revisit if one is wanted.
- Observation (Milestone 1): an empty `venues: {}` would have been a second encoding of "no venue
  rules" with a different `policyHash`, so `VenueRules` refuses it (it must name a venue). This is
  rule (2) of the additive-change rule now written in `docs/approval-protocol.md` §12.
- Observation (2026-11-15 re-check): a Web Push message at the `summary` level labels every
  `approve-intent` request "Payment waiting" (`apps/server/src/notify/content.ts:63`). An order
  is an `approve-intent` request under this plan, so it would be announced as a payment. Neither
  the push message nor the webhook body can carry an amount, a market or any order field: the
  inputs have no such field (`PushFacts`, `content.ts:34`; `WebhookBody`,
  `apps/server/src/notify/webhook.ts:19-41`). See D8.
- Observation (Milestone 3): OWS 1.4.5 `signTypedData` reports the recovery as `v`, not as a
  parity: `recoveryId` is 27 or 28 and equals the signature's last byte (probe output
  `{"signature":"…1c","recoveryId":28}`), unlike `signTransaction`. The vault's existing
  `splitSignature` would have taken 28 as the parity. `OwsVault.signHyperliquid` reads the
  parity from the last byte, accepts 0/1 or 27/28 and refuses a recovery id that disagrees.
  Evidence: `apps/signer/src/vault.ts` (`hyperliquidSignature`), `ows.test.ts`.
- Observation (Milestone 3): viem's `recoverTypedDataAddress` is async, and the check must run
  inside the synchronous SQLite transaction (like `isSignedBy`). So `isTypedSignedBy` recovers
  with noble over viem's `hashTypedData` digest. It takes the `HyperliquidPayload` rather than
  typed data: the signer builds the payload, and the typed data comes from it through the same
  builders the vault uses.
- Observation (Milestones 2 and 3): viem types a `uint64` message value, and a `chainId` in a
  declared `EIP712Domain`, as `bigint`, which `JSON.stringify` cannot write. The builders
  therefore return typed data in viem's form, without `EIP712Domain` (viem derives the same
  domain type from the domain's four fields), and `eip712Json` writes `EIP712Domain` out with
  every integer as a JSON number for OWS. That the two encoders agree is shown, not assumed:
  OWS's signatures from that JSON equal the SDK's and recover over viem's digest, for the L1
  domain and for the withdrawal domain.
- Observation (Milestone 2): `@msgpack/msgpack` is in `packages/testkit`'s `dependencies`, not
  `devDependencies` as this plan said. Bun's isolated linker lets `apps/signer` resolve a
  package only through its own dependencies, so the signer's test reaches the reference encoder
  through `@askgina/os-testkit/msgpack` (a devDependency of `apps/signer`), and `packages/testkit`
  lists what its own source imports under `dependencies` (`cbor-x`, `pg`). It is still in no
  production install: only test code depends on `packages/testkit`, and the signer image installs
  with `--production`. Milestone 6's fake venue, also in `packages/testkit`, can import it directly.
- Observation (Milestone 4): widening `WalletState.spent` to venue networks, as the plan said,
  would not compile in the control plane: it hands `spent` to the web's `WalletSummary`
  (`apps/server/src/directory/routes.ts`, typed with `ChainId` in `packages/api`). The change was
  made additively instead: `spent` stays EVM only and venue spends are in a new
  `WalletState.venueSpent` (`{ chainId: VenueNetwork, asset: "usd6", amount }`). Milestone 5 may
  show it on the wallet page.
- Observation (Milestone 4): D2 was open then, so the signer itself refuses a `hyperliquid:mainnet`
  intent as `policy_denied` with `venue_not_allowed`, whatever the wallet's policy names
  (`SIGNABLE_VENUE_NETWORKS` in `venue-signing.ts`). The plan had only the server refuse mainnet
  at boot; without this a policy naming mainnet would make the signer sign mainnet orders that a
  compromised control plane could post. (Superseded by Milestone 7: since D2 was decided on
  2026-11-16, the signer signs the network the passkey-approved policy names.)
- Observation (Milestone 4): a cancel's `expiresAfter` uses the order's own submit window
  (`expires_after − signed_at` of its `venue_signatures` row), not the current policy's, so a
  later policy without venue rules still lets the order be cancelled (D4). Nonces and expiries
  are the signer's clock in seconds times 1000. The plan's client signature
  `cancelVenueOrder(approvalId, request)` became `cancelVenueOrder(approvalId, workspaceId)`,
  like `revokeApproval` and `revokeMandate`. Destroying a wallet's key empties its venue
  requests and cancels as it empties signed transactions. A reprice of a venue approval, or a
  `/v1/sign` repeat of its envelope, is `conflict`. The request body is checked before signing:
  the action, read back from its JSON as the venue would, must encode to the hashed bytes.
- Observation (Milestone 5): migration `0011_venue_orders`, not `0008` as the plan said: the
  lifecycle, erasure and rate-limit plans took `0008` to `0010` first. Its `venue_orders` has
  `venue_error`, `submitted_at` and `checked_at` beyond the plan's columns and a status
  `accepted` for a withdrawal (the intent ends `confirmed`); the sealed body is stored as the
  exact JSON text the signer returned (location `venue_orders.request:<approvalId>`) and posted
  byte for byte.
- Observation (Milestone 5): the venue's refusal text goes into `venue_orders.venue_error` (cut to
  200 characters) and `VenueOrderView.venueError`, and `failureCode` is the stable
  `venue_refused` (or `venue_cancelled` when the venue cancelled it, for example
  `marginCanceled`), not the venue's text as the plan said: a code agents act on must be stable.
- Observation (Milestone 5): `market_metadata_mismatch` is `conflict`, `invalid_tick`
  `invalid_request`, and a network that is not configured `invalid_request` with
  `venue_not_configured`; a mainnet request therefore answers `venue_not_configured`, because the
  boot refuses a mainnet venue. (Superseded by Milestone 7: a mainnet venue can be configured.)
- Observation (Milestone 5): `orderStatus` reports remaining and original size but no average
  price, so `averagePrice` is only known when the post's own answer was `filled`; a resting
  order that fills later shows its filled size and no average price.
- Observation (Milestone 5): a withdrawal has no client order id, so after a lost answer it was
  posted again; if the first copy had been accepted, the venue refused the copy for its nonce
  and the intent ended `failed` (`venue_refused`) although the money moved. Fixed: before any
  repost, the follow-up reads the venue's ledger (`POST /info
  {"type":"userNonFundingLedgerUpdates","user","startTime"}`, from 5 minutes before the
  withdrawal's nonce) and ends the request `accepted` (intent `confirmed`) when a `withdraw`
  entry carries its nonce, which no other withdrawal of the account can share; only a
  withdrawal the venue has not taken is posted again. The fake venue answers that read from the
  withdrawals it took. That the real venue's `withdraw` ledger entry carries `nonce` is from its
  API documentation, not yet seen (manual testnet proof, D6).
  Evidence: `orders.test.ts` "after a lost answer, finds the withdrawal in the venue's ledger
  and does not post it again" and "… posts a withdrawal the venue did not take once more".
- Observation (Milestone 5): the follow-up watches a posted order for one hour (5 to 60 seconds
  apart), then `reconcileOpenOrders` reads it every 5 minutes; a venue removed from
  `VENUES_FILE` after signing ends an unposted request `expired` once its window passed.
- Observation (Milestone 6): the plan's method for the expiry and crash gates, pausing the
  `fake-hyperliquid` container, cannot show "never posted": a paused container's kernel still
  completes the TCP handshake and buffers the request, which the fake reads on unpause. The gates
  instead disconnect the server's container from the Compose `chain` network (the only one the
  fake is on) and connect it again, so nothing the server posts in between can reach the venue.
  The venue gates run on a stack of their own rather than in `release-gates.spec.ts`, so every
  other gate keeps running as a deployment without `VENUES_FILE` does.
- Observation (Milestone 6): the plan's replay gate re-posts the first order's body, but by then
  the expiry and crash gates have usually run past that order's 300-second `expiresAfter`, and
  the fake venue checks expiry before the nonce, so the copy would be refused as expired and
  prove nothing about the nonce. The replay gate places an order of its own and re-posts it at
  once.
- Observation (Milestone 6): the mainnet-boot gate starts a throwaway server with an
  unreachable `DATABASE_URL` (`database.invalid`), so that a build which stopped refusing a
  mainnet venue would fail at the database instead of joining the running stack as a second
  server; the testnet control run stops there, which shows the venues file was read and
  passed. (Superseded by Milestone 7, whose pairing boot gate replaces this one.)
- Observation (Milestone 2): the SDK writes `r` and `s` with `to_hex`, which drops leading zero
  digits (three of the vector values have 63 digits); the tests compare them as numbers. The SDK
  signs `withdraw3` with `signatureChainId` `0x66eee` on both networks; this plan uses `0xa4b1`
  (42161) on mainnet, which the SDK's comment allows ("can be any chain"). Only the testnet
  withdrawal is proven by a vector; the mainnet one only by recovery.
- Observation (2026-11-16, D2 decided): mainnet needed no new signing code. The fake venue
  (`packages/testkit/src/fake-hyperliquid.ts`) already implemented mainnet (`FakeNetwork`
  `"mainnet"`, phantom agent `source` "a", `hyperliquidChain` "Mainnet"), and the signer's
  encoder tests already carried the SDK's mainnet vectors for orders
  (`apps/signer/test/vectors/hyperliquid-python-sdk.json`, `hyperliquid-encoding.test.ts`,
  `ows.test.ts`). Supporting mainnet was therefore a removal of refusals (signer, server boot,
  policy draft) plus gates. The mainnet withdrawal signature is still checked by recovery only;
  no SDK vector covers it (see the Milestone 2 observation above).

## Decision Log

Owner decisions D1 and D3 to D9 were taken on 2026-11-15 by the lead agent under the repository owner's delegation
("delegate to you on decisions like a CTO"), each as the option this plan recommended. D2
(mainnet) was not delegated; the owner decided it on 2026-11-16 (below). Each was re-checked against
main on 2026-11-15; none is moot. Earlier entries, observations and outcomes that say mainnet is
refused describe the plan before 2026-11-16 and are history as of that date.

- Decision (owner, D1, taken 2026-11-15 by the lead agent under the repository owner's delegation, as recommended):
  the first operation that is not an EVM transaction is a Hyperliquid perpetual limit order on
  testnet.
  Rationale: the smallest venue whose guarantees the signer can make true by itself: one
  signature per approval, one placement (venue nonce set), unusable after `expiresAfter`, cancel
  by client order id. Polymarket V2 cannot bound a signature's lifetime; Solana is a whole chain
  family; a signer-built swap is smaller but is still an EVM transaction.
  Re-check 2026-11-15: unchanged. Recommendation stands: still the smallest step that keeps
  "the signer builds what it signs".
  Date/Author: 2026-11-14 / research agent
- Decision (owner, D2, taken 2026-11-16 by the owner): mainnet venue support ships. In the design
  (Milestone 7):
  - the signer signs a venue intent for whichever network the wallet's passkey-approved policy
    names; `SIGNABLE_VENUE_NETWORKS` and its check are deleted; every other refusal stays
    (policy and network mismatch, caps, restore fence, pause, envelope mismatch);
  - the server's boot refusal of a mainnet venue is replaced by a pairing check of Hyperliquid's
    own hosts: `api.hyperliquid.xyz` must be listed as `hyperliquid:mainnet` and
    `api.hyperliquid-testnet.xyz` as `hyperliquid:testnet`; any other host (a fake, a proxy) is
    accepted with either network; `VENUES_FILE` holds at most one entry per network;
  - a policy draft naming a venue network the server has not configured is refused
    `invalid_request` with code `venue_not_configured`;
  - `WorkspaceDetail.venueNetworks` tells the web app which networks are configured, and the
    wallet rules editor offers only those and lets the person choose when both are;
  - no environment flag or "enable mainnet" switch exists.
    Rationale: the owner decided. Turning a venue on is the operator's configuration plus a
    person's passkey approval of rules that name it; using a venue is up to the person who runs
    the workspace. Before 2026-11-16 this entry was open and the plan shipped the fail-closed
    default (testnet only, mainnet refused at boot and by the signer); that is history as of this
    date.
    Date/Author: 2026-11-16 / lead (open since 2026-11-14 / research agent)
- Decision (owner, D3, taken 2026-11-15 by the lead agent under the repository owner's delegation, as recommended):
  Hyperliquid actions are signed by the wallet's own key; no API wallet is approved.
  Rationale: one signer process gains no isolation from a second key, `approveAgent` would be
  one more action to approve, and deregistered API wallets can be replayed against.
  Re-check 2026-11-15: unchanged. Recommendation stands for the same reason.
  Date/Author: 2026-11-14 / research agent
- Decision (owner, D4, taken 2026-11-15 by the lead agent under the repository owner's delegation, as recommended):
  approving an order includes the right to cancel that one order.
  The signer signs `cancelByCloid` for an order it signed, on the control plane's request,
  without a passkey, also while the workspace is paused. The signer's confirmation view says so.
  Rationale: a cancel of a limit order moves no funds and only removes what the person approved.
  This plan has no stop orders; when they are added, cancelling one needs its own approval.
  Re-check 2026-11-15: open at the time. The sweep built since (`sweep-wallet`, allowed while paused)
  is a precedent for an action that is safe while paused. Because the confirmation view is now
  built by the signer, the sentence "the agent may cancel this order" is shown by the signer and
  cannot be dropped by the control plane. Recommendation stands: cancelling only removes risk.
  Date/Author: 2026-11-14 / research agent
- Decision (owner, D5, taken 2026-11-15 by the lead agent under the repository owner's delegation: option (a),
  widening, as recommended): the protocol change is additive within version 1. Existing
  digests and test vectors stay unchanged; `docs/approval-protocol.md` §12 is amended to allow
  new operation kinds in an existing union and new optional members that leave every existing
  digest unchanged and that an older verifier refuses.
  Rationale: v2 would rehash every structure and make the signer carry two versions.
  Re-check 2026-11-15: open at the time, and sharper. §12 (`docs/approval-protocol.md:899-916`)
  already records three additive changes without a version bump (`sweep-wallet`, the possession
  challenge, mandates), but each was a new kind or structure under its own domain tag. This plan
  instead widens an existing hashed union (`Intent`, tag `askgina.os/v1/intent`) and adds an
  optional member to `WalletPolicy` (tag `askgina.os/v1/policy`). The alternative (b) is a new
  envelope kind `approve-order` with its own `VenueIntent` under its own tag, exactly the §12
  precedent; it leaves `Intent` and every EVM-only consumer of it untouched but duplicates the
  intent lifecycle, approval kind, follow-up and MCP read tools. Recommendation: (a), widening,
  because orders then reuse the whole intent path (inbox, `get_intent`, `list_intents`,
  `cancel_intent`, follow-up); the cost is the explicit venue branches listed in Milestone 1.
  Date/Author: 2026-11-14 / research agent; re-checked 2026-11-15
- Decision (owner, D6, taken 2026-11-15 by the lead agent under the repository owner's delegation, as recommended):
  the manual testnet proof is funded by a `usdSend` of testnet USDC from an existing funded
  testnet account to the wallet's address (at least 11 USDC: 1 for account activation, 10 for
  the minimum order). No such funded testnet account is in hand on 2026-11-15; the proof runs
  when one is, and nothing claims it before then.
  Rationale: the faucet requires a mainnet deposit from the same address; a mainnet deposit
  from a signer wallet would need a mainnet policy and real funds.
  Re-check 2026-11-15: unchanged (the faucet rule was not re-read on 2026-11-15).
  Recommendation stands.
  Date/Author: 2026-11-14 / research agent
- Decision (owner, D7, new 2026-11-15; taken 2026-11-15 by the lead agent under the repository owner's delegation:
  option (a), as recommended): trading mandates. The mandates plan left
  "whether trading mandates (typed swaps) are wanted soon enough to change D3" to this ticket
  (`specs/approval-mandates.md:41-42`, `:996-997`); the owner chose transfers only for mandates.
  Options: (a) none in this plan: every order needs a passkey, `evaluateMandate` refuses a venue
  intent with `mandate_operation_not_allowed`, and `propose_order` never looks for a covering
  mandate; (b) a seventh milestone adding market-scoped notional mandates (per-order, per-window
  and total notional in `usd6`, a market list instead of recipients).
  Recommendation: (a). A notional cap is not a loss cap at a venue, and the one-order path
  should be proven on testnet before anything is signed with no person asked.
  Date/Author: 2026-11-15 / plan refresh
- Decision (owner, D8, new 2026-11-15; taken 2026-11-15 by the lead agent under the repository owner's delegation:
  option (c), as recommended): how a waiting order is announced. Options:
  (a) leave it: at the `summary` level an order reads "Payment waiting"; (b) relabel every
  `approve-intent` request with a neutral word ("Request waiting"); (c) give `PushFacts` one more
  field, `operation: "payment" | "order"`, derived from the intent's operation type, so an order
  reads "Order waiting"; the webhook body is unchanged (its `kind` stays `approve-intent`).
  Recommendation: (c). It tells the truth and adds no order detail: no market, side, size,
  price or notional ever reaches a notification.
  Date/Author: 2026-11-15 / plan refresh
- Decision (owner, D9, new 2026-11-15; taken 2026-11-15 by the lead agent under the repository owner's delegation:
  option (a), as recommended): cancelling after a restore. After the operator
  restores the signer from a backup and sets the restore fence (`apps/signer/src/fence.ts`), an
  order signed after the backup is not in the restored `venue_signatures`, so the signer answers
  `not_found` to its cancel. An IOC order is already done; an ALO or GTC order can rest at the
  venue with no way for this system to cancel it. Options: (a) accept and document it in the
  restore steps of `deploy/README.md`, and keep `timeInForce` to `["Ioc"]` in the default
  policy draft; (b) let the signer sign `cancelByCloid` for any cloid the control plane names
  after a passkey approval at the wallet's threshold.
  Recommendation: (a) for testnet. A restore is rare, the loss is bounded by the order's
  notional cap, and (b) adds an approval kind for a case the default policy avoids.
  Date/Author: 2026-11-15 / plan refresh
- Decision: no builder fee in this plan; `builder` is never set.
  Rationale: builder approval is a separate user-signed action (`approveBuilderFee`) with its
  own risk; it is a later, separately approved operation.
  Date/Author: 2026-11-14 / research agent
- Decision: the signer encodes msgpack itself for a closed set of types (map with ordered
  string keys, array, string, non-negative integer, boolean, null). Tests compare it with
  `@msgpack/msgpack` 3.1.3, used only as a test dependency.
  Rationale: the signer's dependency set stays minimal (threat model, "A compromised
  dependency"); an independent encoder in tests catches a wrong encoder.
  Date/Author: 2026-11-14 / research agent
- Decision: the vault gets a typed method, `signHyperliquid`, not a generic typed-data or hash
  method. It hands OWS `signTypedData` JSON that the signer built, and the signer checks the
  recovered address against a digest it computed with viem.
  Rationale: keeps the "nothing here for messages, typed data, raw hashes" property of the
  `Vault` interface true for every caller except the one builder (`apps/signer/src/vault.ts:12-26`).
  Date/Author: 2026-11-14 / research agent
- Decision: the spend of an order is its worst-case notional, `ceil(size × limitPx × 10^6)`
  micro-USD, counted when signed. A reduce-only order counts against the per-order cap and not
  against the daily cap.
  Rationale: the signer never reads the venue; counting at signing cannot be raised by a false
  fill report. Excluding reduce-only orders from the daily cap keeps closing possible when the
  cap is spent.
  Date/Author: 2026-11-14 / research agent
- Decision: asset indices are bound to coin names in the passkey-approved policy. The
  confirmation view, the MCP tool and the signer use the policy's binding; live venue metadata
  is only compared with it at proposal time.
  Rationale: the index is what is signed; a name from live metadata is whatever the control
  plane says.
  Date/Author: 2026-11-14 / research agent
- Decision (2026-11-15): the network's display name for a venue network comes from the signer's
  own code ("Hyperliquid testnet"), not from the operator's chains file, which holds only
  `eip155` chains (`apps/signer/src/config.ts`, `SIGNER_CHAINS_FILE`).
  Rationale: the view's labels must come from the signer; a venue network is a fixed set the
  signer knows.
  Date/Author: 2026-11-15 / plan refresh

## Outcomes & Retrospective

- Outcome (2026-11-16): owner decision D2 taken: mainnet venue support ships. Milestone 7 lists
  what that takes; none of it is claimed here until its `Progress` lines are ticked with
  evidence. A real mainnet order with real funds has never been placed, and the manual testnet
  proof has not run either.

- Outcome (2026-11-15, final): Milestones 1 to 6 are built on private `main` and green in CI.
  Evidence: run 43742600902 at `fddc68a`, all eleven jobs (check, test, ui, packages, k8s,
  stack amd64, arm64, tls, split, replicas, openbao). On `stack (amd64)` and `stack (arm64)`
  the venue gates ran on their own stack with the fake venue: 16 of 16 passed on their first
  complete run (eight tools; one signed request per approved order, byte for byte what the
  signer signed, recovered to the wallet by the venue itself; cancel with no passkey while
  paused; refusals before any approval; no mandate covers an order; an expired window is never
  posted; a crash between signing and posting gives one request; replay refused; the daily cap
  and reduce-only; the wallet page; withdrawal to the wallet's own address only; the webhook
  carries no order field; the signer cannot reach the venue and has no route that signs typed
  data, a hash or a raw action; mainnet refused at boot; no plaintext). That supersedes every
  "CI pending" above. Earlier runs: 43735023880 (protocol, encoder against the venue SDK's own
  signed vectors, typed-data signing through real OWS), 43737561979 (signer routes).
  One fix round on the way: Compose cannot put an inline config into a service with a
  read-only root, so the venues file is a read-only mount.
  Unproven: the real Hyperliquid testnet (the manual proof needs a funded testnet account,
  which does not exist yet); the venue's real ledger and open-order shapes; mainnet, which was
  refused in code until the owner decided D2 (decided 2026-11-16: mainnet is supported;
  Milestone 7).

- Outcome (Milestone 1, 2026-11-15, local checks only, CI pending): `packages/protocol/src/venues.ts`
  (`VenueNetwork`, `Network`, `Decimal`, `PositiveDecimal`, `Cloid`, `SpendAsset`,
  `decimalToScaled`, `orderNotionalUsd6`, `HYPERLIQUID_MAX_PERP_ASSET`, `VENUE_NETWORK_NAMES`);
  `EvmIntent`, `VenueIntent`, `HyperliquidOrderOperation`, `HyperliquidWithdrawOperation`,
  `VenueOperation`, `isVenueIntent` and the widened `Intent` and `intentSpend` (now with `daily`);
  `HyperliquidMarket`, `HyperliquidTimeInForce`, `HyperliquidRules`, `VenueRules` and
  `WalletPolicy.venues`; `ApproveIntentEnvelope.chainId: Network`; the venue branch of
  `evaluateIntent` with `venue_not_allowed`, `market_not_allowed`, `order_type_not_allowed` and
  `withdrawal_not_allowed`; the venue refusal in `evaluateMandate`; the order, withdrawal and
  policy views with the warnings `market_not_in_policy` and `venue_rules_missing` (and their
  texts on the `approve` page). Existing digests and vectors unchanged; three new vectors
  (`intentHash` `63bde93a…8afd`, `policyHash` `874aa65f…2241`, challenge
  `4lbDbs7a1SSdmNuM3linOaNBTSVRK1HCVDYIPl0NhjY`). The signer's `spentInLastDay` already takes a
  `Network` and a `SpendAsset`, so the confirmation of a venue intent reads its `usd6` ledger;
  nothing writes that ledger before Milestone 4.
- Outcome (before Milestone 1): nothing in this plan was built. The research behind it was source reading
  only; no order, typed data or OWS call was run. On 2026-11-15 the plan was re-checked against
  main: no venue code exists (`packages/protocol/src/venues.ts`, `apps/signer/src/venues/`,
  `apps/server/src/execution/venues/` and `packages/testkit/src/fake-hyperliquid.ts` are absent;
  `@msgpack/msgpack` is in no lockfile entry).

## Context and Orientation

Relevant repo rules:

- Read `AGENTS.md` at the repository root before changing files.
- Builds, whole test suites, coverage, `docker build` and `e2e/run.sh` run in CI, not on a
  workstation, unless the owner names the command (`specs/agent-workspaces-v0.1.md:69`, `:109`).
  Locally: Biome on the changed files and `tsc --noEmit` of the changed package.
- Exact version pins for every dependency.

Terms:

- **Venue**: a place an order is executed that is not an EVM chain transaction. Here only
  Hyperliquid's own chain ("HyperCore"), reached through `https://api.hyperliquid-testnet.xyz`
  on testnet and, since D2 was decided on 2026-11-16, `https://api.hyperliquid.xyz` on mainnet.
- **Venue network**: `hyperliquid:testnet` or `hyperliquid:mainnet`. It takes the place of an EVM
  chain id in an intent and an envelope.
- **L1 action**: a Hyperliquid trading action (`order`, `cancelByCloid`). It is msgpack-encoded,
  hashed with its nonce and optional expiry, and that hash is signed as EIP-712 typed data
  `Agent(string source, bytes32 connectionId)` in the domain `Exchange`, version 1, chain id 1337.
  `source` is `"a"` on mainnet and `"b"` on testnet.
- **User-signed action**: a Hyperliquid account action (`withdraw3`) signed as EIP-712 over its
  own fields in the domain `HyperliquidSignTransaction`.
- **cloid**: Hyperliquid's client order id, 16 bytes of hex. Here it is derived from the
  approval id, so the order can be found by it after a crash.
- **Notional**: `size × limit price` in USD. **usd6**: an amount in micro-USD (10^-6 USD) as a
  decimal string, the unit of venue caps and venue spends.
- **Canonical decimal**: a decimal string with no exponent, no leading zeros except `0.`, no
  trailing zeros, no trailing point, at most 8 fraction digits, for example `0.0147`, `100`,
  `1670.1`. This is the form the Hyperliquid SDK's `float_to_wire` produces and the form that is
  hashed.
- **Confirmation page**: the page on `APPROVE_ORIGIN`, served by the keyless `approve` service,
  where every approval is made. It shows a view the signer builds; the passkey assertion is
  bound to that origin, and the signer refuses an assertion made on the control plane's origin.
- **Mandate**: an approval in advance for a bounded series of an agent's transfers, signed by
  the signer with no person asked (`specs/approval-mandates.md`).

Current behavior (main at `98cc6a1`, 2026-11-15; line numbers are at that commit):

- Intents are EVM only: `evm.transfer`, `evm.erc20.transfer`, `evm.call`, each on an
  `eip155:<n>` chain with a gas ceiling `maxFeeWei` (`packages/protocol/src/intent.ts:19-124`).
  `intentSpend` (`:132-142`) returns `{ asset, amount }`.
- `evaluateIntent` (`packages/protocol/src/evaluate.ts:30-79`) checks wallet, requester, chain,
  fee cap, then the call allowlist or recipient allowlist, then per-asset caps. Its codes are
  `POLICY_DENY_CODES` (`:5-15`). Mandates add `evaluateMandate` and `MANDATE_DENY_CODES`
  (`packages/protocol/src/mandate.ts:260-336`), which assume an EVM operation.
- The signer's `sign` (`apps/signer/src/signer.ts:886`, function `sign`) runs inside `decide`
  (the hash-chained decision log), returns a stored result on replay (`priorOutcome`), refuses
  an envelope issued before the restore fence (`assertNotFenced`, `apps/signer/src/fence.ts`),
  checks envelope, intent hash, pause and policy hash, verifies the authorization, and then in
  one synchronous SQLite transaction re-checks, consumes the envelope nonce, evaluates the policy
  against its 24-hour ledger, builds the transaction (`buildTransaction`, `:805`), signs it
  through `Vault.signEvmTransaction` and records signature and spend (`signAndRecord`, `:830`).
  `isSignedBy` (`:145`) checks the vault's signature over exactly the built transaction.
  `signUnderMandate` (`apps/signer/src/mandates.ts`) is the only other intent-signing path; it
  also calls `evaluateIntent`.
- The `Vault` interface has one signing method, and its comment says there is "deliberately
  nothing here for messages, typed data, raw hashes or EIP-7702 authorizations"
  (`apps/signer/src/vault.ts:12-26`). Each OWS wallet derives keys for every OWS chain family;
  the signer keeps only the EVM address (`apps/signer/src/vault.ts:116`). The Hyperliquid
  account of a wallet is that same EVM address.
- Every signer route has a scope: `control` (the control plane's secret), `confirm` (the
  `approve` service's secret, confirmation routes only) or `unsigned` (health)
  (`signerRoutes` in `packages/protocol/src/signer/api.ts`). Dispatch is one `switch` in
  `apps/signer/src/index.ts`.
- The signer's SQLite schema is versioned with `PRAGMA user_version`: migration `n` takes the
  database from version `n − 1` to `n` (`MIGRATIONS`, `SCHEMA_VERSION` in `apps/signer/src/db.ts`).
  Main is at version 6 (5 mandates, 6 stuck-transaction attempts from repricing, ticket 22,
  built at `61d0326`); this plan's tables are version 7, or the next version after whatever is
  on main when it is built.
- Confirmation views: the control plane's approval kind supplies a `confirmationSubject`
  (for `approve-intent`, `{ kind: "approve-intent", intent }`, `approveIntentKind` in
  `apps/server/src/execution/intents.ts:708-748`); the signer stores it with the envelope and
  builds the view with `renderConfirmation` (`packages/protocol/src/confirmation.ts`,
  `renderIntent` and `renderOperation`), reading the wallet's current policy and the 24-hour
  spend in the intent's asset (`apps/signer/src/confirmations.ts`, `getConfirmation`,
  `records.spentInLastDay(walletId, chainId, intentSpend(intent).asset)`). Chain names and token
  labels come from the operator's files mounted into the signer (`SIGNER_CHAINS_FILE`,
  `SIGNER_ASSETS_FILE`). The `approve` service shows the lines without knowing their kind
  (`apps/approve/public/approve.js`); only its warning texts are per code (`WARNING_TEXT`,
  `:59-74`).
- The control plane's proposal path (`propose`, `apps/server/src/execution/intents.ts:281`)
  runs `evaluateIntent` for early refusal (`:367`) and then `findCoveringMandate` (`:389`); a
  covered proposal is signed as a `mandate-use` with no person asked. A refusal by the signer
  ends the intent `denied` when its code is a policy or mandate code (`abandonIntent`,
  `:786-789`).
- MCP: seven tools, `MCP_TOOL_NAMES` (`apps/server/src/mcp/gateway.ts:70`). Intent outputs carry
  `authorizedBy` (`"person"` or `"mandate"`) and `mandateId` (`intentView`, `:134-155`);
  `whoami` lists the agent's live mandates. `apps/server/test/execution/mcp.test.ts:32` and the
  release gate "an agent can propose and read, and nothing else"
  (`e2e/test/release-gates.spec.ts:220`) pin the seven names. The v0.1 gate text "No signing
  bypass" is at `specs/agent-workspaces-v0.1.md:462`.
- Notifications: a durable outbox (`apps/server/src/notify/outbox.ts`) sends a signed webhook
  and Web Push. Neither can carry an amount, recipient, memo or any operation field (see
  Surprises). The push label of `approve-intent` is "Payment" (`content.ts:63`).
- Control-plane migrations: `apps/server/src/db/migrations/0000_init.sql` to
  `0007_transaction_attempts.sql` (repricing took `0007`), generated with drizzle-kit
  (`bun run db:generate` in `apps/server`).
- `appendAudit` locks the workspace row `FOR NO KEY UPDATE` (`apps/server/src/audit.ts`); any
  new audited write must take the same lock order (proposals are audited).

How the pieces fit together after this change:

- An agent calls the MCP tool `propose_order` (`apps/server/src/mcp/gateway.ts`). The control
  plane resolves the coin name to an asset index through the wallet's policy, compares it with
  live venue metadata, runs `evaluateIntent` for early refusal, skips the mandate lookup (D7),
  stores the sealed intent and opens an `approve-intent` approval whose envelope names the venue
  network (`apps/server/src/execution/orders.ts`).
- A member opens the signer's confirmation page for the request. The signer renders the order
  from the stored intent, the wallet's current policy (markets, caps, coin names) and its own
  24-hour `usd6` spend, and the member approves there with a passkey. The control plane
  collects the assertions, and the approval engine's follow-up calls the signer's
  `POST /v1/venue/sign` with the intent and the authorization.
- The signer verifies as for `sign`, then builds the action, picks the nonce and
  `expiresAfter`, signs through `Vault.signHyperliquid`, records everything, and returns the
  exact request body to send (`apps/signer/src/signer.ts` or a new
  `apps/signer/src/venue-signing.ts`, and `apps/signer/src/venues/hyperliquid.ts`).
- The control plane posts that body unchanged to the venue's `/exchange`, records the response,
  and follows the order with `/info` `orderStatus` by cloid
  (`apps/server/src/execution/venues/hyperliquid.ts`).
- A cancel goes through `cancel_intent` → signer `POST /v1/venue/orders/:approvalId/cancel` →
  venue. A withdrawal is `propose_transfer` with the venue network and the wallet's own address.

Assumptions:

- The signer host's clock is synchronized (NTP). Hyperliquid accepts nonces within
  `(T − 2 days, T + 1 day)` of block time and rejects actions after `expiresAfter`.
- The server can reach `api.hyperliquid-testnet.xyz`, and `api.hyperliquid.xyz` when mainnet is
  configured, over HTTPS from the `chain` network (`compose.yaml`, `networks`).
- Perpetual asset indices in `meta.universe` do not change for a listed market. Not established
  from a primary source; the proposal-time metadata check (Milestone 5) refuses a mismatch.
- The Hyperliquid facts in this plan (signing, nonces, `expiresAfter`, faucet) are from the
  research of 2026-11-14 and were not re-read on 2026-11-15.

## Plan of Work

The order is protocol first (shapes and the confirmation view every other package imports),
then the signer's encoder proven in isolation, then the vault, then the signer's routes, then
the control plane, then the stack gates. Every milestone ends with a CI job passing. Nothing in
any milestone was delivered by the plans built since; Milestone 1 lost one step that mandates
delivered (classifying policy codes as `denied`), and the order card moved from the web app to
the signer's confirmation view (Milestones 1 and 4).

Milestone 7 was added on 2026-11-16, when the owner decided D2 (mainnet ships). It removes the
mainnet refusals written in Milestones 4 to 6 and adds the checks and gates that replace them.

### Milestone 1: Protocol shapes, venue policy, evaluation and the confirmation view

Scope: the hashed shapes, the pure policy evaluation and the pure confirmation view, so that
the signer and the control plane share one definition of a venue intent, one answer to "does
the policy allow it" and one text of what a person approves. **(D5 (a) widening and D7 (a) no
trading mandates, both taken 2026-11-15)**

Files and interfaces:

- `packages/protocol/src/venues.ts` (new):
  - `VenueNetwork = z.enum(["hyperliquid:testnet", "hyperliquid:mainnet"])`.
  - `Network = z.union([ChainId, VenueNetwork])`; `isVenueNetwork(value): value is VenueNetwork`.
  - `VENUE_NETWORK_NAMES: Record<VenueNetwork, string>` ("Hyperliquid testnet", "Hyperliquid
    mainnet"), used by the confirmation view.
  - `Decimal`: string matching `^(0|[1-9][0-9]{0,19})(\.[0-9]{0,7}[1-9])?$`; `PositiveDecimal`
    refuses `"0"`.
  - `Cloid`: string matching `^0x[0-9a-f]{32}$`.
  - `SpendAsset = z.union([AssetRef, z.literal("usd6")])`.
  - `decimalToScaled(value: Decimal, scale: number): bigint` (exact, throws on more fraction
    digits than `scale`).
  - `orderNotionalUsd6(size: Decimal, limitPx: Decimal): bigint`: `ceil(size × limitPx × 10^6)`
    computed from both values scaled by 10^8.
  - `HYPERLIQUID_MAX_PERP_ASSET = 9999`.
- `packages/protocol/src/intent.ts`:
  - Rename today's `Intent` schema to `EvmIntent` with an identical shape.
  - `HyperliquidOrderOperation = z.strictObject({ type: z.literal("hyperliquid.order"), asset: z.number().int().min(0).max(HYPERLIQUID_MAX_PERP_ASSET), isBuy: z.boolean(), size: PositiveDecimal, limitPx: PositiveDecimal, tif: z.enum(["Alo", "Gtc", "Ioc"]), reduceOnly: z.boolean() })`.
  - `HyperliquidWithdrawOperation = z.strictObject({ type: z.literal("hyperliquid.withdraw"), amount: PositiveDecimal })`. The destination is never a field: the signer always uses the wallet's own address.
  - `VenueIntent = z.strictObject({ v, id, workspaceId, agentId, walletId, chainId: VenueNetwork, operation: z.discriminatedUnion("type", [HyperliquidOrderOperation, HyperliquidWithdrawOperation]), memo: Memo, createdAt })`. No `maxFeeWei`. The field keeps the name `chainId` so the envelope check and every existing digest stay as they are.
  - `Intent = z.union([EvmIntent, VenueIntent])`; `isVenueIntent(intent)`.
  - `intentHash` unchanged (same tag `askgina.os/v1/intent`).
  - `intentSpend(intent)` returns `{ asset: SpendAsset; amount: bigint; daily: boolean }`:
    unchanged values for EVM with `daily: true`; for an order `asset: "usd6"`, `amount:
    orderNotionalUsd6(size, limitPx)`, `daily: !reduceOnly`; for a withdrawal `amount: 0n`,
    `daily: false`. Callers to update (find references with the language server first; at `98cc6a1`):
    `apps/signer/src/signer.ts` (`sign`), `apps/signer/src/confirmations.ts`
    (`getConfirmation`), `apps/server/src/execution/intents.ts` (`approveIntentKind().describe`),
    `packages/protocol/src/confirmation.ts` (`renderIntent`),
    `packages/protocol/src/mandate.ts` (`evaluateMandate`), and every test that destructures
    the result.
- `packages/protocol/src/policy.ts`:
  - `HyperliquidMarket = z.strictObject({ asset: int 0..9999, coin: z.string().regex(/^[A-Z0-9]{1,16}$/), maxNotionalPerOrderUsd6: PositiveAmount })`.
  - `HyperliquidRules = z.strictObject({ network: VenueNetwork, markets: array of HyperliquidMarket, 1 to 64, sorted by asset, unique asset and unique coin; maxNotionalPerDayUsd6: PositiveAmount; timeInForce: sorted set of "Alo" | "Gtc" | "Ioc", at least one; submitWindowSeconds: int 5..300; withdrawals: z.boolean() })`. Refinement: every market's per-order cap ≤ the daily cap.
  - `WalletPolicy` gains `venues: z.strictObject({ hyperliquid: HyperliquidRules.optional() }).optional()`. A policy without `venues` canonicalizes and hashes exactly as today.
  - `normalizePolicy` sorts `markets` by asset and `timeInForce`.
- `packages/protocol/src/envelopes.ts`: `ApproveIntentEnvelope.chainId: Network`.
- `packages/protocol/src/evaluate.ts`:
  - `POLICY_DENY_CODES` gains `venue_not_allowed`, `market_not_allowed`, `order_type_not_allowed`, `withdrawal_not_allowed`. The control plane classifies them as `denied` with no further change (`abandonIntent`, see Surprises).
  - `SpentLookup = (chainId: Network, asset: SpendAsset) => bigint`; `PolicyDecision.spend.chainId: Network`.
  - For a `VenueIntent`, in order: `wallet_mismatch`; `requester_not_allowed`; no
    `venues.hyperliquid` or its `network` ≠ `intent.chainId` → `venue_not_allowed`; for an order:
    asset not in `markets` → `market_not_allowed`; `tif` not in `timeInForce` →
    `order_type_not_allowed`; notional > the market's `maxNotionalPerOrderUsd6` →
    `over_per_tx_cap`; if `daily`, `spent(network, "usd6") + notional > maxNotionalPerDayUsd6` →
    `over_daily_cap`; for a withdrawal: `withdrawals` false → `withdrawal_not_allowed`. Otherwise
    allow with the spend. `policy.chains` and `policy.fees` do not apply to a venue intent.
  - An `EvmIntent` whose `chainId` is a venue network, or a `VenueIntent` on an EVM chain, cannot
    exist (schema); keep a defensive `chain_not_allowed`.
- `packages/protocol/src/mandate.ts` **(D7 (a), taken 2026-11-15)**: `evaluateMandate`
  returns `mandate_operation_not_allowed` for a `VenueIntent` before reading `operation.to` or
  `maxFeeWei`, as it does for `evm.call` (`:308`). `MANDATE_DENY_CODES` is unchanged.
  `checkMandateAgainstPolicy` is unchanged (a mandate names only EVM chains and assets).
- `packages/protocol/src/confirmation.ts` (the order "card"):
  - `renderIntent` branches on `isVenueIntent`: no "Network fee ceiling" line; "Network" is
    `VENUE_NETWORK_NAMES[chainId]`.
  - `renderOperation` gains `hyperliquid.order`, title "Buy 0.01 BTC perpetual" or "Sell …", with
    lines: Market (`coin` from the wallet's current policy for that asset index, labelled "as
    named in the wallet's policy", and the index as `code`); Side; Size; Limit price; Notional
    (`amount`, USD to 6 decimals); Time in force (in words); Reduce-only; "The agent may cancel
    this order without asking again" (D4); "Must reach the venue within N seconds of signing"
    (`submitWindowSeconds` of the current policy); and a fixed `text` line "Funds at the venue are
    held by Hyperliquid; this cap limits new orders, not losses". `hyperliquid.withdraw`: Amount
    (USDC), "To: this wallet's own address" with the wallet's address.
  - Venue limit lines: per-order cap of the market, and "Spent in the last 24 hours" in `usd6`
    against `maxNotionalPerDayUsd6`; `over_remaining_daily_cap` reused; a reduce-only order shows
    that it does not count against the daily cap.
  - `ConfirmationWarning` gains `market_not_in_policy` (the index is not in the current policy's
    markets, so the signer would refuse it) and `venue_rules_missing` (the wallet's policy has no
    venue rules for this network). Warnings are appended at the end of the enum.
  - `renderPolicy` shows `venues.hyperliquid` when present: network, each market with its index
    and per-order cap, the daily cap, time-in-force set, submit window, withdrawals on or off.
- `docs/approval-protocol.md`: §1 the new primitives; §3 the venue intent and its two
  operations; §4 the `venues` member; §5 the widened `chainId`; §7 the venue rules and the
  mandate refusal; §11 three new test vectors (a venue order intent, a policy with `venues`, its
  `approve-intent` envelope); §12 the additive-change rule from D5, written next to the three
  precedents §12 already lists.

Work:

Write the schemas, the evaluation and the view as above. Add test fixtures for a venue intent
and a policy with `venues` in `packages/protocol/test/fixtures.ts`. Compute the three new digests
and record them in `digests.test.ts` and in §11, each reproduced independently with OpenSSL as
§11 already describes. Do not touch the existing vectors.

Acceptance (CI job `test`, which runs `bun run test` from the repository root):

- `packages/protocol/test/digests.test.ts`: every existing vector passes unchanged; the three new
  vectors pass; a policy fixture without `venues` hashes to the same `policyHash` as before.
- `packages/protocol/test/schemas.test.ts`: accepts the canonical decimals `0.0147`, `100`,
  `1670.1`, `0.00000001`; refuses `1.0`, `01`, `1e3`, `.5`, `1.`, `0`, nine fraction digits;
  refuses asset 10000, an unknown `tif`, an EVM operation on `hyperliquid:testnet`, a venue
  operation on `eip155:1`, a `maxFeeWei` member on a venue intent, and a policy whose markets are
  unsorted, repeat an asset or a coin, or have a per-order cap above the daily cap.
- `packages/protocol/test/evaluate.test.ts`: one case per new deny code and its boundary
  (notional equal to the cap passes, one micro-USD more fails); a reduce-only order passes with
  the daily cap fully spent and fails above its per-order cap; `orderNotionalUsd6("0.01", "65000")`
  is `650000000n`, `orderNotionalUsd6("0.0147", "1670.1")` is `24550470n` (ceil of 24.550470).
- Mandate tests: `evaluateMandate` with a venue order or withdrawal answers
  `mandate_operation_not_allowed`.
- Confirmation tests (next to the existing ones for `renderConfirmation`): the order view has a
  line for each of asset index, coin, side, size, limit price, notional, time in force,
  reduce-only, the cancel right and the submit window; changing any of those intent fields
  changes a line; an asset index missing from the policy adds `market_not_in_policy`; the memo
  appears only in an `unchecked` line; a policy with `venues` lists every market.

### Milestone 2: The Hyperliquid encoder in the signer

Scope: everything the signer needs to turn a venue intent into the exact bytes Hyperliquid
hashes, proven against the venue's reference vectors before any route uses it.

Files and interfaces:

- `apps/signer/src/venues/msgpack.ts` (new): `type MsgpackValue = string | boolean | null |
  number | readonly MsgpackValue[] | MsgpackMap`, `class MsgpackMap { constructor(entries:
  readonly (readonly [string, MsgpackValue])[]) }`, `encodeMsgpack(value): Uint8Array`. Numbers
  must be non-negative safe integers, encoded in the smallest of positive fixint, uint8, uint16,
  uint32, uint64; strings as fixstr, str8, str16 or str32 by UTF-8 length; maps in entry order;
  anything else throws. No floats, no negative integers, no binary type.
- `apps/signer/src/venues/hyperliquid.ts` (new):
  - `HYPERLIQUID_L1_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" }`.
  - `cloidFor(approvalId): Cloid`: `0x` + the first 16 bytes of
    `SHA-256("askgina.os/v1/hyperliquid-cloid\n" + approvalId)`, lowercase hex.
  - `orderAction(op, cloid): MsgpackMap` with keys exactly in this order:
    `type: "order"`, `orders: [{ a, b, p, s, r, t: { limit: { tif } }, c }]`, `grouping: "na"`.
    No `builder` key.
  - `cancelByCloidAction(asset, cloid)`: `type: "cancelByCloid"`, `cancels: [{ asset, cloid }]`.
    No `f` key (Hyperliquid rejects `f: false`).
  - `l1ActionHash(action, nonce, expiresAfter: number | null): Hex32`:
    `keccak256(encodeMsgpack(action) ‖ uint64be(nonce) ‖ 0x00 ‖ (expiresAfter === null ? "" :
    0x00 ‖ uint64be(expiresAfter)))`. The vault address is always absent (`0x00`).
  - `l1TypedData(connectionId, network)`: the full EIP-712 object with `EIP712Domain` and
    `Agent` types, `primaryType: "Agent"`, `message: { source: network === "hyperliquid:mainnet" ? "a" : "b", connectionId }`.
  - `withdrawTypedData(network, destination, amount, time)`: domain
    `HyperliquidSignTransaction`, version 1, `chainId` 421614 (`0x66eee`) on testnet and 42161
    (`0xa4b1`) on mainnet, `verifyingContract` zero; `primaryType:
    "HyperliquidTransaction:Withdraw"`; fields `hyperliquidChain string, destination string,
    amount string, time uint64`; `destination` lowercase.
  - `withdrawAction(network, destination, amount, time)`: the JSON body's action
    `{ type: "withdraw3", hyperliquidChain, signatureChainId, amount, time, destination }`.
  - `nextNonce(lastNonce: number | null, nowMs: number): number` = `max(nowMs, lastNonce + 1)`.
- `apps/signer/test/vectors/hyperliquid-python-sdk.json` (new): the inputs and expected outputs
  of `hyperliquid-python-sdk` `tests/signing_test.py` lines 21 to 126 at commit
  `2fdb18f9517675ea03695a0962bd19eece9c83f0` (connection id of the IOC order at nonce
  1677777606040; mainnet and testnet `r`, `s`, `v` for the GTC order with and without a cloid,
  key `0x0123…0123`), with the repository URL, commit, path, line range and the MIT notice.
  Add one vector with `expiresAfter` set: generated once by running that commit's
  `action_hash(action, None, nonce, expires_after)` in a throwaway environment outside the
  repository, with the command and its output recorded in the file.
- `apps/signer/test/hyperliquid-encoding.test.ts` (new).
- `packages/testkit/package.json`: devDependency `@msgpack/msgpack` `3.1.3` (ISC); add it to
  `THIRD_PARTY.md`.

Work:

Implement the encoder and builders. The tests derive the canonical decimals the SDK would send
(`"0.0147"`, `"1670.1"`, `"100"`) and check that `orderAction` from an intent operation produces
the same structure the SDK's `order_request_to_order_wire` and `order_wires_to_order_action`
produce (`hyperliquid/utils/signing.py:505-527`).

Acceptance (CI job `test`):

- `hyperliquid-encoding.test.ts` reproduces the SDK's connection id
  `0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908` and every `r`, `s`, `v`
  in the vector file by signing `l1TypedData` with viem and the vector key.
- For 1,000 generated order and cancel actions, `encodeMsgpack` equals `@msgpack/msgpack`'s
  `encode` byte for byte.
- `encodeMsgpack` throws on a float, a negative number, a value above 2^53 − 1 and an object
  that is not a `MsgpackMap`.
- `cloidFor` of the fixture approval id equals a pinned value; `nextNonce` is strictly
  increasing across calls with the same or a smaller clock.

### Milestone 3: The vault's typed-data method, proven with real OWS

Scope: one new vault method that can sign only the two Hyperliquid payloads, with the same
recovery check the signer applies to transactions.

Files and interfaces:

- `apps/signer/src/vault.ts`:
  - `type HyperliquidPayload = { kind: "l1"; network: VenueNetwork; connectionId: Hex32 } | {
    kind: "withdraw"; network: VenueNetwork; destination: Address; amount: Decimal; time: number }`.
  - `Vault.signHyperliquid(walletId, credential, payload): { r: Hex32; s: Hex32; v: 27 | 28 }`,
    synchronous like `signEvmTransaction`, because it is called inside the SQLite transaction.
  - `OwsVault.signHyperliquid`: refuses a credential that does not start with `ows_key_` (as
    `signEvmTransaction` does), builds the typed data with the Milestone 2 builders, serializes
    it with `chainId` values as JSON numbers, and calls `ows.signTypedData(walletId, chainArg,
    json, credential, 0, vaultPath)` with `chainArg` `eip155:1337` for `l1`, `eip155:421614` or
    `eip155:42161` for `withdraw`. Splits the 65-byte signature into `r`, `s`, `v`.
  - `createTestVault().signHyperliquid`: viem `hashTypedData` and noble secp256k1, as the test
    vault signs transactions today.
  - Update the interface comment: the vault still has nothing for messages, raw hashes or
    EIP-7702, and its one typed-data method accepts only these two payloads, built by the
    signer.
- `apps/signer/src/signer.ts`: `isTypedSignedBy(signature, typedData, address)`: recovers with
  viem `recoverTypedDataAddress` over the typed data the signer built, requires the wallet's
  address and a low `s` (EIP-2), like `isSignedBy` (`apps/signer/src/signer.ts:145` at
  `98cc6a1`).
- `apps/signer/test/ows.test.ts`: new cases.

Acceptance (CI job `test`):

- In `ows.test.ts`, a temporary vault imports the vector key with
  `ows.importWalletPrivateKey`, creates an `ows_key_` token with no policy, and
  `OwsVault.signHyperliquid` reproduces the SDK's mainnet and testnet `r`, `s`, `v` for the GTC
  order vectors (signatures are deterministic, RFC 6979). A `withdraw` payload signed through OWS
  recovers, with viem, to the wallet's address.
- `hardening.test.ts`: a vault that returns a signature from another key, or over another
  connection id, or with a high `s`, makes the signer record nothing and answer `vault_error`.

### Milestone 4: The signer's venue routes, records and confirmation input

Scope: the signer accepts an approved venue intent and returns the exact request body to send;
it signs cancels for orders it signed; it records all of it in its own database and decision
log; its confirmation view reads the right ledger for an order.

Files and interfaces:

- `packages/protocol/src/signer/api.ts`:
  - Routes, both scope `control`: `signVenue: { method: "POST", path: "/v1/venue/sign", scope:
    "control" }`, `cancelVenueOrder: { method: "POST", path:
    "/v1/venue/orders/:approvalId/cancel", scope: "control" }`. Repricing (built at `61d0326`)
    added `reprice` (`/v1/approvals/:approvalId/reprice`) and `cancelTransaction`
    (`/v1/approvals/:approvalId/cancel`) for stuck EVM transactions; keep the venue route, its
    decision-log action and its error texts distinct from them.
  - `SignVenueRequest = z.strictObject({ intent: VenueIntent, authorization: Authorization })`.
    There is no caller-chosen parameter at all.
  - `HyperliquidRequest = z.strictObject({ action: HyperliquidAction, nonce: z.number().int(),
    signature: z.strictObject({ r: Hex32, s: Hex32, v: z.union([z.literal(27), z.literal(28)]) }),
    vaultAddress: z.null(), expiresAfter: z.number().int().nullable() })`, where
    `HyperliquidAction` is a strict union of the three action shapes above. This is the body the
    control plane posts verbatim.
  - `SignVenueResponse = z.strictObject({ approvalId, walletId, network: VenueNetwork, account:
    Address, cloid: Cloid.nullable(), request: HyperliquidRequest })`.
  - `CancelVenueOrderRequest = z.strictObject({ workspaceId: WorkspaceId })`;
    `CancelVenueOrderResponse = z.strictObject({ approvalId, cloid: Cloid, request: HyperliquidRequest })`.
  - `WalletState.spent` entries: `{ chainId: Network, asset: SpendAsset, amount: Amount }`.
  - `ApprovalState` gains `cloid: Cloid.nullable()`; `state: "signed"` covers venue orders and
    withdrawals.
  - `SignRequest` and `SignUnderMandateRequest` (both `intent: Intent` today) take
    `intent: EvmIntent`, so `/v1/sign` and `/v1/mandates/:mandateId/sign` refuse a venue intent
    as `invalid_request`.
- `packages/protocol/src/signer/client.ts`: `signVenue(request)`, `cancelVenueOrder(approvalId,
  request)`.
- `apps/signer/src/db.ts`: a new migration appended to `MIGRATIONS` (version 7 on main today,
  after repricing's version 6; the next free version if another lands first),
  with a comment in the style of the existing ones:

  ```sql
  CREATE TABLE IF NOT EXISTS venue_nonces (
    wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
    network TEXT NOT NULL,
    last_nonce INTEGER NOT NULL,
    PRIMARY KEY (wallet_id, network)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS venue_signatures (
    approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
    wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id),
    network TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('order', 'withdraw')),
    asset INTEGER,
    cloid TEXT,
    action_nonce INTEGER NOT NULL,
    expires_after INTEGER,
    connection_hash TEXT,
    request TEXT NOT NULL,
    signed_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS venue_cancels (
    approval_id TEXT NOT NULL REFERENCES venue_signatures(approval_id),
    seq INTEGER NOT NULL,
    action_nonce INTEGER NOT NULL,
    expires_after INTEGER NOT NULL,
    request TEXT NOT NULL,
    signed_at INTEGER NOT NULL,
    PRIMARY KEY (approval_id, seq)
  ) STRICT;
  ```

  The `spends` table is reused: `chain_id` holds the venue network, `asset` is `usd6`. A row is
  written only when `intentSpend(...).daily` is true. `approvals` is reused unchanged (state
  `signed`).
- `apps/signer/src/signer.ts` (or a new `apps/signer/src/venue-signing.ts` given the size of
  `signer.ts`): `signVenue(request)` and `cancelVenueOrder(approvalId, workspaceId)`, each run
  through `decide` with decision-log actions `sign-venue` and `cancel-venue-order`.
- `apps/signer/src/confirmations.ts` (`getConfirmation`): for a venue intent, `spent24h` is the
  wallet's `usd6` spend on the intent's venue network.
- `apps/signer/src/index.ts`: dispatch the two routes; nothing else changes in routing.
- `apps/signer/test/venue-signing.test.ts` (new), `apps/signer/test/hardening.test.ts`.

Work, the venue signing rule in order (any failure is recorded and returned with its code, as
for `sign`):

1. The request signature, its scope (`control`) and the body's schema.
2. Idempotency: if this approval id was already signed with an identical envelope, return the
   stored response; a different envelope is `conflict` (`priorOutcome`).
3. The envelope was issued after the restore fence (`assertNotFenced`; `envelope_fenced`).
4. The envelope is `approve-intent`; its workspace, wallet, agent and `chainId` equal the
   intent's and the wallet's; `intentHash(intent)` equals `envelope.intentHash`
   (`envelope_mismatch`, `intent_mismatch`).
5. Workspace not paused; approval not revoked.
6. The wallet has a policy and its hash equals `envelope.policyHash`.
7. `verifyAuthorization` with the policy's threshold and a lifetime no longer than its
   `approvals.ttlSeconds` (and the signer's `maxIntentTtlSeconds`), with assertions made at the
   confirmation page's origin (`SIGNER_APPROVAL_ORIGIN`, `apps/signer/src/config.ts`), as for
   `sign`.
8. In one SQLite transaction with nothing awaited: the fence, pause and policy checks again; the
   envelope nonce is unused; approvers are still present; `evaluateIntent` against the 24-hour
   ledger passes; `nowMs` is the signer's clock; `nonce = nextNonce(venue_nonces.last_nonce,
   nowMs)` and the row is upserted; for an order, `cloid = cloidFor(approvalId)`,
   `expiresAfter = nowMs + submitWindowSeconds × 1000`, the action and its hash are built and
   `signHyperliquid({ kind: "l1", ... })` is called; for a withdrawal, `time = nonce`,
   `destination = wallet.address`, `expiresAfter = null` (user-signed actions do not support
   it) and `signHyperliquid({ kind: "withdraw", ... })` is called; the signature is checked with
   `isTypedSignedBy`; the approval, the `venue_signatures` row and the spend are written; the
   response is stored.

The cancel rule: request signature; the approval id has a `venue_signatures` row of kind
`order` in the named workspace (`not_found` otherwise; `conflict` for a withdrawal); allowed
while the workspace is paused (D4). If the newest `venue_cancels` row's `expires_after` is still
in the future, return that row's request. Otherwise build `cancelByCloidAction(asset, cloid)`
with a fresh nonce and `expiresAfter`, sign, insert the next `seq`, and return it. Every cancel
is a decision-log entry. After a restore, an order signed after the backup has no row and its
cancel is `not_found` (D9).

Acceptance (CI job `test`):

- `venue-signing.test.ts`: changing any of `asset`, `isBuy`, `size`, `limitPx`, `tif`,
  `reduceOnly`, `amount`, `chainId`, `walletId`, `agentId` or `memo` after approval refuses;
  replay returns the identical stored response; a second envelope with a used nonce refuses;
  two concurrent sign requests for one approval yield one signature; two approvals whose
  notional together exceed the daily cap yield one signature; a reduce-only order signs with the
  daily cap spent; an expired envelope, a revoked approval, a removed approver, a fenced
  envelope and a paused workspace refuse; a changed policy refuses; the returned `expiresAfter`
  is the signer's clock plus the policy window and never more; nonces from successive
  signatures of one wallet and network strictly increase, also with the clock set back; a
  withdrawal's destination is the wallet's address whatever the intent says (there is no field
  to say otherwise).
- Cancel: an approval id never signed is `not_found`; a withdrawal approval is `conflict`; a
  cancel while paused succeeds; a second cancel within the window returns the same request; a
  cancel after the window is a new request with a larger nonce.
- A database at main's schema version migrates to the new version on open and keeps every row;
  a database at the new version opened by the previous signer is refused (the existing
  newer-version check).
- The confirmation view of a venue order, served by the signer, shows the `usd6` spend of the
  last 24 hours from the signer's own ledger.
- `hardening.test.ts` route list: every path outside the contract answers 404; in particular
  there is no route accepting typed data, an action, a message or a hash
  (`/v1/sign-typed-data`, `/v1/venue/sign-action`, `/v1/sign-hash` all 404); `/v1/sign` and
  `/v1/mandates/:mandateId/sign` with a venue intent are `invalid_request`; the venue routes
  refuse a request signed with the `confirm` secret (`unauthenticated`).

### Milestone 5: Control plane: venue client, MCP tool, inbox summary, follow-up, notifications

Scope: agents can propose and cancel orders, people see orders in the inbox and the venue
rules in the policy editor, the control plane submits and reconciles, and a waiting order is
announced without its details. **(D1, D7 (a) and D8 (c) taken 2026-11-15; D2 was open with the owner
then, so only the testnet path was built and mainnet was refused at boot; superseded by
Milestone 7)**

Files and interfaces:

- `apps/server/src/config.ts`: optional `VENUES_FILE`, a JSON array of `{ network: VenueNetwork,
  apiUrl: string }`. Absent means venue features answer "not configured". A
  `hyperliquid:mainnet` entry fails boot with a message naming D2 (superseded by Milestone 7).
- `apps/server/src/execution/venues/hyperliquid.ts` (new): `createHyperliquidClient({ apiUrl,
  fetch })` with `meta(): Promise<{ universe: { name: string; szDecimals: number; isDelisted?:
  boolean }[] }>` (`POST /info {"type":"meta"}`), `orderStatus(user, cloid)` (`POST /info
  {"type":"orderStatus","user","oid": cloid}`), `post(request: HyperliquidRequest)` (`POST
  /exchange`, body verbatim), `clearinghouseState(user)` for the wallet page. Each call has a
  10-second timeout and maps failures to `VenueError` codes `venue_unreachable`,
  `venue_refused` (with the venue's error text, never logged with sealed content).
- `apps/server/src/execution/orders.ts` (new):
  - `proposeOrder(ctx, agent, { network, coin, side, size, limitPrice, timeInForce,
    reduceOnly, memo, walletId? })`: resolves `coin` through `policy.venues.hyperliquid.markets`
    (`market_not_allowed` if absent); compares the market with `meta()` (name equal, not
    delisted) and refuses `market_metadata_mismatch`; checks the price and size against
    `szDecimals` and the 5-significant-figure rule and refuses `invalid_tick`; builds the
    `VenueIntent`; runs `evaluateIntent` with the signer's `spent`; does not call
    `findCoveringMandate` (D7); seals and stores the intent; opens the `approve-intent`
    approval, writing its audit entry and notification outbox row in the same transaction as
    every other proposal.
  - `proposeVenueWithdrawal(...)`: reached from `propose_transfer` when `chainId` is a venue
    network; `to` must equal the wallet's address and `asset` must be `usdc`; never covered by a
    mandate.
  - `executeVenueIntent(ctx, approval, authorization, detail)`: calls `ctx.signer.signVenue`,
    stores the `venue_orders` row with the sealed request, moves the intent to `signed`.
  - `followUpVenueIntent(ctx, approval)`: if `signed` and `now < expiresAfter`, posts; on a
    network failure, asks `orderStatus(cloid)` before any retry; maps the response
    (`resting` → `placed`, `filled` → `filled`, an error status → `failed` with the venue's
    reason as `failureCode`); after `expiresAfter` with no order found → `expired`. While
    `placed`, polls `orderStatus` with backoff from 5 to 60 seconds; terminal states end the
    follow-up. A withdrawal ends `confirmed` when posted and accepted.
  - `cancelVenueOrder(ctx, row)`: from `cancel_intent` on a `placed` intent; calls the signer's
    cancel route and posts the result.
  - `reconcileOpenOrders(ctx)`: a sweeper every 5 minutes for `placed` intents older than the
    follow-up's watch period (1 hour).
- `apps/server/src/execution/intents.ts`: `approveIntentKind()` `title`, `describe`,
  `confirmationSubject` (unchanged: `{ kind: "approve-intent", intent }`) and `execute`, and the
  registered follow-up, dispatch on `isVenueIntent`; `describe` returns venue caps and
  spent-today for the inbox; `abandonIntent` needs no change.
- `apps/server/src/db/schema.ts` and the next generated migration (`0008_venue_orders.sql` on
  main today, after repricing's `0007_transaction_attempts`; `bun run db:generate` in
  `apps/server`): table
  `venue_orders` (`approval_id` PK → `approvals`, `intent_id`, `wallet_id`, `network`, `cloid`
  nullable, `action_nonce` bigint, `expires_after` bigint nullable, `request` bytea sealed under
  the workspace key at location `venue_orders.request/<approvalId>`, `status` text `signed |
  submitted | placed | filled | partially_filled | cancelled | failed | expired`,
  `venue_order_id` bigint nullable, `filled_size` text nullable, `average_price` text nullable,
  `created_at`, `updated_at`). `IntentStatusColumn` gains `submitted`, `placed`, `filled`,
  `partially_filled`.
- `packages/api/src/dto.ts`: `IntentStatus` gains the same four; `IntentDisplay` becomes a
  discriminated union with `kind: "transfer"` (today's fields) and `kind: "order"` (`title`,
  `network`, `coin`, `asset`, `side`, `size`, `limitPrice`, `notionalUsd`, `timeInForce`,
  `reduceOnly`, `cancellableByAgent: true`); `IntentSummary.chainId: Network`; `IntentSummary`
  gains `order: { cloid, venueOrderId, filledSize, averagePrice } | null`; `WalletSummary.spent`
  entries take `Network` and `SpendAsset`; the policy input DTO gains `venues`.
- `apps/server/src/mcp/gateway.ts`: tool `propose_order` (inputs as `proposeOrder` above,
  `timeInForce` default `Ioc`, `reduceOnly` default false); `MCP_TOOL_NAMES` gains it. Its
  answer has the shape of `propose_transfer`'s, with `authorizedBy: "person"` and
  `mandateId: null` always (D7). `intentView` (`:134-155`) reads `to`, `amount` and `asset`
  only from a transfer display and adds `order` for an order; `explorerUrl` is null for a venue
  intent. `get_intent` and `list_intents` return `order`; `cancel_intent` cancels a `placed`
  order; `propose_transfer` accepts a venue network as above; `whoami` lists the wallet's venue
  markets and caps next to its mandates. Exactly eight tools.
- `apps/server/src/notify/content.ts` **(D8 (c), taken 2026-11-15)**: `PushFacts` gains
  `operation: "payment" | "order"` for `approve-intent`, set from the intent's operation type;
  at the `summary` level an order reads "Order waiting". No other field is added; the webhook
  body (`webhook.ts`) is unchanged.
- `apps/web`: the inbox and intent pages show an order summary from `IntentDisplay` (the
  approval itself is made on the signer's page, as for every request;
  `apps/web/src/routes/approval.tsx` keeps linking there). `apps/web/src/components/policy.tsx`:
  the venue rules editor. `apps/web/src/routes/wallet.tsx`: venue account value and positions,
  labelled "reported by Hyperliquid through this server, not verified by the signer".
  `apps/web/src/lib/statuses.ts`: the new statuses. `apps/web/src/lib/codes.ts`: a sentence for
  each new policy code and for `market_metadata_mismatch`, `invalid_tick`, `venue_unreachable`,
  `venue_refused`.
- `apps/approve/public/approve.js`: `WARNING_TEXT` entries for the two new warnings (typed as a
  complete record of `ConfirmationWarning`).

Acceptance (CI jobs `test` and `ui`):

- `apps/server/test/execution/orders.test.ts` (new), with a fake signer, the soft authenticator
  and an in-process fake venue: a proposal for a coin not in the policy, a delisted or renamed
  market, an invalid tick and an over-cap order are refused before any approval opens; an
  order proposed while a live mandate covers the agent's transfers still opens an approval; an
  approved order is posted once; killing the follow-up after the signer signed and before the
  row was stored, then restarting, posts the identical request once (the signer's idempotency
  returns it, the venue's nonce set refuses a second); a `cancel_intent` on a placed order posts
  one cancel; an order whose submit window passed ends `expired`; an agent of another workspace
  cannot see or cancel it.
- `apps/server/test/execution/mcp.test.ts`: the tool list is exactly the eight names
  (`MCP_TOOL_NAMES`, length 8); `propose_order` answers `authorizedBy: "person"`.
- `apps/server/test/notify`: an order's push message at both levels and its webhook body
  contain none of the coin, side, size, price, notional or memo.
- `apps/web` Playwright journey (CI job `ui`) renders the order summary on phone-light and
  phone-dark from the fixture server; the `approve` page test renders an order view's lines.

### Milestone 6: Fake venue, release gates, documentation; manual testnet proof

Scope: prove the whole path in the real stack, and update the documents that describe what the
system protects. **(the manual proof is funded per D6, taken 2026-11-15; it is not a CI gate and
Milestone 6 is called done on CI evidence, with the manual proof recorded on its own Progress
line only when run)**

Files and interfaces:

- `packages/testkit/src/fake-hyperliquid.ts` (new): an HTTP service implementing `/exchange` for
  `order`, `cancelByCloid` and `withdraw3`, and `/info` for `meta` and `orderStatus`. It
  recovers the signer with an encoder independent of the signer's (`@msgpack/msgpack` 3.1.3 and
  viem), keeps the 100 highest nonces per signer and refuses a used or too-small nonce, refuses
  an action after `expiresAfter`, keeps orders by cloid, fills IOC orders at their limit price
  against a configurable book, and rests GTC and ALO orders. It records every accepted action
  for the tests to read.
- A `fake-hyperliquid` service in `e2e/compose.e2e.yaml` on the `chain` network, built the way
  the overlay's `webhook-receiver` is run (`node:26-slim` pinned by digest, read-only, no
  capabilities) or from a new `e2e/fake-hyperliquid.Dockerfile`; the e2e `VENUES_FILE` points
  the server at it as `hyperliquid:testnet`.
- `e2e/test/release-gates.spec.ts`: new gates, below. Approvals go through the signer's
  confirmation page with the same helpers the existing gates use.
- `docs/approval-protocol.md` (completed from Milestone 1): §8 the venue signing rule and the
  cancel rule; §9 what the signer chooses after approval (nonce, `expiresAfter`) and that the
  caller chooses nothing; §10 the two new routes and their scope.
- `docs/threat-model.md`: the section "Threat model after this change" below, under "Code
  execution in the control plane" and "A malicious or prompt-injected agent"; a new trust
  dependency (funds deposited at a venue are held by that venue); "Mandates" (orders are never
  signed under a mandate, D7); "Notifications" (orders announced without details, D8); "Out of
  scope for v0.1" updated.
- `docs/architecture.md:28`: a wallet is a key in the signer whose EVM address is also its
  Hyperliquid account; note that the same OWS mnemonic derives addresses on other families that
  the signer cannot spend from.
- `README.md` scope paragraph (`README.md:195`).
- `deploy/README.md`: `VENUES_FILE`; in the restore steps, that orders signed after the backup
  cannot be cancelled by the restored signer (D9).
- `specs/agent-workspaces-v0.1.md:462`: the "No signing bypass" gate now names eight tools; add
  a revision note there.

Acceptance (CI job `stack`, all three matrix entries, through `e2e/run.sh`):

- "an order proposal becomes exactly one order at the venue after a passkey approval": the fake
  venue records one accepted order whose recovered signer is the wallet's address and whose
  fields equal the approved intent; the confirmation page showed the market, side, size and
  limit price.
- "a signed order sent twice is refused the second time": the test re-posts the body the fake
  venue recorded; the fake venue refuses the used nonce; the intent still shows one order.
- "an order over its cap is refused before anyone is asked".
- "an order past its submit window is refused by the venue and ends expired": the test pauses
  the `fake-hyperliquid` container, approves, waits past the policy's `submitWindowSeconds`
  (set to 5 for this gate), unpauses it, and expects the intent to end `expired` with no
  accepted order (the method of the crash gate, `e2e/test/release-gates.spec.ts:647-667`).
- "a crash after the approval and before the post still ends in exactly one order": the same
  sequence with the server killed (`killServer`, `:160`) and restarted instead, and a 60-second
  window.
- "the agent cancels a resting order; the cancel is the only other action signed".
- "a withdrawal goes to the wallet's own address only".
- "an order is never signed under a mandate": with a live mandate for the agent, `propose_order`
  opens an approval and the signer's decision log has no `sign-venue` entry until it is approved.
- "an agent can propose and read, and nothing else" (`:220`) is updated to the eight tools and
  adds: the signer answers 404 to `/v1/sign-typed-data`, `/v1/sign-hash` and
  `/v1/venue/sign-action` from inside the signing network.
- "what an agent typed is in no column of the database in the clear" (`:629`) is extended with a
  marker in an order's memo and checks `venue_orders.request` is sealed.
- "an approval is announced once, signed, with no sealed content" (`:1611`) is extended with an
  order: the webhook body has no order field.

Manual or runtime validation (not CI; the owner funds it per D6): see `Validation and
Acceptance`.

### Milestone 7: Hyperliquid mainnet (D2 decided 2026-11-16)

Scope: `hyperliquid:mainnet` becomes a supported venue network, equal to testnet. No new signing
code: the encoder and vault already sign both networks (see Surprises, 2026-11-16). The work
removes the refusals and puts the decision in two places that already exist: the operator's
`VENUES_FILE` and the person's passkey-approved policy. There is no flag.

Files and interfaces:

- `packages/protocol/src/venues.ts`: unchanged; `VenueNetwork` stays
  `z.enum(["hyperliquid:testnet", "hyperliquid:mainnet"])`.
- `apps/signer/src/venue-signing.ts`: delete `SIGNABLE_VENUE_NETWORKS` and its check. The signer
  signs a venue intent for the network the wallet's passkey-approved policy names
  (`venues.hyperliquid.network` equal to `intent.chainId`; otherwise `venue_not_allowed`, as
  `evaluateIntent` already answers). Every other refusal stays: policy and network mismatch,
  caps, restore fence, pause, envelope mismatch.
- `apps/server/src/config.ts`: `VENUES_FILE` is a JSON array of at most two
  `{ network, apiUrl }`, at most one per network, either network. The boot stops only on a wrong
  pairing of Hyperliquid's own hosts, with `ConfigError` text
  `VENUES_FILE: api.hyperliquid.xyz is Hyperliquid's mainnet API; its entry must name
  hyperliquid:mainnet` and its testnet twin for `api.hyperliquid-testnet.xyz`. Any other host
  (a fake, a proxy) is accepted with either network. A file that does not parse stops the boot
  with `VENUES_FILE: expected a JSON array of { network, apiUrl }`.
- `apps/server/src/directory/routes.ts`: the mainnet refusal of a policy draft is removed. A
  draft whose `venues.hyperliquid.network` is not one of the server's configured venue networks
  is refused: `HttpError` `invalid_request`, message
  `draft.venues: this venue network is not configured here`, code `venue_not_configured`.
- `packages/api/src/dto.ts`: `WorkspaceDetail` gains `venueNetworks: z.array(VenueNetwork)`, a
  sibling of `chains`: the networks in `VENUES_FILE`, `hyperliquid:testnet` before
  `hyperliquid:mainnet`, empty when there is no venues file.
- `apps/web`: the wallet rules editor offers Hyperliquid only for networks in `venueNetworks`
  and lets the person choose the network when both are configured.
- `e2e`: a second fake venue in mainnet mode (`FakeNetwork` `"mainnet"`) beside the testnet one
  in the venue stack, both listed in the e2e venues file; the mainnet-boot gate is replaced by
  the pairing boot gate.
- Documents: `README.md`, `deploy/README.md` (`VENUES_FILE`: either network, the pairing rule),
  `docs/threat-model.md` and `docs/architecture.md`.

Acceptance:

- Signer unit test: a mainnet intent under a mainnet policy is signed with `source` "a" and
  recovers to the wallet; a testnet intent under a mainnet policy, and the reverse, is refused
  `venue_not_allowed` and records nothing.
- Server config tests: each pairing case above, the two-entry limit, a duplicate network, and
  the parse error text.
- Directory test: a draft naming an unconfigured network answers `venue_not_configured`; the
  workspace detail lists `venueNetworks` in order.
- Web journey: the rules editor shows the network choice only when both networks are configured.
- CI job `stack`: a mainnet order approved under a mainnet policy becomes one accepted request at
  the mainnet fake venue, recovered to the wallet by the fake and by the test; a cross-network
  intent is refused before anyone is asked; a throwaway server whose venues file lists
  `api.hyperliquid.xyz` as `hyperliquid:testnet` exits 1 with the pairing message, and one that
  lists it as `hyperliquid:mainnet` gets past its venues to the database (the control).
- Not CI and not done: a real mainnet order with real funds. It needs the owner at the phone and
  a funded mainnet account; nothing claims it until it runs.

## Threat Model After This Change

Code execution in the control plane, after this change:

- **Can:** not submit a signed order, or submit it at any moment until its `expiresAfter`, at
  most `submitWindowSeconds` (5 to 300, policy-approved) after the signer signed it; submit it
  once (a second submission fails on the venue's nonce rule); ask the signer to cancel any
  order the signer signed, at any time, also while the workspace is paused; hold a signed
  withdrawal for up to the venue's nonce window (about two days) and then submit or drop it;
  read and misreport venue state (fills, positions, account value, liquidations) to people and
  agents; show a misleading order summary on its own pages; read sealed order content, as for
  every other intent.
- **Cannot:** get a signature over any Hyperliquid action the signer did not build from an
  approved intent: no route accepts typed data, actions, messages or hashes, and the signer has
  no builder for `usdSend`, `spotSend`, `sendAsset`, `vaultTransfer`, `approveAgent`,
  `approveBuilderFee`, `updateLeverage`, `scheduleCancel`, `modify` or trigger orders; get an
  approval for an order other than the one the signer showed on the confirmation page (the
  view is built by the signer from the intent whose hash the envelope fixes; trusted display);
  change the asset, side, size, limit price, time in force, reduce-only flag, grouping,
  builder, cloid, nonce or expiry of an approved order; get a second order for one approval or
  reuse an envelope nonce; get an order signed under a mandate (D7); exceed a market's
  per-order cap or the daily notional cap; trade a market the policy does not list; extend an
  order's submit window beyond the policy's; move funds out of the venue account to any address
  but the wallet's own; sign for mainnet with a testnet approval (the network is in the intent,
  the envelope and the phantom agent's `source`); get a mainnet signature for a wallet whose
  passkey-approved policy does not name `hyperliquid:mainnet` (Milestone 7); put an order's
  details into a notification
  (the notification inputs have no field for them).
- **Unchanged:** the signer host can do everything; a person who approves a true but harmful
  order because the control plane or an agent talked them into it is not stopped.

A malicious or prompt-injected agent can propose any order the policy's markets allow and
cancel orders it was approved to place. Each order still needs a passkey approval on the
signer's confirmation page, also when the agent holds a live mandate.

New trust dependency: USDC deposited into Hyperliquid is held by Hyperliquid's chain and bridge,
not by the wallet key alone. Liquidation, auto-deleveraging and venue outages can lose it
without any signature. The loss bound is the venue account's value, which only grows through
EVM transfers to the bridge under the wallet's caps (by a person's approval or, if the bridge is
on a mandate's recipient list, under that mandate). A sweep of a wallet (`sweep-wallet`) does not
reach its venue balance; that needs a withdrawal approved by a person first.

What the notional caps do not bound: leverage (the venue's default or a value set outside this
system), funding payments, and losses on positions opened earlier. The daily cap bounds how much
new exposure the signer signs per day, not the account's exposure.

## Interfaces and Dependencies

Local interfaces (new or changed): `packages/protocol/src/venues.ts`; `EvmIntent`,
`VenueIntent`, `Intent`, `intentSpend` in `intent.ts`; `HyperliquidRules` and
`WalletPolicy.venues` in `policy.ts`; `ApproveIntentEnvelope.chainId` in `envelopes.ts`;
`evaluateIntent` and `POLICY_DENY_CODES` in `evaluate.ts`; `evaluateMandate` in `mandate.ts`;
`renderConfirmation` (`renderIntent`, `renderOperation`, `renderPolicy`) and
`ConfirmationWarning` in `confirmation.ts`; `signVenue`, `cancelVenueOrder`,
`HyperliquidRequest` and two `signerRoutes` entries in `signer/api.ts` and `client.ts`;
`Vault.signHyperliquid` in `apps/signer/src/vault.ts`; `apps/signer/src/venues/msgpack.ts` and
`hyperliquid.ts`; a signer schema migration in `apps/signer/src/db.ts`;
`apps/server/src/execution/orders.ts` and `venues/hyperliquid.ts`; `IntentDisplay`,
`IntentStatus`, `IntentSummary`, `WalletSummary` in `packages/api/src/dto.ts`; `PushFacts` in
`apps/server/src/notify/content.ts` (D8); `MCP_TOOL_NAMES` and `intentView` in
`apps/server/src/mcp/gateway.ts`.

Typed data the vault hands OWS for an L1 action (chain argument `eip155:1337`):

    {"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},
     {"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
     "Agent":[{"name":"source","type":"string"},{"name":"connectionId","type":"bytes32"}]},
     "primaryType":"Agent",
     "domain":{"name":"Exchange","version":"1","chainId":1337,
               "verifyingContract":"0x0000000000000000000000000000000000000000"},
     "message":{"source":"b","connectionId":"0x<32 bytes>"}}

The order action, in this key order (msgpack-encoded for hashing; JSON in the request):

    {"type":"order",
     "orders":[{"a":3,"b":true,"p":"65000","s":"0.01","r":false,
                "t":{"limit":{"tif":"Ioc"}},"c":"0x<16 bytes>"}],
     "grouping":"na"}

The request body the control plane posts to `POST {apiUrl}/exchange` (shape of the SDK's
`_post_action`, `hyperliquid/exchange.py:101-110`):

    {"action":{...},"nonce":1763100000000,"signature":{"r":"0x…","s":"0x…","v":27},
     "vaultAddress":null,"expiresAfter":1763100060000}

External dependencies:

- `@open-wallet-standard/core` 1.4.5 (pinned in `apps/signer/package.json`):
  `signTypedData(wallet, chain, typedDataJson, passphrase?, index?, vaultPathOpt?, address?)`
  (`index.d.ts:68`). EVM only; compares `domain.chainId` with the chain argument; decimal
  `uint` strings must fit `u128` (use JSON numbers or hex); returns `signature` (65 bytes hex)
  and `recoveryId`.
- `viem` 2.57.19 (already pinned in the signer): `hashTypedData`, `recoverTypedDataAddress`,
  `keccak256`.
- `@msgpack/msgpack` 3.1.3, ISC: tests and the fake venue only.
- Hyperliquid API, testnet `https://api.hyperliquid-testnet.xyz`: `POST /exchange`, `POST /info`
  (`meta`, `orderStatus`, `clearinghouseState`). Behaviour sources: the
  [exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint.md),
  [nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets.md),
  [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint.md),
  [signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing.md).
- Reference implementation for vectors only: `hyperliquid-dex/hyperliquid-python-sdk` at
  `2fdb18f9517675ea03695a0962bd19eece9c83f0` (0.24.0, MIT). Not a dependency of any package.

Dependencies on other plans:

- Trusted display (ticket 20, built): every approval is made on the signer's confirmation page;
  this plan adds the order's lines to the signer-built view and nothing to the `approve`
  service except two warning texts.
- Mandates (ticket 19, built for transfers only): this plan adds the explicit venue refusal in
  `evaluateMandate` and keeps orders out of mandates (D7).
- Notifications (ticket 24, built): orders reuse the `approve-intent` announcement; D8 (c) gives
  them the push label "Order waiting".
- Repricing (ticket 22, built on main at `61d0326`): EVM only, no shared code; this plan's
  signer migration is version 7 and its server migration `0008`, the next free numbers after it.
- v0.1 defect fixes (built): the restore fence applies to venue envelopes; a sweep does not
  reach venue balances.

## Concrete Steps

From the repository root, on `main` (milestones land on `main` one at a time, as mandates and
notifications did; CI on the pushed commit is the proof):

    git pull --ff-only
    rg -n "intentSpend|evaluateMandate|renderOperation|ApproveIntentEnvelope|signEvmTransaction|MCP_TOOL_NAMES" packages apps
    # after each milestone's edits, locally (allowed by the repo rule):
    bunx biome check <changed files>
    bun run --filter @askgina/os-protocol typecheck
    bun run --filter @askgina/os-signer typecheck
    bun run --filter @askgina/os-server typecheck
    git push
    gh run watch --exit-status

Expected evidence per milestone, from the CI run's `test` job log:

    ✓ protocol  test/digests.test.ts   (existing vectors unchanged, 3 new)
    ✓ protocol  confirmation tests     (order view lines)
    ✓ signer    test/hyperliquid-encoding.test.ts
    ✓ signer    test/ows.test.ts  > signs the SDK's order vectors through OWS
    ✓ signer    test/venue-signing.test.ts

and from the `stack` job for Milestone 6:

    ✓ an order proposal becomes exactly one order at the venue after a passkey approval
    ✓ a signed order sent twice is refused the second time
    ✓ an order is never signed under a mandate

## Validation and Acceptance

Automated validation (CI, every milestone):

- `check`: Biome and `tsc` across the workspace.
- `test`: `bun run test`, including the files named in Milestones 1 to 5.
- `ui`: the order summary journey and the `approve` page's order view.
- `stack` (amd64, arm64, tls): the release gates named in Milestones 6 and 7 (Milestone 7 adds
  a second fake venue in mainnet mode and the pairing boot gate), together with every existing
  gate (v0.1, trusted display, mandates, notifications).

Manual or runtime validation (owner-funded, D6; not CI):

- Start the stack with `VENUES_FILE` naming `hyperliquid:testnet` and
  `https://api.hyperliquid-testnet.xyz`.
- Fund the agent wallet's Hyperliquid testnet account with at least 11 testnet USDC by
  `usdSend` from an existing funded testnet account.
- Approve, on the signer's confirmation page, a policy with one market (for example BTC at its
  current index), a per-order cap of 50 USD, a daily cap of 100 USD, `timeInForce: ["Gtc",
  "Ioc"]`, `submitWindowSeconds: 60`.
- Have the scripted agent propose an IOC buy of the minimum size at a price above the market;
  check the confirmation page's lines against the proposal; approve with a passkey; observe
  `filled` and the fill on the testnet explorer.
- Propose a GTC buy far below the market; approve; observe `placed`; `cancel_intent`; observe
  `cancelled`.
- Record the order ids, cloids and times in `Artifacts and Notes`.
- Mainnet with real funds (Milestone 7): not done. It needs the owner at the phone and a funded
  mainnet account, and repeats the steps above with `hyperliquid:mainnet` and
  `https://api.hyperliquid.xyz`.

Regression checks:

- Every release gate in `e2e/test/release-gates.spec.ts` and `e2e/test/browser.spec.ts`.
- Every existing protocol test vector and every existing policy hash.
- `/v1/sign` and signing under a mandate with an EVM intent behave exactly as before.

## Idempotence and Recovery

- The signer's new tables arrive in one `user_version` migration, applied once on open like
  every other version; their `CREATE TABLE IF NOT EXISTS` makes a re-run harmless.
- The server's venue migration is applied by `migrateDatabase` under its advisory lock;
  re-running is a no-op.
- A repeated `POST /v1/venue/sign` for a signed approval returns the stored response; the control
  plane can always retry and posts identical bytes.
- After a crash between posting and recording, the follow-up asks `orderStatus(cloid)` before
  posting again; the venue's nonce set refuses a duplicate in any case.
- After a signer restore and fence, every venue envelope issued before the fence is refused
  (`envelope_fenced`); a nonce picked by the restored signer is still above every nonce it
  signed before because nonces follow the clock (`nextNonce`); orders signed after the backup
  cannot be cancelled through the signer (D9).
- Backout: approve a policy without `venues` for each wallet (the signer then refuses every
  venue intent) and remove `VENUES_FILE` (the tool answers "not configured"). Reverting the code
  leaves unused tables behind, but a signer database at the new schema version cannot be opened
  by the previous signer (it refuses a newer version), so backout of the signer is by policy, not
  by downgrade.

## Rollout and Operations

- Feature flags/config/env vars: `VENUES_FILE` on the server (absent by default: no venue; at
  most one entry per network, either network since Milestone 7; Hyperliquid's own hosts must be
  listed under their own network). No flag turns mainnet on: the operator's venues file and a
  person's passkey-approved policy naming the network do. No new signer configuration: the
  policy carries the rules, and venue network names are in the signer's code.
- Deployment: signer first (it accepts the new shapes and still serves every existing request),
  then the server. A server ahead of the signer gets 404 on the new routes and fails the
  approval with that code.
- Monitoring: server log lines `venue.post`, `venue.status`, `venue.cancel` (ids, network,
  status, never sealed content); signer decision-log actions `sign-venue` and
  `cancel-venue-order`; the wallet page's venue section.
- Clock: the signer and server hosts run NTP; a signer clock behind the venue's by more than the
  submit window makes every order expire on arrival.

## Risks and Open Questions

- Risk: the encoder differs from what Hyperliquid hashes, so every order is refused ("User or API
  Wallet ... does not exist"). Mitigation: Milestone 2's vectors from the venue's own SDK and an
  independent encoder in tests. A mismatch fails closed: nothing is executed.
- Risk: Hyperliquid changes an action format or the hashing. Mitigation: the vectors are pinned
  to an SDK commit. The manual testnet proof was meant to run before mainnet; it has not run,
  and D2 was decided on 2026-11-16 without it. A wrong encoding still fails closed (the venue
  recovers another address and refuses), but nothing has shown the real venue accepting one of
  this signer's orders on either network.
- Risk (Milestone 7): mainnet orders move real value, and no real mainnet order with real funds
  has been placed; mainnet is exercised only against the fake venue in mainnet mode.
  Mitigation: every order still needs a passkey approval of an order the signer showed, under
  a policy that names mainnet, its markets and its caps; the venue account's deposit bounds the
  loss. A first real order needs the owner at the phone and a funded mainnet account.
- Risk (Milestone 7): only Hyperliquid's own two hosts are paired with their network. Any other
  host in `VENUES_FILE` (a proxy) is trusted to forward to the network it is listed under. A
  proxy listed under the wrong network would deliver an action signed for the other network;
  the network is part of what is signed (`source`, `hyperliquidChain`), so the venue should
  recover another address and refuse it. That follows from the signing scheme; no gate shows it.
- Risk: OWS's EIP-712 encoder differs from viem's for these types. Mitigation: Milestone 3 signs
  the SDK vectors through real OWS; the signer checks every signature against viem's digest.
- Risk: a policy's asset index stops naming its coin (relisting, reordering). Mitigation: the
  proposal-time metadata check refuses `market_metadata_mismatch`; the signer cannot check, so a
  control plane that skips the check could get an approval for an index whose coin changed; the
  confirmation view shows the index and the policy's name for it.
- Risk: notional caps are mistaken for loss caps. Mitigation: the confirmation view, the policy
  editor and the threat model state the venue account value as the loss bound.
- Risk: every order needs a passkey, which is too slow for trading. Ticket 19 built mandates
  for transfers only and handed trading mandates to this ticket; this plan does not add them
  (D7). A later plan can add market-scoped notional mandates once the one-order path is proven.
- Risk: widening `Intent` touches every consumer that assumes an EVM intent (`evaluateMandate`,
  `renderIntent`, `intentView`, `approveIntentKind().title`, the signer's `sign`). Mitigation:
  `SignRequest` and `SignUnderMandateRequest` take `EvmIntent`; the type checker flags the rest;
  Milestone 1 and 5 tests cover each branch. (D5 option (b) avoids this at the cost of a
  parallel path.)
- Risk: an order is announced as a payment. Mitigation: D8 (c), taken 2026-11-15, labels it
  "Order waiting"; the announcement carries no amount either way.
- Risk: the submit window is too short for a slow workflow, and orders expire. Mitigation: 60
  seconds by default; the follow-up posts before any other work after signing.
- Risk: a resting order signed after the last backup cannot be cancelled after a restore (D9).
  Mitigation: D9 (a), taken 2026-11-15: documented in the restore steps, and the default
  policy draft allows only `Ioc`.
- Closed question (D2, mainnet): decided 2026-11-16 by the owner: mainnet venue support ships. See
  the `Decision Log` entry D2 and Milestone 7.
- Answered (2026-11-15, by the lead agent under the repository owner's delegation; no recommendation, so the
  conservative option): reduce-only orders stay under the per-order cap. Reason: the smaller
  change, and a cap that always applies fails closed.
- Answered (2026-11-15, by the lead agent under the repository owner's delegation; no recommendation, so the
  conservative option): the testnet manual proof is not required to call Milestone 6 done; it
  is its own Progress line, ticked only when run, and was to be required before any mainnet
  decision (D2). Reason: CI proves the milestone; the manual proof needs funds not in hand, and
  no status claims it until it runs. D2 was decided on 2026-11-16 before the proof ran; the gap
  is the risk stated above.
- Unconfirmed on 2026-11-15: the Hyperliquid and OWS facts above were not re-read. The migration
  numbers are re-checked against main at `61d0326`: signer schema 6 (next 7), server
  migrations through `0007_transaction_attempts` (next `0008`).

## Artifacts and Notes

Research evidence, from the report:

    Hyperliquid SDK tests/signing_test.py:35
    phantom agent connectionId (IOC order, nonce 1677777606040, mainnet)
    0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908

    Polymarket ctf-exchange-v2 UserPausable.sol:14
    uint256 public userPauseBlockInterval = 100;

Out of scope for this plan, each its own later ticket: Polymarket (needs a bound on a signed
order's lifetime); Solana transfers; signer-built EVM swaps
(`multicall(deadline, [exactInputSingle(...)])`, recipient fixed to the wallet, router never a
call target); trading mandates (D7); Hyperliquid trigger orders, leverage changes, builder fees,
spot, HIP-3 DEXs.

## Revision Notes

- 2026-11-14: First version, written from the research report for ticket 21 before any owner
  decision. Written for the recommended options; each dependency on an owner decision is marked.
- 2026-11-15: Re-checked against main at `98cc6a1` after trusted display, the v0.1 defect fixes,
  mandates and notifications landed. The order card moved from `apps/web` to the signer-built
  confirmation view (`renderConfirmation`, Milestone 1; signer input in Milestone 4). Dropped the
  step replacing the control plane's hand-copied policy-code list: mandates Milestone 3 already
  replaced it. Added the explicit venue refusal in `evaluateMandate`, the push label (D8), the
  restore fence and post-restore cancel (D9), trading mandates (D7), route scopes, the signer's
  `user_version` migration instead of plain `CREATE TABLE` in the schema, the next free server
  migration number instead of `0002`, MCP `authorizedBy`/`mandateId` for orders, and updated
  file and line references (gates, README, architecture, v0.1 gate text). D5 re-stated against
  the three additive precedents now in §12. Status stays Draft; still six milestones, none
  delivered by other plans.
- 2026-11-15: D1 and D3 to D9 taken by the lead agent under the repository owner's delegation, each as recommended
  (D5 (a), D7 (a), D8 (c), D9 (a)); D2 stayed open with the owner then, mainnet refused at boot
  (decided 2026-11-16: mainnet is supported; Milestone 7). The two
  open questions without a recommendation are answered with the conservative option. Repricing
  is built at `61d0326`: the signer migration is version 7 and the server migration
  `0008_venue_orders`; the repricing routes are named.
- 2026-11-16: Owner decision D2 taken by the owner: mainnet venue support ships. Decision Log entry
  rewritten as decided; Milestone 7 added to `Progress` (all lines unticked) and to `Plan of
  Work`; one Surprises entry (mainnet needed no new signing code); the mainnet refusals of
  Milestones 4 to 6 marked superseded rather than removed; non-goals, the open question, the
  rollout line and the risks updated; the missing manual testnet proof is now stated as a risk
  carried into mainnet. Title no longer says "testnet".
