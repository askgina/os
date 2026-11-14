# Sign Hyperliquid testnet orders that the signer builds from an approved intent

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-14
- Links: [Issue #21](https://github.com/askgina/os/issues/21) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](research/non-evm-operations.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

After this change an agent can propose an order on Hyperliquid testnet, for example "buy 0.01
BTC perpetual at a limit of 65,000 USD, immediate or cancel, because the funding rate turned".
The proposal appears in the approval inbox as an order card. A member approves it with a
passkey. The signer checks that approval itself, checks the wallet's venue rules (allowed
markets, per-order and daily notional caps, allowed time-in-force), builds the Hyperliquid
order action from the intent's fields with its own code, picks the action's nonce and expiry
itself, signs exactly one action, and never signs another order for that approval. The control
plane submits it, follows it by a client order id derived from the approval id, and lets the
agent cancel it. Money reaches Hyperliquid by a v0.1 USDC transfer to the Hyperliquid bridge
and comes back by a passkey-approved withdrawal to the wallet's own address.

This is the first operation in the project that is not an EVM transaction. It proves the
general rule from the research report: the signer never accepts typed data, a message or bytes
from the caller; it builds the venue's signed object from an approved intent. The same shape
later carries Polymarket, Solana and signer-built swaps.

This plan is written for the research report's recommended options. Each choice that waits on
the owner is marked **(depends on owner decision Dn)** and listed in the `Decision Log`.

Non-goals, each out of scope for this plan: Hyperliquid mainnet; spot markets and HIP-3 DEXs;
trigger (stop-loss, take-profit) orders, TWAP, modify and batch orders; leverage and margin-mode
changes; builder codes; API (agent) wallets; subaccounts and vaults; `usdSend`, `spotSend`,
`sendAsset`, `vaultTransfer`, `approveAgent`, `approveBuilderFee`, `scheduleCancel`; Polymarket;
Solana; signer-built EVM swaps (a separate ticket); approvals wider than one order (ticket 19);
a trusted display (ticket 20); repricing (ticket 22).

Success means:

- The signer reproduces the Hyperliquid Python SDK's own signing vectors byte for byte, through
  the test vault and through the real OWS 1.4.5 vault, in the CI `test` job.
- In the CI `stack` job, against a fake Hyperliquid service that recovers the signer with an
  independent encoder: an agent's order proposal, after one passkey approval, becomes exactly one
  accepted order; a resubmission is refused by the venue's nonce rule; an order past its submit
  window is refused; a cancel by client order id succeeds; a withdrawal goes only to the wallet's
  own address.
- The signer still has no route that accepts typed data, messages, actions or hashes, and the
  MCP tool list is exactly eight tools (v0.1's seven plus `propose_order`).
- Out of scope and stated: the venue's own state (positions, leverage, liquidations) is reported
  by the control plane and is not verified by anyone in this system.

## Progress

- [x] (2026-11-14 21:44Z) Research current behavior and relevant code paths
      ([research report](research/non-evm-operations.md)).
- [x] (2026-11-14 21:44Z) Define the implementation approach and validation plan (this file).
- [ ] Owner decisions D1 to D6 answered (see `Decision Log`).
- [ ] Milestone 1: protocol shapes, venue policy and evaluation.
- [ ] Milestone 2: the Hyperliquid encoder in the signer, proven against the SDK vectors.
- [ ] Milestone 3: the vault's typed-data method, proven with real OWS.
- [ ] Milestone 4: the signer's venue routes and records.
- [ ] Milestone 5: control plane: venue client, MCP tool, approval card, follow-up.
- [ ] Milestone 6: fake venue, release gates, documentation; manual testnet proof.

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

## Decision Log

Decisions marked "pending owner" are the research report's recommendation; the plan is written
for them and changes if the owner chooses otherwise.

- Decision (pending owner, D1): the first operation that is not an EVM transaction is a
  Hyperliquid perpetual limit order on testnet.
  Rationale: the smallest venue whose guarantees the signer can make true by itself: one
  signature per approval, one placement (venue nonce set), unusable after `expiresAfter`, cancel
  by client order id. Polymarket V2 cannot bound a signature's lifetime; Solana is a whole chain
  family; a signer-built swap is smaller but is still an EVM transaction.
  Date/Author: 2026-11-14 / research agent
- Decision (pending owner, D2): venue support ships disabled (no `VENUES_FILE`), testnet only;
  the server refuses to start with a mainnet venue configured. Mainnet waits for the owner's
  answers to the legal and geographic questions in the research report ("Owner questions").
  Rationale: the plan does not answer legal questions; it keeps the feature off until someone
  who can answer them has.
  Date/Author: 2026-11-14 / research agent
- Decision (pending owner, D3): Hyperliquid actions are signed by the wallet's own key; no API
  wallet is approved.
  Rationale: one signer process gains no isolation from a second key, `approveAgent` would be
  one more action to approve, and deregistered API wallets can be replayed against.
  Date/Author: 2026-11-14 / research agent
- Decision (pending owner, D4): approving an order includes the right to cancel that one order.
  The signer signs `cancelByCloid` for an order it signed, on the control plane's request,
  without a passkey, also while the workspace is paused. The approval card says so.
  Rationale: a cancel of a limit order moves no funds and only removes what the person approved.
  This plan has no stop orders; when they are added, cancelling one needs its own approval.
  Date/Author: 2026-11-14 / research agent
- Decision (pending owner, D5): the protocol change is additive within version 1. Existing
  digests and test vectors stay unchanged; `docs/approval-protocol.md` §12 is amended to allow
  new kinds and optional members that leave every existing digest unchanged and that an older
  verifier refuses.
  Rationale: v2 would rehash every structure and make the signer carry two versions.
  Date/Author: 2026-11-14 / research agent
- Decision (pending owner, D6): the manual testnet proof is funded by a `usdSend` of testnet USDC
  from an existing funded testnet account to the wallet's address (at least 11 USDC: 1 for
  account activation, 10 for the minimum order).
  Rationale: the faucet requires a mainnet deposit from the same address; a mainnet deposit
  from a signer wallet would need a mainnet policy and real funds.
  Date/Author: 2026-11-14 / research agent
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
  Rationale: keeps v0.1's "nothing here for messages, typed data, raw hashes" property of the
  `Vault` interface true for every caller except the one builder (`apps/signer/src/vault.ts:12-26`).
  Date/Author: 2026-11-14 / research agent
- Decision: the spend of an order is its worst-case notional, `ceil(size × limitPx × 10^6)`
  micro-USD, counted when signed. A reduce-only order counts against the per-order cap and not
  against the daily cap.
  Rationale: the signer never reads the venue; counting at signing cannot be raised by a false
  fill report. Excluding reduce-only orders from the daily cap keeps closing possible when the
  cap is spent.
  Date/Author: 2026-11-14 / research agent
- Decision: asset indices are bound to coin names in the passkey-approved policy. The approval
  card, the MCP tool and the signer use the policy's binding; live venue metadata is only
  compared with it at proposal time.
  Rationale: the index is what is signed; a name from live metadata is whatever the control
  plane says.
  Date/Author: 2026-11-14 / research agent

## Outcomes & Retrospective

- Outcome: none yet. Nothing in this plan is built. The research behind it was source reading
  only; no order, typed data or OWS call was run.

## Context and Orientation

Relevant repo rules:

- Read `AGENTS.md` at the repository root before changing files.
- Builds, whole test suites, coverage, `docker build` and `e2e/run.sh` run in CI, not on a
  workstation, unless the owner names the command (`specs/agent-workspaces-v0.1.md:69`, `:108`).
  Locally: Biome on the changed files and `tsc --noEmit` of the changed package.
- Exact version pins for every dependency.
- `docs/references/` is context, not authority.

Terms:

- **Venue**: a place an order is executed that is not an EVM chain transaction. Here only
  Hyperliquid's own chain ("HyperCore"), reached through `https://api.hyperliquid-testnet.xyz`.
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

Current behavior:

- Intents are EVM only: `evm.transfer`, `evm.erc20.transfer`, `evm.call`, each on an
  `eip155:<n>` chain with a gas ceiling `maxFeeWei` (`packages/protocol/src/intent.ts:20-118`).
- The signer builds the EIP-1559 transaction from the intent, signs it through
  `Vault.signEvmTransaction`, and records the nonce, signature and spend in one SQLite
  transaction (`apps/signer/src/signer.ts:677-826`). There is no other signing path
  (`apps/signer/src/vault.ts:12-26`).
- The release gate "No signing bypass" requires no route for messages, typed data or hashes and
  exactly seven MCP tools (`specs/agent-workspaces-v0.1.md:461`).
- Each OWS wallet already derives keys for every OWS chain family; the signer keeps only the
  EVM address (`apps/signer/src/vault.ts:116`). The Hyperliquid account of a wallet is that same
  EVM address.

How the pieces fit together after this change:

- An agent calls the MCP tool `propose_order` (`apps/server/src/mcp/gateway.ts`). The control
  plane resolves the coin name to an asset index through the wallet's policy, compares it with
  live venue metadata, runs `evaluateIntent` for early refusal, stores the sealed intent and
  opens an `approve-intent` approval whose envelope names the venue network
  (`apps/server/src/execution/orders.ts`).
- A member approves on the order card (`apps/web/src/routes/approval.tsx`). The approval
  engine's follow-up calls the signer's `POST /v1/venue/sign` with the intent and the
  authorization.
- The signer verifies as in v0.1, then builds the action, picks the nonce and `expiresAfter`,
  signs through `Vault.signHyperliquid`, records everything, and returns the exact request body
  to send (`apps/signer/src/signer.ts`, `apps/signer/src/venues/hyperliquid.ts`).
- The control plane posts that body unchanged to the venue's `/exchange`, records the response,
  and follows the order with `/info` `orderStatus` by cloid
  (`apps/server/src/execution/venues/hyperliquid.ts`).
- A cancel goes through `cancel_intent` → signer `POST /v1/venue/orders/:approvalId/cancel` →
  venue. A withdrawal is `propose_transfer` with the venue network and the wallet's own address.

Assumptions:

- The signer host's clock is synchronized (NTP). Hyperliquid accepts nonces within
  `(T − 2 days, T + 1 day)` of block time and rejects actions after `expiresAfter`.
- The server can reach `api.hyperliquid-testnet.xyz` over HTTPS from the `chain` network.
- Perpetual asset indices in `meta.universe` do not change for a listed market. Not established
  from a primary source; the proposal-time metadata check (Milestone 5) refuses a mismatch.

## Plan of Work

The order is protocol first (shapes every other package imports), then the signer's encoder
proven in isolation, then the vault, then the signer's routes, then the control plane, then the
stack gates. Every milestone ends with a CI job passing.

### Milestone 1: Protocol shapes, venue policy and evaluation

Scope: the hashed shapes and the pure policy evaluation, so that the signer and the control
plane share one definition of a venue intent and one answer to "does the policy allow it".
**(depends on owner decision D5)**

Files and interfaces:

- `packages/protocol/src/venues.ts` (new):
  - `VenueNetwork = z.enum(["hyperliquid:testnet", "hyperliquid:mainnet"])`.
  - `Network = z.union([ChainId, VenueNetwork])`; `isVenueNetwork(value): value is VenueNetwork`.
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
    `daily: false`. Callers to update (run `xd://lsp` references first):
    `apps/signer/src/signer.ts:814`, `apps/server/src/execution/intents.ts:900`, and every test
    that destructures the result.
- `packages/protocol/src/policy.ts`:
  - `HyperliquidMarket = z.strictObject({ asset: int 0..9999, coin: z.string().regex(/^[A-Z0-9]{1,16}$/), maxNotionalPerOrderUsd6: PositiveAmount })`.
  - `HyperliquidRules = z.strictObject({ network: VenueNetwork, markets: array of HyperliquidMarket, 1 to 64, sorted by asset, unique asset and unique coin; maxNotionalPerDayUsd6: PositiveAmount; timeInForce: sorted set of "Alo" | "Gtc" | "Ioc", at least one; submitWindowSeconds: int 5..300; withdrawals: z.boolean() })`. Refinement: every market's per-order cap ≤ the daily cap.
  - `WalletPolicy` gains `venues: z.strictObject({ hyperliquid: HyperliquidRules.optional() }).optional()`. A policy without `venues` canonicalizes and hashes exactly as today.
  - `normalizePolicy` sorts `markets` by asset and `timeInForce`.
- `packages/protocol/src/envelopes.ts`: `ApproveIntentEnvelope.chainId: Network`.
- `packages/protocol/src/evaluate.ts`:
  - `POLICY_DENY_CODES` gains `venue_not_allowed`, `market_not_allowed`, `order_type_not_allowed`, `withdrawal_not_allowed`.
  - `SpentLookup = (chainId: Network, asset: SpendAsset) => bigint`.
  - For a `VenueIntent`, in order: `wallet_mismatch`; `requester_not_allowed`; no
    `venues.hyperliquid` or its `network` ≠ `intent.chainId` → `venue_not_allowed`; for an order:
    asset not in `markets` → `market_not_allowed`; `tif` not in `timeInForce` →
    `order_type_not_allowed`; notional > the market's `maxNotionalPerOrderUsd6` →
    `over_per_tx_cap`; if `daily`, `spent(network, "usd6") + notional > maxNotionalPerDayUsd6` →
    `over_daily_cap`; for a withdrawal: `withdrawals` false → `withdrawal_not_allowed`. Otherwise
    allow with the spend.
  - An `EvmIntent` whose `chainId` is a venue network, or a `VenueIntent` on an EVM chain, cannot
    exist (schema); keep a defensive `chain_not_allowed`.
- `packages/protocol/src/signer/api.ts`: listed in Milestone 4, but the schemas land here so the
  client compiles.
- `apps/server/src/execution/intents.ts:940-952`: replace the hand-copied `isPolicyCode` list
  with `POLICY_DENY_CODES.includes(code)`; the copy would otherwise miss the new codes.
- `docs/approval-protocol.md`: §1 the new primitives; §3 the venue intent and its two
  operations; §4 the `venues` member; §5 the widened `chainId`; §7 the venue rules; §11 three
  new test vectors (a venue order intent, a policy with `venues`, its `approve-intent`
  envelope); §12 the additive-change rule from D5.

Work:

Write the schemas and the evaluation as above. Add test fixtures for a venue intent and a policy
with `venues` in `packages/protocol/test/fixtures.ts`. Compute the three new digests and record
them in `digests.test.ts` and in §11, each reproduced independently with OpenSSL as §11 already
describes. Do not touch the existing vectors.

Acceptance (CI job `test`, which runs `bun run test` from the repository root):

- `packages/protocol/test/digests.test.ts`: every existing vector passes unchanged; the three new
  vectors pass; a v0.1 policy fixture hashes to the same `policyHash` as before.
- `packages/protocol/test/schemas.test.ts`: accepts the canonical decimals `0.0147`, `100`,
  `1670.1`, `0.00000001`; refuses `1.0`, `01`, `1e3`, `.5`, `1.`, `0`, nine fraction digits;
  refuses asset 10000, an unknown `tif`, an EVM operation on `hyperliquid:testnet`, a venue
  operation on `eip155:1`, a `maxFeeWei` member on a venue intent, and a policy whose markets are
  unsorted, repeat an asset or a coin, or have a per-order cap above the daily cap.
- `packages/protocol/test/evaluate.test.ts`: one case per new deny code and its boundary
  (notional equal to the cap passes, one micro-USD more fails); a reduce-only order passes with
  the daily cap fully spent and fails above its per-order cap; `orderNotionalUsd6("0.01", "65000")`
  is `650000000n`, `orderNotionalUsd6("0.0147", "1670.1")` is `24550470n` (ceil of 24.550470).

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
recovery check v0.1 applies to transactions.

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
  address and a low `s` (EIP-2), like `isSignedBy` (`apps/signer/src/signer.ts:105-110`).
- `apps/signer/test/ows.test.ts`: new cases.

Acceptance (CI job `test`):

- In `ows.test.ts`, a temporary vault imports the vector key with
  `ows.importWalletPrivateKey`, creates an `ows_key_` token with no policy, and
  `OwsVault.signHyperliquid` reproduces the SDK's mainnet and testnet `r`, `s`, `v` for the GTC
  order vectors (signatures are deterministic, RFC 6979). A `withdraw` payload signed through OWS
  recovers, with viem, to the wallet's address.
- `hardening.test.ts`: a vault that returns a signature from another key, or over another
  connection id, or with a high `s`, makes the signer record nothing and answer `vault_error`.

### Milestone 4: The signer's venue routes and records

Scope: the signer accepts an approved venue intent and returns the exact request body to send;
it signs cancels for orders it signed; it records all of it in its own database and decision
log.

Files and interfaces:

- `packages/protocol/src/signer/api.ts`:
  - Routes: `signVenue: { method: "POST", path: "/v1/venue/sign" }`, `cancelVenueOrder: {
    method: "POST", path: "/v1/venue/orders/:approvalId/cancel" }`.
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
- `packages/protocol/src/signer/client.ts`: `signVenue(request)`, `cancelVenueOrder(approvalId,
  request)`.
- `apps/signer/src/db.ts`, added to `SCHEMA` (all `CREATE TABLE IF NOT EXISTS`, `STRICT`):

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
  written only when `intentSpend(...).daily` is true.
- `apps/signer/src/signer.ts`: `signVenue(request)` and `cancelVenueOrder(approvalId,
  workspaceId)`. Decision-log actions `sign-venue` and `cancel-venue-order`.
- `apps/signer/src/index.ts`: dispatch the two routes; nothing else changes in routing.
- `apps/signer/test/venue-signing.test.ts` (new), `apps/signer/test/hardening.test.ts`.

Work, the venue signing rule in order (any failure is recorded and returned with its code, as
in v0.1):

1. The request signature and the body's schema.
2. Idempotency: if this approval id was already signed with an identical envelope, return the
   stored response; a different envelope is `conflict`.
3. The envelope is `approve-intent`; its workspace, wallet, agent and `chainId` equal the
   intent's and the wallet's; `intentHash(intent)` equals `envelope.intentHash`
   (`envelope_mismatch`, `intent_mismatch`).
4. Workspace not paused; approval not revoked.
5. The wallet has a policy and its hash equals `envelope.policyHash`.
6. `verifyAuthorization` with the policy's threshold and a lifetime no longer than its
   `approvals.ttlSeconds`.
7. In one SQLite transaction with nothing awaited: the envelope nonce is unused; approvers are
   still present; `evaluateIntent` against the 24-hour ledger passes; `nowMs` is the signer's
   clock; `nonce = nextNonce(venue_nonces.last_nonce, nowMs)` and the row is upserted; for an
   order, `cloid = cloidFor(approvalId)`, `expiresAfter = nowMs + submitWindowSeconds × 1000`,
   the action and its hash are built and `signHyperliquid({ kind: "l1", ... })` is called; for a
   withdrawal, `time = nonce`, `destination = wallet.address`, `expiresAfter = null` (user-signed
   actions do not support it) and `signHyperliquid({ kind: "withdraw", ... })` is called; the
   signature is checked with `isTypedSignedBy`; the approval, the `venue_signatures` row and the
   spend are written; the response is stored.

The cancel rule: request signature; the approval id has a `venue_signatures` row of kind
`order` in the named workspace (`not_found` otherwise; `conflict` for a withdrawal); allowed
while the workspace is paused (D4). If the newest `venue_cancels` row's `expires_after` is still
in the future, return that row's request. Otherwise build `cancelByCloidAction(asset, cloid)`
with a fresh nonce and `expiresAfter`, sign, insert the next `seq`, and return it. Every cancel
is a decision-log entry.

Acceptance (CI job `test`):

- `venue-signing.test.ts`: changing any of `asset`, `isBuy`, `size`, `limitPx`, `tif`,
  `reduceOnly`, `amount`, `chainId`, `walletId`, `agentId` or `memo` after approval refuses;
  replay returns the identical stored response; a second envelope with a used nonce refuses;
  two concurrent sign requests for one approval yield one signature; two approvals whose
  notional together exceed the daily cap yield one signature; a reduce-only order signs with the
  daily cap spent; an expired envelope, a revoked approval, a removed approver and a paused
  workspace refuse; a changed policy refuses; the returned `expiresAfter` is the signer's clock
  plus the policy window and never more; nonces from successive signatures of one wallet and
  network strictly increase, also with the clock set back; a withdrawal's destination is the
  wallet's address whatever the intent says (there is no field to say otherwise).
- Cancel: an approval id never signed is `not_found`; a withdrawal approval is `conflict`; a
  cancel while paused succeeds; a second cancel within the window returns the same request; a
  cancel after the window is a new request with a larger nonce.
- `hardening.test.ts` route list: every path outside the contract answers 404; in particular
  there is no route accepting typed data, an action, a message or a hash
  (`/v1/sign-typed-data`, `/v1/venue/sign-action`, `/v1/sign-hash` all 404); `/v1/sign` with a
  venue intent is `invalid_request`.

### Milestone 5: Control plane: venue client, MCP tool, approval card, follow-up

Scope: agents can propose and cancel orders, people see order cards and venue rules, and the
control plane submits and reconciles. **(depends on owner decisions D1 and D2)**

Files and interfaces:

- `apps/server/src/config.ts`: optional `VENUES_FILE`, a JSON array of `{ network: VenueNetwork,
  apiUrl: string }`. Absent means venue features answer "not configured". A
  `hyperliquid:mainnet` entry fails boot with a message naming D2.
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
    `VenueIntent`; runs `evaluateIntent` with the signer's `spent`; seals and stores the intent
    and an `OrderDisplay`; opens the `approve-intent` approval.
  - `proposeVenueWithdrawal(...)`: reached from `propose_transfer` when `chainId` is a venue
    network; `to` must equal the wallet's address and `asset` must be `usdc`.
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
- `apps/server/src/execution/intents.ts`: `approveIntentKind().execute` and the registered
  follow-up dispatch on `isVenueIntent`; `describe` returns venue caps and spent-today for the
  order card.
- `apps/server/src/db/schema.ts` and migration `apps/server/src/db/migrations/0002_venue_orders.sql`
  (generated with drizzle-kit, as 0000 and 0001 were): table `venue_orders` (`approval_id` PK →
  `approvals`, `intent_id`, `wallet_id`, `network`, `cloid` nullable, `action_nonce` bigint,
  `expires_after` bigint nullable, `request` bytea sealed under the workspace key at location
  `venue_orders.request/<approvalId>`, `status` text `signed | submitted | placed | filled |
  partially_filled | cancelled | failed | expired`, `venue_order_id` bigint nullable,
  `filled_size` text nullable, `average_price` text nullable, `created_at`, `updated_at`).
  `IntentStatusColumn` gains `submitted`, `placed`, `filled`, `partially_filled`.
- `packages/api/src/dto.ts`: `IntentStatus` gains the same four; `IntentDisplay` becomes a
  discriminated union with `kind: "transfer"` (today's fields) and `kind: "order"` (`title`,
  `network`, `coin`, `asset`, `side`, `size`, `limitPrice`, `notionalUsd`, `timeInForce`,
  `reduceOnly`, `cancellableByAgent: true`); `IntentSummary.chainId: Network`; `IntentSummary`
  gains `order: { cloid, venueOrderId, filledSize, averagePrice } | null`; the policy input DTO
  gains `venues`.
- `apps/server/src/mcp/gateway.ts`: tool `propose_order` (inputs as `proposeOrder` above,
  `timeInForce` default `Ioc`, `reduceOnly` default false); `get_intent` returns `order`;
  `cancel_intent` cancels a `placed` order; `propose_transfer` accepts a venue network as
  above; `whoami` lists the wallet's venue markets and caps. Exactly eight tools.
- `apps/web/src/routes/approval.tsx`: the order card. One sentence ("Buy 0.01 BTC perpetual on
  Hyperliquid testnet at up to 65,000 USD"), notional against the per-order and daily caps, time
  in force, reduce-only, "The agent may cancel this order", the submit window, the coin name from
  the policy. `apps/web/src/components/policy.tsx`: the venue rules editor.
  `apps/web/src/routes/wallet.tsx`: venue account value and positions, labelled "reported by
  Hyperliquid through this server, not verified by the signer". `apps/web/src/lib/statuses.ts`:
  the new statuses.

Acceptance (CI jobs `test` and `ui`):

- `apps/server/test/execution/orders.test.ts` (new), with a fake signer, the soft authenticator and an
  in-process fake venue: a proposal for a coin not in the policy, a delisted or renamed market,
  an invalid tick and an over-cap order are refused before any approval opens; an approved
  order is posted once; killing the follow-up after the signer signed and before the row was
  stored, then restarting, posts the identical request once (the signer's idempotency returns
  it, the venue's nonce set refuses a second); a `cancel_intent` on a placed order posts one
  cancel; an order whose submit window passed ends `expired`; an agent of another workspace
  cannot see or cancel it.
- `apps/server/test/execution/mcp.test.ts`: the tool list is exactly the eight names.
- `apps/web` Playwright journey (CI job `ui`) renders the order card on phone-light and
  phone-dark from the fixture server and shows the notional against both caps.

### Milestone 6: Fake venue, release gates, documentation; manual testnet proof

Scope: prove the whole path in the real stack, and update the documents that describe what the
system protects. **(the manual proof depends on owner decision D6)**

Files and interfaces:

- `packages/testkit/src/fake-hyperliquid.ts` (new): an HTTP service implementing `/exchange` for
  `order`, `cancelByCloid` and `withdraw3`, and `/info` for `meta` and `orderStatus`. It
  recovers the signer with an encoder independent of the signer's (`@msgpack/msgpack` 3.1.3 and
  viem), keeps the 100 highest nonces per signer and refuses a used or too-small nonce, refuses
  an action after `expiresAfter`, keeps orders by cloid, fills IOC orders at their limit price
  against a configurable book, and rests GTC and ALO orders. It records every accepted action
  for the tests to read.
- `e2e/fake-hyperliquid.Dockerfile` (new, `node:26-slim` pinned by digest like the other
  images) and a `fake-hyperliquid` service in `e2e/compose.e2e.yaml` on the `chain` network;
  the e2e `VENUES_FILE` points the server at it as `hyperliquid:testnet`.
- `e2e/test/release-gates.spec.ts`: new gates, below.
- `docs/approval-protocol.md` (completed from Milestone 1): §8 the venue signing rule and the
  cancel rule; §9 what the signer chooses after approval (nonce, `expiresAfter`) and that the
  caller chooses nothing.
- `docs/threat-model.md`: the section "Threat model after this change" below; a new trust
  dependency (funds deposited at a venue are held by that venue); "Out of scope" updated.
- `docs/architecture.md:27`: a wallet is a key in the signer whose EVM address is also its
  Hyperliquid account; note that the same OWS mnemonic derives addresses on other families that
  the signer cannot spend from.
- `README.md` scope paragraph (`README.md:126`).
- `specs/agent-workspaces-v0.1.md:461`: the "No signing bypass" gate now names eight tools; add
  a revision note there.

Acceptance (CI job `stack`, all three matrix entries, through `e2e/run.sh`):

- "an order proposal becomes exactly one order at the venue after a passkey approval": the fake
  venue records one accepted order whose recovered signer is the wallet's address and whose
  fields equal the approved intent.
- "a signed order sent twice is refused the second time": the test re-posts the body the fake
  venue recorded; the fake venue refuses the used nonce; the intent still shows one order.
- "an order over its cap is refused before anyone is asked".
- "an order past its submit window is refused by the venue and ends expired": the test pauses
  the `fake-hyperliquid` container, approves, waits past the policy's `submitWindowSeconds`
  (set to 5 for this gate), unpauses it, and expects the intent to end `expired` with no
  accepted order (the method of the v0.1 crash gate, `e2e/test/release-gates.spec.ts:358-378`).
- "a crash after the approval and before the post still ends in exactly one order": the same
  sequence with the server killed and restarted instead, and a 60-second window.
- "the agent cancels a resting order; the cancel is the only other action signed".
- "a withdrawal goes to the wallet's own address only".
- "an agent can propose and read, and nothing else" is updated to the eight tools and adds:
  the signer answers 404 to `/v1/sign-typed-data`, `/v1/sign-hash` and `/v1/venue/sign-action`
  from inside the signing network.
- "what an agent typed is in no column of the database in the clear" is extended with a marker
  in an order's memo and checks `venue_orders.request` is sealed.

Manual or runtime validation (not CI; the owner funds it per D6): see `Validation and
Acceptance`.

## Threat Model After This Change

Code execution in the control plane, after this change:

- **Can:** not submit a signed order, or submit it at any moment until its `expiresAfter`, at
  most `submitWindowSeconds` (5 to 300, policy-approved) after the signer signed it; submit it
  once (a second submission fails on the venue's nonce rule); ask the signer to cancel any
  order the signer signed, at any time, also while the workspace is paused; hold a signed
  withdrawal for up to the venue's nonce window (about two days) and then submit or drop it;
  read and misreport venue state (fills, positions, account value, liquidations) to people and
  agents; show a misleading approval card (the trusted-display gap, ticket 20); read sealed
  order content, as for every other intent.
- **Cannot:** get a signature over any Hyperliquid action the signer did not build from an
  approved intent: no route accepts typed data, actions, messages or hashes, and the signer has
  no builder for `usdSend`, `spotSend`, `sendAsset`, `vaultTransfer`, `approveAgent`,
  `approveBuilderFee`, `updateLeverage`, `scheduleCancel`, `modify` or trigger orders; change the
  asset, side, size, limit price, time in force, reduce-only flag, grouping, builder, cloid,
  nonce or expiry of an approved order; get a second order for one approval or reuse an envelope
  nonce; exceed a market's per-order cap or the daily notional cap; trade a market the policy
  does not list; extend an order's submit window beyond the policy's; move funds out of the
  venue account to any address but the wallet's own; sign for mainnet with a testnet approval
  (the network is in the intent, the envelope and the phantom agent's `source`).
- **Unchanged:** the signer host can do everything; a passkey proves a digest was approved, not
  what was shown.

A malicious or prompt-injected agent can propose any order the policy's markets allow and
cancel orders it was approved to place. Each order still needs a passkey approval.

New trust dependency: USDC deposited into Hyperliquid is held by Hyperliquid's chain and bridge,
not by the wallet key alone. Liquidation, auto-deleveraging and venue outages can lose it
without any signature. The loss bound is the venue account's value, which only grows through
v0.1 EVM transfers to the bridge under v0.1 caps.

What the notional caps do not bound: leverage (the venue's default or a value set outside this
system), funding payments, and losses on positions opened earlier. The daily cap bounds how much
new exposure the signer signs per day, not the account's exposure.

## Interfaces and Dependencies

Local interfaces (new or changed): `packages/protocol/src/venues.ts`; `EvmIntent`,
`VenueIntent`, `Intent`, `intentSpend` in `intent.ts`; `HyperliquidRules` and
`WalletPolicy.venues` in `policy.ts`; `ApproveIntentEnvelope.chainId` in `envelopes.ts`;
`evaluateIntent` and `POLICY_DENY_CODES` in `evaluate.ts`; `signVenue`, `cancelVenueOrder`,
`HyperliquidRequest` in `signer/api.ts` and `client.ts`; `Vault.signHyperliquid` in
`apps/signer/src/vault.ts`; `apps/signer/src/venues/msgpack.ts` and `hyperliquid.ts`;
`apps/server/src/execution/orders.ts` and `venues/hyperliquid.ts`; `IntentDisplay`,
`IntentStatus`, `IntentSummary` in `packages/api/src/dto.ts`.

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

- `@open-wallet-standard/core` 1.4.5 (pinned): `signTypedData(wallet, chain, typedDataJson,
  passphrase?, index?, vaultPathOpt?, address?)` (`index.d.ts:68`). EVM only; compares
  `domain.chainId` with the chain argument; decimal `uint` strings must fit `u128` (use JSON
  numbers or hex); returns `signature` (65 bytes hex) and `recoveryId`.
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

## Concrete Steps

From the repository root, on a branch created from `main`:

    git switch -c feat/hyperliquid-orders
    rg -n "intentSpend|isPolicyCode|ApproveIntentEnvelope|signEvmTransaction" packages apps
    # after each milestone's edits, locally (allowed by the repo rule):
    bunx biome check <changed files>
    bun run --filter @askgina/os-protocol typecheck
    bun run --filter @askgina/os-signer typecheck
    git push -u origin feat/hyperliquid-orders
    gh run watch --exit-status

Expected evidence per milestone, from the CI run's `test` job log:

    ✓ protocol  test/digests.test.ts   (existing vectors unchanged, 3 new)
    ✓ signer    test/hyperliquid-encoding.test.ts
    ✓ signer    test/ows.test.ts  > signs the SDK's order vectors through OWS
    ✓ signer    test/venue-signing.test.ts

and from the `stack` job for Milestone 6:

    ✓ an order proposal becomes exactly one order at the venue after a passkey approval
    ✓ a signed order sent twice is refused the second time

## Validation and Acceptance

Automated validation (CI, every milestone):

- `check`: Biome and `tsc` across the workspace.
- `test`: `bun run test`, including the files named in Milestones 1 to 5.
- `ui`: the order card journey.
- `stack` (amd64, arm64, tls): the release gates named in Milestone 6, together with every v0.1
  gate.

Manual or runtime validation (owner-funded, D6; not CI):

- Start the stack with `VENUES_FILE` naming `hyperliquid:testnet` and
  `https://api.hyperliquid-testnet.xyz`.
- Fund the agent wallet's Hyperliquid testnet account with at least 11 testnet USDC by
  `usdSend` from an existing funded testnet account.
- Approve a policy with one market (for example BTC at its current index), a per-order cap of
  50 USD, a daily cap of 100 USD, `timeInForce: ["Gtc", "Ioc"]`, `submitWindowSeconds: 60`.
- Have the scripted agent propose an IOC buy of the minimum size at a price above the market;
  approve with a passkey; observe `filled` and the fill on the testnet explorer.
- Propose a GTC buy far below the market; approve; observe `placed`; `cancel_intent`; observe
  `cancelled`.
- Record the order ids, cloids and times in `Artifacts and Notes`.

Regression checks:

- Every v0.1 release gate in `specs/agent-workspaces-v0.1.md` "Validation and Acceptance".
- Every existing protocol test vector and every existing policy hash.
- `/v1/sign` with an EVM intent behaves exactly as before.

## Idempotence and Recovery

- Signer tables are `CREATE TABLE IF NOT EXISTS` and run on every start, like v0.1's.
- The server migration `0002_venue_orders.sql` is applied by `migrateDatabase` under its advisory
  lock; re-running is a no-op.
- A repeated `POST /v1/venue/sign` for a signed approval returns the stored response; the control
  plane can always retry and posts identical bytes.
- After a crash between posting and recording, the follow-up asks `orderStatus(cloid)` before
  posting again; the venue's nonce set refuses a duplicate in any case.
- Backout: approve a policy without `venues` for each wallet (the signer then refuses every
  venue intent) and remove `VENUES_FILE` (the tool answers "not configured"). Reverting the code
  leaves unused tables behind; a v0.1 signer refuses the new shapes because every schema is
  strict.

## Rollout and Operations

- Feature flags/config/env vars: `VENUES_FILE` on the server (absent by default; testnet only in
  this plan). No new signer configuration: the policy carries the rules.
- Deployment: signer first (it accepts the new shapes and still serves v0.1 requests), then the
  server. A server ahead of the signer gets `not_found` on the new routes and fails the approval
  with that code.
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
  to an SDK commit; the manual testnet proof is repeated before any mainnet decision.
- Risk: OWS's EIP-712 encoder differs from viem's for these types. Mitigation: Milestone 3 signs
  the SDK vectors through real OWS; the signer checks every signature against viem's digest.
- Risk: a policy's asset index stops naming its coin (relisting, reordering). Mitigation: the
  proposal-time metadata check refuses `market_metadata_mismatch`; the signer cannot check, so a
  control plane that skips the check could get an approval for an index whose coin changed; the
  card shows the policy's name for that index.
- Risk: notional caps are mistaken for loss caps. Mitigation: the card, the policy editor and the
  threat model state the venue account value as the loss bound.
- Risk: every order needs a passkey, which is too slow for trading. This plan does not solve it;
  ticket 19 (mandates) is where a bounded grant over many orders is designed.
- Risk: the submit window is too short for a slow workflow, and orders expire. Mitigation: 60
  seconds by default; the follow-up posts before any other work after signing.
- Open question (D2, legal and geographic, EU first): see the research report's "Owner
  questions". Nothing in this plan answers them; mainnet stays refused at boot.
- Open question: whether reduce-only orders should also bypass the per-order cap. This plan
  keeps them under it.
- Open question: whether the testnet manual proof is required before Milestone 6 is called done
  (D6).

## Artifacts and Notes

Research evidence, from the report:

    Hyperliquid SDK tests/signing_test.py:35
    phantom agent connectionId (IOC order, nonce 1677777606040, mainnet)
    0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908

    Polymarket ctf-exchange-v2 UserPausable.sol:14
    uint256 public userPauseBlockInterval = 100;

Out of scope for this plan, each its own later ticket: Polymarket (needs a bound on a signed
order's lifetime and answers to D2); Solana transfers; signer-built EVM swaps
(`multicall(deadline, [exactInputSingle(...)])`, recipient fixed to the wallet, router never a
call target); Hyperliquid trigger orders, leverage changes, builder fees, spot, HIP-3 DEXs;
mainnet.

## Revision Notes

- 2026-11-14: First version, written from the research report for ticket 21 before any owner
  decision. Written for the recommended options; each dependency on an owner decision is marked.
