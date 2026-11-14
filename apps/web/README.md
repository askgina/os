# @askgina/os-web

The web UI of Agent Workspaces: where people set up the server, create workspaces, agents and
wallets, set each wallet's limits, manage members and invites, read the audit log, and approve or
reject what agents ask for with a passkey. The approval page is the product: on a phone it shows,
without scrolling, what will happen, how much, to whom, from which wallet and agent, the agent's
memo, the fee ceiling, the wallet's limits, the time left and how many approvals are in.

It is a Vite, React 19 and Tailwind 4 single-page app. It talks only to `/api/v1` through
`createApiClient()` from `@askgina/os-api`, and passkeys go through `@simplewebauthn/browser`.

## Development

The UI runs against `dev/fixture-server.ts`, an in-memory stand-in for the control plane that
serves the same API contract and validates every response it sends with the contract's own
schemas. It is not secure (it never checks a passkey signature) and nothing under `dev/` is part
of the built UI.

```bash
bun run fixture   # the fixture API on 127.0.0.1:55731
bun run dev       # the UI on http://localhost:55730, proxying /api to the fixture
```

Open http://localhost:55730 (passkeys need the name `localhost`, not `127.0.0.1`). The setup
token is `fixture-setup-token-0123456789`. Both servers send the production
Content-Security-Policy (the one constant in `@askgina/os-api`), so anything that needs an inline script, an inline
`<style>` or an outside request breaks here first. That is also why the dev server runs without
the React plugin's Fast Refresh: a change reloads the page.

## Tests

- `bunx vitest run test/<file>.test.ts`: plain logic, such as the status sentences and the
  operator command.
- `bunx playwright test --project=<phone-light|phone-dark|desktop-light|desktop-dark>`: the
  first-day journey in Chromium with a virtual authenticator. Playwright starts the fixture and
  the Vite dev server itself, fails on any console error or failed request, and writes
  screenshots to `dev/screenshots/`. Set `OS_WEB_BASE_URL` to run it against a real server
  instead (and `OS_WEB_PROPOSE_URL`, `OS_WEB_SETUP_TOKEN` to match it).
- `bunx tsc --noEmit` checks the types.

## Production

CI runs `bun run build`, which writes `dist/`. The control plane serves those files itself, from
the same origin as the API and under the same Content-Security-Policy, so the UI needs no server
of its own.
