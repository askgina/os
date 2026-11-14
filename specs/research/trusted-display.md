<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

# Research: a trusted display for passkey approvals

Ticket: [askgina/os#20 How can the person be sure the approval they sign is the operation they were shown?](https://github.com/askgina/os/issues/20)

Map: [askgina/os#18 After v0.1: wider approvals, more venues, more machines](https://github.com/askgina/os/issues/18)

Date: 2026-11-14. Written by a research agent. The plan that follows from it is
[`specs/trusted-display.md`](../trusted-display.md).

**How to read this report.** Nothing here was observed at runtime. No build, test, browser or
device was run. Every claim is tagged as source-read, with a repository path and line or a URL,
or as `[INFERENCE]`. Repository paths are relative to the repository root at commit `61dd59c`.
`SimpleWebAuthn` line numbers refer to the installed `@simplewebauthn/server` 14.1.0 package,
file `esm/authentication/verifyAuthenticationResponse.js`.

## Question

> A passkey proves that a person approved a digest, not that they saw the right details. A
> compromised control plane can show one operation and submit another, bounded only by signer
> limits. Which mechanisms close that gap for a self-hosted product (a confirmation page served
> by the signer on its own origin, W3C Secure Payment Confirmation, a hardware wallet co-signing,
> a second device or out-of-band code, WebAuthn extensions), what does each cost, and what do
> browsers support today?

## Answer

- The gap is wider than the question states. A misled passkey tap can authorize an
  `add-approver` or `set-policy` envelope, not only a payment. Every workspace starts with an
  admin threshold of 1, so one tap can enroll a key the attacker holds, and the signer's caps
  then bound nothing. Every passkey prompt on the control-plane origin, sign-in included, is such
  a tap.
- The browser writes the calling page's origin into `clientDataJSON`, and the authenticator signs
  over it. Script cannot change it. So the signer can require that every approval assertion was
  made on a page the control plane does not serve, and that page can show the operation from the
  same data that is hashed. This closes the gap against a compromised control plane and against
  XSS on its origin, in every browser that has WebAuthn, for every envelope kind, without
  re-enrolling passkeys when the page shares the RP ID.
- Secure Payment Confirmation (SPC) puts amount and payee in browser-drawn UI and signs them, but
  it ships only in Chromium on Windows, macOS and Android, has no WebKit or Gecko commitment,
  cannot express contract calls, policy changes or approver changes, and needs re-enrolled
  credentials.
- No WebAuthn transaction-display extension exists in any browser. `txAuthSimple` and
  `txAuthGeneric` were removed after Level 1, a 2024 revival was closed in 2025, and Level 3
  (a Recommendation since 25 August 2026) has none.
- Hardware wallets (EIP-712 on the device screen) are a real trusted display, but they need a
  second approver credential type in the protocol, WebHID (Chromium desktop only) or a wallet
  bridge, and on Ledger a self-hosted message type gets blind-signing friction.
- Recommendation: a confirmation page on its own origin, served by a keyless service in the
  signer's trust domain, sharing the existing RP ID. Details under "Recommendation".

## Findings

### F1. What v0.1 binds today

1. The WebAuthn challenge is `digest("askgina.os/v1/authorize", envelope)`, 32 bytes, so an
   assertion is bound to one envelope (source: `docs/approval-protocol.md:158-160`,
   `packages/protocol/src/envelopes.ts:107`).
2. The signer recomputes the challenge from the envelope and ignores anything the caller says
   about it (source: `packages/protocol/src/webauthn/verify-authorization.ts:72`). It checks the
   origin against a configured list, the RP ID, the stored public key, and requires user
   verification (source: `verify-authorization.ts:89-103`). The sign counter is fixed at 0
   (source: `verify-authorization.ts:98-100`); single use comes from the envelope nonce.
3. The signer's origin list is the control plane's own public origin. Compose sets
   `WEBAUTHN_ORIGINS: ${PUBLIC_ORIGIN:-http://localhost:8080}` on the signer and the same
   `PUBLIC_ORIGIN` on the server (source: `compose.yaml:57-58`, `compose.yaml:83-84`); the TLS
   overlay sets both to `https://${OS_HOSTNAME}` (source: `compose.tls.yaml:17-23`). The server's
   relying party is `{ id: WEBAUTHN_RP_ID or the public host, origins: [PUBLIC_ORIGIN] }`
   (source: `apps/server/src/config.ts:96-106`).
4. The control plane chooses the challenge and runs the page that asks for the assertion.
   `startCeremony` builds the WebAuthn options with the envelope digest as challenge (source:
   `apps/server/src/execution/approvals.ts:404-416`). The page passes the options to
   `startAuthentication` unchanged (source: `apps/web/src/lib/passkey.ts:29-34`,
   `apps/web/src/routes/approval.tsx:415`).
5. The card, the envelope JSON and the digest a person sees are rendered by that same page
   (source: `apps/web/src/routes/approval.tsx:446-447`, `approval.tsx:605-609`). Showing the
   digest gives no assurance, because the page that shows it also chooses what is signed
   `[INFERENCE]`.
6. Authenticators and browsers show the RP ID and account name, never the transaction (source:
   the passkey research quoted in `docs/threat-model.md:203-211`).

So a verified approval binds: one envelope, one credential, the RP ID, the control plane's
origin, and user verification. It binds nothing about what was displayed.

### F2. Every passkey prompt on the control-plane origin is an approval opportunity

Sign-in uses the same RP ID, the same origin and an empty `allowCredentials` (source:
`apps/server/src/identity/ceremonies.ts:152-165`), and the same browser helper as approvals
(source: `apps/web/src/routes/auth.tsx:120`). Script on that origin can replace a sign-in
challenge with an envelope digest, and the browser shows the same prompt `[INFERENCE from F1.6]`.
XSS on the control-plane origin is therefore equivalent to code execution in the control plane
for approvals `[INFERENCE]`.

### F3. The signer's caps do not bound the loss: admin envelopes

1. `set-policy`, `add-approver`, `remove-approver`, `set-admin-threshold` and `resume-workspace`
   are verified at the workspace's `adminThreshold` (source: `docs/approval-protocol.md:279-281`,
   `apps/signer/src/signer.ts:357-397`).
2. Every workspace is created with `adminThreshold: 1` (source:
   `apps/server/src/directory/routes.ts:243`, `routes.ts:256`, default in
   `apps/server/src/db/schema.ts:124`).
3. The signer's approver registry has no roles; any approver's assertion counts (source:
   `apps/signer/src/signer.ts:147-153`).
4. `add-approver` inserts the public key carried in the envelope (source:
   `apps/signer/src/signer.ts:485-500`).

Consequence `[INFERENCE from 1-4, not exercised]`: a compromised control plane that gets one
assertion from any approver over an `add-approver` envelope enrolls a key it holds. That key alone
then meets the admin threshold for a `set-policy` that raises every cap and allows any recipient,
and meets the policy threshold (never above the admin threshold) for each later intent. One
misled tap gives lasting control of every wallet in the workspace. The statements that "the
signer's policy caps bound the loss" are true only for `approve-intent` envelopes (see
"Stale or wrong statements" below).

### F4. What the browser guarantees that the control plane cannot fake

1. The client builds `clientDataJSON` with `type`, `challenge` and `origin`, the authenticator
   signs `authenticatorData || SHA-256(clientDataJSON)`, and the relying party checks the origin
   (source: [WebAuthn Level 3, Recommendation of 25 August 2026](https://www.w3.org/TR/2026/REC-webauthn-3-20260825/),
   sections on `CollectedClientData` and "Verifying an Authentication Assertion").
2. Page script chooses the challenge but not the origin `[INFERENCE from 1]`.
3. Therefore: if the signer accepts approval assertions only when `origin` is a page the control
   plane cannot run code on, and that page renders the operation from exactly the data that is
   hashed, the control plane can no longer obtain an approval for something the person was not
   shown `[INFERENCE]`.

### F5. RP ID and origin consequences of a separate confirmation page

1. A caller may set the RP ID to its origin's effective domain or to a registrable domain suffix
   of it (source: [WebAuthn L3, "RP ID"](https://www.w3.org/TR/webauthn-3/#rp-id)). The suffix
   rule refuses a suffix that is itself a public suffix (source:
   [HTML, "is a registrable domain suffix of or is equal to"](https://html.spec.whatwg.org/multipage/browsers.html#is-a-registrable-domain-suffix-of-or-is-equal-to)).
2. Passkeys are registered with RP ID `WEBAUTHN_RP_ID`, which defaults to the public host
   (source: `apps/server/src/identity/ceremonies.ts:73-81`, `apps/server/src/config.ts:104`).
3. Layouts, and what each means for enrolled credentials:

   | Layout                                    | Example                                                       | Existing passkeys                         | Notes                                                                                                                                                                                                                                                                                                                                    |
   | ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Subdomain, shared RP ID                   | page `https://approve.os.example.com`, RP ID `os.example.com` | keep working                              | needs a DNS name and a certificate (source: F5.1)                                                                                                                                                                                                                                                                                        |
   | Same host, other port                     | page `https://os.example.com:8443` or `http://localhost:8081` | keep working                              | the RP ID ignores the port; the origin includes it, and SimpleWebAuthn compares origins as exact strings (source: `specs/research/passkey-assertion-bound-to-one-approval.md`, finding 5)                                                                                                                                                |
   | Other domain with Related Origin Requests | page `https://approve-os.example.net`                         | keep working where supported              | the list lives at `https://<RP ID>/.well-known/webauthn`, which the control plane serves; Chrome and Edge 128+, Safari on macOS 15+ and iOS 18+, Firefox 152+ (source: [passkeys.dev device support, updated 2026-09-21](https://passkeys.dev/device-support/); [passkeys.dev ROR](https://passkeys.dev/docs/advanced/related-origins/)) |
   | Separate RP ID                            | page and RP ID `approve.os.example.com`                       | must enroll a second passkey per approver | the control-plane origin then cannot even request such assertions, because its host is not under that RP ID (source: F5.1)                                                                                                                                                                                                               |

4. A subdomain of `localhost` probably cannot use RP ID `localhost`: under the public suffix
   list's default rule `localhost` is its own public suffix, which F5.1 refuses `[INFERENCE]`.
   Development should use another port on `localhost` instead. Plain `http://localhost:PORT` is a
   secure context for WebAuthn (source: passkey research, "RP ID and origin for self-hosters").
5. Tailscale certificates are issued per machine name under the tailnet name (source:
   [Tailscale, Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates));
   MagicDNS custom records are an open feature request (source:
   [tailscale/tailscale#1543](https://github.com/tailscale/tailscale/issues/1543)). A
   `*.ts.net` deployment, the example host in `deploy/README.md:20`, therefore needs the
   same-host-other-port layout `[INFERENCE]`.
6. With a shared RP ID the control-plane origin can still request assertions for the same
   credentials. Protection comes only from the signer's origin check, not from RP scoping
   `[INFERENCE from F5.1]`.
7. `approve.os.example.com` and `os.example.com` are same-site. The page must not use cookies
   (the control plane could set a parent-domain cookie), must refuse framing, and should send
   `Origin-Agent-Cluster: ?1` so `document.domain` cannot join it to the control plane's agent
   cluster `[INFERENCE]`.
8. Compose and Caddy today: Caddy serves one site and proxies only to the server (source:
   `deploy/Caddyfile:9-22`); the signer sits only on the internal `signing` network (source:
   `compose.yaml:62`, `compose.yaml:181-182`); the architecture says the signer is "reachable
   only from the server" (source: `docs/architecture.md:84`). A confirmation page needs a second
   Caddy site (and a second certificate in the TLS overlay), a network path from Caddy to
   whatever serves the page, and the signer's origin setting changed. Whatever terminates TLS
   for the page joins the set of things the person must trust for the display `[INFERENCE]`.

### F6. Two details of the installed verifier

1. SimpleWebAuthn 14.1.0 accepts `crossOrigin: true` when `topOrigin` is absent (source:
   `verifyAuthenticationResponse.js:76-81`, a comment there says Safari does not send
   `topOrigin`). An approval verifier should refuse `crossOrigin: true` outright `[INFERENCE]`.
   In v0.1 the control-plane pages refuse framing (source: `packages/api/src/csp.ts:22`,
   `deploy/Caddyfile:17`), so this is hardening, not a hole.
2. With no `expectedType`, the verifier accepts only `webauthn.get` (source:
   `verifyAuthenticationResponse.js:52-64`). SPC assertions have type `payment.get` (source:
   SPC spec, below), so v0.1 would refuse them.

### F7. Secure Payment Confirmation

1. Status: W3C Candidate Recommendation Draft of 13 October 2026 (source:
   [SPC](https://www.w3.org/TR/secure-payment-confirmation/)).
2. What it proves: the browser MUST show the payee name or origin, the total (currency and
   value) and the instrument, and the signed `clientDataJSON` carries
   `payment: { rpId, topOrigin, payeeName, payeeOrigin, total, instrument, ... }` (source: SPC
   sections 4.10.1 and 5.2). The relying party can check what the browser displayed.
3. Credentials: the `payment` extension with `isPayment: true` at creation "is currently
   required" (source: SPC section 2 note and section 3). v0.1 passkeys were created without it
   (source: `apps/server/src/identity/ceremonies.ts:73-81`), so every approver would re-enroll.
4. Amounts: `total` is a Payment Request `PaymentCurrencyAmount`; the currency must be a
   well-formed 3-letter code, enforced with `IsWellFormedCurrencyCode` (source:
   [Payment Request API, CRD 22 June 2026](https://www.w3.org/TR/payment-request/),
   `PaymentCurrencyAmount` and its note on digital currencies). `ETH` fits; `USDC` does not.
5. Coverage for this product: native coin and 3-letter-ticker transfers only. There is no field
   for a contract call, a policy diff, an approver key or a threshold `[INFERENCE from 2 and 4]`.
6. Chrome: enabled by default in Chrome 95 (source:
   [Chrome Platform Status 5702310124584960](https://chromestatuslite.com/feature/5702310124584960));
   Android from Chrome 109 (source:
   [Chrome blog, SPC on Android](https://developer.chrome.com/blog/spc-on-android)); "supported
   by Google Chrome on macOS, Windows, and Android. Other platforms, including iOS and ChromeOS,
   are not supported as of March 2025" (source:
   [Chrome docs](https://developer.chrome.com/docs/payments/secure-payment-confirmation)).
   Browser-bound keys shipped on Android in 139, and the 10 March 2026 intent to ship SPC
   capabilities says SPC is "currently only Android, macOS, and Windows" and "only in Chromium
   browsers for the foreseeable future" (source:
   [blink-dev, 10 June 2025](https://www.mail-archive.com/blink-dev@chromium.org/msg13884.html),
   [blink-dev, 10 March 2026](https://www.mail-archive.com/blink-dev@chromium.org/msg16054.html)).
   Linux is not listed `[INFERENCE: unsupported]`.
7. WebKit: position request open since 2022-07-07; an Apple engineer wrote the same day that
   Apple ports ship only the Apple Pay Payment Request method and "probably wouldn't ship this
   either" (source: [WebKit/standards-positions#30](https://github.com/WebKit/standards-positions/issues/30)).
8. Firefox: position request open since 2021-08-24 with no position (source:
   [mozilla/standards-positions#570](https://github.com/mozilla/standards-positions/issues/570));
   Payment Request is partial and disabled by default (source:
   [caniuse data, payment-request](https://github.com/Fyrd/caniuse/blob/main/features-json/payment-request.json)).
9. Against a compromised control plane: the control plane may call SPC itself, but the browser
   shows the true payee and amount, and the signer can compare them with the intent. This closes
   the gap for the covered transfers on the covered browsers `[INFERENCE]`.

### F8. WebAuthn transaction-display extensions

1. `txAuthSimple` and `txAuthGeneric` were in WebAuthn Level 1 and were removed from Level 2
   because they had no implementations (source:
   [w3c/webauthn#1386](https://github.com/w3c/webauthn/issues/1386), opened 2020-03-11, fixed by
   #1399). A working-group member wrote on 2021-07-14 that "WG representatives for the major
   browsers have stated that they have no plans to implement support" (same issue).
2. A 2024 revival, [w3c/webauthn#2020](https://github.com/w3c/webauthn/pull/2020), is closed.
   The note of 2025-04-02: "there is no current 'sponsor' for this work"; the use cases moved to
   Digital Payment Credentials over the Digital Credentials API and OpenID4VP (same PR).
3. Level 3 became a W3C Recommendation on 25 August 2026 (source:
   [W3C news](https://www.w3.org/news/2026/web-authentication-an-api-for-accessing-public-key-credentials-level-3-is-now-a-w3c-recommendation/))
   and contains no `txAuth` extension (source: text search of the Recommendation, no match).
4. So no browser shows relying-party transaction text through WebAuthn today, and an
   authenticator with a screen cannot receive it from a browser `[INFERENCE from 1-3]`.

### F9. Hardware wallets as a co-signer

1. EIP-712 is Final (source:
   [EIP-712 source](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-712.md), header
   `status: Final`). ERC-7730 is a Draft; it is a JSON descriptor format that tells a wallet how
   to display calldata or an EIP-712 message, bound to contract deployments (source:
   [ERC-7730](https://eips.ethereum.org/EIPS/eip-7730)). Ledger moved its stewardship to the
   Ethereum Foundation on 12 May 2026 (source:
   [Ledger developer docs, Clear Signing overview](https://developers.ledger.com/docs/clear-signing/overview.md)).
2. Ledger: Ethereum app 1.10.0 (2022-10-26) computes EIP-712 signatures on the device and shows
   their content; 1.12.0 (2024-09-27) "Added blind-signing friction to EIP-712 v0 & unfiltered
   flows" (source: [app-ethereum CHANGELOG](https://github.com/LedgerHQ/app-ethereum/blob/develop/CHANGELOG.md)).
   The blind-signing setting is off by default and every blind operation is warned (source:
   [Ledger design guidelines, signing](https://developers.ledger.com/docs/device-app/integration/design-guidelines/transactions)).
   Clear signing with descriptors needs the descriptor in the registry and, for third-party
   wallets, an agreement with Ledger (source: Ledger Clear Signing overview). A message type
   unique to one self-hosted installation would be "unfiltered" on Ledger `[INFERENCE]`.
3. Trezor Model T: EIP-712 signing with field display since firmware 2.4.3, 8 December 2021
   (source: [trezor-firmware core/CHANGELOG.T2T1.md](https://github.com/trezor/trezor-firmware/blob/main/core/CHANGELOG.T2T1.md),
   entry for #1835).
4. Browser transport: WebHID ships in Chrome and Edge 89+ on desktop only; not in Firefox,
   Safari, iOS or Chrome for Android (source:
   [caniuse data, webhid](https://github.com/Fyrd/caniuse/blob/main/features-json/webhid.json)).
   Other routes go through a wallet app or extension `[INFERENCE]`.
5. Two shapes:
   - Approver credential: the signer builds an EIP-712 struct from the envelope and the intent,
     the device shows its fields, the signer recovers the address with viem (already a signer
     dependency, source: `apps/signer/package.json`). This needs a second approver kind in the
     protocol (`ApproverCredential` holds only a COSE key today, source:
     `docs/approval-protocol.md:176`) `[INFERENCE]`.
   - On-chain co-signer: a 2-of-2 smart account with the signer key and the device. This changes
     custody, gas and chain support, and is a different product `[INFERENCE]`.
6. The signature does not say whether the device showed the fields or signed blind
   `[INFERENCE: an ECDSA signature over an EIP-712 digest carries no display attestation]`.

### F10. Second device and out-of-band codes

1. Opening the confirmation page on a phone (link or QR code) adds isolation from the desktop
   browser and its extensions; cross-device passkey use is broadly supported (source:
   [passkeys.dev device support](https://passkeys.dev/device-support/)).
2. A notification that comes from the signer itself would need the signer to reach the internet;
   it has "no outbound route" today (source: `docs/architecture.md:84`, `architecture.md:159-160`).
3. A short code is only useful if something the control plane does not control displays it
   `[INFERENCE]`. It does help for `add-approver`: the new person and the existing approvers can
   compare a fingerprint of the new key, each shown by the confirmation page `[INFERENCE]`.

## Options compared

"Closes" means a compromised control plane can no longer obtain an approval for an operation the
person was not shown. All rows are `[INFERENCE]` from the findings cited.

| Option                                                        | Compromised control plane        | XSS on control-plane origin | Envelope kinds covered                            | Browsers and devices today                                 | Cost                                                                                                                            | Residual risk                                                                                                               |
| ------------------------------------------------------------- | -------------------------------- | --------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A. Confirmation page on its own origin, shared RP ID (F4, F5) | closes                           | closes                      | all six                                           | every browser with WebAuthn                                | a small page and service, a second Caddy site and name or port, signer origin rule, control-plane flow change; no re-enrollment | whoever serves or terminates TLS for that origin; XSS on that page; a compromised browser or OS; a person who does not read |
| B. SPC (F7)                                                   | closes for covered transfers     | same                        | `approve-intent` transfers with a 3-letter ticker | Chromium on Windows, macOS, Android                        | re-enroll every approver with the `payment` extension; still need A for everything else                                         | other browsers fall back to the gap; payee text is free-form                                                                |
| C. WebAuthn display extension (F8)                            | n/a                              | n/a                         | none                                              | none                                                       | none possible                                                                                                                   | the whole gap                                                                                                               |
| D. Hardware approver over EIP-712 (F9)                        | closes for what the device shows | closes                      | any kind with a defined struct                    | device plus WebHID on Chromium desktop, or a wallet bridge | protocol change for approver kinds, hardware, enrollment; Ledger blind-signing friction                                         | device firmware; no proof the device clear-signed; long policy diffs on small screens                                       |
| E. Second device (F10)                                        | only with A                      | only with A                 | as A                                              | as A                                                       | QR code or link                                                                                                                 | as A, minus desktop extensions                                                                                              |
| F. Keep v0.1 and document                                     | no                               | no                          | none                                              | all                                                        | none                                                                                                                            | F3: one tap can give lasting control                                                                                        |

## Recommendation

This is a recommendation, not a decision.

1. Adopt option A. Serve a confirmation page from its own origin under the existing RP ID:
   `https://approve.<host>` where the operator controls DNS, or the same host on another port
   (`https://<host>:8443`, `http://localhost:8081` in development) where it does not, such as
   `*.ts.net`.
2. Serve that page from a small keyless service in the signer's trust domain, not from the
   signer process. The signer keeps its "reachable only from internal services" boundary; the
   service holds no key and a request secret that unlocks only display routes. A compromise of
   that service brings back the v0.1 display gap but cannot sign.
3. Make the signer accept approval assertions only with `origin` equal to that page's origin, for
   every envelope kind, and refuse `crossOrigin: true`. The signer builds the view from the
   intent, policy and ledger it holds; the page computes nothing that matters.
4. For `add-approver`, show a fingerprint of the new key on the confirmation page, to both the
   new person (after they prove they hold it) and the approvers, and ask them to compare.
5. Offer the page on a phone through a QR code (option E). Revisit SPC (B) when a second engine
   ships it, and hardware approvers (D) as their own ticket.
6. Correct the v0.1 documents now: the caps bound only payments (F3). Recommend an admin
   threshold of 2 or more wherever a workspace has two approvers.

## Stale or wrong statements found in v0.1

- `docs/threat-model.md:213-214`: "The signer's policy caps bound the loss." True only for
  `approve-intent`; see F3.
- `README.md:116-117`: "The signer's limits bound the damage." Same.
- `specs/agent-workspaces-v0.1.md:251-252` and `:489`: same claim.
- `docs/threat-model.md:102-104`: "cannot ... change policy or approvers without passkey approval
  of the exact new value" is literally true, but the person need not have seen that value (F2,
  F3).
- `docs/approval-protocol.md:305`: "The fee ceiling `maxFeeWei` is part of the intent, so the
  approver saw it" assumes an honest page (F1.5).
- `docs/approval-protocol.md:178-209` does not state the `crossOrigin` behavior (F6.1).

## Limits

- No runtime observation: no browser, authenticator, hardware wallet or Compose stack was run.
  Browser behavior is taken from specifications, vendor documentation and tracker entries.
- Support data is as published on the dates given; Chromium may ship SPC to more platforms, and
  WebKit or Gecko positions may change.
- The F3 attack path was traced through code, not executed.
- The `localhost` subdomain (F5.4) and Tailscale subdomain (F5.5) conclusions are inferences.
- Ledger behavior for a custom EIP-712 type (F9.2) is inferred from the changelog and guidelines,
  not tested on a device.
- Nothing here covers a compromised user device, operating system or browser extension with
  access to the confirmation origin; option E reduces that only when the second device is clean.
