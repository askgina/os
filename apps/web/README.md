# @askgina/os-web

The web UI of Agent Workspaces: where people set up the server, create workspaces, agents and
wallets, set each wallet's limits, manage members and invites, read the audit log, and decide
what agents ask for. The approval page is the product: on a phone it shows, without scrolling,
what will happen, how much, to whom, from which wallet and agent, the agent's memo, the fee
ceiling, the wallet's limits, the time left and how many approvals are in.

Approving does not happen here. The approval page links to the signer's confirmation page, on
its own origin (`APPROVE_ORIGIN`, served by `apps/approve`), names that page's host, and tells the
person to check that their address bar shows it before they approve with their passkey there. A
"Copy link" button opens the same page on another device. This page keeps reading the request
every 3 seconds, so the count ("1 of 2 approvals") and the outcome appear here once the signer
has collected the approvals. Reject stays on this page and needs no passkey. When the signer
refuses to open a confirmation page, for example because the wallet's limits changed after the
request was made, the page says the request cannot be approved and offers only Reject.

A request that adds an approver's passkey has one more step, on the signer's page, for the person
it adds: they open the same link, press "This passkey is mine" and answer with the new passkey,
and that page shows them the key's fingerprint. Nobody can approve the change before that. So the
approval page gives that person the link too, with what to do, although they cannot decide. It
shows everyone the key fingerprint, computed from the request's envelope, and tells the people
who approve to compare it with the new person over a call or in person before they approve, and
who has to act when the signer's page says the proof is still missing. The control plane's API
does not say whether the proof is done (only the signer's page does), so the page says what to do
either way.

An owner can also approve one agent's payments in advance (a mandate): on the wallet page, or the
agent's page for its own wallet, "Approve in advance…" opens an editor for the recipients (one
address per line), each asset's caps in whole units (per payment, in a rolling window, in total),
the window, the number of payments, the network fee per payment (the wallet's fee ceiling to
start with), the end (end of today, end of Friday, in 7 days, or a date and time in the viewer's
own time zone) and a purpose. Before anything is sent it shows the whole mandate in one sentence
and its worst case: the most that can leave the wallet, `min(total, payments × per payment)` per
asset, plus the fees. Submitting opens a `grant-mandate` request, approved like any other on the
signer's page; its approval page shows the sentence, the worst case set apart, every recipient in
full, the agent, the wallet, the window, the end time with how long that is from now, each
asset's caps next to the wallet's own limits, and the purpose as its asker wrote it. When the
server or the signer refuses a draft or a grant, the page says why in words (`src/lib/codes.ts`).

The wallet and agent pages list live mandates with what the signer counted (payments used and
left, each asset's total and window against its caps), and ended ones with the reason they ended.
Each has its own page (`/w/<workspace>/mandates/<id>`) with the payments signed under it. Anyone
who can approve can revoke one there or in the list: a confirmation, no passkey, because revoking
only takes authority away. A payment signed under a mandate has no approval page; it says
"Approved in advance", links to its mandate, and has its own page
(`/w/<workspace>/payments/<intent>`), linked from the mandate's and the agent's lists.

It is a Vite, React 19 and Tailwind 4 single-page app. It talks only to `/api/v1` through
`createApiClient()` from `@askgina/os-api`. Signing in and adding a passkey go through
`@simplewebauthn/browser`.

A page opened while signed out, such as an approval link sent to a phone or opened from a
notification, sends the person to `/login?next=<path>` and back to that page after sign-in. The
same happens when a session ends while a page is open. `src/lib/return-path.ts` decides what
`next` may be: a path on this site with one leading `/`. It refuses `//host`, `/\host`, any
backslash, schemes, absolute URLs, control characters, and an encoded `/`, `\` or control
character in the path (`%2F`, `%5C`, `%09`), and then lands on the workspace list instead.

## Stuck transactions

Once a payment or a sweep is sent, its request's page (and a mandated payment's own page) shows
its transaction: every attempt the signer signed for it, oldest first (the first signature, the
same payment with a higher fee, or a cancel), each with its fee per gas in gwei, the most it can
cost, its hash linked to the block explorer, and whether the network mined it. While it is not
mined, the page says why in words (`stuckReasonSentence` in `src/lib/statuses.ts`): the fee is too
low, an earlier transaction waits ahead of it, the workspace is paused, the next fee would pass
the approved ceiling, the signer's time or number of attempts ran out, or the signer refuses. The
page keeps reading it every 5 seconds while it is stuck.

Owners and approvers get two buttons, each shown only when the transaction allows it
(`canSpeedUp`, `canCancel`); a viewer reads the attempts and the state and is told who can act.
"Speed up" asks for one more attempt with higher fees, within the ceiling people approved, with
no passkey. "Cancel payment" (or "Cancel sweep", on a sweep's page; a sweep is never sped up)
opens a `cancel-transaction` request and goes to it; while one waits, the transaction links to
it instead. Its approval page is short, so the link to the signer's page stays on a phone's
first screen: what it would stop, the wallet, the network, the most it may cost in fees, the
attempts so far, and that it is an attempt, not a guarantee: if the network includes the payment
first, the payment goes through (`cancel_too_late`). It is approved like any other request, on
the signer's page with passkeys. Afterwards the page follows the payment until the network
decides: "Cancelled on chain" (`voided`, nothing moved, a fee was paid) or the payment's own
outcome. Every refusal of a speed-up or a cancel, and the outcomes `transaction_cancelled`,
`cancel_too_late` and `nonce_used_elsewhere`, have their own sentences (`src/lib/codes.ts`).

## Retiring a wallet, deleting a workspace, removing an agent

Owners retire a wallet from its page ("Retire this wallet…") and delete a workspace from its
overview ("Delete this workspace…", only while paused). Both forms first read
`getDeletionPreflight`: what the server reads is still in each wallet, labelled "read by the
server; the signer cannot check balances", the reasons deleting would lose something or wait
(`blockerText` in `src/lib/lifecycle.ts`), and the signer's shortest delay, which is the default
of the delay choices (7 days unless the operator changed it, then 14 and 30 days), each with the
date the keys go. `destroyAfter` is worked out on the server's clock with a few minutes' margin,
so the shortest choice is never refused as too short. The request is approved like any admin
change, on the signer's page, which warns that the keys are destroyed and that the signer cannot
see balances; its approval page is short so the link stays on a phone's first screen, and lists
the wallets with what the server reads in them below the decision.

While a wallet retires, its page says when its key goes, counts down, warns against sending to it
and offers "Cancel retirement" (owners and approvers, no passkey), which leaves it stopped until
new limits are approved. A destroyed wallet says so and offers nothing. While a workspace is
deleted, every page of it shows when its keys go, a countdown and "Cancel deletion" (any member,
no passkey; it stays paused); nothing can be added or resumed. If the deletion finishes while its
page is open, the page says the workspace was deleted: its former members can no longer read it.

"Remove" on an agent's page is the API's `disableAgent`: its token stops working, its waiting
payment requests are cancelled and its mandates end, for good. Its wallet stays until retired.

## Notifications

The settings page turns notifications on for the device it is opened on, lists the person's
devices (with "This device" and a Remove button for each), has two switches per workspace
("Notify me", and one reminder shortly before a request expires) and quiet hours: a window such as
22:00 to 07:00, in a time zone chosen from the browser's list (the device's own to start with),
during which notifications wait, and are dropped if their request expires first. When the server
does not send Web Push (`PushConfig.enabled` false, the operator's default), the page says so and
points to the other way: the operator's webhook, which can pass waiting requests on to a chat or
an ntfy app. Every refusal has its own sentence (`explainNotificationError` in `src/lib/codes.ts`):
the server's `push_off`, `endpoint_refused` and `bad_subscription`, a blocked or dismissed
permission, a worker that would not install and a push service that could not be reached.

Each workspace's overview has "What notifications say", with what each level shows on a locked
screen: only that requests wait ("Approval waiting · 1 request needs your passkey", the default),
or also the kind of request, who asked and the workspace ("Payment waiting · Invoice payer in
Research team"). Never an amount or a recipient. Only an owner can change it, with no passkey, and
the change is in the activity log; everyone else sees the level and that only an owner can change
it.

`src/lib/push.ts` decides whether this browser can get notifications (`pushSupport`): `available`,
`blocked` (the person blocked them for this site), `needs-install` (an iPhone or iPad in a Safari
or other tab: notifications come only to the app added to the Home Screen, from iOS 16.4) or
`unsupported` (no service worker or push, a page not on HTTPS, or iOS before 16.4). Turning
notifications on asks the browser's permission first, on the press of the button (iOS asks only
then), installs the worker, subscribes with the server's key and sends the subscription to the
server. The server's list of devices names no endpoint, so the page remembers in `localStorage`
which device this browser became and for whom, and says when notifications stopped on this device:
the browser dropped or replaced its subscription, the server's key changed, or the device was
removed elsewhere. Turning them on again replaces it.

The app is installable: `public/manifest.webmanifest` (standalone, scope `/`) and the icons in
`public/icons/`, drawn by `node dev/icons.ts` from the shapes of `public/favicon.svg`.

The service worker is `public/sw.js`, served as it is at `/sw.js` with scope `/`, by the Vite dev
server and from the build alike. It handles `push` and `notificationclick` only: no `fetch`
handler, no Cache Storage, no request to the API and no action buttons. It shows every message
(Safari revokes a subscription whose messages show nothing): the server's Declarative Web Push
JSON with plain text cut to 60 characters, and only when its link is this site's approval page or
the workspace list; anything else as a generic "Approval waiting" that opens the workspace list.
Pressing a notification brings a window of the app to that path, or opens one; a signed-out
device lands on sign-in, which goes back to the approval. The CSP needs no change: a worker from
the site's own origin falls under `script-src 'self'`, and `manifest-src 'self'` covers the
manifest.

Safari 18.4 and later shows a Declarative Web Push message itself, without the worker, so the
worker's link check does not run there. The standard does not require that link to be on the
site's own origin (the WHATWG Notifications "navigation URL" is any URL that parses; the Push API
proposal, w3c/push-api#385, links to another origin in its own example). The server only ever
sends links on its own origin, carrying no token.

## Development

The UI runs against `dev/fixture-server.ts`, an in-memory stand-in for the control plane that
serves the same API contract and validates every response it sends with the contract's own
schemas. It is not secure (it never checks a passkey signature) and nothing under `dev/` is part
of the built UI.

The fixture also stands in for the signer's confirmation page, on a second origin,
`http://localhost:55732` (files in `dev/confirm/`). It shows the request, asks the passkey there,
and checks only that the browser answered for this request's challenge, on that origin, at the
top level, with a passkey of one of the workspace's approvers. It holds the approval as the
signer would and goes back to the approval page, whose next read counts it. Like the real
signer, it opens no confirmation for a payment or a limits change asked for under limits that
have changed since; that request then cannot be approved. For an approver change it has the real
page's "This passkey is mine" step: it takes an answer only from the new passkey, for the step's
own challenge, shows the key's fingerprint, and refuses every approval until then
(`possession_unproven`). It holds approvals in advance as the signer does: a grant takes effect
only if the wallet's limits still allow it, a payment the agent proposes (through
`/__fixture/propose`) that one covers is sent with no request, counted for good, and checked
against the wallet's limits too, and anything else goes to the inbox. It is a fixture: the real
page is `apps/approve/public/`, and the stand-in says on screen that it checks no signature.

A sent transaction's newest attempt is "mined" two seconds after it was offered.
`/__fixture/settle` with `{ intentId, status: "stuck" }` holds a payment back instead: nothing of
it is mined, its fee is too low, and its attempts are dated three minutes back (the server's
`REPRICE_AFTER_SECONDS`), so Speed up adds an attempt at once; within 15 seconds of the newest
one it adds none, as the server does. A cancel request, approved on the stand-in page, adds a
cancel attempt, which is then mined and voids the payment. While the workspace is paused, a
transaction cannot be sped up and says so.

Notification settings are kept as the server keeps them, and the fixture refuses a subscription
as the server does (`push_off`, `endpoint_refused`, a key that is not a P-256 point). Web Push is
on with a key made at start; `OS_WEB_FIXTURE_WEB_PUSH=0` starts it off, and `/__fixture/web-push`
turns it off or on as the operator's `WEB_PUSH_ENABLED` would. The fixture never pushes anything.

```bash
bun run fixture   # the fixture API on 127.0.0.1:55731, its confirmation page on :55732
bun run dev       # the UI on http://localhost:55730, proxying /api to the fixture
```

Open http://localhost:55730 (passkeys need the name `localhost`, not `127.0.0.1`). The setup
token is `fixture-setup-token-0123456789`. Both servers send the production
Content-Security-Policy (the one constant in `@askgina/os-api`), so anything that needs an inline script, an inline
`<style>` or an outside request breaks here first. That is also why the dev server runs without
the React plugin's Fast Refresh: a change reloads the page.

## Tests

- `bunx vitest run test/<file>.test.ts`: plain logic, such as the status sentences, the
  operator command, the sign-in return path and the mandate editor's helpers (whole units to
  base units, the worst case, the end-time choices, the sentences, the meaning of every mandate
  code), and `transaction.test.ts` for sent transactions (attempt labels, fees in gwei, that a
  viewer gets no action, every speed-up and cancel refusal in words). For notifications:
  `sw.test.ts` runs the real `public/sw.js` in a stand-in worker scope
  (what each message shows, that only a page of this site opens, that it listens for nothing
  else), `push.test.ts` the support matrix (desktop, Android, iPhone and iPad in a tab and from
  the Home Screen, before and after iOS 16.4, blocked) and the state of this device, and
  `quiet-hours.test.ts` the quiet hours form.
- `bunx playwright test --project=<phone-light|phone-dark|desktop-light|desktop-dark|phone-wide-font>`:
  the first-day journey in Chromium with a virtual authenticator. Every approval goes through
  the confirmation page's link and back. A second person, with their own authenticator, joins as
  an approver, proves on the confirmation page that the new passkey is theirs, and the owner
  approves the change after the fingerprints match. The owner then approves payments in advance,
  the agent pays under it with nobody asked, and the owner revokes it. Then notifications: off at
  the server first, then on for this device, a message shown by the worker, another device
  removed, a reminder switched off, quiet hours set, and the workspace's notifications allowed to
  name the request, which a viewer sees but cannot change. A stuck payment (held back by
  `/__fixture/settle`) is sped up and is mined; another is cancelled through its request, approved
  on the confirmation page, and ends "Cancelled on chain"; a viewer sees the first stuck payment's
  attempts with no action. After signing out, a notification's
  path leads through sign-in back to its approval. A second journey, on a fresh server, removes an
  agent, retires its wallet and cancels that, retires the treasury to the end, then deletes the
  workspace: refused until paused, cancelled during the delay, asked again and finished, after
  which the page says it was deleted. The 7-day delay is skipped with `/__fixture/due`, so that
  journey runs against the fixture only. Headless Chromium reaches no push service, so
  the browser's push subscription is a stand-in (`test/push-stand-in.ts`: real keys, a made-up
  endpoint) and messages reach the real worker through the DevTools protocol, unencrypted; the
  permission, the worker's registration under the production Content-Security-Policy and the
  worker itself are the browser's own. The journey runs in Chromium's new headless mode
  (`channel: "chromium"`): the separate headless shell reports notifications as denied whatever
  is granted, and its service workers may not show any. Playwright starts the
  fixture and the Vite dev server itself, fails on any console error or failed request, and
  writes screenshots to `dev/screenshots/`. Set `OS_WEB_BASE_URL` to run it against a real
  server instead (and `OS_WEB_PROPOSE_URL`, `OS_WEB_SETUP_TOKEN` to match it).
- Before every screenshot, the journey checks that nothing is wider than the screen
  (`expectNoSidewaysOverflow` in `test/layout.ts`). On a phone, a page wider than the screen
  slides sideways and shifts every tap. It fails with the elements that end past
  `document.documentElement.clientWidth` (tag, first classes, start of text, right edge) and the
  outermost container around each one that grew past its parent: usually the layout to fix,
  with `min-w-0`, a `minmax(0,1fr)` track (`grid-cols-1`) or a label that may wrap.
- Fonts differ between machines: CI's runners have wider ones than a typical development machine,
  so a screen can fit here and overflow there. The `phone-wide-font` project runs the phone
  journey with every letter 0.08em wider (appended to each stylesheet as it loads, so the
  Content-Security-Policy stays as it is), more than the difference between those fonts. Run it
  after any layout change. It is a stress run for sideways overflow and wrapping only: its text
  runs taller than with any real font, so it skips the rule that a request's decision (a payment,
  or a cancel) fits on the first phone screen. That rule holds on `phone-light` and `phone-dark`.
- `bunx tsc --noEmit` checks the types.

## Production

CI runs `bun run build`, which writes `dist/`. The control plane serves those files itself, from
the same origin as the API and under the same Content-Security-Policy, so the UI needs no server
of its own.
