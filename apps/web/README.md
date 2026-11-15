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

It is a Vite, React 19 and Tailwind 4 single-page app. It talks only to `/api/v1` through
`createApiClient()` from `@askgina/os-api`. Signing in and adding a passkey go through
`@simplewebauthn/browser`.

A page opened while signed out, such as an approval link sent to a phone, sends the person to
`/login?next=<path>` and back to that page after sign-in. The same happens when a session ends
while a page is open. `src/lib/return-path.ts` decides what `next` may be: a path on this site with
one leading `/`. It refuses `//host`, `/\host`, any backslash, schemes, absolute URLs and control
characters, and then lands on the workspace list instead.

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
(`possession_unproven`). It is a fixture: the real page is `apps/approve/public/`, and the
stand-in says on screen that it checks no signature.

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
  operator command and the sign-in return path.
- `bunx playwright test --project=<phone-light|phone-dark|desktop-light|desktop-dark|phone-wide-font>`:
  the first-day journey in Chromium with a virtual authenticator. Every approval goes through
  the confirmation page's link and back. A second person, with their own authenticator, joins as
  an approver, proves on the confirmation page that the new passkey is theirs, and the owner
  approves the change after the fingerprints match. Playwright starts the fixture and the Vite
  dev server itself, fails on any console error or failed request, and writes screenshots to
  `dev/screenshots/`. Set `OS_WEB_BASE_URL` to run it against a real server instead (and
  `OS_WEB_PROPOSE_URL`, `OS_WEB_SETUP_TOKEN` to match it).
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
  runs taller than with any real font, so it skips the rule that a payment's decision fits on the
  first phone screen. That rule holds on `phone-light` and `phone-dark`.
- `bunx tsc --noEmit` checks the types.

## Production

CI runs `bun run build`, which writes `dist/`. The control plane serves those files itself, from
the same origin as the API and under the same Content-Security-Policy, so the UI needs no server
of its own.
