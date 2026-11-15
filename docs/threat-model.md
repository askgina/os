# Threat model

This document says what the system protects, against whom, how, and where it does not. Each
claim names the file that implements it or the plan section that fixes it. The plan is
[`specs/agent-workspaces-v0.1.md`](../specs/agent-workspaces-v0.1.md); mandates follow
[`specs/approval-mandates.md`](../specs/approval-mandates.md), reprices and cancels of a stuck
transaction [`specs/stuck-transaction-repricing.md`](../specs/stuck-transaction-repricing.md),
retiring a wallet and deleting a workspace [`specs/workspace-lifecycle.md`](../specs/workspace-lifecycle.md),
running on more than one machine [`specs/beyond-one-machine.md`](../specs/beyond-one-machine.md),
venue orders [`specs/non-evm-operations.md`](../specs/non-evm-operations.md).
Components and terms are introduced in [`architecture.md`](./architecture.md); the exact checks
are in [`approval-protocol.md`](./approval-protocol.md).

## Assets

1. **Funds in the wallets.** The wallet private keys, and the ability to make the signer use
   them. USDC a wallet deposited at Hyperliquid is held by the venue, not by the key alone (see
   "Venue orders").
2. **Authority.** Who may approve, the approval threshold, and each wallet's policy.
3. **Content about operations.** What agents and people write about an operation: intents,
   memos, calldata, simulation results, audit details, workflow payloads.
4. **Integrity of the record.** The audit log and the signer's decision log.
5. **Availability.** Agents can propose and people can approve.
6. **Erasure.** When people retire a wallet or delete a workspace, its keys are destroyed and
   what was stored about it can no longer be read, outside the operator's older backups.

## Actors

- **Operator.** Runs the stack and holds the keyring (or the OpenBao that holds its keys), the
  signer volume and backups. With the signer on its own host, each host can have its own
  operator, and only the signer host's holds the signer volume.
- **Members.** People with a role in a workspace: owner, approver or viewer.
- **Agents.** Programs the operator brings, connected over MCP with a bearer token.
- **Outsiders.** Anyone on the network who can reach the public entry point.

## Trust boundaries

1. **Agent → control plane.** An agent reaches only Caddy and the MCP gateway. Its eight tools
   can propose, read and withdraw its own intents while they wait, and cancel its own order at a
   venue. None signs, approves, administers, or speeds up or cancels a sent transaction (plan,
   "MCP tools"; [`gateway.ts`](../apps/server/src/mcp/gateway.ts), `MCP_TOOL_NAMES`).
2. **Browser → control plane.** People sign in with passkeys. Sessions are rows behind an
   httpOnly, SameSite=Strict cookie; only a SHA-256 of the cookie value is stored
   ([`apps/server/src/db/schema.ts`](../apps/server/src/db/schema.ts), table `sessions`). No
   approval is made here: the control plane lists and explains requests and links to the
   confirmation page, and has no route that takes a passkey approval.
3. **Control plane → signer.** Requests carry an HMAC request signature
   ([`request-signature.ts`](../packages/protocol/src/signer/request-signature.ts)). Anything that
   adds authority also needs passkey assertions the signer verifies itself
   ([`verify-authorization.ts`](../packages/protocol/src/webauthn/verify-authorization.ts)). With
   the signer on its own host, the requests travel inside mutual TLS, and the control plane's
   certificate reaches the control routes only (see "Running on more than one machine").
4. **Data at rest → keyring.** Content is encrypted under data keys that are wrapped by
   key-encryption keys outside Postgres: in a keyring file, or in an OpenBao Transit key when
   `KEY_PROVIDER=openbao` ([`packages/keys/src/`](../packages/keys/src/); see "Key providers").
5. **Browser → confirmation page.** The `approve` service serves the signer's confirmation page
   on its own origin, `APPROVE_ORIGIN` ([`apps/approve`](../apps/approve)). Every approval is
   made here. The page shows the view the signer built from its own records and its own origin,
   with the instruction to approve only when the address bar shows it. The signer accepts an
   assertion only when the browser made it at `APPROVE_ORIGIN`, top-level (not in a frame), as a
   `webauthn.get` ([`verify-authorization.ts`](../packages/protocol/src/webauthn/verify-authorization.ts)).
   The service holds no key, sets no cookie, and Caddy drops any cookie on the way to it. A
   link's token is in its fragment, so it reaches the service only in a request header
   ([`specs/trusted-display.md`](../specs/trusted-display.md)).
6. **`approve` service → signer.** Requests carry an HMAC request signature under a second
   secret, which the signer accepts on its four confirmation routes and nowhere else
   ([`signer/api.ts`](../packages/protocol/src/signer/api.ts), `scope`). With mutual TLS, only the
   `approve` service's certificate reaches those routes.
7. **Control plane → the operator's webhook receiver.** When `NOTIFY_WEBHOOK_URL` is set, the
   server POSTs identifiers, a kind, a time and a link, signed with HMAC-SHA-256 under a third
   secret, `notify-webhook-secret` ([`apps/server/src/notify/webhook.ts`](../apps/server/src/notify/webhook.ts)).
   Nothing the receiver answers is read. See "Notifications".
8. **Control plane → venue.** When `VENUES_FILE` names one, the server posts the requests the
   signer signed to Hyperliquid's testnet API and reads order and account state from it
   ([`apps/server/src/execution/venues/hyperliquid.ts`](../apps/server/src/execution/venues/hyperliquid.ts)).
   The signer never talks to the venue, and nothing the venue answers reaches the signer. See
   "Venue orders".

## Attacker positions

### A malicious or prompt-injected agent

- **Can:** propose any operation it likes, with any memo; read its own wallet's state and its own
  intents; fill the approval inbox with proposals.
- **Stopped by:** a person must approve each intent with a passkey, unless a live mandate people
  granted that agent covers it (see "Mandates"); the signer checks the policy
  (requesters, chains, recipients, contract allowlist, per-transaction and daily caps, fee
  ceiling) on its own ledger ([`evaluate.ts`](../packages/protocol/src/evaluate.ts)). The agent
  has no tool that approves or signs, and none that raises the fee of a sent payment or cancels
  it: a prompt-injected agent could otherwise push every payment to its fee ceiling. It sees the
  attempts in `get_intent`. Memos may not contain control or bidirectional characters
  that could make a card show something other than what is stored
  ([`intent.ts`](../packages/protocol/src/intent.ts), `Memo`). On the network, the agent can
  reach only Caddy (plan, "How the pieces fit together").
- **Not stopped:** a persuasive memo that talks a person into approving. Within its policy, an
  approved intent spends real money, and an approved order can lose more than its notional cap
  at the venue (see "Venue orders"). The agent can cancel an order of its own that rests at the
  venue, which only removes what people approved (D4). Within a live mandate, the agent's
  transfers to the mandate's recipients are signed with no person asked, until the mandate's
  caps are spent. A raw contract call to an allowlisted contract can move
  things the caps cannot measure ([`policy.ts`](../packages/protocol/src/policy.ts),
  `CallOperation` comment in `intent.ts`). A capped token cannot itself be a call target (the
  policy schema refuses it), but an allowlisted contract that holds or can pull the wallet's
  tokens (a router with an approval, for example) is outside the caps.

### A stolen agent token

- **Can:** everything the agent can, from anywhere that reaches the MCP gateway.
- **Stopped by:** the same approval and policy checks. Tokens are stored as SHA-256 hashes only
  (`agents` table), so reading the database does not yield them.
- **Not stopped:** proposals that a person approves without noticing they did not come from the
  real agent; transfers inside that agent's live mandates, which no person sees before they are
  signed. Disabling the agent stops its token at once and revokes its mandates (see "Mandates").

### A compromised host of bots (the private Busy fork)

The private fork `askgina/busy` (based on Busy; the name is not final) runs agents as bots. Each
bot holds its own agent token: the fork's Hub stores it sealed and hands it to the runner as a
secret file, and the bot reaches the gateway over the `os_agents` network.

- **Can:** whoever controls the Hub or the runner holds every bot's agent token, so it is a
  stolen agent token for each of them: propose, cancel those agents' own requests, and spend any
  live mandate of theirs up to its worst case with no person asked.
- **Cannot:** approve anything. The gateway tools carry no Busy approval card; the only
  authorization is a passkey approval on the signer's confirmation page, or a mandate granted
  there. The bot sends the approval link as plain text, and the page refuses to load in a frame.
  The fork does not receive this stack's webhook.
- **Bound it:** small mandates or none for bot agents; one agent per bot; disable the agent here
  on any doubt about the Hub, which stops its token and revokes its mandates at once. The runner
  holds a Docker socket: never run it on the signer's host. The Hub's own tables are plaintext;
  bots' workflow state is encrypted by `@askgina/os-world` with a keyring per bot.
- **Proven:** the fork's unit CI and a real-stack gate with a bot on the encrypting World. The
  wallet connection is unit-tested and gated against a stub gateway only; no payment by a Busy
  bot has been proven end to end.

### Read access to the control plane's database

- **Can:** read identifiers, names of workspaces, agents and wallets, roles, statuses,
  timestamps, hashes, chain addresses, wallet policies, WebAuthn public keys and assertions, and
  the Workflow runtime's metadata (names, ids, hook tokens, timestamps, the keys of run
  attributes; their values are stored as `[withheld]` unless a key is listed as readable) (finding 2
  of [`specs/research/encrypting-postgres-world.md`](../specs/research/encrypting-postgres-world.md)).
- **Stopped by:** content is sealed (see the table below). Data keys in the database are wrapped
  under keys in the keyring file or OpenBao, with associated data binding each wrapped key to its scope, id,
  tenant and key id ([`data-key-store.ts`](../packages/keys/src/data-key-store.ts), `wrapAad`).
  Session cookies, invite tokens, agent tokens and the setup token are stored hashed.
- **Not stopped:** everything listed under "Can". It is readable on purpose.

### Write access to the control plane's database

- **Can:** corrupt, delete or reorder records; mark intents as approved in its own tables;
  change the mirrored policy shown on a wallet page.
- **Stopped by:** the signer does not trust any of it. It recomputes the challenge from the
  envelope and checks assertions against its own approver registry; it holds the authoritative
  policy and compares the envelope's `policyHash` to it; it records used nonces itself (plan,
  Milestone 2). A sealed value copied into another row or column fails to open, because its
  location is authenticated as associated data ([`seal.ts`](../packages/keys/src/seal.ts),
  [`apps/server/src/db/sealed.ts`](../apps/server/src/db/sealed.ts)). The audit log is hash-chained
  per workspace and verifies without the data key ([`apps/server/src/audit.ts`](../apps/server/src/audit.ts)).
- **Not stopped:** denial of service, and edits to readable columns. A hash chain detects
  edits; it does not prevent someone who can rewrite the whole chain from rewriting it.

### Code execution in the control plane

This covers code execution in the server and a script injected into a page on `PUBLIC_ORIGIN`
(XSS, a malicious build of the UI).

- **Can:** ask the signer anything the request signature allows; read sealed content (the
  server holds the keyring), the confirmation links it holds, and so what the confirmation page
  shows; show a person a misleading card in its own pages; propose any operation, policy change
  or approver change; link a person to the confirmation page of a different waiting request;
  refuse to open confirmations or withhold the approvals it collects; obtain a sign-in assertion
  and a session; pause workspaces and revoke approvals. Pausing stops new signatures; a repeat of
  an approval the signer already signed still returns that stored transaction, because it
  already exists. Ask for a sweep of any wallet, which has no cap, and choose its amount when it
  asks. Have the signer sign again, with higher fees and no passkey, any transaction it signed
  and that is not mined, choosing when and how far up to its fee ceiling (see "Stuck
  transactions"); open a cancel request for one and link people to it.
- **Stopped by:** it cannot obtain an approval the signer accepts. A passkey prompt on any of
  its pages makes an assertion stamped with `PUBLIC_ORIGIN`, which the signer refuses
  (`assertion_invalid`), whatever digest it carries. It cannot change what the confirmation page
  shows, because the signer renders that view from data whose hash the envelope fixes and from
  its own records. It cannot frame or script the confirmation page: that page sends
  `frame-ancestors 'none'` and `Cross-Origin-Opener-Policy: same-origin`, and the signer refuses
  an assertion made in a frame. So it can no longer obtain an approval for an operation the
  person did not see on the signer's page. It cannot exceed the signer's policy caps, reuse an
  approval, or change policy or approvers without passkey approval of the exact new value. The
  signer builds every transaction from the approved intent or sweep, and every later attempt of
  it from its own record of the first signature: only the two fee fields change. A sweep needs
  the workspace's admin threshold, and the signer sends it only to an address already on the
  wallet's recipient allowlist or to a treasury wallet of the same workspace, read from its own
  records ([`signer.ts`](../apps/signer/src/signer.ts), `assertSweepAllowed`). It cannot set or
  move the restore fence: that happens only on the signer host. It cannot have an approver
  change applied before someone proved on the confirmation page that they hold the new key: the
  signer refuses it with `possession_unproven`, and the named person's own passkey fails that
  proof for a key that is not theirs. It cannot grant a mandate: a grant needs passkey
  approvals on the confirmation page like any other request.
- **Not stopped:** a person who approves a true but harmful request because the control plane or
  an agent talked them into it; a person who approves without reading the confirmation page;
  denial of service; an `add-approver` request that carries a key the attacker holds under the
  named person's credential id, when nobody compares the fingerprint (see "Limits"); transfers it
  invents under a live mandate, which the signer signs with no person (see "Mandates"); network
  fees burned by repricing up to each approval's fee ceiling (see "Stuck transactions"); a
  retirement or deletion people did not want, described falsely, or with false balances beside
  it, and a deletion it stalls by cancelling it (see "Retiring a wallet and deleting a
  workspace"); for venue orders, an order it withholds, posts late inside its submit window or
  cancels, and false fills and balances it reports (see "Venue orders"). The release gate "an
  approval made on the control plane's page is refused" and the browser gate "a script on the
  control plane's page cannot get an approval" test the
  refusal against the real stack; the release gate "an approver change whose key the new person
  does not hold cannot be approved" tests the possession step.

### A compromised `approve` service, or Caddy, DNS or the certificate for `APPROVE_ORIGIN`

- **Can:** show a false view on the confirmation page and relay assertions over other digests,
  which is the display gap again; read the details of any request whose link it sees; send up
  to 64 submissions per confirmation.
- **Stopped by:** it holds no key. Its secret reaches only the signer's four confirmation routes,
  which read a view, store an assertion, and issue and check a new approver's possession
  challenge; it cannot sign, apply, open a confirmation or list assertions
  ([`apps/signer/src/index.ts`](../apps/signer/src/index.ts)). Every assertion it
  relays is verified by the signer as one approver's, at `APPROVE_ORIGIN`, over the envelope's
  digest, and again when the signer acts. It reaches only the signer, on its own internal
  network.
- **Not stopped:** a person misled on a page it controls; this brings back, for the people who
  use the page meanwhile, the gap the confirmation page closes. A script injected into the
  confirmation page is the same case. The page limits that risk: one hand-written script with no
  dependencies, no inline script or style, text set with `textContent` only, Trusted Types
  required (enforced by Chromium-based browsers), no third-party requests. Root on the host that
  runs the service controls it as it controls everything else there; with the signer on its own
  host, that is the signer host.

### A lookalike host (phishing)

- **Can:** imitate the confirmation page on another host, or on a page the control plane
  serves, and show a person a request that is not the one waiting, or keep them from the real
  page.
- **Stopped by:** a passkey is scoped to the RP ID, so a host outside it cannot obtain an
  assertion at all, and the signer accepts only the exact `APPROVE_ORIGIN`, so an assertion
  made on any other host under the RP ID is refused. The confirmation page shows its own origin
  and tells people to approve only when the address bar shows exactly that, and the control
  plane's approval page names the host the link opens.
- **Not stopped:** a person who does not check the address bar and believes a false page.

### A stolen confirmation link

- **Can:** read the request's details (amount, recipient, the agent's note) on the confirmation
  page, also after the request closed: the page keeps showing why it is closed. The control
  plane opens each confirmation once and hands out the same link on every view, so a link is
  not rotated while the request waits.
- **Stopped by:** a link grants no approval: only an approver's passkey at `APPROVE_ORIGIN` adds
  one. The signer stores only the token's SHA-256; the control plane keeps the link sealed
  (`approvals.confirmation`). The token is in the link's fragment, so no proxy or server log
  records it.

### A network position between the services

- **Can:** on one machine, on the signing network, observe requests between server and signer,
  including intents and assertions: the internal networks there carry no TLS. Between two hosts,
  see "Running on more than one machine".
- **Stopped by:** the HMAC request signature detects altered requests and refuses timestamps more
  than 60 seconds off. Altering an intent or envelope breaks its hash or its passkey signature.
  The signing network is internal, with no route from the agents network. The same holds for the
  `approve-signer` network between the `approve` service and the signer, under its own secret; a
  replayed submission adds no authority, because one person's assertion counts once.
- **Not stopped:** replay of a captured request within 60 seconds (the nonce and approval id then
  make it a no-op or a refusal, not a second signature); reading what passes.

### A stolen passkey or session

- **Stolen session cookie:** can act in the UI as that person, but cannot approve. Every approval
  needs a fresh assertion with user verification (`requireUserVerification: true` in
  `verify-authorization.ts`).
- **Stolen passkey (or a device unlocked by someone else):** can approve as that person, within
  the policy's caps and the workspace's thresholds. A threshold above 1 means one stolen passkey
  is not enough to sign, and since a wallet's threshold may never exceed the workspace's admin
  threshold, it is not enough to rewrite that wallet's policy either. Removing the approver
  invalidates pending authorizations they took part in, because every assertion must come from a
  current approver, and revokes every mandate their passkey granted (see "Mandates").

### A malicious member

- **Viewer:** can read what members read.
- **Approver:** can approve intents up to the policy's threshold. With a threshold of 1, one
  approver can approve any intent inside the caps.
- **Owner:** can propose policy and approver changes. These take effect only with the
  workspace's `adminThreshold` of approvals. With an admin threshold of 1, one owner who is an
  approver can raise caps. The signer keeps every wallet's threshold at or below the admin
  threshold, so the admin threshold is the real bar for a wallet's rules. An owner can also ask
  for a sweep, which takes the same admin threshold and reaches only the treasury or an address
  already on the wallet's allowlist, and for retiring a wallet or deleting the paused workspace,
  which take the same admin threshold and destroy keys only after the delay.
- **Any member, viewer included:** can cancel a waiting deletion; an approver or owner can cancel
  a waiting retirement. Cancelling keeps every key, so it needs no passkey.

### The signer host

- **Can:** everything for the wallets on it. It holds the vault, the per-wallet OWS tokens and
  the key that seals them. It is the only place a wallet key can be exported
  (`admin.ts export-wallet`, recorded as `export-wallet-by-operator` in the decision log). The
  key is also the wallet's Hyperliquid account, so whoever holds it can sign any venue action,
  on mainnet too.
- **Stopped by:** nothing in this design.

### The operator's backups

- **The Postgres volume alone:** the same as read access to the database.
- **The Postgres volume and the keyring file:** all sealed content and all workflow history.
  With OpenBao, the same holds for the Postgres volume and a token that may decrypt with the
  Transit key, for as long as OpenBao still holds the key versions the copy was wrapped under.
- **An exported record:** the workspace's history in readable form (see "Exporting, cloning and
  erasing a person"). It lives wherever the owner saved it, outside every backup policy here.
- **The signer volume:** the vault and its records. The OWS research found that a token plus
  read access to the vault directory is the wallet's mnemonic (findings F6 and F7 of
  [`specs/research/ows-node-sdk-in-an-isolated-signer.md`](../specs/research/ows-node-sdk-in-an-isolated-signer.md)).
  The signer seals those tokens under its own key (`token-key`); a backup that contains that key
  as well contains the wallets.
- **Restoring an older signer volume:** it forgets every approval used after the backup, so an
  approval paid after it would look unused. Every restore is fenced: the operator runs
  `admin.ts fence` before the signer serves, and the signer fences a database file it did not
  open last by itself. Then it refuses every envelope issued before the fence
  ([`fence.ts`](../apps/signer/src/fence.ts); `approval-protocol.md`, section 8). It has also
  forgotten the payments it counted under a mandate after the backup, so every move of the
  fence revokes every live mandate (see "Mandates"). It may also have forgotten attempts it
  signed after the backup, a cancel among them, so it no longer reprices any transaction signed
  before the fence (`envelope_fenced`); a cancel, approved after the fence, is still signed (see
  "Stuck transactions").
- **After a deletion:** a backup set taken before it holds the deleted workspace whole: its
  wallet keys, the signer's signed transactions, confirmations and mandate texts, and its sealed
  data with a keyring that opens it. Restored, it brings the workspace back. See "Retiring a
  wallet and deleting a workspace".

Back up each trust domain separately and protect the signer's backups as you would the funds.

### A compromised dependency

- **Can:** whatever the process that loads it can. A compromised package in the signer is the
  signer host case. In the server, it is the control-plane case.
- **Stopped by:** exact version pins for every dependency (`bunfig.toml`, plan "Context and
  Orientation"); the signer's small dependency set and its isolation.
- **Not stopped:** a malicious release that is pinned on purpose. The OWS native binary statically
  links 669 Rust crates whose licences and contents were not audited (finding F13 of the OWS
  research).

## Mandates

A mandate is approved once, at the workspace's admin threshold, on the signer's confirmation
page like every other request. From then on the signer signs, with no person asked, each
transfer of that one agent from that one wallet that fits all of it: a listed recipient, an
asset it lists (the native coin or an ERC-20 token), each of its caps (per payment, per rolling
window, in total, number of payments, fee per payment), the wallet's live policy, and the span
between its start and its end by the signer's clock. It never covers a contract call, not even
one that sends no coin. The signer verifies the grant's assertions itself, keeps the mandate,
and counts every use in the same database transaction as the signature
([`apps/signer/src/mandates.ts`](../apps/signer/src/mandates.ts); `approval-protocol.md`,
sections 7 and 8). The control plane chooses which proposals go to a mandate, but cannot widen,
extend, refund or revive one. No mandate covers a venue order or withdrawal (D7):
`evaluateMandate` refuses a venue intent with `mandate_operation_not_allowed`, and
`propose_order` never looks for one, so every order waits for a passkey (see "Venue orders").

| If this is compromised       | It can, while a mandate is live                                                                                                                                                                                                                                                    | It cannot                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The control plane            | Have the signer sign, with no person, any transfer that fits the mandate, choosing which and when, until its worst case is spent; invent the agent's proposals to do so; revoke any mandate (denial of service); ignore a person's revocation, which reaches the signer through it | Grant a mandate; have the signer sign a contract call, a recipient the mandate does not list, an amount over any cap of the mandate or the policy, before its start or from its end, after it was revoked, or past its number of payments or its total; move funds of another wallet |
| An agent's token             | Propose transfers that the signer signs with no person, inside that agent's live mandates                                                                                                                                                                                          | Pay an address the mandate does not list; exceed a cap; use another agent's mandate (the control plane binds a token to its agent; a compromised control plane is the row above)                                                                                                     |
| One approver's passkey       | Grant a mandate where the admin threshold is 1, which is no more than it could approve one payment at a time; the mandate outlives the theft until it is revoked or ends                                                                                                           | Keep its mandates after its passkey is removed: removing it revokes them in the same signer transaction                                                                                                                                                                              |
| The `approve` service        | Show a person one mandate and relay their approval for another, which the signer then grants                                                                                                                                                                                       | Grant a mandate wider than the wallet's policy or longer than the signer's longest life; sign anything                                                                                                                                                                               |
| The control plane's database | Read mandate ids, wallets, agents, status, start and end times, and hashes; corrupt the mirror the control plane keeps                                                                                                                                                             | Read a mandate's purpose, recipients or caps (sealed); change what the signer enforces                                                                                                                                                                                               |
| The signer host              | Everything, as before                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                      |

**Worst case of one mandate, per asset:** at most `min(maxTotal, maxUses × maxPerAction)`, and
at most the policy's 24-hour cap in any 24 hours, plus network fees of at most
`maxUses × maxFeePerActionWei`. When it is granted, the signer refuses a mandate whose
per-payment cap is above the policy's per-transaction cap, whose window cap is above the
policy's 24-hour cap (for windows up to a day), whose recipients the policy's allowlist does
not hold, whose fee cap is above the policy's, or whose life is longer than
`SIGNER_MAX_MANDATE_SECONDS` (seven days by default). Mandated payments count against the
policy's 24-hour cap. One misled grant therefore yields the whole worst case, where one misled
payment approval yields one payment: read a grant on the confirmation page with that in mind.
The page shows the most that can leave the wallet.

**No refunds.** The signer counts every payment it signs under a mandate, also one the network
never includes. Only the control plane could say a transaction failed, and it is not trusted.
The mandate's budget is spent by the signature.

**Ending a mandate.** It ends for good, with no resume, when a person revokes it (no passkey:
revoking only removes authority), when a passkey that granted it is removed, when its agent is
disabled, when the operator revokes it on the signer host, when the restore fence moves, at its
end time, and when its payments or every asset's total are spent. A person's revocation and the
agent's disabling go through the control plane; a compromised one can ignore them. The
operator's `revoke-mandate` on the signer host does not depend on the control plane
(`deploy/README.md`, "Mandates").

**Restoring the signer.** A restored signer has forgotten the uses it counted after the backup,
so its counts would let more leave the wallet than people approved. Every move of the restore
fence revokes every live mandate in the same transaction, and people grant again
([`fence.ts`](../apps/signer/src/fence.ts)). A restore that is not fenced keeps the old counts:
the `fence` step is part of every restore.

**The clock.** The signer's clock decides when a mandate starts and ends and which payments fall
in its window. A clock that runs behind keeps an ended mandate signing; one that runs ahead lets
payments leave the window early. The deploy guide requires time synchronization on the signer
host; nothing in the stack checks it.

**At rest.** The control plane seals the mandate, its purpose included, in `mandates.mandate`
and in the grant's `approvals.detail`. The signer keeps the canonical mandate in plain text in
its SQLite, as it keeps policies: the signer volume is the funds' trust domain already.

What the release gates in [`e2e/test/release-gates.spec.ts`](../e2e/test/release-gates.spec.ts)
check on the real stack, and what they do not:

- "a mandate approved on the confirmation page at the admin threshold lets its agent pay a
  listed recipient with no person asked": the grant, its view on the confirmation page, two
  covered payments (one by the example agent) with nothing in the inbox, and the counts.
- "a payment over the mandate's per-payment cap, or to a recipient it does not list, waits for a
  person": both go to the inbox; named, the mandate refuses each with its reason.
- "concurrent payments under one mandate never exceed its window cap, and the next is refused
  with mandate_over_window_cap".
- "a server killed right after a payment under a mandate still ends in exactly one transaction,
  and the mandate keeps its counts".
- "a revoked mandate signs nothing, and the next payment waits for a person".
- "removing the approver who granted a mandate ends that mandate and no other".
- "disabling an agent revokes its mandates at the signer and cancels its waiting grants".
- "the operator's revoke-mandate --all on the signer host ends every live mandate of the
  workspace" and "the operator's restore fence ends every live mandate": the second runs the
  fence command on a running signer; no gate restores a backup that holds a live mandate.
- "a mandate's purpose is in no column of the database in the clear, and in no log line".

The signer's own tests ([`apps/signer/test/mandates.test.ts`](../apps/signer/test/mandates.test.ts))
cover each grant refusal, each `mandate_denied` reason, the window sliding with time, the start
and end times, the policy as the outer limit, a paused workspace, concurrent uses, raising the
admin threshold above the grantors, the fence, and a repeated use. Nothing tests a wrong clock or
a compromised control plane spending a mandate.

## Notifications

People learn that a request waits from the approval inbox, from the operator's webhook when
`NOTIFY_WEBHOOK_URL` is set, and from Web Push when the operator turns it on
(`WEB_PUSH_ENABLED=1`, off by default;
[`specs/approval-notifications.md`](../specs/approval-notifications.md)). Other channels, such as
ntfy or a chat service, are sidecars of the webhook that hold their own credential
([`examples/ntfy-sidecar`](../examples/ntfy-sidecar)); the control plane holds none. The signer is
not involved: no notification is an input to an approval, whatever was or was not sent.

The webhook's body is canonical JSON with the request's or the payment's identifiers, its kind,
its expiry and a link; never an amount, a recipient, calldata, a memo, a policy, a mandate's caps
or purpose, or a name. It is signed with HMAC-SHA-256 over the timestamp and the exact body, with
the delivery id inside the signed body, under `notify-webhook-secret`, a file in the server's
secrets volume ([`webhook.ts`](../apps/server/src/notify/webhook.ts); format and checks in
`deploy/README.md`, "Notifications"). Each delivery is a row of `notification_deliveries`
written in the transaction that opens the request or records the payment, and sent at least once
([`outbox.ts`](../apps/server/src/notify/outbox.ts)). A link is the request's or the mandate's
page on `PUBLIC_ORIGIN`, built from checked identifiers; it carries no token, never creates a
session, and opening it needs a passkey sign-in. No notification offers a button that acts.

| If this is compromised                                                            | It can                                                                                                                                                                                                                                                                     | It cannot                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The control plane                                                                 | Stay silent on every channel, so requests expire unseen; send false notifications the webhook receiver accepts as signed, and with Web Push on, with any text to every subscribed device; link to a misleading page it serves; learn which people subscribed which devices | Approve anything; turn a notification into a capability; move more than the signer's caps or a mandate allow                                                                                                   |
| The control plane's database                                                      | Read the outbox: which request was announced when, to which target, and each attempt's outcome code; read each person's devices (push endpoints, keys and labels), quiet hours and switches, and each workspace's content level                                            | Sign a webhook delivery or send a push message: the webhook secret and the VAPID key are files, not rows, and every subscription is bound to that key                                                          |
| The webhook secret (at the server or a receiver)                                  | Send that receiver deliveries it accepts as genuine                                                                                                                                                                                                                        | Anything at the control plane or the signer                                                                                                                                                                    |
| The webhook receiver, or the service it forwards to (ntfy, a chat service)        | Read identifiers, kinds, times and links, which is the workspace's activity; drop, delay or repeat notifications                                                                                                                                                           | Read what a request is about; approve                                                                                                                                                                          |
| A browser's push service (Apple, Google, Mozilla, Microsoft), when Web Push is on | See when and how often a device is notified, the server's address and its VAPID subject; drop or delay messages                                                                                                                                                            | Read the message, which is encrypted for the device (RFC 8291) and padded to 512 bytes ([`send.ts`](../apps/server/src/notify/webpush/send.ts)); learn which request a message is about: its `Topic` is a hash |
| The VAPID key file (`vapid-key.pem`)                                              | With a copy of the subscriptions, send any text to every subscribed device                                                                                                                                                                                                 | Approve anything; read anything at the control plane or the signer                                                                                                                                             |

**A false notification** can only claim that something waits, or that a mandate paid: there is no
field that would say what. A person still approves only on the confirmation page, after checking
its address bar. The ntfy sidecar passes on a link only when it is on `PUBLIC_ORIGIN`, so through it
a compromised control plane can point people at its own pages and no other site.

**The content level.** Each workspace sets what a push notification shows. At `count`, the
default, it says only that requests wait and how many: no name of any kind. At `summary` it also
shows the kind of request, the requester's name (the agent's or the person's) and the
workspace's name, each line cut to 60 characters with control and bidirectional characters
removed ([`content.ts`](../apps/server/src/notify/content.ts)). No level shows an amount, a
recipient, an address or a memo: the structure a message is built from has no field for them.
At `summary` a waiting venue order reads "Order waiting", not "Payment waiting" (D8), and no
level shows its market, side, size, price or notional.
Names are plaintext already, but `summary` puts them on lock screens and in the push services'
hands, and a name is text a member typed: an agent called "URGENT approve refund" reads as an
instruction. Only an owner changes the level, without a passkey, and each change is recorded in
the audit log (`workspace.notification_detail_set`). The signer has no stake in it.

**A malicious or lasting service worker.** Push needs a service worker, `/sw.js`, on each
device, and it stays there after the server that served it is fixed. A compromised control plane
can serve a worker that shows false notifications or, if it adds a `fetch` handler, intercepts
the web app's requests on that device. Nothing the worker does can approve: approving happens on
the confirmation page, on another origin, with a passkey. Serving a good worker again replaces a
bad one when browsers next check it; to remove it instead, the operator serves a no-op worker or
sends `Clear-Site-Data: "storage"` (`deploy/README.md`, "Removing a service worker").

**Server-side request forgery through a push endpoint.** A member supplies the URL the server
posts push messages to. The server accepts it only over `https:`, with no user name or password,
and under a host of `WEB_PUSH_ENDPOINT_HOSTS` (by default the four push services), when it is
added and again before every send, and never contacts an endpoint that fails the check
([`send.ts`](../apps/server/src/notify/webpush/send.ts)). It follows no redirect and never reads
the answer's body ([`http.ts`](../apps/server/src/notify/http.ts)). An operator who lists another
host lets members make the server post encrypted messages there.

**Push subscriptions are personal data.** A subscription's endpoint names one browser at its
push service, and its keys let whoever also holds the VAPID key send to it. The server stores
them unsealed, because it needs them to send; it never logs them and never shows them back, not
even to their owner. A subscription the push service reports gone (404 or 410) is deleted.
Without the VAPID key file, a copy of the database cannot send to any of them.

**Replay.** A receiver refuses a timestamp more than 300 seconds from its clock and dedupes on the
delivery id. The signature covers the timestamp and the body, which holds the delivery id; the
`x-os-delivery` header is not covered, so a receiver checks that it equals the body's.

**A lost notification.** A receiver that keeps failing gets eight attempts over about twenty
minutes (10 seconds, doubling, at most 600), then the delivery is `failed` and logged. A request
decided or expired before its delivery is due is not announced. The inbox stays the truth.

**What push services learn.** For each message: which device it is for, when it is sent, its
urgency, how long to keep it, a `Topic` that is a hash naming no request, the server's address
and the VAPID subject (`WEB_PUSH_SUBJECT`, or `PUBLIC_ORIGIN`). Not its text: the body is
encrypted for the device and padded to 512 bytes, so its length says nothing either (RFC 8291
§7: "the timing and length of communication cannot be hidden from the push service"). The
timing remains. The device shows the text, on its lock screen too.

**What a channel's operator learns.** A self-hosted ntfy that serves the iOS app forwards a poll
request with each message's id to its upstream (normally `ntfy.sh`), which reaches the phone
through Firebase and Apple's push service: they learn when, not what. A chat app that opens a
link in its own browser has no session there and often no passkey: open links in the system
browser, or turn links off (the sidecar's default).

What the release gates in [`e2e/test/release-gates.spec.ts`](../e2e/test/release-gates.spec.ts)
check on the real stack, with a webhook receiver on its `control` network:

- "an approval is announced once, signed, with no sealed content, even after a failed delivery":
  the receiver fails the first attempt with 503; the same delivery id comes again and is accepted,
  both attempts verify with the secret read from the server's volume, the body has exactly its
  eight keys and none of the proposal's memo, recipient or amount, and the outbox holds one
  delivery, sent, after one failed attempt.
- "a payment under a mandate is announced to the webhook as mandate.used, signed, with no sealed
  content": one delivery with exactly its seven keys, naming the payment's own record and the
  mandate's page.

The sidecar's own tests ([`examples/ntfy-sidecar/test/bridge.test.ts`](../examples/ntfy-sidecar/test/bridge.test.ts))
cover a changed body, another secret, an old or future timestamp, a repeated and a racing
delivery id, ntfy failing, and links on other origins. The server's tests
([`apps/server/test/notify/`](../apps/server/test/notify/)) cover the outbox's transaction, retry
and drop rules, the reminder and quiet-hours times, what each content level contains, and Web
Push encryption against RFC 8291's own example. Push delivery is tested only against a local
stand-in push service, in the server's tests; no release gate turns Web Push on, and no real
phone has received a push from this build. Nothing tests a receiver whose clock is wrong.

## Stuck transactions

A transaction the signer signed and the server sent may never be mined. Its account nonce stays
held, so the wallet's later transactions on that chain wait behind it. The signer then signs
further **attempts** of the same approval, all at the first signature's nonce, so at most one of
them can be mined ([`apps/signer/src/attempts.ts`](../apps/signer/src/attempts.ts);
`approval-protocol.md`, section 8, "Reprices and cancels"). A **reprice** is the same
transaction with both fees higher: no passkey, asked for by the server on a schedule or by an
owner's or approver's "Speed up". A **cancel** is a transfer of nothing from the wallet to
itself at that nonce, approved as a `cancel-transaction` request on the confirmation page with
passkeys at the wallet policy's threshold. The server follows the hashes of every attempt and
reports the one that was mined ([`apps/server/src/execution/`](../apps/server/src/execution/),
`repricing.ts`, `cancel.ts`, `transactions.ts`).

| If this is compromised | It can                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | It cannot                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The control plane      | Choose when and how far fees rise for any approval it holds, up to `min(intent.maxFeeWei, policy fees.maxPerTxWei)`, within `SIGNER_REPRICE_WINDOW_SECONDS` of the first signature and `SIGNER_MAX_TX_ATTEMPTS` signatures: it can burn each payment's network fee up to the ceiling people approved; withhold broadcasts or give two approvals one nonce so they void each other (denial of service, as in v0.1); open a cancel request for any sent, unmined transaction and link people to it | Change the nonce, gas, recipient, amount, calldata or chain of an approved operation: the signer rebuilds every attempt from its own record; get a signature of it at a second nonce, so it is never mined twice; reprice an approval the signer never signed, or with another envelope or intent; reprice while the workspace is paused; get a cancel without passkeys at the wallet's threshold; turn a cancel back into the payment; add or release a spend |
| An agent's token       | Read the attempts and the stuck reason of its own intents                                                                                                                                                                                                                                                                                                                                                                                                                                        | Speed up or cancel anything: no tool does, and the people's routes need a session                                                                                                                                                                                                                                                                                                                                                                              |
| One approver's passkey | Approve a cancel where the wallet's threshold is 1: that payment does not happen, and the wallet pays one cancel fee within the policy's cap                                                                                                                                                                                                                                                                                                                                                     | Move anything with a cancel: it sends nothing to anyone                                                                                                                                                                                                                                                                                                                                                                                                        |
| The signer host        | Everything, as before                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**A cancel is an attempt, not a guarantee.** The chain decides: if the payment is mined first,
it stands (`confirmed` or `reverted`, with `cancel_too_late`), and the cancel does nothing but
cost its fee. The confirmation page says so. Once a cancel was signed, every later attempt is a
cancel, whichever route asks for it, so no reprice turns it back into the payment.

**The spend stands.** Neither a reprice nor a cancel adds or releases a spend or a mandate use.
The signer counted the payment when it first signed it, and only the control plane could say
which attempt was mined, so a landed cancel ages out of the 24-hour window like any spend.

**Which attempt was mined.** At most one can be, and the server reads every attempt's receipt,
whichever node saw which. An outcome is final only at the chain's `confirmations` depth: until
then a reorg can swap the payment for its cancel or the reverse, and the nonce stays held.
Operators of chains with deep reorgs raise `confirmations`.

**Replacement rules differ by client.** go-ethereum and reth replace a pooled transaction only
for both fees at least 10% higher; Anvil for any higher fee cap; Besu, Nethermind, L2
sequencers and private relays by rules of their own. The signer requires only "strictly
higher"; the size of the raise is the server's `REPRICE_BUMP_PERCENT` (12 by default). A refused
replacement leaves the earlier attempt valid, and it may still be mined.

**Restoring the signer.** A restored signer may have forgotten attempts signed after its
backup, a cancel among them, and a reprice built from what it remembers could undo that cancel.
So it refuses to reprice anything signed before the restore fence (`envelope_fenced`; the
server shows `reprice_refused`). A cancel request opened after the fence is not refused: people
can still stop such a transaction.

**Pause.** A paused workspace gets no reprice, neither from the server nor from a person's
speed-up, and the signer refuses one too. A cancel is still signed: it moves nothing and carries
its own passkeys.

What the release gates in [`e2e/test/release-gates.spec.ts`](../e2e/test/release-gates.spec.ts)
check on the real stack, with Anvil's mining held back so a payment stays unmined until the gate
lets it be mined:

- "a payment the chain does not mine is signed again with a higher fee by itself, differs only
  in its fees, and is mined exactly once": the node drops the first attempt and a block is mined
  without it; the server's own reprice raises both fees by the bump and stays inside the
  approved ceiling; as the node holds them, both attempts have the same sender, recipient,
  amount, data, nonce, gas and chain; once mining resumes exactly one attempt has a receipt, the
  recipient is paid once, the nonce rises by one, and the spend counts once.
- "an approver speeds up a stuck payment with no passkey, and the agent that proposed it sees
  every attempt but can neither speed it up nor cancel it": a click within 15 seconds adds
  nothing, a later one adds an attempt with no passkey assertion; the agent has its eight tools,
  its token gets 401 from the speed-up and cancel routes and 404 from the agents network, and
  `get_intent` shows each attempt and the stuck reason.
- "a cancel a person asks for, approved on the confirmation page at the wallet's threshold while
  the workspace is paused, is mined in the payment's place: nothing moves, the nonce is used
  once, and the spend still counts": the page shows the payment it would stop from the signer's
  record; the cancel attempt as the node holds it is a transfer of nothing from the wallet to
  itself; the intent ends `voided` with `transaction_cancelled`, the recipient's balance is
  unchanged, the wallet pays only the cancel's fee, and the signer's spend is unchanged.

The signer's tests ([`apps/signer/test/repricing.test.ts`](../apps/signer/test/repricing.test.ts))
cover every reprice and cancel refusal, the window, the attempt limit, the fence, mandate uses,
and a cancel's ceiling; the server's tests
([`apps/server/test/execution/repricing.test.ts`](../apps/server/test/execution/repricing.test.ts),
[`cancel.test.ts`](../apps/server/test/execution/cancel.test.ts)) cover the schedule, crash
recovery, the payment mined after a cancel was signed, a foreign transaction at the nonce, a
paused workspace and the cancel of a sweep. Everything runs against Anvil. Nothing tests a real
public mempool, the replacement rules of go-ethereum, reth or any other client, a reorg that
swaps two attempts, or a real phone's passkey on a cancel.

## Venue orders

The first operation that is not an EVM transaction is a limit order on a Hyperliquid perpetual
market, on Hyperliquid's testnet only, with a withdrawal of USDC from the wallet's Hyperliquid
account back to the wallet's own address
([`specs/non-evm-operations.md`](../specs/non-evm-operations.md)). A wallet's EVM address is also
its Hyperliquid account, and the wallet's own key signs every venue action; no API wallet is
approved (D3).

An agent proposes an order with `propose_order`, or a withdrawal with `propose_transfer` on the
network `hyperliquid:testnet`. The server checks the wallet policy's venue rules and the venue's
own metadata: the market must still be listed at the policy's asset index
(`market_metadata_mismatch`), and the price and size must fit its precision (`invalid_tick`)
([`orders.ts`](../apps/server/src/execution/orders.ts), `proposeOrder`). A person approves on
the signer's confirmation page, which shows the market as the policy names it and its index, the
side, size, limit price, notional at the limit price, time in force, reduce-only, the submit
window, that the agent may cancel the order without asking again, and that the caps limit new
orders, not losses ([`confirmation.ts`](../packages/protocol/src/confirmation.ts)). The signer
then builds the action with its own encoder, takes a nonce from its own ledger and an
`expiresAfter` inside the policy's submit window (5 to 300 seconds), signs once per approval,
checks the vault's signature against a digest it computed itself, and records the request before
it answers ([`venue-signing.ts`](../apps/signer/src/venue-signing.ts); `approval-protocol.md`,
section 8, "Venue orders"). The server stores the request sealed, posts it to the venue byte for
byte, and follows the order by its client order id, which the signer derives from the approval
id.

Approving an order includes the right to cancel that one order (D4). The signer signs its
`cancelByCloid` with no passkey, also while the workspace is paused, when the agent calls
`cancel_intent` or an owner or approver presses "Cancel order"; a cancel moves nothing. No
mandate covers an order or a withdrawal (D7), so each one waits for a passkey.

| If this is compromised                                | It can                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | It cannot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent's token                                      | Propose orders in the markets its wallet's policy lists, each waiting for a passkey; propose withdrawals where the policy allows them; cancel its own orders at the venue (D4); read the fills and account the venue reports                                                                                                                                                                                                                                                                                                   | Get an order signed with no person (D7); trade a market the policy does not list or exceed its caps; withdraw to an address other than the wallet's own; cancel another agent's order                                                                                                                                                                                                                                                                                                                                                                                                               |
| The control plane                                     | Not post a signed request, or post it at any moment until its `expiresAfter`; hold a signed withdrawal, which has no expiry of its own, until the venue's nonce rule refuses it (about two days, by the venue's documentation) and then post or drop it; have the signer cancel any order it signed, at any time, also while paused; skip the metadata check, so people may approve an index whose coin changed; report false fills, positions, account value and liquidations to people and agents; read sealed order content | Get a signature over a Hyperliquid action the signer did not build from an approved intent: no route takes an action, typed data, a message or a hash; change the market index, side, size, limit price, time in force, reduce-only flag, client order id, nonce or expiry of an approved order; set a priority fee or a builder (the signer fixes `grouping` to `na` and sets no builder); get two orders from one approval (a second post fails on the venue's nonce rule); exceed a cap; extend the submit window; withdraw to any address but the wallet's own; get anything signed for mainnet |
| One approver's passkey                                | Approve an order or a withdrawal where the wallet's threshold is 1, as for a payment                                                                                                                                                                                                                                                                                                                                                                                                                                           | Approve anything outside the policy's venue rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The `approve` service                                 | Show a person one order and relay their approval for another waiting order                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Get anything signed beyond what an approved intent and the policy allow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The venue itself (Hyperliquid, its chain, its bridge) | Lose or freeze the USDC deposited there with no signature: liquidation, auto-deleveraging, an outage or a bridge failure; fill, cancel or report orders other than as asked                                                                                                                                                                                                                                                                                                                                                    | Get a signature: the signer never talks to it, and nothing it answers reaches the signer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The signer host                                       | Everything, as before; with the wallet's key it can sign any venue action, on mainnet too                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**What the signer checks, and what it cannot.** The signer enforces the network (it signs only
`hyperliquid:testnet`), that the market index is one of the policy's markets, each market's
per-order cap and the daily cap on its own ledger, the time in force, the submit window, and that
a withdrawal is allowed by the policy and goes only to the wallet's own address. It has no path
to the venue, so it cannot see fills, positions, the account's value, or what an asset index
names today. Those come from the venue through the control plane, and the web app shows them as
reported by the venue, not verified. Asset indices are bound to coin names in the policy people
approved, and the confirmation page shows both; the check of the live metadata at proposal time
is the control plane's, and a compromised control plane can skip it.

**The loss bound is the venue account's value, not the caps.** A cap counts an order's
worst-case notional, size times limit price, when the signer signs it. It limits the new exposure
signed per order and per rolling day, not what can be lost: leverage (the venue's default or a
value set outside this system), funding payments, liquidation and positions opened earlier are
outside it. A reduce-only order counts against its market's per-order cap and not against the
daily cap, so closing stays possible when the daily cap is spent. A withdrawal has no cap; it can
only reach the wallet's own address. What can be lost is the value of the account at the venue,
which grows by deposits: EVM transfers to the venue's bridge under the wallet's EVM caps, or
transfers from other accounts at the venue. A sweep (`sweep-wallet`) does not reach the venue
balance, and retiring a wallet or deleting a workspace destroys the key whatever the venue
account holds; after that, the signer signs no cancel (`wallet_retired`), so an order still
resting stays at the venue. Withdraw first, with a person's approval.

**After a restore (D9).** A restored signer has no record of an order it signed after its
backup, so it answers `not_found` to that order's cancel. An immediate-or-cancel order is
already done; a good-till-cancelled or add-liquidity-only order may rest at the venue with no
way for this system to cancel it. The venue rules a policy starts from in the web app allow only
immediate or cancel for that reason. The restore fence refuses every approval issued before it,
orders included, and the signer's next nonce is never below its clock, so a restored signer
does not reuse a nonce while its clock is right.

**Mainnet is refused (D2).** The signer signs only `hyperliquid:testnet`, a constant in its code
(`SIGNABLE_VENUE_NETWORKS`), and refuses a mainnet intent with `venue_not_allowed` whatever the
wallet's policy names. The server stops at boot when `VENUES_FILE` names `hyperliquid:mainnet` or
the host `api.hyperliquid.xyz` ([`config.ts`](../apps/server/src/config.ts)). Turning mainnet
venue support on is the owner's open decision.

**What is stored.** The signed request is sealed in `venue_orders.request`. The order's client
order id, nonce, expiry, status, venue order id, filled size, average price and the venue's own
refusal text (at most 200 characters) are readable, like a transaction's hash and status. Server
log lines `venue.post`, `venue.status` and `venue.cancel` carry ids, the network and a status,
never the request.

What is proven, and what is not:

- The encoder and the signatures: equal to the venue SDK's own signed vectors
  (`hyperliquid-python-sdk` at `2fdb18f9`) for orders, cancels and testnet withdrawals, through
  real OWS ([`hyperliquid-encoding.test.ts`](../apps/signer/test/hyperliquid-encoding.test.ts),
  [`ows.test.ts`](../apps/signer/test/ows.test.ts)); green in CI. A mainnet withdrawal is checked
  only by recovering its signer, not against a vector.
- The signer's venue routes and their refusals (mainnet, caps, fence, pause, a cancel with no
  passkey): unit tests ([`venue-signing.test.ts`](../apps/signer/test/venue-signing.test.ts)),
  green in CI (runs 43735023880 and 43737561979).
- The control plane's proposal checks, posting, follow-up, cancel and the withdrawal ledger read:
  unit tests ([`orders.test.ts`](../apps/server/test/execution/orders.test.ts)) against a fake
  venue that checks signatures with an encoder of its own (`@askgina/os-testkit/fake-hyperliquid`).
  Unit-tested; the real-stack gate is pending.
- Not run: the real Hyperliquid testnet, because no funded testnet account is in hand (the manual
  proof is open, D6), and so also whether the real venue's ledger entry for a withdrawal carries
  its nonce, which the follow-up relies on after a lost answer. Mainnet is refused and has never
  run.

## Retiring a wallet and deleting a workspace

Retiring a wallet, or deleting a workspace with every wallet in it, ends with the signer
destroying keys. Destroying a key is treated like signing. An owner asks; people approve a
`retire-wallet` or `delete-workspace` request on the confirmation page with passkeys at the
workspace's admin threshold. The page shows the wallets and addresses the signer holds and the
destroy time, with two warnings: whatever is still in the wallets then is lost, and the signer
cannot see balances. From the moment it applies the approval the signer signs nothing for those
wallets and ends their mandates ([`apps/signer/src/lifecycle.ts`](../apps/signer/src/lifecycle.ts);
`approval-protocol.md`, section 8). It keeps the keys until the destroy time by its own clock,
which must lie between `SIGNER_MIN_DESTROY_DELAY_SECONDS` (seven days by default) and
`SIGNER_MAX_DESTROY_DELAY_SECONDS` (90 days) after the request was opened. Until then any member
can cancel a deletion, and an owner or approver a retirement, with no passkey: a cancel only
keeps keys. Once the time has passed and no transaction of the subject can still be mined, the
server's sweeper has the signer destroy the keys, and for a workspace shreds its data keys and
leaves a tombstone ([`apps/server/src/lifecycle/finalize.ts`](../apps/server/src/lifecycle/finalize.ts)).

| If this is compromised | It can                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | It cannot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The control plane      | Ask for a retirement or deletion people did not want and describe it falsely in its own pages; report false or partial balances, so approvers accept a loss they would not; cancel any retirement or deletion during the delay, which only delays it; leave runs unfinished or never call finalize, so a deletion never completes; read the workspace's sealed content until it shreds the workspace key; skip ending an agent's waiting payments when the agent is disabled | Show another wallet set, address or destroy time on the confirmation page: the signer renders them from its own records; destroy a key without passkeys at the admin threshold over an envelope that names exactly the wallets the signer still holds (`wallet_set_mismatch`); destroy before the destroy time, or set a delay outside the signer's bounds (`destroy_delay_out_of_range`); have a retiring or destroyed wallet sign, or have a deleting workspace approve anything but a `cancel-transaction`; make a cancelled deletion sign again: the workspace stays paused and a `held` wallet signs again only under a new policy people approve; bring back a mandate the request ended; export a key: no route does |
| An agent or its token  | Nothing new: no tool retires, deletes or cancels                                                                                                                                                                                                                                                                                                                                                                                                                             | Use its token once its workspace is deleted: the tombstone replaces every agent's token hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| One owner's passkey    | Ask for a retirement or deletion, and approve it alone where the admin threshold is 1                                                                                                                                                                                                                                                                                                                                                                                        | Shorten the delay below the signer's minimum, or stop another member cancelling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A member's session     | Cancel a deletion (any member), or a retirement (an owner or approver)                                                                                                                                                                                                                                                                                                                                                                                                       | Destroy anything: a cancel only keeps keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The signer host        | Everything, as before: export any key with `admin.ts export-wallet`, or delete the vault                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**What a successful attack gains.** A misled deletion destroys funds without moving them:
sabotage, not theft, and recoverable from the operator's backups until they expire. Nothing in
retiring or deleting sends money anywhere. The way to empty a wallet first is the sweep, whose
bound is unchanged: an address on the wallet's allowlist or the workspace's treasury.

**What the signer destroys, and what it keeps.** Finalizing runs in one write transaction with
SQLite's `secure_delete` on. The signer reads the state again, deletes the wallet from the OWS
vault (revoking every OWS API key named after it first, since each holds its own encrypted copy
of the secret), then empties the wallet's sealed credential and every signed transaction and
attempt of it. For a workspace it also deletes its approvers, confirmations, the assertions
made on the confirmation page and possession challenges, and blanks the text of its mandates.
After the commit it truncates the write-ahead log. It keeps used nonces, approvals, spends,
policies, mandate ids, hashes, grantors and uses, and the decision log, so nothing of the
workspace can be replayed, and afterwards answers only reads of its state and log for it
(`workspace_deleted`). A vault failure rolls the rows back; a key already gone counts as
deleted, so the next round completes.

**What the control plane removes.** After the signer's step the server shreds the key of every
workflow run of the workspace (`shredTenant("run", workspaceId)`: every run the server starts
names the workspace as its tenant) and the workspace's data key, so no sealed column and no
workflow payload of it can be opened with the live keyring
([`data-key-store.ts`](../packages/keys/src/data-key-store.ts)). The tombstone keeps ids,
statuses, times, hashes, addresses and the audit chain, which still verifies without the key;
names and labels are cleared; agents are disabled with their token hashes replaced; memberships,
invites, approver mirrors, assertions, rejections, nonce reservations and notification
preferences are removed, and undelivered notifications dropped. Former members then get
`not_found`.

**A transaction that could still be mined.** A signed transaction stays valid after its key is
destroyed, and nobody can replace it then. So finalize waits while any transaction of the
subject is `signed`, `broadcast` or `stuck`, and while one is `rejected` and no later
transaction of its wallet on its chain has used its nonce (`hasUnminedTransactions` in
[`state.ts`](../apps/server/src/lifecycle/state.ts)). People clear a stuck one with its
`cancel-transaction` request, which the signer still opens and signs while the deletion waits.

**Mandates and agents.** Applying a retirement or deletion revokes every live mandate of the
wallet or workspace in the same signer transaction, with reason `requested`; cancelling brings
none back. Disabling an agent, the way to remove one, also ends its payments still waiting for
people and revokes them at the signer
([`directory/routes.ts`](../apps/server/src/directory/routes.ts)).

**Not stopped:**

- **Assets the control plane did not read.** The signer cannot see balances. The list the web
  app shows before a deletion is the server's own reading of the native coin of each configured
  chain and of the assets each wallet's policy lists ([`preflight.ts`](../apps/server/src/lifecycle/preflight.ts)):
  partial, and false when the control plane lies. A token it does not list, or an NFT, is lost
  with the key. The delay, the notifications (`lifecycle.scheduled` when the request applies,
  `lifecycle.due_soon` 24 hours before the destroy time, to the webhook and to approvers' devices;
  [`deploy/README.md`](../deploy/README.md#what-the-server-sends)) and the operator's
  `export-wallet` before the time are the protection.
- **A stalled deletion.** A compromised control plane can cancel every deletion, or never
  finalize one. The keys survive, the workspace stays paused, and the state is visible. No
  operator command finalizes a deletion from the signer host.
- **The signer's clock decides the destroy time**, as it decides the restore fence and mandate
  windows. A clock running ahead destroys early; the seven-day minimum dwarfs ordinary drift.
- **Backups.** A backup set taken before the deletion holds the keys, the signed transactions,
  the confirmations, the mandate texts and the sealed data with a keyring that opens it, until
  the operator destroys it. Rotating the keyring after each deletion makes a pre-deletion
  database copy unreadable with the current keyring, not with the keyring copy saved beside it
  ([`deploy/README.md`](../deploy/README.md#backups-and-restoring)).
- **Cached keys.** Other processes may keep a shredded data key in their cache for up to one
  minute.
- **A restore during the delay** brings back a `deleting` workspace whose countdown continues:
  finalizing needs no envelope, so the restore fence does not stop it.
- **Plaintext on the signer during the delay.** The confirmations, assertions and mandate texts
  stay readable on the signer host until finalize removes them.

Tests: [`apps/signer/test/lifecycle.test.ts`](../apps/signer/test/lifecycle.test.ts) (applying,
cancelling, the delay bounds, the fence, a vault that fails mid-destroy, what a deleted
workspace keeps, the version 7 migration),
[`apps/server/test/lifecycle/retire.test.ts`](../apps/server/test/lifecycle/retire.test.ts) and
[`delete.test.ts`](../apps/server/test/lifecycle/delete.test.ts) (mandates ended on approval, a
cancel keeping the keys and the pause, the wait for a given-up transaction, the wait for runs, a
proposal racing the tombstone, a deleted workspace whose stored data cannot be opened, disabling
an agent), and the key store's tests of `shredTenant`. On the real stack, the ten release gates
in [`e2e/test/lifecycle.spec.ts`](../e2e/test/lifecycle.spec.ts) passed in CI run 43729783071 on
amd64 and arm64: retiring and cancelling, the operator's `export-wallet`, destroying a key at its
time, a deletion pausing the workspace and ending its mandates, the webhook announcement,
cancelling a deletion, waiting on a transaction that could still be mined, what a deleted
workspace leaves, and a pre-deletion database copy after a keyring rotation.

## Exporting, cloning and erasing a person

An owner can download a workspace's template (`exportTemplate`) and its record
(`exportRecord`), and make a new workspace from it (`cloneWorkspace`). Any signed-in person can
make one from a template file (`importTemplate`). The record also needs a passkey sign-in at
most 300 seconds old ([`apps/server/src/lifecycle/`](../apps/server/src/lifecycle/)).

**What a template and a clone carry.** A template is configuration only: the workspace's name,
admin threshold and notification content level, its members' user ids and roles, and per wallet
its kind, label, agent name and policy. Wallets that are retiring or destroyed and agents that
are disabled are left out ([`template.ts`](../apps/server/src/lifecycle/template.ts)). A clone
is built through the ordinary paths ([`clone.ts`](../apps/server/src/lifecycle/clone.ts)): a
new treasury and new agents, with new keys, new addresses and new agent tokens shown once; the
person cloning as its only owner and approver; an admin threshold of 1 until people change it
(the template's is returned as a reminder, not applied); one `set-policy` request per wallet,
with its threshold capped at 1, which applies no limit until the new workspace's approvers
approve it on the confirmation page; and invite links, with their roles, for the members this
installation knows and has not erased.

**What a clone cannot carry: authority.** No key, address, token, mandate, approver, approval,
intent, transaction, audit entry or workflow run of the source. A template file is input from
whoever wrote it: it can propose recipients, contract calls and limits, which are shown on the
confirmation page like any policy change and apply only when people approve them there. A policy
naming a chain this installation does not configure is refused before anything is created.

**What a record holds.** JSON Lines: the opened audit log with its chained fields and salts,
intents, transactions without their signed bytes, policy revisions, mandates with what the
signer counts of them and their uses, and the signer's decision log
([`export.ts`](../apps/server/src/lifecycle/export.ts)). No token, session, sealed value,
confirmation link, push endpoint or signed transaction. It is the workspace's sealed content made
readable, so whoever holds the file reads it. `workspace.exported` is appended first, so the
record includes its own export. `node apps/server/src/lifecycle/verify-record.ts <file>` checks
every hash, both chains, their heads, the order of the lines and each section's count offline;
editing, deleting or reordering a line makes it fail.

| If this is compromised       | It can                                                                                                       | It cannot                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| The control plane            | Hand out a record or template that is not the workspace's: the chains are hashes it computes, not signatures | Carry a mandate, approver or approval into a clone; apply a clone's limits without passkeys  |
| An owner's session           | Download the template; clone the workspace, getting the new agents' tokens                                   | Download the record without a passkey sign-in in the last 300 seconds                        |
| An owner's passkey           | Download the record, and with it the workspace's history                                                     | Change anything in the source workspace by exporting or cloning it                           |
| A template someone hands you | Propose recipients, contract calls and limits                                                                | Apply any of them before the new workspace's approvers approve them on the confirmation page |

**Not stopped:** a record that verifies is consistent, not true. A compromised control plane
can compute a whole record with chains that verify. Compare its `auditHead` and
`signerDecisionHead` with those of an earlier export you kept.

**Erasing a person.** A person asks with `eraseMe` (`POST /api/v1/me/erase`, a passkey sign-in at
most 300 seconds old); the operator, for someone who cannot sign in, runs
`node apps/server/src/identity/erase-cli.ts --user <id>`
([`apps/server/src/identity/erase.ts`](../apps/server/src/identity/erase.ts)). It takes two
calls because the control plane cannot take a passkey out of the signer's approver set. The
first opens one `remove-approver` request per passkey and workspace and answers `waiting`;
people approve them on the confirmation page at the admin threshold, which also ends every
mandate that passkey granted. Once no passkey of the person approves anywhere, the next call
erases. The operator's command cannot open requests: while the person's passkeys still approve,
it exits 3 with `still_approving` and changes nothing. Refused, all `conflict`: `last_owner`,
`last_approver` (fewer people could approve than a threshold of the workspace needs), and
`workspace_deleting`.

**What erasure removes, and what it keeps.** It removes the person's name (shown as "Erased
person" from then on), passkeys, sessions, push subscriptions, notification settings and quiet
hours, memberships, unsent notifications and the unused invites they made, and appends
`member.erased` to each workspace's audit log. It keeps the person's user id wherever history
keeps it: audit chains, approvals and their assertions, notification deliveries, the signer's
records, and so exported records. Nothing sealed is rewritten, so every chain still verifies.
A clone or import no longer invites an erased person.

| If this is compromised | It can                                                                                    | It cannot                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The control plane      | Erase anyone's name, passkeys and sessions from its own database, or refuse to erase them | Take a passkey out of the signer's approver set: only a `remove-approver` request people approve does that |
| A person's passkey     | Erase that person, and open the requests that remove their passkeys                       | Remove a passkey from the signer without the admin threshold of approvals                                  |

**Not stopped:**

- **The user id stays**, and links that person's history across every workspace they were in.
- **Copies taken before erasure.** Backups keep the name and everything else until they are
  destroyed. Records and templates already downloaded keep the id.

## Key providers

`KEY_PROVIDER=file` (the default) keeps the key-encryption keys in the keyring file;
`KEY_PROVIDER=openbao` keeps them in an OpenBao Transit key, which never leaves OpenBao
([`packages/keys`](../packages/keys/README.md#choosing-the-key-provider)). With both set, a
composite wraps new keys under Transit and unwraps each key with the provider that wrapped it.

- **A compromised OpenBao, or its token for the server:** it unwraps every data key it is given.
  With a database copy, that reads everything, for as long as OpenBao holds the key versions the
  copy used. The policy in [`deploy/openbao/policy.hcl`](../deploy/openbao/policy.hcl) grants
  encrypt, decrypt and reading the key's versions, not export, rotation, deletion or
  configuration.
- **An OpenBao outage fails closed.** Every operation that needs a key fails with
  `KeyProviderUnavailableError` until OpenBao answers again, apart from keys a process has
  cached (up to one minute). No provider falls back to another, to the keyring file or to
  plaintext; the composite opens a `bao:` key only with Transit. Shredding needs no key provider,
  so a deletion's shredding does not wait for OpenBao.
- **Rotating the Transit key** and raising its `min_decryption_version` makes copies wrapped
  under older versions, backups included, unopenable.

Export, clone, import and erasing a person have release gates on the real stack
([`lifecycle.spec.ts`](../e2e/test/lifecycle.spec.ts)), beside their unit tests
([`export.test.ts`](../apps/server/test/lifecycle/export.test.ts),
[`clone.test.ts`](../apps/server/test/lifecycle/clone.test.ts),
[`erase.test.ts`](../apps/server/test/identity/erase.test.ts)).

## Running on more than one machine

[`deploy/README.md`](../deploy/README.md#running-the-signer-on-its-own-host) has the procedures;
the plan is [`specs/beyond-one-machine.md`](../specs/beyond-one-machine.md).

### The signer on its own host

The signer, the `approve` service and the confirmation page's edge run on the signer's host; the
server, Postgres, the public edge and the agent gateway on the control host
([`deploy/split/`](../deploy/split/)). The server reaches the signer's port 8787 over mutual TLS
1.3; each side accepts exactly the other's self-signed certificate, and the signer binds each
client certificate to one scope before it checks the request signature
([`apps/signer/src/index.ts`](../apps/signer/src/index.ts), `clientScopes`). What changes for
each attacker position:

- **Code execution in the control plane, or root on the control host.** Everything listed under
  "Code execution in the control plane" still holds, including transfers it invents under a live
  mandate and fees burned up to each ceiling. What no longer comes with it is the signer host:
  the control host holds no vault, no `token-key`, no `vault-passphrase`, no confirm secret and
  no signer or `approve` key, so it cannot read a wallet key, run the signer's admin commands,
  set the fence or serve the confirmation page. The CI gate `split.spec.ts` checks that the
  control project has no volume with those secrets and runs no `approve` service.
- **The network between the hosts.** It sees TLS 1.3: when the hosts talk, how much, and the
  signer's name the server asks for; TLS 1.3 encrypts both certificates and everything after
  the handshake, intents and assertions included. It can drop or delay traffic, which stops
  signing and approving. It cannot replay a captured request: the 60-second window of the request
  signature applies inside a TLS session it cannot open. A client on that network without one of
  the two client certificates gets no handshake (`split.spec.ts`).
- **A stolen control certificate and key.** It still needs the request secret, and the reverse:
  the certificate alone fails the request signature, and the secret alone fails the handshake.
  Both are on the control host, so whoever has that host has both: the control-plane case. A
  stolen confirm secret is useless from the control host, because the confirm routes take only
  the `approve` service's certificate.
- **The confirmation page's edge on the signer host takes internet traffic.** Caddy there serves
  `APPROVE_ORIGIN` on ports 80 and 443 and reaches an ACME server for its certificate. It holds
  no secret but that certificate. Its compromise is the case "A compromised `approve` service, or
  Caddy, DNS or the certificate for `APPROVE_ORIGIN`"; an escape from its container is the signer
  host case. The example rules in `deploy/split/nftables-signer.conf` drop every connection the
  signer opens, and `approve` has only internal networks; `split.spec.ts` checks the signer cannot
  reach the internet under those rules. They are an example the operator applies, not something
  the stack enforces.
- **The signer host.** Unchanged: everything for the wallets on it.

Two more things the split brings:

- **The operator command the members page shows.** For a workspace with no approver left, the
  page shows owners the `enroll-approver` command to run on the signer host, starting with the
  control plane's `SIGNER_ADMIN_COMMAND`. The server at start and the web app check that prefix
  against a pattern with no shell metacharacters, but a compromised control plane chooses the
  whole text. Whoever runs it on the signer host reads it first: the prefix must be the signer's
  admin command, and the key must be the one the person reads out.
- **Certificates expire.** Two years after `make-peer-certs.sh`, every handshake fails and
  nothing is signed or approved until new ones are installed. The signer logs the days left at
  every start and refuses to start with an expired certificate.

A move of the signer to another host is a new database file: the signer fences itself, every
waiting approval is refused, and every live mandate ends (decision D9 in the plan), because a
move cannot be told from a copy.

Proven: the release gates and `split.spec.ts` in CI job `stack (split)` (runs 43733608692 and
43735023880), with both Compose projects on one runner. Not tested: two real hosts with different
administrators.

### Several server replicas

- **Limits are shared.** The limits on one agent's requests (120 a minute) and on one client's
  failed authentications (10 a minute) are token buckets in Postgres
  ([`apps/server/src/rate-limit.ts`](../apps/server/src/rate-limit.ts)), so N replicas allow what
  one does. The table is `UNLOGGED`: a database crash or failover resets every limit. The failed
  authentication limit charges the address `FORWARDED_HOPS` entries from the end of
  `X-Forwarded-For`; set too high, a client chooses the address it is charged to and is not
  limited.
- **One setup token per installation.** No boot mints one; `cli.ts setup-token` replaces it under
  one lock, so of two commands run at once one token works. Until the first owner exists, whoever
  can run that command in a server container can create the first owner, as on one machine. The
  token is never in the log, so reading the log is not enough.
- **A shred reaches every replica.** See "What is encrypted at rest".

Proven: the unit tests, with two gateways on one database, in CI run 43736178714. The real-stack
gate `stack (replicas)` is written and has not run.

### Kubernetes

The manifests in [`deploy/k8s/`](../deploy/k8s/) are written and have not run in CI. They claim
isolation only as far as the isolation probe
([`deploy/k8s/isolation-probe.yaml`](../deploy/k8s/isolation-probe.yaml)) and the gate
`e2e/test/kubernetes.spec.ts` check it, and neither has run yet:

- an agent pod gets no DNS, no Kubernetes API and no internet, and reaches only the gateway's MCP
  endpoint;
- any other pod in `os` reaches nothing;
- from a namespace without policies, the edge answers and the server, the gateway, Postgres, the
  chain, the signer and the confirmation service do not;
- in the in-cluster layout, the signer reaches nothing, and the confirmation service only the
  signer.

Nothing else is claimed. A NetworkPolicy does nothing on a network plugin that does not enforce
it, and kind's plugin fails open when its controller cannot start: only the probe shows it, so it
runs after every install. Policies cannot block `localhost` inside a pod. Secrets are not
encrypted in etcd by default, and cluster administration reaches every node, so whoever
administers the cluster is the control plane; with the signer in the cluster (CI and evaluation
only) they are the signer host. In production the signer and its confirmation page run outside
the cluster. With notifications on, the server may open TCP 443 to any address, and its own
checks of the webhook URL and push hosts are what limit it.

## What is encrypted at rest

| Data                                                                                                                            | Where                                                                                                   | Encrypted?                                                                                 | Why                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| The canonical intent (operation, recipient, amount, calldata, memo)                                                             | `intents.payload`                                                                                       | Sealed, workspace key                                                                      | What people and agents typed about an operation                                                                         |
| What the approval card shows, and the simulation result                                                                         | `intents.presentation`                                                                                  | Sealed, workspace key                                                                      | Same                                                                                                                    |
| What an approval kind needs to apply its effect: a proposed policy, a sweep's amount and target                                 | `approvals.detail`                                                                                      | Sealed, workspace key                                                                      | Same                                                                                                                    |
| The confirmation page's link for a waiting request, with its token                                                              | `approvals.confirmation`                                                                                | Sealed, workspace key                                                                      | The token shows the request to whoever holds it; the signer stores only its SHA-256                                     |
| A mandate: its caps, recipients and purpose                                                                                     | `mandates.mandate`, and the grant's `approvals.detail`                                                  | Sealed, workspace key                                                                      | What a person typed about a standing grant; its id, wallet, agent, times, hash and status stay readable                 |
| The signed raw transaction, of every attempt                                                                                    | `transactions.raw`, `transaction_attempts.raw`                                                          | Sealed, workspace key                                                                      | Kept only to rebroadcast; it contains the operation. Each attempt's hash, gas and fees stay readable, as on chain       |
| The signed venue request of an order or a withdrawal                                                                            | `venue_orders.request`                                                                                  | Sealed, workspace key                                                                      | It contains the order. Its client order id, nonce, status, fills and the venue's refusal text stay readable             |
| Audit details                                                                                                                   | `audit_events.detail`                                                                                   | Sealed, workspace key                                                                      | Free-form content; its digest stays readable so the chain verifies without the key                                      |
| Workflow inputs, outputs, hook payloads, stream chunks, step errors                                                             | `workflow` schema                                                                                       | AES-256-GCM, per-run key ([`packages/world/src/index.ts`](../packages/world/src/index.ts)) | The upstream Postgres World stores these in plaintext                                                                   |
| Data keys                                                                                                                       | `os_keys` schema                                                                                        | Wrapped by a KEK from the keyring file or OpenBao Transit                                  | The database alone must not be enough                                                                                   |
| Identifiers, names given to workspaces, agents and wallets, roles, statuses, timestamps, hashes                                 | `os` schema                                                                                             | No                                                                                         | Needed to list, join and display without keys                                                                           |
| Wallet addresses and policies                                                                                                   | `wallets`                                                                                               | No                                                                                         | Public on chain, and needed to show limits                                                                              |
| WebAuthn public keys and assertions                                                                                             | `credentials`, `approver_credentials`, `approval_assertions`                                            | No                                                                                         | Public keys and signatures over digests; not secret                                                                     |
| Session, invite, agent and setup tokens                                                                                         | various                                                                                                 | Stored as SHA-256 hashes                                                                   | Only needed for comparison                                                                                              |
| Workflow names, ids, hook tokens, run attribute keys                                                                            | `workflow` schema                                                                                       | No                                                                                         | The Workflow SDK does not encrypt them (finding 2 of the World research). Attribute values are replaced, not stored     |
| The notification outbox: which request or payment was announced, to which target, when, and each attempt's code                 | `notification_deliveries`                                                                               | No                                                                                         | Identifiers, times and short codes only; what a notification says is built from them when it is sent                    |
| Each device's push subscription (endpoint, keys, label); each person's quiet hours and switches; each workspace's content level | `push_subscriptions`, `users.quiet_hours`, `notification_preferences`, `workspaces.notification_detail` | No                                                                                         | Needed to send. Subscriptions are personal data: never logged, never shown back, and useless without the VAPID key file |
| Server log lines                                                                                                                | stdout                                                                                                  | No                                                                                         | They carry identifiers, codes and counts only, never content ([`apps/server/src/log.ts`](../apps/server/src/log.ts))    |

The plaintext scanner used to check this decompresses and decodes workflow payloads before
searching ([`packages/testkit/src/scan.ts`](../packages/testkit/src/scan.ts)). A naive scan reports
a database full of readable data as clean, because the SDK compresses before it stores.

The encrypting World never answers "no key". Upstream treats a missing key as "store plaintext",
so every failure throws and the run stalls and retries instead of leaking. Shredding a key leaves
a tombstone so a later read cannot mint a replacement ([`data-key-store.ts`](../packages/keys/src/data-key-store.ts)).
Every server replica listens for shreds and drops a shredded key from its cache at once; it
caches nothing while that connection is down. A process that does not listen, such as a World
started from `@askgina/os-world/target`, keeps a cached key until its cache time (one minute)
expires.

## Limits

These are stated without softening.

**A passkey proves a person approved a digest, not that they saw the right details.** The
passkey research puts it this way
([`specs/research/passkey-assertion-bound-to-one-approval.md`](../specs/research/passkey-assertion-bound-to-one-approval.md)):

> A verified assertion proves only that an authenticator holding the private key for credential
> C, scoped to RP ID R, produced a signature over a challenge equal to H(grant) while running in
> a client that reported origin O, with the user-presence and (if UV) user-verification flags set
> by that authenticator. It does not prove that the user saw, read or understood the grant's
> contents, that the page rendered the grant faithfully, or that the client code at origin O was
> uncompromised. The challenge is an opaque hash: authenticators and browsers display only the RP
> ID and account name, never the transaction. Any script running at origin O (XSS, malicious
> extension, compromised control-plane build) can obtain a valid approval for a different grant
> from a user who believes they are approving the one shown.

The confirmation page ([`specs/trusted-display.md`](../specs/trusted-display.md)) closes this
gap against the control plane. The page is on an origin the control plane does not serve, it
shows what the signer holds, and the signer accepts only assertions made there, top-level, as a
`webauthn.get`. A compromised control plane, or a script on its origin, chooses the challenge of
every passkey prompt on its own pages, the sign-in prompt included, but no assertion made there
counts. So it can no longer obtain an approval for an operation the person did not see on the
signer's page. What remains:

- **The confirmation page's own origin.** A compromised `approve` service, or Caddy, DNS or the
  certificate for `APPROVE_ORIGIN`, brings the gap back: it can show one operation and relay an
  approval for another. It still cannot sign or read a key. For a payment, the signer's policy
  caps bound the loss; for a change of policy or approvers they do not.
- **The signer host.** Whoever controls it controls the wallets, with or without approvals.
- **A person who approves without reading.** The page shows the signer's warnings and the
  operation as the signer holds it, but it cannot make anyone read them.
- **Phishing with a lookalike host.** It cannot obtain an assertion the signer accepts, but it
  can deceive a person who does not check the address bar, which is why the page tells people
  to check it.
- **A new approver's key.** Before anyone can approve an `add-approver` request, the person being
  added must answer on the confirmation page, with the passkey the request carries, a challenge
  only that key can sign; the signer refuses the change otherwise (`possession_unproven`). So no
  approver change is applied with a key that nobody has shown they hold, and a person being
  added whose passkey was swapped sees their own answer fail. It does not close a key swap: a
  WebAuthn signature does not cover the credential id, so whoever holds a key that a compromised
  control plane put in the request under the named person's credential id can pass the step,
  while the named person's own passkey fails it. Only the fingerprint comparison catches that,
  and only when people do it. After their answer the page shows the person being added the
  key's fingerprint; they read it to the approvers over a call or in person, and the approvers
  approve only if it matches the "Key fingerprint" line on their page. The comparison works only
  when that person did the step themselves: one who found the step already done, or whose
  answer failed, has no fingerprint of their own to read, and the approvers must not approve.

A workspace starts with an admin threshold of 1, where one misled approval of a policy or
approver change is enough for lasting control of its wallets. Raise the admin threshold to 2 as
soon as a second approver is enrolled: a swapped approver key then needs two people to skip the
fingerprint comparison.

**On the port layout the browser sends the control plane's cookies to the confirmation page.**
Cookies do not separate ports, so with `APPROVE_ORIGIN` on another port of the same host the
session cookie goes with every request to it. Caddy drops it before the `approve` service; a
compromised Caddy sees it in any layout. The subdomain layout keeps the session cookie, which is
host-only, away from the confirmation page altogether.

**One machine running everything gives no protection against that machine.** The network
separation between server and signer protects only when they run on different hosts with
separate administration. On one host, root on that host is the signer host case. The split
deployment puts the signer on its own host, but its CI gate runs both projects on one machine:
two hosts with different administrators have not been tested (see "Running on more than one
machine").

**OWS signs in-process.** The OWS library runs inside the signer's process. It is a key store,
not an isolation boundary, and its own policy is not used as an authority (OWS research,
verdict and F2–F5). The signer process is the boundary.

**The first approvers of a workspace are trust on first use.** When a workspace is registered,
the signer cannot check who its first approvers are. It only keeps the set from changing later
without their passkeys (`CreateWorkspaceRequest` in
[`signer/api.ts`](../packages/protocol/src/signer/api.ts)). The operator can also enroll a new
approver directly from the signer's admin command line (`enroll-approver`, recorded as
`enroll-approver-by-operator` in the decision log); there is no HTTP route for it, so the control
plane cannot choose the enrolled key, and it has no possession step, because the operator types
the key on the host. Host access is the root of trust: whoever controls the signer host
controls recovery.

**The signer's decision log detects damage, not a determined writer.** Each workspace's log is a
hash chain whose head (`seq` and `hash`) is kept on the workspace row and updated in the same
transaction as every append, so edited, inserted or deleted rows, including the newest ones, are
found by `verify-log`. The chain is not keyed: someone who can write the SQLite file can rewrite
every row and the head together. The log records allowed changes and refusals of requests that
passed the request signature and schema for a known workspace; unauthenticated or malformed
requests and unknown workspaces appear only in the signer's stdout.

**A signed amount counts against the daily cap even if the transaction never lands.** The signer
records the spend in the same database transaction as the signature (plan, Milestone 2, step 8).
It does not watch the chain.

**A stuck transaction blocks later ones until one of its attempts is mined.** A signed
transaction that is never mined holds its nonce, so later transactions of that wallet on that
chain cannot be mined either. The server raises its fee within the approved ceiling, and people
can cancel it, but nothing forces the chain to take either: a fee ceiling below what the chain
asks, a closed reprice window or an exhausted attempt limit leaves it waiting, and a cancel can
lose to the payment (see "Stuck transactions").

**The request signature can be replayed for 60 seconds.** It is not a source of single use; the
envelope nonce is.

**"At most once" lasts only as long as the signer's database.** A restored signer database has
forgotten what it signed after the backup. The restore fence closes that, at a cost: every
approval issued before the fence is refused, so approvals waiting at the restore, and proposals
made in the 30 seconds after it, must be made again. The signer notices on its own only a
database file that is not the one it last opened (a copy, an extracted archive, a move to another
host). A restore that rolls the same file back in place, such as a disk snapshot, is fenced only
by the operator's `fence` step, which the deploy guide makes part of every restore. The fence
relies on the signer host's clock: a clock set back across a restore weakens it. A v0.1 signer
image does not know the fence, so going back to one after an upgrade drops it.

**A sweep has no cap.** It moves a whole balance in one transaction, approved at the admin
threshold. What bounds a misled sweep is the destination rule: the money can only reach an
address the approvers allowed earlier, or the workspace's own treasury. A paused workspace can
still be swept, on purpose: it is how a paused workspace is emptied.

**A deletion destroys what the signer cannot see.** The signer has no path to a chain, so it
destroys keys whatever their wallets still hold. The confirmation page says so; the balances the
web app shows are the control plane's, partial, and not checked by anyone else. A key is gone
from backups only when every backup that holds it is gone (see "Retiring a wallet and deleting a
workspace").

**A venue order's caps are not loss caps.** The signer counts each order's notional when it
signs, but what can be lost at the venue is the account's value there, and the signer sees
neither fills nor balances: they are the venue's report, passed on by the control plane (see
"Venue orders").

**Removing the passkeys of every approver does not lock the funds forever, by design.** It also
means the signer host's operator can always add an approver.

## Out of scope for v0.1

From the map's "Not yet specified" list ([askgina/os#1](https://github.com/askgina/os/issues/1)):

- Approvals wider than one action, beyond transfers: mandates cover native and ERC-20 transfers
  to listed recipients (see "Mandates"); contract calls, trades, venue orders and session
  delegation are not covered by anything but one approval per action.
- Operations that are not EVM transactions, beyond Hyperliquid testnet perpetual limit orders and
  withdrawals to the wallet's own address (see "Venue orders"): other chains, other venues, other
  Hyperliquid actions (stop and trigger orders, transfers between accounts, leverage changes),
  and Hyperliquid mainnet, which is refused until the owner decides D2.
- Shipping agent runtimes or sandboxes.
- Cloud KMS key providers, and HA Postgres (CloudNativePG is planned and not built). The signer
  on its own host, OpenBao Transit, several server replicas and the Kubernetes manifests are in
  "Running on more than one machine" and "Key providers", each with what is proven.
- Notifications outside the inbox beyond Web Push and the signed webhook with its sidecars (see
  "Notifications"): email, and chat adapters built into the control plane.
- For stuck transactions: a new gas limit, legacy (type 0) and blob transactions, L2-specific
  fee fields, private order flow, and a signer that watches the chain itself.

Also out of scope: hosted or multi-tenant operation by Ask Gina.
