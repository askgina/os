# Tell approvers about a waiting approval outside the inbox

- Branch: main
- Status: In Progress
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-15
- Links: [Issue #24](https://github.com/askgina/os/issues/24) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](research/approval-notifications.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

In v0.1 a person learns that an agent proposed a payment only by opening the approval inbox, or by an operator-built bridge from a webhook that is sent once and lost if it fails. Agents act at any hour, and approvals expire (60 seconds to 24 hours for intents, `packages/protocol/src/policy.ts:78`). An approval nobody sees in time is a payment that does not happen.

After this change:

- An approver who installs the web app on a phone (Home Screen on iOS 16.4 or later, any Chromium or Firefox browser elsewhere) and turns on notifications gets a push notification when an approval waits for them, and one reminder before it expires. Tapping it opens the approval page. Approving still needs the passkey, on the page, exactly as today.
- The operator's webhook becomes reliable: every approval produces exactly one delivery record, retried with backoff until it succeeds, the approval stops being pending, or attempts run out. Each request is signed and carries a delivery id for dedupe.
- An example sidecar forwards the webhook to an ntfy server, so a self-hosted ntfy (or anything else) can carry notifications without the control plane holding any third-party credential.
- No notification on any channel contains sealed content. The default text is a count. A workspace owner may allow the request kind, workspace name and requester name. Amount, recipient, calldata, memo, policy contents and simulation output never leave the approval page.

Non-goals: email; built-in Telegram, Slack or Discord adapters (sidecars may be written later against the same webhook); approving from a notification; notifications for decided, failed or reconciled operations; any change to the signer or the approval protocol; native mobile apps.

Success means:

- `apps/server/test/notify/*.test.ts` prove: one delivery row per approval and target written in the same transaction as the approval; retry and drop rules; a signed webhook body that contains none of the sealed marker strings of the intent; RFC 8291 Appendix A ciphertext reproduced byte for byte; VAPID tokens that verify and expire within 24 hours; quiet hours and reminder timing under a fake clock.
- A new release gate in `e2e/test/release-gates.spec.ts` shows that a webhook receiver which returns 503 first still receives exactly one acknowledged delivery for a proposal, with a valid signature and no sealed content, against the real Compose stack in CI.
- A new browser gate in `e2e/test/browser.spec.ts` shows that `/sw.js` registers and `/manifest.webmanifest` loads under the production Content-Security-Policy, unchanged.
- A real phone receiving a real push is out of automated scope; it is a manual staging check like the v0.1 phone passkey test.

## Progress

- [x] (2026-11-14 00:00Z) Research current behavior and relevant code paths ([report](research/approval-notifications.md)).
- [x] (2026-11-14 00:00Z) Define the implementation approach and validation plan (this draft).
- [x] (2026-11-15) Owner decisions D1 to D7 in `Decision Log`: Eric chose the recommended option of each.
- [x] (2026-11-15) Milestones 1 and 2 are commit `371c2ce`, CI run 43705883757 green (check, test, ui, stack amd64/arm64/tls). Milestone 1: notification outbox and signed webhook (`apps/server/src/notify/`, migration `0005_notifications`). The webhook also reports `mandate.used`. First start creates `notify-webhook-secret`; Compose passes it.
- [x] (2026-11-15) Milestone 2: Web Push sender (RFC 8291, RFC 8292), reproducing the RFC 8291 Appendix A body byte for byte. First start creates `vapid-key.pem`.
- [x] (2026-11-15) Milestone 3: subscriptions, preferences, content levels, API (commit `e8ae6ff`, migration `0006_push_subscriptions`, seven routes). CI run 43707841094: test, ui and stack amd64/arm64/tls green; `check` red on one unformatted Markdown table, fixed in the next commit. All six jobs green at `3bf1a7b`, CI run 43709103267.
- [ ] Milestone 4: web app manifest, service worker, return path after sign-in.
- [x] (2026-11-15) Milestone 5: expiry reminders and quiet hours (same commit and run as Milestone 3). The webhook is not held by quiet hours.
- [x] (2026-11-15) Milestone 6: ntfy sidecar example (`examples/ntfy-sidecar`, its own Compose overlay), docs, threat model, two webhook release gates (commits `b03f277`, `ec28864`). CI run 43709103267 green at `3bf1a7b` on check, test, ui and stack amd64/arm64/tls. No release gate turns Web Push on: push delivery is tested against a local stand-in push service in the server tests only. The sidecar's overlay has not been started against a real ntfy server.
- [ ] Manual staging check: a real phone receives a push and opens the approval.

## Surprises & Discoveries

- Observation: the schema's "outbox" is for waking workflows, not for notifications. The webhook has no outbox at all.
  Evidence: `apps/server/src/db/schema.ts:303-307` (`resume_state`); `apps/server/src/execution/approvals.ts:738-750` (`#notify`, one `fetch`, `.catch` logs and drops).
- Observation: an approval recovered by the sweeper is never notified, and a crash between commit and `#notify` loses the notification.
  Evidence: `#notify` is called only at `approvals.ts:158`, after the transaction at `:130-155`; `recoverOrphan` at `:704-708` does not call it.
- Observation: the login redirect drops the page the person asked for.
  Evidence: `apps/web/src/router.tsx:32-33` redirects to `/login` with no return path.
- Observation: the CSP needs no change for a same-origin service worker; `worker-src` is absent and falls back to `script-src 'self'` (CSP Level 3). Not yet observed in a browser.
  Evidence: `packages/api/src/csp.ts:11-23`.
- Observation: the open question on Declarative Web Push is answered: no standard requires `navigate` to be on the site's own origin. The WHATWG Notifications standard sets a notification's "navigation URL" to whatever `navigate` parses to, and the Push API proposal (w3c/push-api#385, closed 2025-08) links to another origin in its own example. Safari 18.4 and later shows such a message without the service worker, so the worker's same-origin check does not run there; the server only ever sends `PUBLIC_ORIGIN` links with no token.
  Evidence: https://notifications.spec.whatwg.org/ ("If options["navigate"] exists, then parse it using baseURL"); https://github.com/w3c/push-api/pull/385 (example `"navigate": "https://email.example/message/12"`).
- Observation: Chromium's headless shell, which Playwright uses by default, reports `Notification.permission` as `denied` and refuses `showNotification` in a service worker even after `grantPermissions(["notifications"])` (while `requestPermission()` answers `granted`). Chromium's new headless mode (`channel: "chromium"`) behaves as a headed browser, and `ServiceWorker.deliverPushMessage` then reaches the worker's `push` handler. `pushManager.subscribe` fails in both ("Registration failed - permission denied"), so the web journey stands in for the subscription only.
  Evidence: probe with Playwright 1.65.1, Chromium 159.0.8154.6, 2026-11-15; `apps/web/playwright.config.ts`, `apps/web/test/push-stand-in.ts`.
- Observation: the npm `web-push` package is MPL-2.0 and its 4.0.0 release is four days old.
  Evidence: `https://registry.npmjs.org/web-push` (latest 4.0.0, licence MPL-2.0, released 2026-11-10).

## Decision Log

Decisions D1 to D7 were taken by the owner on 2026-11-15: Eric chose the recommended option of each (the entries below still read "open" and "recommended"; the recommendation is the decision). The approval page a notification leads to now links on to the signer's confirmation page (ticket 20, built after this plan was drafted).

- Decision (D1, open): channels built into the control plane. Recommended: Web Push and the signed, reliable webhook; everything else as sidecars of the webhook.
  Rationale: Web Push reaches the phone people already approve on; sidecars keep third-party tokens out of the control plane.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D2, open): content ceiling. Recommended: `count` by default, `summary` (kind, workspace name, requester name) as a per-workspace owner setting, never amount or recipient.
  Rationale: notifications are a plaintext channel like logs; the approval page is the one place to decide.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D3, open): Web Push implementation. Recommended: implement RFC 8291 and RFC 8292 with Node 26 WebCrypto, tested against RFC 8291 Appendix A.
  Rationale: about two hundred lines, no new dependency, no MPL-2.0 file in the server image.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D4, open): Web Push default. Recommended: off until the operator sets `WEB_PUSH_ENABLED=1`.
  Rationale: it adds a vendor push service as a third party; "nothing hosted is required" holds only while it is optional.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D5, open): quiet hours against expiry. Recommended: hold deliveries until the window ends; drop them if the approval has expired by then.
  Rationale: predictable for the person; an agent can propose again.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D6, open): email. Recommended: not built; possible later as a webhook sidecar.
  Rationale: needs personal data the product does not hold, an SMTP relay is a third party, email links are the most imitated phishing vector.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision (D7, open): who may raise a workspace's content level to `summary`. Recommended: the owner role, recorded in the audit chain, no passkey approval.
  Rationale: `summary` exposes only names that are already unencrypted; the signer has no stake in it.
  Date/Author: 2026-11-14 / research agent (recommendation only).
- Decision: notification links carry no token, never create a session, and are built by the server from ids only.
  Rationale: a token in a link becomes a capability for anyone who sees a lock screen, chat history or mail server.
  Date/Author: 2026-11-14 / research agent.
- Decision: notifications never offer action buttons that call the API.
  Rationale: approving needs a WebAuthn assertion in a page; a "Reject" button would be a state change without the page's context.
  Date/Author: 2026-11-14 / research agent.

## Outcomes & Retrospective

- Outcome: none yet; nothing is built.
  Evidence: not applicable.
  Remaining: everything in `Plan of Work`.

## Context and Orientation

Terms:

- **Approval**: a row in `os.approvals` waiting for passkey assertions over its `envelope` (`apps/server/src/db/schema.ts:277-314`). Kinds: `approve-intent`, `set-policy`, `add-approver`, `remove-approver`, `set-admin-threshold`, `resume-workspace` (`packages/protocol/src/envelopes.ts:36-86`).
- **Sealed**: encrypted with the workspace's data key by `ctx.sealer` (`apps/server/src/db/sealed.ts`). The table in `docs/threat-model.md:169-185` says what is sealed.
- **Outbox**: a table row written in the same database transaction as the change it reports, so a crash cannot separate them; a background loop delivers rows and marks them done.
- **Web Push**: the browser standard where a server sends an encrypted message to a URL (the subscription endpoint) run by the browser's vendor, which forwards it to the device. RFC 8030 (delivery), RFC 8291 (payload encryption), RFC 8292 (VAPID, the server's signing key).
- **Service worker**: a script the browser keeps for an origin and wakes for push events. Here it lives at `/sw.js`.
- **Declarative Web Push**: a JSON payload format (`{ "web_push": 8030, "notification": {...} }`) that Safari 18.4 and later display without running the service worker.

Relevant repo rules:

- Read `AGENTS.md` before changing files.
- CI owns builds, the full test suite and `e2e/run.sh`; locally only single-file checks, `tsc` and Biome.
- Logs carry identifiers, codes and counts only (`apps/server/src/log.ts:3-7`). The same rule applies to notifications.
- The signer decides whether a person approved and signs only what was approved. The control plane is not trusted for that. This plan does not touch `apps/signer`.
- Exact version pins for dependencies (`bunfig.toml`). This plan adds none to the server if D3 is accepted.

Current behavior:

- `Engine.open()` (`apps/server/src/execution/approvals.ts:114-160`) inserts the approval and an audit event in one transaction, starts the workflow, then calls `#notify` (`:738-750`), which POSTs `{ event: "approval.opened", approvalId, workspaceId, kind }` to `NOTIFY_WEBHOOK_URL` once, with a 5-second timeout, unsigned, and drops failures.
- `sweep()` (`apps/server/src/execution/index.ts:47-110`) runs every 3 seconds (`:19`, `:125-133`) and handles the workflow wake outbox and orphaned approvals.
- The UI is a single-page app served by `serveWebApp` (`apps/server/src/http/static.ts`). There is no manifest and no service worker. `apps/web/public/` holds `favicon.svg` only.
- The session cookie is `__Host-os_session`, `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS (`apps/server/src/identity/sessions.ts:11-16`, `:98-106`).
- `os.users` holds `id`, `display_name`, `created_at` (`schema.ts:51-55`); no email or chat id.
- `NOTIFY_WEBHOOK_URL` is passed by `compose.yaml:93` and listed in `specs/agent-workspaces-v0.1.md:418`; `README.md`, `deploy/README.md` and `docs/architecture.md` do not document it.

How the pieces fit after the change:

- `Engine.open()` calls `enqueueApprovalNotifications(tx, approval)` inside its transaction. That writes one `notification_deliveries` row for the webhook (if configured) and one per eligible push subscription, plus reminder rows.
- `sweep()` calls `deliverDueNotifications(ctx)`, which claims due rows with `FOR UPDATE SKIP LOCKED`, checks the approval is still pending and unexpired, builds the content from identifiers only, and sends through the webhook or Web Push sender.
- The web app registers `/sw.js`, subscribes through `pushManager.subscribe` with the server's VAPID public key, and POSTs the subscription to `/api/v1/me/push-subscriptions`.
- The signer is not involved at any step. Approving is unchanged by this plan. Since the trusted display was built, a person approves on the signer's confirmation page, and the signer accepts an assertion only from that origin (`SIGNER_APPROVAL_ORIGIN`); a notification still links to the control plane's page, which links onward.

Assumptions:

- The server can reach the internet on the `control` network (`compose.yaml:177-184`). If an operator blocks egress, Web Push fails and the delivery rows end as `failed`; the inbox still works.
- Node 26 WebCrypto supports ECDH P-256, HKDF-SHA-256, AES-128-GCM and ECDSA P-256 with SHA-256. Milestone 2's tests prove it in CI.
- Owner decisions D1 to D7 go the recommended way. If D3 goes to `web-push`, Milestone 2 shrinks to a wrapper and `THIRD_PARTY.md` gains an MPL-2.0 entry.

## Plan of Work

### Milestone 1: Notification outbox and signed webhook

Scope: replace the fire-and-forget webhook with an outbox. First, because every later channel uses the same table and delivery loop.

Files and interfaces:

- `apps/server/src/db/schema.ts`: new table `notificationDeliveries` (`os.notification_deliveries`):
  - `id text primary key` (`ndl_` + ULID, same id helper as other tables)
  - `workspace_id text not null references workspaces`
  - `approval_id text not null references approvals`
  - `event text not null` (`"approval.opened" | "approval.reminder"`)
  - `target text not null` (`"webhook"` or `"push:" + subscription id`)
  - `user_id text references users` (null for the webhook)
  - `state text not null default 'pending'` (`pending | sent | dropped | failed`)
  - `attempts integer not null default 0`
  - `due_at timestamptz not null`, `next_attempt_at timestamptz not null`
  - `last_code text` (a short code such as `http_503`, `network`, `gone`, `approval_ended`; never a response body)
  - `created_at`, `sent_at`
  - unique index `(approval_id, event, target)`; index `(state, next_attempt_at)`.
- `apps/server/src/db/migrations/0002_notifications.sql`: generated by `bun run db:generate` in `apps/server`.
- `apps/server/src/notify/outbox.ts` (new):
  - `enqueueApprovalNotifications(ctx, tx, approval: { id, workspaceId, kind, expiresAt })`: inserts rows with `ON CONFLICT DO NOTHING`. In this milestone only the webhook target.
  - `deliverDueNotifications(ctx): Promise<{ sent: number; retried: number; dropped: number; failed: number }>`.
- `apps/server/src/notify/webhook.ts` (new): `sendWebhook(ctx, delivery, approval)`.
- `apps/server/src/notify/content.ts` (new): `approvalLink(config, workspaceId, approvalId): string` returning `${publicOrigin}/w/${workspaceId}/approvals/${approvalId}`; ids are checked against the protocol id schemas before use.
- `apps/server/src/execution/approvals.ts`: delete `#notify` and its call; call `enqueueApprovalNotifications` inside the `open()` transaction after `appendAudit`.
- `apps/server/src/execution/index.ts`: `sweep()` calls `deliverDueNotifications(ctx)` after the existing work and adds its counts to the return value.
- `apps/server/src/config.ts`: add `NOTIFY_WEBHOOK_SECRET_FILE` (required when `NOTIFY_WEBHOOK_URL` is set; boot fails otherwise). `Config.notify = { webhookUrl, webhookSecret }`.
- `deploy/init/init.mjs`: create `server-secrets/notify-webhook-secret` (32 random bytes, base64url) if absent.
- `compose.yaml`: pass `NOTIFY_WEBHOOK_SECRET_FILE: /run/secrets/server/notify-webhook-secret`.
- `apps/server/test/notify/outbox.test.ts`, `apps/server/test/notify/webhook.test.ts` (new).

Work:

1. Webhook body, version 1, JSON, keys sorted:
   `{ "v": 1, "deliveryId", "event", "approvalId", "workspaceId", "kind", "expiresAt", "link" }`. `expiresAt` is Unix seconds. `link` is from `approvalLink`. No other field.
2. Headers: `content-type: application/json`, `x-os-delivery: <deliveryId>`, `x-os-timestamp: <unix seconds>`, `x-os-signature: v1=<hex HMAC-SHA-256(secret, timestamp + "." + body)>`. The receiver rejects timestamps more than 300 seconds old and dedupes on `x-os-delivery`.
3. Delivery rules in `deliverDueNotifications`:
   - Claim up to 50 rows where `state = 'pending' and next_attempt_at <= now`, ordered by `next_attempt_at`, with `FOR UPDATE SKIP LOCKED`; set `next_attempt_at = now + 60s` (a lease) in the same transaction, then send outside it.
   - Before sending, reload the approval. If its status is not `pending` or `expires_at <= now`, set `state = 'dropped'`, `last_code = 'approval_ended'`.
   - 2xx: `sent`. 408, 429, 5xx, timeout or network error: `attempts + 1`, `next_attempt_at = now + min(600, 10 * 2^attempts)` seconds (honour `Retry-After` when present and smaller than the expiry), `failed` after 8 attempts. Other 4xx: `failed` at once.
   - Log `notification delivered`, `notification retry`, `notification dropped`, `notification failed` with `deliveryId`, `approvalId`, `target` kind (`webhook` or `push`) and `code` only.
4. Remove `#notify` entirely (clean cutover; v0.1 is private and unreleased).

Acceptance:

- `apps/server/test/notify/outbox.test.ts`: (a) `open()` writes one webhook row in the approval's transaction; an `alongside` that throws leaves neither approval nor delivery row; (b) a row left `pending` (simulated crash: insert, no send) is delivered by one `sweep()` to a local HTTP receiver; (c) a receiver answering 503 then 200 ends with `attempts = 1`, `state = sent`, and the receiver saw the same `x-os-delivery` twice; (d) an approval rejected before delivery gives `dropped` / `approval_ended` and no request; (e) a second `enqueueApprovalNotifications` for the same approval inserts nothing; (f) two concurrent `deliverDueNotifications` calls send each row once.
- `apps/server/test/notify/webhook.test.ts`: the signature verifies with the secret and fails with one changed byte; the body has exactly the eight keys; the body of a payment proposal contains none of the marker strings used for the intent's amount, recipient and memo (reuse the marker approach of `packages/testkit/src/scan.ts`).
- `bun run typecheck` and `bun run check` pass in CI.

### Milestone 2: Web Push sender

Scope: encrypt and sign push messages without a new dependency (D3). Independent of the UI, so it can be proven with RFC vectors alone.

Files and interfaces:

- `apps/server/src/notify/webpush/encrypt.ts` (new): `encryptPayload({ plaintext: Uint8Array, uaPublicKey: Uint8Array /* p256dh, 65 bytes */, authSecret: Uint8Array /* 16 bytes */, salt?: Uint8Array, asKeyPair?: CryptoKeyPair }): Promise<Uint8Array>` producing the `aes128gcm` body of RFC 8291 §3.4 with one record, record size 4096. Rejects a `uaPublicKey` that is not an uncompressed P-256 point (RFC 8291 §7). `salt` and `asKeyPair` are injectable only for the test vector.
- `apps/server/src/notify/webpush/vapid.ts` (new): `vapidAuthorization({ endpoint: URL, subject: string, privateKey: CryptoKey, publicKeyRaw: Uint8Array, now: number }): string` returning `vapid t=<jwt>, k=<base64url public key>`; JWT header `{"typ":"JWT","alg":"ES256"}`, claims `aud` = endpoint origin, `exp = now + 12h` (RFC 8292 caps at 24h), `sub`.
- `apps/server/src/notify/webpush/send.ts` (new): `sendPush(ctx, subscription, message: { payload: object; topic: string; ttlSeconds: number; urgency: "high" | "normal" }): Promise<PushResult>` where `PushResult` is `{ ok: true } | { ok: false; code: "gone" | "retry" | "rejected"; retryAfter?: number }`. 404 and 410 mean `gone`.
- `apps/server/src/config.ts`: `WEB_PUSH_ENABLED` (`0`/`1`, default `0`), `WEB_PUSH_VAPID_KEY_FILE` (PKCS#8 PEM, P-256), `WEB_PUSH_SUBJECT` (`mailto:` or `https:`; default `PUBLIC_ORIGIN`), `WEB_PUSH_ENDPOINT_HOSTS` (comma list of host suffixes; default `fcm.googleapis.com,updates.push.services.mozilla.com,push.apple.com,notify.windows.com`).
- `deploy/init/init.mjs`: create `server-secrets/vapid-key.pem` with `crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })` if absent.
- `apps/server/test/notify/webpush-encrypt.test.ts`, `apps/server/test/notify/webpush-vapid.test.ts` (new).

Work:

1. Plaintext is the declarative JSON of Milestone 3, padded with trailing zero bytes after the 0x02 delimiter to a fixed 512 bytes, so every message has the same length (RFC 8291 §7: length leaks unless padded).
2. Headers on send: `TTL` = seconds until the approval expires (at least 60), `Urgency`, `Topic` = first 32 characters of base64url(SHA-256(`"os-approval:" + approvalId`)), `Content-Encoding: aes128gcm`, `Authorization` from `vapidAuthorization`.
3. Refuse to send to an endpoint that is not `https:` or whose host does not end with one of `WEB_PUSH_ENDPOINT_HOSTS` (prevents the server POSTing to internal addresses on a member's behalf).

Acceptance:

- `webpush-encrypt.test.ts` reproduces the RFC 8291 Appendix A ciphertext exactly from its listed keys, salt and plaintext; rejects a 64-byte and an off-curve public key; decrypts its own output with the user agent's private key (test-only decrypt helper in the test file).
- `webpush-vapid.test.ts`: the JWT verifies with the public key via WebCrypto; `exp - now` is 43200; `aud` equals the endpoint origin; a subject that is not `mailto:` or `https:` fails config parsing.
- A unit test of `sendPush` against a local HTTPS test server shows 201 maps to ok, 410 to `gone`, 429 with `Retry-After: 30` to `retry`/30, and that a non-allowlisted host is refused without a request.

### Milestone 3: Subscriptions, preferences, content levels, API

Scope: who receives what. Depends on D2 and D7 for the content levels and who sets them.

Files and interfaces:

- `apps/server/src/db/schema.ts`:
  - `pushSubscriptions` (`os.push_subscriptions`): `id` (`psb_`), `user_id`, `endpoint text unique not null`, `p256dh text not null`, `auth text not null` (base64url), `label text` (person-given, at most 40 characters, e.g. "Phone"), `created_at`, `last_success_at`, `failure_count integer default 0`.
  - `notificationPreferences` (`os.notification_preferences`): primary key `(user_id, workspace_id)`, `web_push boolean not null default true`, `reminders boolean not null default true`.
  - `users`: add `quiet_hours jsonb` nullable: `{ start: "HH:MM", end: "HH:MM", timeZone: IANA name }`.
  - `workspaces`: add `notification_detail text not null default 'count'` (`count | summary`).
- `apps/server/src/db/migrations/0003_push_subscriptions.sql`.
- `packages/api/src/dto.ts`: `PushConfig { enabled: boolean; applicationServerKey: string | null }`, `PushSubscriptionInput { endpoint; keys: { p256dh; auth }; label? }` (strict, endpoint at most 2048 characters, `https:` only), `PushSubscriptionSummary { id; label; createdAt; lastSuccessAt }`, `NotificationPreferences { workspaces: { workspaceId; webPush; reminders }[]; quietHours: { start; end; timeZone } | null }`, `NotificationDetail = "count" | "summary"`.
- `packages/api/src/routes.ts`:
  - `getPushConfig: get("/api/v1/me/push", PushConfig)`
  - `listPushSubscriptions: get("/api/v1/me/push-subscriptions", items(PushSubscriptionSummary))`
  - `addPushSubscription: post("/api/v1/me/push-subscriptions", PushSubscriptionInput, PushSubscriptionSummary)`
  - `removePushSubscription: del("/api/v1/me/push-subscriptions/:subscriptionId", NoBody)`
  - `getNotificationPreferences: get("/api/v1/me/notifications", NotificationPreferences)`
  - `setNotificationPreferences: post("/api/v1/me/notifications", NotificationPreferences, NotificationPreferences)` (the route table has `get`, `list`, `post`, `del` helpers and no `put`, `packages/api/src/routes.ts:64-108`)
  - `setNotificationDetail: post("/api/v1/workspaces/:workspaceId/notification-detail", z.strictObject({ detail: NotificationDetail }), WorkspaceDetail)` (owner role, D7; audit action `workspace.notification_detail_set`).
- `apps/server/src/notify/routes.ts` (new) mounted in `apps/server/src/http/app.ts` beside the other route groups.
- `apps/server/src/notify/recipients.ts` (new): `approvalRecipients(tx, workspaceId)`: users with membership role `approver` or `owner` and at least one `approver_credentials` row in state `active` or `removing` for the workspace, and their subscriptions where `notification_preferences.web_push` is not false.
- `apps/server/src/notify/content.ts`: `pushMessage({ level, facts, link }): DeclarativePush` where `facts` is `{ pendingCount: number; kind: ApprovalKind; workspaceName: string; requesterName: string }`. The type has no field that could hold an amount or address. Output: `{ web_push: 8030, notification: { title, body, navigate: link, tag: "approval-" + approvalId, lang: "en", silent: false, app_badge: String(pendingCount) } }`. `count`: title "Approval waiting", body "1 request needs your passkey" (or "N requests"). `summary`: title "<kind label> waiting", body "<requester name> in <workspace name>", both truncated to 60 characters with control characters removed.
- `apps/server/src/notify/outbox.ts`: `enqueueApprovalNotifications` adds one `push:<id>` row per recipient subscription when `WEB_PUSH_ENABLED=1`; delivery calls `sendPush`; `gone` deletes the subscription and drops the row.
- Tests: `apps/server/test/notify/recipients.test.ts`, `apps/server/test/notify/content.test.ts`, `apps/server/test/notify/routes.test.ts`.

Acceptance:

- `recipients.test.ts`: a viewer, a member with no approver passkey, and a member who turned off `web_push` for that workspace get no row; an approver with two devices gets two rows.
- `content.test.ts`: for a payment proposal with marker amount, recipient and memo, neither level's JSON contains any marker; `summary` strips newlines and truncates; `navigate` always starts with `PUBLIC_ORIGIN` and matches `^/w/[A-Za-z0-9_]+/approvals/[A-Za-z0-9_]+$` in its path.
- `routes.test.ts`: subscription endpoints need a session; another user's subscription id gives `not_found`; a `http:` or non-allowlisted endpoint gives 400; `setNotificationDetail` from an approver gives `forbidden` and from an owner writes one audit event.

### Milestone 4: Web app manifest, service worker, return path

Scope: make the UI installable and able to receive push, and make a link work for a signed-out person. Depends on Milestone 3's API.

Files and interfaces:

- `apps/web/public/manifest.webmanifest` (new): `{ "id": "/", "name": "Agent workspaces", "short_name": "Workspaces", "start_url": "/", "scope": "/", "display": "standalone", "background_color", "theme_color", "icons": [192 and 512 PNG] }`.
- `apps/web/public/icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180x180) (new).
- `apps/web/index.html`: `<link rel="manifest" href="/manifest.webmanifest">`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`.
- `apps/web/src/sw.ts` (new), built to `/sw.js`:
  - `push`: parse the payload; if it is declarative JSON, validate that `navigate` is same-origin and its path matches the approval pattern or is `/`; otherwise show a generic "Approval waiting" notification with `navigate` `/`. Always call `showNotification` (Safari revokes subscriptions that do not). Use `tag` so a reminder replaces the first notification. Call `setAppBadge` when present.
  - `notificationclick`: close the notification; focus an existing window on the same origin and navigate it, else `clients.openWindow(path)`. Path only, never a full URL from the payload.
  - `pushsubscriptionchange`: subscribe again with the stored application server key and POST the new subscription.
  - No `fetch` handler and no Cache Storage use. The worker must not intercept or cache the app.
- `apps/web/vite.config.ts`: `build.rollupOptions.input = { main: "index.html", sw: "src/sw.ts" }`, `output.entryFileNames = (chunk) => chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"`.
- `apps/web/src/lib/push.ts` (new): `pushSupport()` returning `"unsupported" | "needs-install"` (iOS not in standalone display mode) `| "available"`; `enablePush(label)` (must be called from a click handler) and `disablePush()`.
- `apps/web/src/routes/settings.tsx`: section "Notifications on this device" (enable, disable, label, list of devices with remove), per-workspace toggles, quiet hours with time zone (default `Intl.DateTimeFormat().resolvedOptions().timeZone`).
- `apps/web/src/routes/workspace.tsx`: owner-only control for the workspace's content level, with the text "Notifications never show amounts or recipients."
- `apps/web/src/lib/return-path.ts` (new): `safeReturnPath(raw: string | null): string | null`. Accept only strings starting with a single `/`, not `//` or `/\`, that resolve to the same origin and match a route in `apps/web/src/router.tsx`. Anything else gives null.
- `apps/web/src/router.tsx`: redirect to `/login?next=<path>` for a signed-out person; after sign-in, navigate to `safeReturnPath(next) ?? "/"`.
- `apps/server/src/http/static.ts`: no change. `.png` and `.webmanifest` types exist (`:12-13`), non-`/assets/` files are served `no-cache` (`:53`), and a worker at `/sw.js` has scope `/` without a `Service-Worker-Allowed` header.
- Tests: `apps/web/test/sw.test.ts`, `apps/web/test/return-path.test.ts`, `e2e/test/browser.spec.ts` (extended).

Acceptance:

- `apps/web/test/sw.test.ts` (Vitest with a fake `ServiceWorkerGlobalScope`): a declarative payload shows one notification with the payload's title and path; a payload whose `navigate` is `https://evil.example/...` shows the generic notification with `/`; an undecryptable or non-JSON payload still shows the generic notification; `notificationclick` opens only a same-origin path.
- `apps/web/test/return-path.test.ts`: accepts `/w/ws_1/approvals/apr_1`; rejects `//evil.example`, `/\evil.example`, `https://evil.example/`, `javascript:alert(1)`, `/%2F%2Fevil.example`, and an unknown path.
- `e2e/test/browser.spec.ts`: against the real stack with the production CSP, `navigator.serviceWorker.register("/sw.js")` resolves and reaches `activated`; `/manifest.webmanifest` returns `application/manifest+json`; the console shows no CSP violation; a signed-out visit to an approval link, then passkey sign-in with the virtual authenticator, lands on that approval page.
- `packages/api/src/csp.ts` is unchanged (a test asserts the constant's value is the v0.1 string).

### Milestone 5: Expiry reminders and quiet hours

Scope: one reminder before expiry; respect each person's quiet hours. Depends on D5.

Files and interfaces:

- `apps/server/src/notify/schedule.ts` (new):
  - `reminderDueAt(createdAt, expiresAt): number | null`: `null` when the lifetime is under 30 minutes; else `expiresAt - max(600, floor(0.25 * (expiresAt - createdAt)))`.
  - `nextAllowedTime(now, quietHours | null): number`: `now` outside the window, else the window's end in the person's time zone (windows may cross midnight).
- `apps/server/src/notify/outbox.ts`: `enqueueApprovalNotifications` adds `approval.reminder` rows (push targets only, and only for people with `reminders` on) with `due_at = reminderDueAt(...)`. Delivery applies `nextAllowedTime` to push rows; a row whose allowed time is at or after the approval's expiry is `dropped` / `quiet_hours`. Webhook rows ignore quiet hours (the operator's receiver decides).
- Reminder content: same as the opened message, with title prefix "Expiring soon: " and the same `tag` and `Topic`, so it replaces the first notification on the device and at the push service.
- `apps/server/test/notify/schedule.test.ts` (new).

Acceptance:

- `schedule.test.ts` with fixed clocks: a 1-hour approval reminds at 45 minutes; a 10-minute approval has no reminder; a 24-hour approval reminds at 18 hours; quiet hours 22:00 to 07:00 in `Europe/London` defer a 23:30 delivery to 07:00, and drop it if the approval expires at 06:00; a daylight-saving change day computes the right instant.
- `outbox.test.ts` gains: a reminder for an approval decided in the meantime is dropped; a person with reminders off gets no reminder row.

### Milestone 6: ntfy sidecar, docs, threat model, release gates

Scope: show the sidecar pattern, document every third party, and gate the webhook end to end.

Files and interfaces:

- `examples/ntfy-sidecar/` (new): `src/bridge.ts` (verification, dedupe, publishing), `src/config.ts` (settings and the files they name), `src/main.ts` (Node 26, no framework, listens on `PORT`). It verifies `x-os-signature` with `NOTIFY_WEBHOOK_SECRET_FILE` and the 300-second timestamp window, dedupes `x-os-delivery` in memory for 24 hours, and POSTs to `${NTFY_URL}/${NTFY_TOPIC}` a fixed text per event ("Approval waiting" for `approval.opened`), header `Click: <link>` only when `NTFY_INCLUDE_LINK=1` and the link is on `PUBLIC_ORIGIN`, and `Authorization: Bearer` from `NTFY_TOKEN_FILE` if set. `Dockerfile` in the style of `examples/scripted-agent/Dockerfile`; `test/bridge.test.ts`; `README.md` stating that on iOS a self-hosted ntfy forwards a poll request with the message id to its `upstream-base-url` (ntfy.sh by default).
- `examples/ntfy-sidecar/compose.yaml`: its own Compose overlay on the root `compose.yaml` (`docker compose -f compose.yaml -f examples/ntfy-sidecar/compose.yaml up -d --build`), not a profile of the root file. It adds `ntfy-sidecar-init`, which copies the webhook secret (and an ntfy token file, if named) from the server's secrets volume into the sidecar's own volume with no network, and `ntfy-sidecar` on the `control` network, which never mounts the server's volume; it points the server's `NOTIFY_WEBHOOK_URL` at the sidecar.
- `e2e/compose.e2e.yaml` and `e2e/src/stack.ts`: a webhook receiver service that answers 503 to the first request and 200 after, and records requests.
- `e2e/test/release-gates.spec.ts`: gate "an approval is announced once, signed, with no sealed content, even after a failed delivery".
- `docs/threat-model.md`: new section "Notifications" (text in `Risks and Open Questions` below and the threat summary); remove "Notifications outside the inbox: web push and chat." from "Out of scope for v0.1" only when this ships, and record what remains (email, chat adapters built in).
- `docs/architecture.md`: the outbox, the push path, the sidecar pattern.
- `deploy/README.md`: env vars `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET_FILE`, `WEB_PUSH_ENABLED`, `WEB_PUSH_VAPID_KEY_FILE`, `WEB_PUSH_SUBJECT`, `WEB_PUSH_ENDPOINT_HOSTS`; a table of third parties per channel (Google, Mozilla, Apple, Microsoft push services; ntfy.sh upstream on iOS); that Web Push needs HTTPS and, on iOS, installing to the Home Screen.
- `README.md`: one paragraph on notifications and a link to `deploy/README.md`.

Acceptance:

- `examples/ntfy-sidecar/test/bridge.test.ts`: a bad signature, an old timestamp, and a replayed delivery id are refused; a valid one produces one POST to a fake ntfy server with no link unless enabled.
- The new release gate passes in CI on the `stack` jobs (amd64, arm64, tls): after the scripted agent proposes a payment, the receiver records two requests with the same `x-os-delivery`, the second answered 200, the signature verifies with the stack's secret, and a scan of all recorded bodies finds none of the proposal's marker strings.
- CI `check` passes for the docs (Biome, link targets exist).

## Interfaces and Dependencies

Local interfaces:

- `enqueueApprovalNotifications(ctx, tx, approval)`:
  - Inputs: the transaction of `Engine.open()`; `approval` `{ id: ApprovalId; workspaceId: WorkspaceId; kind: ApprovalKind; createdAt: number; expiresAt: number }`.
  - Outputs: nothing; rows inserted with `ON CONFLICT DO NOTHING`.
  - Failures: database errors abort the approval's transaction, so an approval never exists without its delivery rows.
- `deliverDueNotifications(ctx)`:
  - Inputs: the app context; reads the clock from `ctx.now()`.
  - Outputs: counts `{ sent, retried, dropped, failed }`.
  - Failures: never throws for a delivery failure; a database error propagates to `sweep()`, which logs `sweep failed` and runs again in 3 seconds.
- `sendWebhook`, `sendPush`: return a result value; network errors become `retry`.
- `pushMessage({ level, facts, link })`: pure; input type excludes amounts and addresses by construction.
- `safeReturnPath(raw)`: pure; returns a same-origin known path or null.

External dependencies:

- Web Push protocol:
  - Version/source checked: RFC 8030, RFC 8291, RFC 8292 (rfc-editor.org text, read 2026-11-14).
  - Expected behavior: 201 on accept; 404 or 410 when the subscription is gone; 413 above 4096 bytes; Topic replaces undelivered messages; VAPID `exp` at most 24 hours.
  - Failure handling: `gone` deletes the subscription; others retry with backoff until the approval ends.
- Declarative Web Push (Safari 18.4 and later):
  - Version/source checked: [WebKit, Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/), 2025-03-27.
  - Expected behavior: the browser shows `notification` and opens `navigate` without the service worker; the worker may replace it.
  - Failure handling: other browsers pass the same JSON to `/sw.js`, which shows it. Whether Safari requires `navigate` to be same-origin is unconfirmed; the server only ever sets `PUBLIC_ORIGIN` links.
- Web Push on iOS:
  - Version/source checked: [WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
  - Expected behavior: iOS 16.4 or later, Home Screen web app with `display: standalone`, permission requested from a user action.
  - Failure handling: `pushSupport()` returns `needs-install` and the settings page explains installing.
- ntfy (example only):
  - Version/source checked: v2.38.0 (released 2026-11-14), `docs/config.md` "iOS instant notifications".
  - Expected behavior: `POST /<topic>` publishes; `Click` header sets the tap target.
  - Failure handling: the sidecar answers 502 to the control plane, which retries.
- npm `web-push` 4.0.0 (MPL-2.0): not used if D3 is accepted.

## Concrete Steps

From the repository root (`/srv/openclaw-data/home/ericjuta/.openclaw/workspace/repos/os`), on a branch `feat/approval-notifications`:

    (cd apps/server && bunx tsc --noEmit)
    (cd apps/server && bun run db:generate)        # writes 0002 and 0003 migrations
    (cd apps/web && bunx tsc --noEmit)
    bunx biome check --write .
    git push -u origin feat/approval-notifications   # CI runs check, test, ui, stack x3

Single-file checks allowed locally (repo rule):

    (cd apps/server && bunx vitest run test/notify/webpush-encrypt.test.ts)

Expected evidence (CI):

    ✓ apps/server test/notify/webpush-encrypt.test.ts (RFC 8291 Appendix A)
    ✓ e2e release-gates: an approval is announced once, signed, with no sealed content

## Validation and Acceptance

Automated validation (all in CI):

- `bun run test`: every new test file under `apps/server/test/notify/`, `apps/web/test/sw.test.ts`, `apps/web/test/return-path.test.ts`, `examples/notify-ntfy/test/bridge.test.ts`; existing 519 tests still pass.
- `bun run typecheck`, `bun run check`: pass.
- `./e2e/run.sh` (CI `stack` jobs, amd64, arm64, tls): the new webhook gate and the extended browser gate pass with all existing gates.

Manual or runtime validation:

- Start: a staging stack behind HTTPS (as the v0.1 phone passkey test), `WEB_PUSH_ENABLED=1`.
- Exercise: install the app to the Home Screen on an iPhone (iOS 16.4 or later) and in Chrome on Android; enable notifications in Settings; have the scripted agent propose a payment.
- Observe: one notification per device reading "Approval waiting"; tapping it opens the approval page; approving needs the passkey; a reminder replaces the notification at the computed time if left alone; nothing in the notification names an amount or address.

Regression checks:

- The inbox and approval flow are unchanged: existing release gates for proposals, approvals, spent approvals, expiry and restore still pass.
- With `NOTIFY_WEBHOOK_URL` unset and `WEB_PUSH_ENABLED=0`, `enqueueApprovalNotifications` writes no rows and no outbound request is made (asserted in `outbox.test.ts`).

## Idempotence and Recovery

- Enqueueing is idempotent through the unique index `(approval_id, event, target)`.
- Delivery is at least once. Duplicates are collapsed by `x-os-delivery` at the webhook receiver, and by `Topic` at the push service and `tag` on the device.
- A crash during delivery leaves the row `pending` with a 60-second lease; the next sweep after the lease sends it again.
- Migrations `0002` and `0003` only add tables and columns with defaults. Backout: revert the branch and add a migration that drops the new tables and columns; v0.1 behaviour returns except the old unsigned webhook (re-add by revert).
- `init.mjs` creates secrets only when absent, so re-running Compose keeps keys. Rotating the VAPID key invalidates every push subscription (they are bound to the key, RFC 8292 §4); the settings page then shows "re-enable on this device". Rotating the webhook secret needs the receiver updated in the same change window.

## Rollout and Operations

- Feature flags/config/env vars: `WEB_PUSH_ENABLED` (default `0`), `WEB_PUSH_VAPID_KEY_FILE`, `WEB_PUSH_SUBJECT`, `WEB_PUSH_ENDPOINT_HOSTS`, `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET_FILE`.
- Migration/backfill steps: `0002_notifications.sql`, `0003_push_subscriptions.sql`, applied at boot by `apps/server/src/db/migrate.ts`. No backfill: approvals pending at upgrade get no notification.
- Monitoring/alerts/logs: `notification failed` lines with `code`; a growing count of `pending` rows past their `due_at`; `notification dropped` with `quiet_hours` or `approval_ended` is normal.
- PR/branch workflow: one branch, milestone commits, CI green on every push; the phone check before the change is called done.

## Risks and Open Questions

Threat summary after the change. The signer is unchanged and remains the only party that decides whether people approved.

A compromised control plane can:

- Not notify (suppress all channels). Effect: approvals expire unseen; no funds move.
- Send false notifications, with any text, to every subscribed device, because it holds the VAPID private key and the subscriptions, and to the webhook with a valid signature. Effect: social engineering; a false notification still links only to whatever page that control plane serves, which it controls anyway.
- Show a page that misdescribes the operation. This is the existing trusted-display gap (`docs/threat-model.md:199-214`), not new.
- Learn which people have which devices subscribed and when they are active (it already knows sessions).
- Ship a malicious `/sw.js`. A service worker persists on devices after the server is fixed. Mitigation: no `fetch` handler, so a malicious worker must be newly shipped and still cannot intercept the app unless the compromised server also adds one; browsers re-check `/sw.js` at least every 24 hours, so a fixed server replaces it; recovery note in `deploy/README.md` (serve a no-op worker, or `Clear-Site-Data: "storage"`).

A compromised control plane cannot:

- Approve anything. The signer verifies each assertion against its own RP ID and origin list (`apps/signer/src/config.ts:91`) and the envelope digest, and consumes the nonce. Notifications are not an input to that.
- Turn a notification into a capability. Links carry no token; a session needs a passkey sign-in.
- Raise spend beyond the signer's policy caps.

Someone with only a database copy cannot send push messages (subscriptions are bound to the VAPID key, which is a file, not a row) and cannot forge webhook signatures (the secret is a file).

- Risk: an agent-chosen or member-chosen name carries social-engineering text in `summary` mode ("URGENT approve refund").
  Mitigation: `count` is the default; `summary` truncates to 60 characters and strips control characters; agent names are set by members (`agents.name`), and the memo is never used.
- Risk: the push service, the device OS, or a chat provider stores notification text.
  Mitigation: content rules (identifiers and counts only); fixed-length padding for Web Push; the docs name each third party.
- Risk: server-side request forgery through a member-supplied push endpoint.
  Mitigation: `https:` only and the host suffix allowlist `WEB_PUSH_ENDPOINT_HOSTS`.
- Risk: open redirect through `?next=`.
  Mitigation: `safeReturnPath` with tests for known bypass forms.
- Risk: in-app browsers (Telegram, Slack) have their own cookie jar and no session; passkeys may not be available there.
  Mitigation: the page shows sign-in; sidecar docs recommend opening links in the system browser or omitting links (`NTFY_INCLUDE_LINK=0`).
- Risk: Web Push on iOS needs Home Screen install; people will not find it.
  Mitigation: `pushSupport()` and settings text; the webhook and ntfy path as an alternative.
- Open question: does Safari require a same-origin `navigate` URL for Declarative Web Push?
  Owner/next step: implementer reads [w3c/push-api#385](https://github.com/w3c/push-api/pull/385) before Milestone 4; the server only sends `PUBLIC_ORIGIN` links regardless.
- Open question: D1 to D7.
  Owner/next step: the owner.

## Artifacts and Notes

The v0.1 webhook, for reference (`apps/server/src/execution/approvals.ts:738-750`):

    /** Tell the operator's webhook that something waits. Identifiers only; never blocks. */
    #notify(approvalId, workspaceId, kind): void {
      const url = this.#ctx.config.notifyWebhookUrl;
      if (url === undefined) return;
      fetch(url, { method: "POST", ..., body: JSON.stringify({ event: "approval.opened", approvalId, workspaceId, kind }),
        signal: AbortSignal.timeout(5_000) }).catch(() => { this.#ctx.log.warn("approval webhook failed", { approvalId }); });
    }

RFC 8291 §7, on what the push service still sees: "The timing and length of communication cannot be hidden from the push service."

## Revision Notes

- 2026-11-14: First draft from the research report for issue #24. Nothing built.
