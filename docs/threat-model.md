# Threat model

This document says what the system protects, against whom, how, and where it does not. Each
claim names the file that implements it or the plan section that fixes it. The plan is
[`specs/agent-workspaces-v0.1.md`](../specs/agent-workspaces-v0.1.md). Components and terms are
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
   ([`apps/server/src/db/schema.ts`](../apps/server/src/db/schema.ts), table `sessions`).
3. **Control plane → signer.** Requests carry an HMAC request signature
   ([`request-signature.ts`](../packages/protocol/src/signer/request-signature.ts)). Anything that
   adds authority also needs passkey assertions the signer verifies itself
   ([`verify-authorization.ts`](../packages/protocol/src/webauthn/verify-authorization.ts)).
4. **Data at rest → keyring.** Content is encrypted under data keys that are wrapped by keys in a
   file outside Postgres ([`packages/keys/src/`](../packages/keys/src/)).

## Attacker positions

### A malicious or prompt-injected agent

- **Can:** propose any operation it likes, with any memo; read its own wallet's state and its own
  intents; fill the approval inbox with proposals.
- **Stopped by:** a person must approve each intent with a passkey; the signer checks the policy
  (requesters, chains, recipients, contract allowlist, per-transaction and daily caps, fee
  ceiling) on its own ledger ([`evaluate.ts`](../packages/protocol/src/evaluate.ts)). The agent
  has no tool that approves or signs. Memos may not contain control or bidirectional characters
  that could make a card show something other than what is stored
  ([`intent.ts`](../packages/protocol/src/intent.ts), `Memo`). On the network, the agent can
  reach only Caddy (plan, "How the pieces fit together").
- **Not stopped:** a persuasive memo that talks a person into approving. Within its policy, an
  approved intent spends real money. A raw contract call to an allowlisted contract can move
  things the caps cannot measure ([`policy.ts`](../packages/protocol/src/policy.ts),
  `CallOperation` comment in `intent.ts`). A capped token cannot itself be a call target (the
  policy schema refuses it), but an allowlisted contract that holds or can pull the wallet's
  tokens (a router with an approval, for example) is outside the caps.

### A stolen agent token

- **Can:** everything the agent can, from anywhere that reaches the MCP gateway.
- **Stopped by:** the same approval and policy checks. Tokens are stored as SHA-256 hashes only
  (`agents` table), so reading the database does not yield them.
- **Not stopped:** proposals that a person approves without noticing they did not come from the
  real agent.

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

- **Can:** ask the signer anything the request signature allows; read sealed content (the
  server holds the keyring); show a person a misleading approval card; pause workspaces and
  revoke approvals. Pausing stops new signatures; a repeat of an approval the signer already
  signed still returns that stored transaction, because it already exists. Ask for a sweep of
  any wallet, which has no cap, and choose its amount when it asks.
- **Stopped by:** it cannot produce a passkey assertion. It cannot exceed the signer's policy
  caps, reuse an approval, or change policy or approvers without passkey approval of the exact
  new value. The signer builds every transaction from the approved intent or sweep. A sweep needs
  the workspace's admin threshold, and the signer sends it only to an address already on the
  wallet's recipient allowlist or to a treasury wallet of the same workspace, read from its own
  records ([`signer.ts`](../apps/signer/src/signer.ts), `assertSweepAllowed`). It cannot set or
  move the restore fence: that happens only on the signer host.
- **Not stopped:** the trusted-display gap, stated in full under "Limits".

### A network position between the services

- **Can:** on the signing network, observe requests between server and signer, including
  intents and assertions. The plan's layout puts no TLS on the internal networks.
- **Stopped by:** the HMAC request signature detects altered requests and refuses timestamps more
  than 60 seconds off. Altering an intent or envelope breaks its hash or its passkey signature.
  The signing network is internal, with no route from the agents network.
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
  current approver.

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
  ([`fence.ts`](../apps/signer/src/fence.ts); `approval-protocol.md`, section 8).

Back up each trust domain separately and protect the signer's backups as you would the funds.

### A compromised dependency

- **Can:** whatever the process that loads it can. A compromised package in the signer is the
  signer host case. In the server, it is the control-plane case.
- **Stopped by:** exact version pins for every dependency (`bunfig.toml`, plan "Context and
  Orientation"); the signer's small dependency set and its isolation.
- **Not stopped:** a malicious release that is pinned on purpose. The OWS native binary statically
  links 669 Rust crates whose licences and contents were not audited (finding F13 of the OWS
  research).

## What is encrypted at rest

| Data                                                                                            | Where                                                        | Encrypted?                                                                                 | Why                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The canonical intent (operation, recipient, amount, calldata, memo)                             | `intents.payload`                                            | Sealed, workspace key                                                                      | What people and agents typed about an operation                                                                      |
| What the approval card shows, and the simulation result                                         | `intents.presentation`                                       | Sealed, workspace key                                                                      | Same                                                                                                                 |
| What an approval kind needs to apply its effect: a proposed policy, a sweep's amount and target | `approvals.detail`                                           | Sealed, workspace key                                                                      | Same                                                                                                                 |
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

So a compromised control plane can show one operation and submit another for approval. For a
payment, the signer's policy caps bound the loss. For a change of authority they do not: the
control plane chooses the challenge on every passkey prompt it serves, the sign-in prompt
included, so one misled tap by an approver can approve a new policy or enroll an attacker's
passkey as an approver. A workspace starts with an admin threshold of 1, where one such tap is
enough for lasting control of its wallets. Until a trusted display exists, raise the admin
threshold to 2 as soon as a second approver is enrolled. The design is drafted in
[`specs/trusted-display.md`](../specs/trusted-display.md) and not built.

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
plane cannot choose the enrolled key. Host access is the root of trust: whoever controls the
signer host controls recovery.

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

- Approvals wider than one action: session delegation and strategy mandates.
- A trusted display that proves the approver saw the right details.
- Operations that are not EVM transactions: other chains, and off-chain venues.
- Shipping agent runtimes or sandboxes.
- Operating beyond one machine: KMS or OpenBao key providers, HA Postgres, Kubernetes.
- Notifications outside the inbox: web push and chat. The optional webhook (`NOTIFY_WEBHOOK_URL`)
  exists: it sends identifiers only, unsigned, once, to an address the operator chose.
- Workspace lifecycle beyond emptying a wallet: clone, export, retiring a wallet, and delete with
  assets still in the wallets. A person can sweep a wallet whose agent is gone.
- Repricing stuck transactions.

Also out of scope: hosted or multi-tenant operation by Ask Gina.
