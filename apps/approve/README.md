# @askgina/os-approve

The `approve` service serves the signer's confirmation page on its own origin, `APPROVE_ORIGIN`. It is the only place a person approves a request with a passkey. It holds no key and no database: it serves one static page and relays that page's requests to the signer ([`apps/signer`](../signer/README.md)). It runs next to the signer, on the same machine as the rest of the stack or on the signer's own host.

A person opens a request in the control plane and follows its link here. The page shows its own origin and asks them to approve only when the address bar shows exactly that. It shows the request as the signer holds it: the view the signer renders from its own records, not anything the control plane sends. The passkey prompt runs on this page, so the browser writes `APPROVE_ORIGIN` into the assertion. The signer accepts an approval only when it was made at that origin, top-level (not in a frame), as a `webauthn.get`. The control plane then collects the approvals from the signer. The design and its reasons are in [`specs/trusted-display.md`](../../specs/trusted-display.md); the rule is section 6 of [`docs/approval-protocol.md`](../../docs/approval-protocol.md).

**Status.** Proven in CI: the routes, headers, relaying and the page's own logic in `test/app.test.ts`, and the configuration checks in `test/config.test.ts` (job `test`); approvals made on this page in a real browser with a virtual authenticator, against the whole stack, in `stack (amd64)`, `stack (arm64)` and, over HTTPS, `stack (tls)` (`e2e/test/browser.spec.ts`); the service relaying to a signer on its own host over mutual TLS in `stack (split)` (`e2e/test/split.spec.ts`, then `e2e/test/release-gates.spec.ts`).

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

The service checks only the shape of what it relays: an approval id and a token of the right form (`not_found` otherwise), and one assertion in a body of at most 16 KiB (`invalid_request`, with 413 for a body too large and 400 for anything else). It passes the signer's answer on unchanged, status and code included, and answers 502 with `internal` when the signer cannot be reached. The signer decides everything: whether the token is right, what the view says, whether an assertion counts, and whether a possession answer proves the key.

## Adding an approver

On an approver change the page has one step before anyone can approve. It asks "Are you the person being added?" and shows a button, "This passkey is mine". The person being added presses it on the device that holds the new passkey. The browser asks only that passkey to sign the signer's challenge, top-level on this origin, as with approving. When the signer accepts the answer, the page shows the key's fingerprint and tells the person to read it to the people who approve over a call or in person, not through this site or a message it sent.

Until then the approve button stays disabled for the approvers, and the page tells them to wait and reload. On every approver change the page also tells them to ask the person being added for the fingerprint their page showed and to approve only if it matches the "Key fingerprint" line. The signer refuses an approval of an unproven change with `possession_unproven`, and applies the change only when the proof is recorded. The rules are in section 10 of [`docs/approval-protocol.md`](../../docs/approval-protocol.md).

## What it holds and what it can reach

- One secret, the signer's confirm-scope request secret (`APPROVE_SIGNER_SECRET_FILE`). The signer accepts it on its four confirmation routes and nowhere else, so this service cannot sign, apply a change, open a confirmation or list assertions.
- No wallet key, no keyring, no database. It sets no cookie and reads none; Caddy drops the `Cookie` header on the way here.
- In Compose, only Caddy reaches it (network `approve-edge`, internal), and it reaches only the signer (network `approve-signer`, internal). Its secret is a read-only copy in the `approve-secrets` volume, which `init` writes from the signer's whenever they differ.

Every response carries a strict Content-Security-Policy (`default-src 'none'`; script, style, images and requests from this origin only; `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `require-trusted-types-for 'script'`, `trusted-types 'none'`), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Origin-Agent-Cluster: ?1`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a `Permissions-Policy` that allows passkey assertions on this origin and passkey creation nowhere, and `Cache-Control: no-store`; over HTTPS also `Strict-Transport-Security`. The policy and headers are `CONFIRMATION_PAGE_POLICY` and `SECURITY_HEADERS` in `src/app.ts`. The page sets text with `textContent` only.

What a compromise of this service, or of Caddy, DNS or the certificate for `APPROVE_ORIGIN`, allows: showing people a false view and relaying their approvals over other operations, which is the display gap this page exists to close. It still cannot sign or read a key. See [`docs/threat-model.md`](../../docs/threat-model.md).

## Configuration

| Variable                     | Meaning                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`                       | Listener port (default 8788).                                                                              |
| `APPROVE_ORIGIN`             | The exact origin people open the page on, in canonical form, for example `https://approve.os.example.com`. |
| `SIGNER_URL`                 | The signer, for example `http://signer:8787`.                                                              |
| `APPROVE_SIGNER_SECRET_FILE` | Base64 file, at least 32 bytes: the confirm-scope secret shared with the signer.                           |
| `APPROVE_TLS_CERT_FILE`      | Mutual TLS to a signer on its own host: this service's certificate, PEM.                                   |
| `APPROVE_TLS_KEY_FILE`       | The key of `APPROVE_TLS_CERT_FILE`.                                                                        |
| `APPROVE_TLS_PEER_CERT_FILE` | The one certificate it accepts from the signer.                                                            |

The same origin is the signer's `SIGNER_APPROVAL_ORIGIN` and the server's `APPROVE_ORIGIN`. Where it may live (a subdomain or another port of the RP ID host) is described in [`deploy/README.md`](../../deploy/README.md). `SIGNER_URL` is `http:` on one machine and `https:` when the signer runs on its own host; an `https:` address needs all three `APPROVE_TLS_*` files, an `http:` one takes none, and the signer must present the certificate issued for the host name in `SIGNER_URL` (`deploy/split/make-peer-certs.sh` makes them). The service refuses to start, logging `config_invalid` with the variable's name, when a variable is missing, when `APPROVE_ORIGIN` is not a canonical http or https origin, when the secret file is unreadable, not base64 or too short, or when the TLS files do not match `SIGNER_URL`.

```sh
node src/main.ts
```

Logs are JSON lines with the route, the status and a code. They never carry a token or an assertion.

## Checking a change

From the repository root, after `bun install`: `bun run check` (Biome), `bun run lint:slop` (Oxlint with the repository's anti-slop rules), and the type-check `cd apps/approve && ../../node_modules/.bin/tsc --noEmit`. Then run the test file you changed, from the repository root: `node_modules/.bin/vitest run apps/approve/test/app.test.ts` (routes, headers, relaying and the page's logic) or `apps/approve/test/config.test.ts`. Neither needs a running service.

CI runs both files in job `test`, the type-check in job `check`, and the page against the whole stack in the `stack` jobs named under "Status".
