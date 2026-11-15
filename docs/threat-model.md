# Threat model

This document says what the system protects, against whom, how, and where it does not. Each
claim names the file that implements it or the plan section that fixes it. The plan is
[`specs/agent-workspaces-v0.1.md`](../specs/agent-workspaces-v0.1.md); mandates follow
[`specs/approval-mandates.md`](../specs/approval-mandates.md). Components and terms are
introduced in [`architecture.md`](./architecture.md); the exact checks are in
[`approval-protocol.md`](./approval-protocol.md).

## Assets

1. **Funds in the wallets.** The wallet private keys, and the ability to make the signer use
   them.
2. **Authority.** Who may approve, the approval threshold, and each wallet's policy.
3. **Content about operations.** What agents and people write about an operation: intents,
   memos, calldata, simulation results, audit details, workflow payloads.
4. **Integrity of the record.** The audit log and the signer's decision log.
5. **Availability.** Agents can propose and people can approve.

## Actors

- **Operator.** Runs the stack and holds the keyring, the signer volume and backups.
- **Members.** People with a role in a workspace: owner, approver or viewer.
- **Agents.** Programs the operator brings, connected over MCP with a bearer token.
- **Outsiders.** Anyone on the network who can reach the public entry point.

## Trust boundaries

1. **Agent → control plane.** An agent reaches only Caddy and the MCP gateway. Its seven tools
   can propose, read and cancel its own intents. None signs, approves or administers (plan,
   "MCP tools").
2. **Browser → control plane.** People sign in with passkeys. Sessions are rows behind an
   httpOnly, SameSite=Strict cookie; only a SHA-256 of the cookie value is stored
   ([`apps/server/src/db/schema.ts`](../apps/server/src/db/schema.ts), table `sessions`). No
   approval is made here: the control plane lists and explains requests and links to the
   confirmation page, and has no route that takes a passkey approval.
3. **Control plane → signer.** Requests carry an HMAC request signature
   ([`request-signature.ts`](../packages/protocol/src/signer/request-signature.ts)). Anything that
   adds authority also needs passkey assertions the signer verifies itself
   ([`verify-authorization.ts`](../packages/protocol/src/webauthn/verify-authorization.ts)).
4. **Data at rest → keyring.** Content is encrypted under data keys that are wrapped by keys in a
   file outside Postgres ([`packages/keys/src/`](../packages/keys/src/)).
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
   ([`signer/api.ts`](../packages/protocol/src/signer/api.ts), `scope`).

## Attacker positions

### A malicious or prompt-injected agent

- **Can:** propose any operation it likes, with any memo; read its own wallet's state and its own
  intents; fill the approval inbox with proposals.
- **Stopped by:** a person must approve each intent with a passkey, unless a live mandate people
  granted that agent covers it (see "Mandates"); the signer checks the policy
  (requesters, chains, recipients, contract allowlist, per-transaction and daily caps, fee
  ceiling) on its own ledger ([`evaluate.ts`](../packages/protocol/src/evaluate.ts)). The agent
  has no tool that approves or signs. Memos may not contain control or bidirectional characters
  that could make a card show something other than what is stored
  ([`intent.ts`](../packages/protocol/src/intent.ts), `Memo`). On the network, the agent can
  reach only Caddy (plan, "How the pieces fit together").
- **Not stopped:** a persuasive memo that talks a person into approving. Within its policy, an
  approved intent spends real money. Within a live mandate, the agent's transfers to the
  mandate's recipients are signed with no person asked, until the mandate's caps are spent. A
  raw contract call to an allowlisted contract can move
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

### Read access to the control plane's database

- **Can:** read identifiers, names of workspaces, agents and wallets, roles, statuses,
  timestamps, hashes, chain addresses, wallet policies, WebAuthn public keys and assertions, and
  the Workflow runtime's metadata (names, ids, hook tokens, timestamps, the keys of run
  attributes; their values are stored as `[withheld]` unless a key is listed as readable) (finding 2
  of [`specs/research/encrypting-postgres-world.md`](../specs/research/encrypting-postgres-world.md)).
- **Stopped by:** content is sealed (see the table below). Data keys in the database are wrapped
  under keys in the keyring file, with associated data binding each wrapped key to its scope, id,
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
  asks.
- **Stopped by:** it cannot obtain an approval the signer accepts. A passkey prompt on any of
  its pages makes an assertion stamped with `PUBLIC_ORIGIN`, which the signer refuses
  (`assertion_invalid`), whatever digest it carries. It cannot change what the confirmation page
  shows, because the signer renders that view from data whose hash the envelope fixes and from
  its own records. It cannot frame or script the confirmation page: that page sends
  `frame-ancestors 'none'` and `Cross-Origin-Opener-Policy: same-origin`, and the signer refuses
  an assertion made in a frame. So it can no longer obtain an approval for an operation the
  person did not see on the signer's page. It cannot exceed the signer's policy caps, reuse an
  approval, or change policy or approvers without passkey approval of the exact new value. The
  signer builds every transaction from the approved intent or sweep. A sweep needs the
  workspace's admin threshold, and the signer sends it only to an address already on the
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
  invents under a live mandate, which the signer signs with no person (see "Mandates"). The release
  gate "an approval made on the control plane's page is refused" and the browser gate "a script
  on the control plane's page cannot get an approval" test the refusal against the real stack;
  the release gate "an approver change whose key the new person does not hold cannot be
  approved" tests the possession step.

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
  required (enforced by Chromium-based browsers), no third-party requests. On the same host,
  root controls the service as it controls everything else.

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

- **Can:** on the signing network, observe requests between server and signer, including
  intents and assertions. The plan's layout puts no TLS on the internal networks.
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
  already on the wallet's allowlist.

### The signer host

- **Can:** everything for the wallets on it. It holds the vault, the per-wallet OWS tokens and
  the key that seals them.
- **Stopped by:** nothing in this design.

### The operator's backups

- **The Postgres volume alone:** the same as read access to the database.
- **The Postgres volume and the keyring file:** all sealed content and all workflow history.
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
  fence revokes every live mandate (see "Mandates").

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
extend, refund or revive one.

| If this is compromised       | It can, while a mandate is live                                                                                                                                                                                                                                             | It cannot                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The control plane            | Have the signer sign, with no person, any transfer that fits the mandate, choosing which and when, until its worst case is spent; invent the agent's proposals to do so; revoke any mandate (denial of service); ignore a person's revocation, which reaches the signer through it | Grant a mandate; have the signer sign a contract call, a recipient the mandate does not list, an amount over any cap of the mandate or the policy, before its start or from its end, after it was revoked, or past its number of payments or its total; move funds of another wallet |
| An agent's token             | Propose transfers that the signer signs with no person, inside that agent's live mandates                                                                                                                                                                                  | Pay an address the mandate does not list; exceed a cap; use another agent's mandate (the control plane binds a token to its agent; a compromised control plane is the row above)                                                                                                |
| One approver's passkey       | Grant a mandate where the admin threshold is 1, which is no more than it could approve one payment at a time; the mandate outlives the theft until it is revoked or ends                                                                                                     | Keep its mandates after its passkey is removed: removing it revokes them in the same signer transaction                                                                                                                                                                         |
| The `approve` service        | Show a person one mandate and relay their approval for another, which the signer then grants                                                                                                                                                                                | Grant a mandate wider than the wallet's policy or longer than the signer's longest life; sign anything                                                                                                                                                                         |
| The control plane's database | Read mandate ids, wallets, agents, status, start and end times, and hashes; corrupt the mirror the control plane keeps                                                                                                                                                      | Read a mandate's purpose, recipients or caps (sealed); change what the signer enforces                                                                                                                                                                                          |
| The signer host              | Everything, as before                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                                                                 |

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

## What is encrypted at rest

| Data                                                                                            | Where                                                        | Encrypted?                                                                                 | Why                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The canonical intent (operation, recipient, amount, calldata, memo)                             | `intents.payload`                                            | Sealed, workspace key                                                                      | What people and agents typed about an operation                                                                      |
| What the approval card shows, and the simulation result                                         | `intents.presentation`                                       | Sealed, workspace key                                                                      | Same                                                                                                                 |
| What an approval kind needs to apply its effect: a proposed policy, a sweep's amount and target | `approvals.detail`                                           | Sealed, workspace key                                                                      | Same                                                                                                                 |
| The confirmation page's link for a waiting request, with its token                              | `approvals.confirmation`                                     | Sealed, workspace key                                                                      | The token shows the request to whoever holds it; the signer stores only its SHA-256                                  |
| A mandate: its caps, recipients and purpose                                                     | `mandates.mandate`, and the grant's `approvals.detail`       | Sealed, workspace key                                                                      | What a person typed about a standing grant; its id, wallet, agent, times, hash and status stay readable              |
| The signed raw transaction                                                                      | `transactions.raw`                                           | Sealed, workspace key                                                                      | Kept only to rebroadcast; it contains the operation                                                                  |
| Audit details                                                                                   | `audit_events.detail`                                        | Sealed, workspace key                                                                      | Free-form content; its digest stays readable so the chain verifies without the key                                   |
| Workflow inputs, outputs, hook payloads, stream chunks, step errors                             | `workflow` schema                                            | AES-256-GCM, per-run key ([`packages/world/src/index.ts`](../packages/world/src/index.ts)) | The upstream Postgres World stores these in plaintext                                                                |
| Data keys                                                                                       | `os_keys` schema                                             | Wrapped by a KEK from the keyring file                                                     | The database alone must not be enough                                                                                |
| Identifiers, names given to workspaces, agents and wallets, roles, statuses, timestamps, hashes | `os` schema                                                  | No                                                                                         | Needed to list, join and display without keys                                                                        |
| Wallet addresses and policies                                                                   | `wallets`                                                    | No                                                                                         | Public on chain, and needed to show limits                                                                           |
| WebAuthn public keys and assertions                                                             | `credentials`, `approver_credentials`, `approval_assertions` | No                                                                                         | Public keys and signatures over digests; not secret                                                                  |
| Session, invite, agent and setup tokens                                                         | various                                                      | Stored as SHA-256 hashes                                                                   | Only needed for comparison                                                                                           |
| Workflow names, ids, hook tokens, run attribute keys                                            | `workflow` schema                                            | No                                                                                         | The Workflow SDK does not encrypt them (finding 2 of the World research). Attribute values are replaced, not stored  |
| Server log lines                                                                                | stdout                                                       | No                                                                                         | They carry identifiers, codes and counts only, never content ([`apps/server/src/log.ts`](../apps/server/src/log.ts)) |

The plaintext scanner used to check this decompresses and decodes workflow payloads before
searching ([`packages/testkit/src/scan.ts`](../packages/testkit/src/scan.ts)). A naive scan reports
a database full of readable data as clean, because the SDK compresses before it stores.

The encrypting World never answers "no key". Upstream treats a missing key as "store plaintext",
so every failure throws and the run stalls and retries instead of leaking. Shredding a key leaves
a tombstone so a later read cannot mint a replacement ([`data-key-store.ts`](../packages/keys/src/data-key-store.ts)).
In other processes, a cached key stays usable until its cache time (one minute by default)
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
separate administration. On one host, root on that host is the signer host case.

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

**A stuck transaction blocks later ones.** A signed transaction that is never mined holds its
nonce, so later transactions of that wallet on that chain cannot be mined either. Repricing
under an existing approval is not designed.

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

**Removing the passkeys of every approver does not lock the funds forever, by design.** It also
means the signer host's operator can always add an approver.

## Out of scope for v0.1

From the map's "Not yet specified" list ([askgina/os#1](https://github.com/askgina/os/issues/1)):

- Approvals wider than one action, beyond transfers: mandates cover native and ERC-20 transfers
  to listed recipients (see "Mandates"); contract calls, trades and session delegation are not
  covered by anything but one approval per action.
- Operations that are not EVM transactions: other chains, and off-chain venues.
- Shipping agent runtimes or sandboxes.
- Operating beyond one machine: KMS or OpenBao key providers, HA Postgres, Kubernetes.
- Notifications outside the inbox: web push and chat. The optional webhook (`NOTIFY_WEBHOOK_URL`)
  exists: it sends identifiers only, unsigned, once, to an address the operator chose.
- Workspace lifecycle beyond emptying a wallet: clone, export, retiring a wallet, and delete with
  assets still in the wallets. A person can sweep a wallet whose agent is gone.
- Repricing stuck transactions.

Also out of scope: hosted or multi-tenant operation by Ask Gina.
