# Security policy

This project holds keys that move money. Please report security problems privately.

## How to report

Use GitHub's private vulnerability reporting on this repository:
open the **Security** tab of [askgina/os](https://github.com/askgina/os), choose
**Report a vulnerability**, and fill in the form. The report is visible only to you and the
maintainers.

Please do not open a public issue, pull request or discussion for a vulnerability.

## What to include

- What an attacker can do, and from which position (for example: an agent, a member with a
  given role, someone with database access).
- The affected component and file, and the commit you tested.
- Steps to reproduce. A failing test is the most useful form.
- Whether any real funds or real deployments were involved.

Please test only against your own deployment and your own test wallets.

## In scope

- The signer: anything that makes it sign without a valid passkey authorization, sign twice for
  one approval, sign outside the wallet's policy, or sign anything other than the transaction an
  intent describes.
- The approval protocol: digests, envelopes, the authorization verifier, the request signature
  ([`docs/approval-protocol.md`](docs/approval-protocol.md)).
- The control plane: authentication, workspace isolation, the MCP gateway, and exposure of the
  Workflow delivery routes.
- Encryption at rest: any content stored readable that
  [`docs/threat-model.md`](docs/threat-model.md#what-is-encrypted-at-rest) says is sealed.
- The deployment files in this repository.

## Known limits

Some weaknesses are known and documented, such as the passkey "trusted display" gap and the fact
that the signer host holds the wallets. They are listed in
[`docs/threat-model.md`](docs/threat-model.md#limits). A report that shows one of them is worse
than documented is in scope.
