<!-- Research evidence for a Wayfinder ticket. A record of what was found on the date below, not living documentation. -->

> **Ticket:** [How is a passkey assertion bound to one exact approval?](https://github.com/askgina/os/issues/4). **Date:** 2026-11-14.
>
> Written by a research agent; the maintainer re-ran its `./verify.sh` the same day and it passed. File names below (`verify.sh`, `*.test.ts` and so on) refer to a scratch directory outside this repository. The code that was kept is named in [the ExecPlan](../agent-workspaces-v0.1.md).
>
> `refs/<name>` in this report means a shallow clone of the upstream repository at a fixed commit: `refs/workflow` is [vercel/workflow@47ae6d1](https://github.com/vercel/workflow/tree/47ae6d137f346000c9197e654c75e709b93ca715) (release `workflow@5.5.0`), `refs/ows-core` is [open-wallet-standard/core@947f562](https://github.com/open-wallet-standard/core/tree/947f5627cb71299951cd3163b178f1c2b1e9c850) (v1.4.5), `refs/simplewebauthn` is [MasterKale/SimpleWebAuthn@01d1a64](https://github.com/MasterKale/SimpleWebAuthn/tree/01d1a640d5ded4fced0b45a9d806fd0ff44ad244) (v14.1.0), `refs/eve` is [vercel/eve@be1adda](https://github.com/vercel/eve/tree/be1addaaa5b7c2b75537b58767a27c3fdb595931), `refs/busy` is [MatiSolina/busy@3dd91e1](https://github.com/MatiSolina/busy/tree/3dd91e16c0708bd02066377ba3e45aa06f4813c0), `refs/mcp-typescript-sdk` is [modelcontextprotocol/typescript-sdk@919bb8e](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c). "The `workflow@5.5.0` docs" means the documentation shipped inside the `workflow@5.5.0` npm package.

# Spike: passkey — binding a WebAuthn assertion to one exact approval

## Question

Can the challenge of a WebAuthn assertion be `base64url(SHA-256(tag || canonical(grant)))` so that a separate signer service, holding only the credential public key, verifies the approval with `@simplewebauthn/server` 14.x, without the options the control plane issued? How do we test this without a human?

## Verdict

**Yes.** The signer can recompute the challenge from the grant and verify the assertion. No session state from the issuing server is needed. It needs exactly one piece of state of its own: an atomic store of used nonces. Replay protection MUST come from that store, not from signCount. Tests run without a human in two ways: a software authenticator (P-256, Node crypto) and real Chromium with a CDP virtual authenticator. `./verify.sh` covers both: 25/25 tests pass.

## Versions (exact)

@simplewebauthn/server 14.1.0 (source: refs/simplewebauthn v14.1.0 `01d1a64`), @simplewebauthn/browser 14.0.0 (pinned for type parity; the page uses native `toJSON()`), canonicalize 5.1.0, playwright 1.65.1 (chromium-headless-shell build 1255, installed into `./.browsers`), vitest 5.1.0, typescript 7.0.2, @types/node 26.6.6, Node 26.2.0, bun 1.4.4. Docker was not needed.

## Files

- `soft-authenticator.ts` (+ `cbor.ts`): a software authenticator. ES256 keys; registration with attestation `none`. Emits the JSON shape `@simplewebauthn/browser` returns: `id, rawId, type, clientExtensionResults, authenticatorAttachment, response{…}`. Tests control UP/UV/BE/BS, signCount (incrementing or pinned at 0), rpId hash, origin, aaguid and transports. It holds several credentials. `tamperClientData` edits a response after signing. Unit tests: `test/soft-authenticator.test.ts`.
- `grant.ts`: `ApprovalGrant` (string leaves only), `canonicalStrict` (hand-rolled), `canonicalJcs` (RFC 8785 via `canonicalize`), `grantChallenge`.
- `verifier.ts`: the signer-side `verifyApproval`. Input: `{credential {id, COSE publicKey, counter}, rpID, origin, grant, response, now, consumeNonce}`. It checks that both the grant approver's credentialId and `response.id` equal the stored id, checks expiry, then calls SimpleWebAuthn with `expectedChallenge = grantChallenge(grant)` and `requireUserVerification: true`. It applies an optional device-bound policy, then consumes the nonce, and only after the signature verified.
- `browser/server.ts` + `browser/index.html`: the RP on 127.0.0.1:55631 (page at `http://localhost:55631`). `test/browser.test.ts` drives it.

## Findings (evidence)

1. **Binding works and every requested negative fails** (`test/approval.test.ts`, output below):
   - one changed grant field (value, to, chain, nonce, expiresAt) → `Unexpected authentication response challenge`
   - wrong origin → `Unexpected response origin`
   - clientData edited after signing → signature failure
   - wrong rpID hash → RP ID error
   - UV unset → `User verification required`
   - Bob's assertion for Alice's grant → `credential does not match the grant approver`; relabelled with Alice's id → signature fails
   - replay → `grant nonce already used`
   - expired grant → rejected
2. **Real browser** (Chromium + `WebAuthn.addVirtualAuthenticator` ctap2/internal/resident key/UV):
   - registration is verified: `{"verified":true,"deviceType":"singleDevice","backedUp":false}`.
   - the assertion over the grant challenge is verified: `{"first":{"verified":true,"newCounter":2}`.
   - the same assertion replayed → `grant nonce already used`; the same assertion with a tampered grant `value` → challenge mismatch.
   - `http://os.example` (resolver-mapped to 127.0.0.1) has `isSecureContext=false` and `navigator.credentials` is undefined: `TypeError: Cannot read properties of undefined (reading 'create')`.
3. **Pitfall found:** `generateAuthenticationOptions({challenge})` treats a _string_ challenge as UTF-8 and base64url-encodes it again (refs/simplewebauthn/packages/server/src/authentication/generateAuthenticationOptions.ts:49-56). Pass the raw 32 digest bytes (`browser/server.ts`). Otherwise the browser signs `b64url(utf8(b64url(digest)))` and the signer's recomputed challenge never matches.
4. **`expectedChallenge` may be a function**: `string | ((challenge) => boolean | Promise<boolean>)` (verifyAuthenticationResponse.ts:45, 118-126), tested. A plain string recomputed from the grant is simpler and enough.
5. **`expectedOrigin` and `expectedRPID` may be lists** (verifyAuthenticationResponse.ts:46-47; matchExpectedOrigin.ts uses exact string `includes`). Tested with `[https://wallet.example.org, http://localhost:55630]`.

## Answers

**RP ID and origin for self-hosters.**

- The RP ID is a registrable domain or host without scheme or port. The authenticator puts `SHA-256(rpId)` in authData, and SimpleWebAuthn compares that hash (verifyAuthenticationResponse.ts:212-222).
- `localhost` is a valid RP ID, any port works, and plain `http://localhost:PORT` is a secure context (proved in the browser test).
- IP addresses (127.0.0.1) are not valid RP IDs [INFERENCE from the WebAuthn spec "valid domain" rule; not tested].
- Plain http on any other hostname has no WebAuthn at all (proved). Self-hosters need TLS on a real or LAN domain.
- The origin is compared as an exact string. It includes the scheme and any non-default port, and SimpleWebAuthn rejects a trailing `/` and non-punycode only for `https://` origins (assertValidExpectedOrigin.ts:11).
- **Changing the hostname breaks every existing passkey.** A credential is scoped to its RP ID, so a move from `os.lan` to `os.example.com` needs re-enrolment (the wrong-rpID test shows the verifier rejects it).
- A subdomain (`app.example.com`) may use the parent RP ID `example.com`. Config should therefore pin `rpID` and the list of allowed origins explicitly; never derive them from the Host header.

**Counters.** Synced passkeys commonly report signCount 0. SimpleWebAuthn checks the counter only when `counter > 0 || credential.counter > 0`, and then requires the new counter to be strictly greater than the stored one (verifyAuthenticationResponse.ts:267-276).

- With 0/0 the identical assertion verifies again (test: "SimpleWebAuthn alone accepts the identical assertion again").
- With a non-zero counter, replay is caught only if the stored counter was advanced after use.
- Therefore replay protection = a single-use `nonce` (plus `approvalId`) inside the hashed grant, consumed atomically by the signer (e.g. a `UNIQUE` insert). Store `newCounter` only as a clone-detection signal.

**What to store per credential.**

- Store: `id` (base64url), `publicKey` (COSE bytes), `counter`, `transports`, `deviceType` (`singleDevice|multiDevice`), `backedUp`, `aaguid`, `userId`, `createdAt`, and the `rpID` it was registered under.
- The verifier needs only `id`, `publicKey`, `counter` (`WebAuthnCredential`, types/index.ts:186-193), plus the deployment's `rpID` and origin list. A policy-enforcing signer also needs `deviceType`/`backedUp` from registration or from each assertion's flags.
- `transports` and `aaguid` are UX and attestation metadata only. With attestation `none`, `aaguid` is unverified, and Chromium's virtual authenticator reports zeros.

**BE/BS flags.** `BE` (0x08) = the credential may be synced (`credentialDeviceType: 'multiDevice'`). `BS` (0x10) = it is currently backed up. BS without BE throws (parseBackupFlags.ts; tested). A policy demanding device-bound credentials requires `credentialDeviceType === 'singleDevice'` on **every assertion**, not only at registration. Implemented as `requireDeviceBound` and tested both ways. Flags are authenticator-asserted: without verified attestation, a software authenticator can lie [INFERENCE].

**Separate process and host.** Safe, and demonstrated: `verifier.ts` receives no options, session or challenge from the issuer and recomputes the challenge. The signer's own required state is the used-nonce store, plus a trusted copy of the credential public key and its binding to the approver (the signer must not accept a public key supplied by the control plane at approval time). Its clock decides `expiresAt`. The nonce must be consumed before signing, in the same transaction as the sign decision.

**What a passkey assertion does NOT prove** (quotable):

> A verified assertion proves only that an authenticator holding the private key for credential C, scoped to RP ID R, produced a signature over a challenge equal to H(grant) while running in a client that reported origin O, with the user-presence and (if UV) user-verification flags set by that authenticator. It does not prove that the user saw, read or understood the grant's contents, that the page rendered the grant faithfully, or that the client code at origin O was uncompromised. The challenge is an opaque hash: authenticators and browsers display only the RP ID and account name, never the transaction. Any script running at origin O (XSS, malicious extension, compromised control-plane build) can obtain a valid approval for a different grant from a user who believes they are approving the one shown. Without attestation, it also does not prove what kind of authenticator was used, nor that BE/BS flags or signCount are truthful.

Showing transaction details trustworthily requires a display outside origin O. Secure Payment Confirmation exists for payments [not evaluated here].

## Canonical encoding — recommendation

Use **RFC 8785 JCS semantics over a grant schema whose leaves are only strings, booleans or null**. Implement it with the dependency-free `canonicalStrict`, which rejects numbers, BigInt, undefined and non-plain objects. On its accepted domain, its output is byte-identical to `canonicalize` (tested, including UTF-16 code-unit key ordering with `é`, `😀`, `ﬁ`, and escaping of `\u2028` and control characters). The signer and other-language verifiers can use any JCS library.

- Number pitfalls (tested): `9007199254740993` → `9007199254740992`; `1e21` → `1e+21`; `-0` → `0`; `0.1+0.2` → `0.30000000000000004`; BigInt throws in both `JSON.stringify` and `canonicalize`.
- Amounts therefore travel as base-10 integer strings in base units (wei). The schema validator (not shown) must also fix their format (`^(0|[1-9][0-9]*)$`) so that `"01"` and `"1"` cannot both appear.

**Test vector** (`test/canonical.test.ts`, independently recomputed with openssl in verify.sh):

- tag = `askgina-os/approval-grant/v1\0` (29 bytes incl. NUL)
- canonical = `{"approvalId":"apr_01","approver":{"credentialId":"Y3JlZA","userId":"usr_alice"},"chain":"eip155:8453","expiresAt":"2026-11-14T12:05:00Z","intent":{"data":"0x","to":"0x2222222222222222222222222222222222222222","value":"1000000000000000000"},"intentHash":"0xabab…ab"(32 bytes),"nonce":"n_7f3a9c","v":"1","wallet":{"address":"0x1111111111111111111111111111111111111111","walletId":"wal_agent1"},"workspaceId":"ws_1"}`
- challenge = `QyP1xa60OW3zBc5wILoLJyIxNLuDUbrC2VHebgS3yj0`

## Design decisions forced

1. The grant includes `approver.credentialId`, `nonce`, `approvalId`, `expiresAt`, `chain`, the full intent and `intentHash`. The signer recomputes the challenge and must never accept a challenge string from the control plane.
2. The signer owns an atomic used-nonce table. signCount is advisory only.
3. Generate options with `challenge` as raw bytes.
4. `rpID` and the origin list are explicit deployment config. Document that a hostname change requires re-enrolment and that non-localhost deployments need HTTPS.
5. Device-bound policy is checked per assertion through BE.
6. Threat model: the passkey proves key possession and UV, not informed consent (quote above).

## Builds and test runs performed (all inside this spike directory, no Docker, no coverage)

| what                                                                                                      | wall time       |
| --------------------------------------------------------------------------------------------------------- | --------------- |
| `bun add` (runtime deps, then dev deps)                                                                   | 0.34 s + 0.64 s |
| `bunx playwright install chromium-headless-shell` into `./.browsers`                                      | 11.8 s          |
| `vitest run -u` canonical/soft-authenticator/approval suites (twice, to write the inline snapshot vector) | 1.5 s, 0.4 s    |
| `vitest run test/browser.test.ts` (twice, the second time with verbose logs)                              | 9.5 s, 2.0 s    |
| `./verify.sh`, first run (stopped at `tsc` type errors, which were fixed)                                 | 1.9 s           |
| `./verify.sh`, final full run (install, browser check, `tsc`, openssl vector, all suites)                 | 8.9 s           |

## How to rerun

`./verify.sh`. It deletes `node_modules`, then runs, in order: `bun install --frozen-lockfile`, Chromium install into `.browsers`, `tsc`, the openssl vector check, and all vitest suites. It then checks that no port 55630-55639 is left listening. Exit is non-zero on any failure.

## Not checked

- Real hardware or platform authenticators, iCloud/Google synced passkeys (synced behaviour is emulated with BE/BS and counter 0).
- Firefox and Safari.
- Attestation formats other than `none`.
- Cross-origin iframes / `topOrigin`.
- An IP-address RP ID.
- Related Origin Requests (`/.well-known/webauthn`).
- SPC.
- Conditional UI.
- A production grant schema validator.
- Concurrency of a real nonce store (the in-memory set models it).

## verify.sh tail

```
 ✓ test/approval.test.ts > approval bound to a grant > rejects a replayed assertion via the nonce, even when signCount is 0 (synced passkey) 5ms
 ✓ test/approval.test.ts > approval bound to a grant > counter > 0 replay is caught by SimpleWebAuthn only if the stored counter was advanced 2ms
 ✓ test/approval.test.ts > approval bound to a grant > device-bound policy reads BE: rejects synced, accepts device-bound 5ms
 ✓ test/approval.test.ts > approval bound to a grant > expectedOrigin may be a list; expectedChallenge may be a function 3ms
BROWSER registration {"verified":true,"deviceType":"singleDevice","backedUp":false}
BROWSER approve {"first":{"verified":true,"newCounter":2},"replay":{"error":"grant nonce already used"},"tampered":{"error":"Unexpected authentication response challenge \"J1Wt88…\", expected \"J1O1-mo8…\""},…}
BROWSER virtual credential signCount 2 rpId localhost
 ✓ test/browser.test.ts > … registers, then approves a grant-bound challenge; server verifies, rejects replay and tampering 333ms
BROWSER http://os.example secure= false register -> TypeError: Cannot read properties of undefined (reading 'create')
 ✓ test/browser.test.ts > … plain http on a non-localhost hostname is not a secure context: no WebAuthn 510ms
 Test Files  4 passed (4)
      Tests  25 passed (25)
VERIFY OK
```
