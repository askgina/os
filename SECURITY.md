# Security policy

This project holds keys that move money. Please report security problems privately.

## How to report

Use GitHub's private vulnerability reporting on this repository: open the **Security** tab of
[askgina/os](https://github.com/askgina/os), choose **Report a vulnerability**, and fill in the
form. The report is visible only to you and the maintainers.

GitHub offers this form only when the maintainers have turned it on. If the **Report a
vulnerability** button is missing, open a public issue that asks the maintainers for a private
channel and says nothing about the problem itself.

Do not open a public issue, pull request or discussion that describes a vulnerability.

## What to include

- What an attacker can do, and from which position (for example: an agent, a member with a
  given role, someone with database access).
- The affected component and file, and the commit you tested.
- Steps to reproduce. A failing test is the most useful form.
- Whether any real funds or real deployments were involved.

Test only against your own deployment and your own test wallets.

## What the design protects

The signer is the only component that holds wallet keys, and it decides on its own whether to
sign. It signs only an operation that people approved with passkeys on the confirmation page, or
that a live mandate it holds covers, and only inside the wallet's policy. A compromised agent, a
compromised control plane, or someone who can write to the control plane's database cannot make
it sign anything else. Content people and agents type is stored encrypted.

## What it does not protect

- Whoever controls the signer's host controls every wallet on it.
- A compromised confirmation service, or the proxy or certificate in front of it, can show a
  person one operation and collect an approval for another. Payment limits bound the damage;
  for a change of limits or approvers they do not.
- A live mandate is spent with no person asked, up to its caps.
- A venue order can lose more than its notional cap.
- The software has not been audited.

[`docs/threat-model.md`](docs/threat-model.md#limits) lists every known limit.

## What an operator must do

- Run the signer and its confirmation page on a host of their own, administered by other people
  than the control plane, when the stakes justify it
  ([`deploy/README.md`](deploy/README.md#running-the-signer-on-its-own-host)).
- Give each workspace at least two approvers and an admin threshold of 2, and compare a new
  approver's key fingerprint with that person over a call or in person.
- Grant mandates with short lives and tight caps.
- Protect and test backups, fence a restored signer before it starts, and rotate the keyring after
  a workspace is deleted ([`deploy/README.md`](deploy/README.md)).
- Use test funds until you have reviewed the code and the threat model yourself.

## In scope

- The signer: anything that makes it sign without a valid passkey authorization, sign twice for
  one approval, sign outside the wallet's policy, or sign anything other than the transaction an
  intent describes.
- The approval protocol: digests, envelopes, the authorization verifier, the request signature
  ([`docs/approval-protocol.md`](docs/approval-protocol.md)).
- The confirmation page and the `approve` service that serves it: anything that lets an approval
  made anywhere but the confirmation page's origin count, lets a page frame or script it, makes
  it show something other than what the signer holds, or lets its secret reach a signer route
  other than the confirmation routes.
- The possession step of an approver change: anything that lets the signer apply an
  `add-approver` request before someone answered its challenge with the key the request carries.
- The control plane: authentication, workspace isolation, the MCP gateway, and exposure of the
  Workflow delivery routes.
- Encryption at rest: any content stored readable that
  [`docs/threat-model.md`](docs/threat-model.md#what-is-encrypted-at-rest) says is sealed.
- The deployment files in this repository.

## Known limits

Some weaknesses are known and documented, such as a compromised confirmation service bringing
back the display gap, a swapped new approver key that only the fingerprint comparison catches
(the possession step proves that someone holds the key, not who), and the fact that the signer
host holds the wallets. They are listed in
[`docs/threat-model.md`](docs/threat-model.md#limits). A report that shows one of them is worse
than documented is in scope.
