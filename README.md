# os

Self-hosted workspaces where AI agents can hold and spend money without being trusted with it.

An agent proposes a payment. A person reads it on the signer's own confirmation page and approves
it there with a passkey. A separate signer service, the only component that can reach the wallet
keys, checks that passkey approval itself, checks the wallet's limits, and signs exactly one
transaction. For routine payments, people can instead approve once, in advance, a mandate: one
agent may pay listed recipients from one wallet up to stated amounts until a stated time, and the
signer enforces it. Everything runs on your own machine: Postgres, a control plane, the signer, a
keyless confirmation service and a reverse proxy in one Compose file. No hosted service is needed.

<p align="center">
  <img src="docs/images/approval-phone.png" width="320"
       alt="A payment request on a phone: send 0.015 ETH, the full recipient address, the wallet, the agent, the fee ceiling, the agent's memo marked as unchecked, the wallet's limits, a button that opens the signer's page to review and approve, the host that page is on, and Reject.">
</p>

A payment request in the control plane, on a phone, from the UI's development fixture. It does
not ask for a passkey: it links to the signer's confirmation page and names the host to check in
the address bar.

## Why it is built this way

- **The approval is enforced where the key is.** The signer verifies the approver's passkey
  signature over a digest of the exact operation. The web application cannot mint an approval,
  and neither can someone who can write to its database.
- **The approval is made on a page the control plane cannot change.** The signer's confirmation
  page has its own origin, and the signer builds what it shows from its own records. The signer
  accepts a passkey approval only when the browser made it there: at that origin, top-level, as a
  `webauthn.get`.
- **Approving in advance is bounded by the signer.** A mandate names one agent, one wallet, the
  recipients, caps per payment, per window and in total, a number of payments and an end time.
  People approve it once, on the confirmation page; the signer then signs each payment that fits
  with no person asked, counts it itself, and sends everything else to the inbox. Anyone who
  approves can revoke it with one click.
- **What people and agents type about an operation is ciphertext at rest.** Workflow state is
  encrypted through our own storage backend for the Workflow SDK (the upstream Postgres backend
  stores it in plaintext), and the application's own content columns are sealed per workspace.
- **Bring your own agent.** An agent is any program that speaks MCP: Claude Code, Codex, a
  script. It gets seven tools. None of them signs, approves or administers.

## How one payment happens

```mermaid
sequenceDiagram
  participant A as Agent
  participant S as Control plane
  participant P as Person
  participant Q as Confirmation page
  participant G as Signer
  participant C as Chain
  A->>S: propose_transfer (MCP)
  S->>S: simulate, check the wallet's limits, open an approval
  S->>G: open a confirmation for it
  P->>S: open the request, follow its link
  P->>Q: check the address bar, read what the signer holds
  P->>Q: approve with a passkey there
  Q->>G: the passkey signature, verified and kept by the signer
  S->>G: collect it, then send the intent and the passkey signature
  G->>G: verify the passkey itself, check policy and daily limits, sign once
  S->>C: broadcast
  C-->>S: receipt
  A->>S: get_intent: confirmed
```

## Run it

You need Docker with Compose v2.

```bash
git clone https://github.com/askgina/os.git && cd os
docker compose --profile dev up --build
```

The `dev` profile adds a local test chain, so there is something to send transactions to.

1. Find the setup token: `docker compose logs server | grep "setup token" | tail -1`.
2. Open <http://localhost:8080>, enter the token and create your passkey.
3. Create a workspace and add an agent. The agent gets its own wallet, and its token is shown once.
4. Set the wallet's limits and approve them with your passkey. A wallet with no limits signs nothing.
5. Give the wallet some test coins. The agent's page shows its wallet's full address; copy it, then:

   ```bash
   docker compose --profile dev exec anvil cast rpc anvil_setBalance <wallet address> 0xde0b6b3a7640000
   ```

6. Let the example agent propose a payment:

   ```bash
   docker compose --profile dev run --rm \
     -e AGENT_TOKEN=<the agent's token> \
     -e TRANSFER_TO=0x00000000000000000000000000000000000a11ce \
     scripted-agent
   ```

7. The proposal appears in the approval inbox. Open it and follow "Review and approve on the
   signer's page". The signer's confirmation page opens on <http://localhost:8081>: check that
   your address bar shows that address, read the payment as the signer holds it, and approve it
   there with your passkey. Back in the approval inbox, watch the agent report `confirmed`.

Passkeys work on `http://localhost` and on HTTPS. To serve a real host name with certificates,
see [`deploy/README.md`](deploy/README.md); the confirmation page then needs its own origin,
`APPROVE_ORIGIN`, on a subdomain or another port.

## Connect your own agent

Any MCP client that supports Streamable HTTP with a bearer token works:

```json
{
  "mcpServers": {
    "os": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer <the agent's token>" }
    }
  }
}
```

The tools are `whoami`, `get_balances`, `propose_transfer`, `propose_contract_call`,
`get_intent`, `list_intents` and `cancel_intent`. `whoami` lists the agent's live mandates with
what is left of them. A propose tool answers with `authorizedBy`: `"mandate"` when a mandate
covers the proposal (it is signed and sent with no person asked, and has no `approvalUrl`), or
`"person"` when someone must approve it at `approvalUrl`. `propose_transfer` takes an optional
`mandateId` to use exactly that mandate, or be refused with the reason. `get_intent` shows every
attempt of a sent payment and why it is not mined yet; no tool lets an agent speed one up or
cancel it.
[`examples/scripted-agent`](examples/scripted-agent)
is the smallest complete agent. [`examples/eve-agent`](examples/eve-agent) is a real agent
runtime (vercel/eve, no Vercel service) that keeps its conversations encrypted in its own
database.

## Approve in advance with a mandate

An owner asks for a mandate for one agent's wallet: the recipients, the caps per payment, per
window (for example an hour or a day) and in total, how many payments, the fee per payment, the
end time (seven days at most by default) and a purpose. Approvers approve it on the signer's
confirmation page at the workspace's admin threshold; the page shows the most that can leave the
wallet. From then on each payment of that agent that fits is signed with no passkey; anything
else waits in the inbox. Every payment counts, also one the network never includes.

Any owner or approver revokes a mandate with one click, without a passkey. It also ends when a
passkey that granted it is removed, when its agent is disabled, at its end time, after a restore
of the signer, and when the operator revokes it on the signer host
(`node src/admin.ts revoke-mandate`, see [`deploy/README.md`](deploy/README.md#mandates)).

## Be told when a request waits

Set `NOTIFY_WEBHOOK_URL` in `.env` and the server posts to it whenever a request waits for people
and whenever a mandate pays: identifiers, the kind of request, its expiry and a link to its page,
signed with a secret `init` creates, and retried until your receiver accepts it. Never an amount,
a recipient or a memo, and the link is no capability: opening it needs a passkey sign-in, and
approving still happens on the confirmation page.
[`examples/ntfy-sidecar`](examples/ntfy-sidecar) turns it into a phone notification through
[ntfy](https://ntfy.sh); other channels are built the same way, so the control plane holds no chat
or push provider's credential. The format and how to verify it are in
[`deploy/README.md`](deploy/README.md#notifications).

To notify people's own phones and browsers directly, serve the stack over HTTPS and set
`WEB_PUSH_ENABLED=1`; each person then turns notifications on per device, and the messages are
encrypted for the device and never show an amount or a recipient
([`deploy/README.md`](deploy/README.md#web-push)).

## When a payment is stuck

A sent payment that the chain does not mine keeps its nonce, and the wallet's later payments wait
behind it. The server signs it again with a higher fee by itself (after `REPRICE_AFTER_SECONDS`,
three minutes by default), and an owner or approver can press "Speed up" at once, without a
passkey. Only the two fee fields change, inside the fee ceiling people approved: never the
recipient, the amount or the nonce, so at most one of its attempts can be mined. People can also
cancel it: a request they approve with passkeys on the confirmation page, after which the signer
signs a transfer of nothing from the wallet to itself at the same nonce. A cancel is an attempt:
if the chain mines the payment first, the payment stands. Either way the payment counts toward
the wallet's daily limit. The settings and what they cannot do are in
[`deploy/README.md`](deploy/README.md#stuck-transactions).

## What this protects, and what it does not

| If this is compromised       | The attacker can                                                                                                                                                              | The attacker cannot                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent or its token        | Propose operations; spend inside its live mandates                                                                                                                            | Approve, sign, change limits, reach the signer; pay outside a mandate's list or caps; speed up or cancel a payment                                                   |
| The control plane's database | Read names, ids, statuses, addresses, limits                                                                                                                                  | Read sealed content; forge an approval                                                                                                                               |
| The control plane itself     | Ask the signer; show a person a misleading card; have the signer sign transfers that fit a live mandate; raise a sent payment's network fee up to the ceiling people approved | Get an approval the signer accepts; change the confirmation page; exceed limits or a mandate; reuse an approval; change a stuck payment's recipient, amount or nonce |
| The confirmation service     | Show a person a misleading page                                                                                                                                               | Sign or read a key; reach a signer route but its four; approve unaided                                                                                               |
| The signer's machine         | Everything for the wallets on it                                                                                                                                              |                                                                                                                                                                      |

Two limits are worth knowing before you rely on this:

- A passkey proves that a person approved a digest. It does not prove they read the details.
  The confirmation page shows what the signer holds, on an origin the control plane does not
  serve, so a compromised control plane can no longer get an approval for an operation the
  person did not see there. A compromised confirmation service, or the proxy in front of it,
  could still show one operation and collect an approval for another. For a payment the signer's
  limits bound that damage; for a change of limits or approvers they do not. A new approver
  must prove on the confirmation page that they hold the passkey being added before anyone can
  approve, but whoever holds a key a compromised control plane swapped in can pass that step
  too. Only comparing the key's fingerprint with the new person, over a call or in person,
  catches that. Add a second approver and raise the admin threshold to 2.
- A live mandate is spent with no person asked. A stolen agent token, or a compromised control
  plane, can make the signer pay the mandate's recipients up to its remaining caps, choosing
  when. Grant mandates with short lives and tight caps, and revoke them when they are not needed.
- Running every service on one machine gives no protection against that machine.

The full list is in [`docs/threat-model.md`](docs/threat-model.md).

## Status

This is a first release (v0.1) and has not been audited. Use test funds.

Scope: EVM chains; native transfers, ERC-20 transfers and allowlisted contract calls; one
approval for one transaction, or a mandate for a bounded series of one agent's transfers; a
stuck transaction repriced under its approval or cancelled with passkeys, tested against a local
chain only. Not in this release: mandates for contract calls or trades, other chains, a bundled
agent runtime, cloud key management. The
[map of open questions](https://github.com/askgina/os/issues/1) lists what is planned and why.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): the components and what each may reach.
- [`docs/approval-protocol.md`](docs/approval-protocol.md): the exact formats, digests and checks.
- [`docs/threat-model.md`](docs/threat-model.md): every attacker position and the known limits.
- [`deploy/README.md`](deploy/README.md): services, networks, volumes, the confirmation page's
  origin, backups, key rotation.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
- [`THIRD_PARTY.md`](THIRD_PARTY.md): dependencies whose licence is not MIT or Apache-2.0.

## Development

```bash
bun install
bun run services:up     # Postgres and a local chain for the tests
bun run check && bun run typecheck && bun run test
bun run services:down
```

Bun 1.4.4 and Node 26 are required. The repository layout is described in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

[MIT](LICENSE)
