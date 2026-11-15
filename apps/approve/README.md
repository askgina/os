# @askgina/os-approve

The `approve` service serves the signer's confirmation page on its own origin, `APPROVE_ORIGIN`. It is the only place a person approves a request with a passkey. It holds no key.

A person opens a request in the control plane and follows its link here. The page shows its own origin and asks them to approve only when the address bar shows exactly that. It shows the request as the signer holds it: the view the signer renders from its own records, not anything the control plane sends. The passkey prompt runs on this page, so the browser writes `APPROVE_ORIGIN` into the assertion. The signer accepts an approval only when it was made at that origin, top-level (not in a frame), as a `webauthn.get`. The control plane then collects the approvals from the signer. The design and its reasons are in [`specs/trusted-display.md`](../../specs/trusted-display.md); the rule is section 6 of [`docs/approval-protocol.md`](../../docs/approval-protocol.md).

## Routes

Everything not listed here answers 404.

| Route                                        | What it does                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /a/:approvalId`                         | The page, `public/index.html`. The link's token is in the fragment, so it never reaches this service in a path.     |
| `GET /approve.js`, `/approve.css`            | The page's one script and one stylesheet, hand-written, with no dependencies.                                       |
| `GET /favicon.svg`                           | The page's icon.                                                                                                    |
| `GET /api/approvals/:approvalId`             | Relays the view to `GET /v1/confirm/:approvalId` on the signer, with the token from the `x-confirm-token` header.   |
| `POST /api/approvals/:approvalId/assertions` | Relays one passkey assertion (at most 16 KiB) to `POST /v1/confirm/:approvalId/assertions` on the signer.           |
| `GET /api/approvals/:approvalId/possession`  | Relays the possession challenge of an approver change from `GET /v1/confirm/:approvalId/possession` on the signer.  |
| `POST /api/approvals/:approvalId/possession` | Relays the person being added's answer (at most 16 KiB) to `POST /v1/confirm/:approvalId/possession` on the signer. |
| `GET /healthz`                               | Health check.                                                                                                       |

The service checks only the shape of what it relays. The signer decides everything: whether the token is right, what the view says, whether an assertion counts, and whether a possession answer proves the key.

## Adding an approver

On an approver change the page has one step before anyone can approve. It asks "Are you the person being added?" and shows a button, "This passkey is mine". The person being added presses it on the device that holds the new passkey. The browser asks only that passkey to sign the signer's challenge, top-level on this origin, as with approving. When the signer accepts the answer, the page shows the key's fingerprint and tells the person to read it to the people who approve over a call or in person, not through this site or a message it sent.

Until then the approve button stays disabled for the approvers, and the page tells them to wait and reload. On every approver change the page also tells them to ask the person being added for the fingerprint their page showed and to approve only if it matches the "Key fingerprint" line. The signer refuses an approval of an unproven change with `possession_unproven`, and applies the change only when the proof is recorded. The rules are in section 10 of [`docs/approval-protocol.md`](../../docs/approval-protocol.md).

## What it holds and what it can reach

- One secret, the signer's confirm-scope request secret (`APPROVE_SIGNER_SECRET_FILE`). The signer accepts it on its four confirmation routes and nowhere else, so this service cannot sign, apply a change, open a confirmation or list assertions.
- No wallet key, no keyring, no database. It sets no cookie and reads none; Caddy drops the `Cookie` header on the way here.
- In Compose, only Caddy reaches it (network `approve-edge`, internal), and it reaches only the signer (network `approve-signer`, internal). Its secret is a read-only copy in the `approve-secrets` volume, which `init` writes from the signer's whenever they differ.

Every response carries a strict Content-Security-Policy (`default-src 'none'`, the page's own script and style only, `frame-ancestors 'none'`, `require-trusted-types-for 'script'`, `trusted-types 'none'`), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Origin-Agent-Cluster: ?1` and `Referrer-Policy: no-referrer`; over HTTPS also `Strict-Transport-Security`. The page sets text with `textContent` only.

What a compromise of this service, or of Caddy, DNS or the certificate for `APPROVE_ORIGIN`, allows: showing people a false view and relaying their approvals over other operations, which is the display gap this page exists to close. It still cannot sign or read a key. See [`docs/threat-model.md`](../../docs/threat-model.md).

## Configuration

| Variable                     | Meaning                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`                       | Listener port (default 8788).                                                                              |
| `APPROVE_ORIGIN`             | The exact origin people open the page on, in canonical form, for example `https://approve.os.example.com`. |
| `SIGNER_URL`                 | The signer, for example `http://signer:8787`.                                                              |
| `APPROVE_SIGNER_SECRET_FILE` | Base64 file, at least 32 bytes: the confirm-scope secret shared with the signer.                           |

The same origin is the signer's `SIGNER_APPROVAL_ORIGIN` and the server's `APPROVE_ORIGIN`. Where it may live (a subdomain or another port of the RP ID host) is described in [`deploy/README.md`](../../deploy/README.md). The service refuses to start when a variable is missing, when `APPROVE_ORIGIN` is not a canonical http or https origin, or when the secret file is unreadable, not base64 or too short.

```sh
node src/main.ts
```

Logs are JSON lines with the route, the status and a code. They never carry a token or an assertion.
