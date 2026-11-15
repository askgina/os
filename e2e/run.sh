#!/usr/bin/env bash
# Start the whole stack as a throwaway Compose project, run the release gates against it, and
# remove it again.
#   ./e2e/run.sh           build, start, test, remove
#   ./e2e/run.sh --keep    leave the stack running afterwards, for looking around
#   E2E_TLS=1 ./e2e/run.sh the browser gate only, over HTTPS with compose.tls.yaml (ports 80, 443)
set -euo pipefail
cd "$(dirname "$0")/.."

export E2E_PROJECT="${E2E_PROJECT:-os-e2e}"
export HTTP_PORT="${HTTP_PORT:-55902}"
export PUBLIC_ORIGIN="http://localhost:${HTTP_PORT}"
export PUBLIC_HOST="localhost:${HTTP_PORT}"
export OS_HOSTNAME="localhost"
export E2E_ORIGIN="${PUBLIC_ORIGIN}"
# The confirmation page: another port on the same host, as on any host without a subdomain.
export APPROVE_HTTP_PORT="${APPROVE_HTTP_PORT:-55903}"
export APPROVE_ORIGIN="http://localhost:${APPROVE_HTTP_PORT}"
export E2E_POSTGRES_PORT="${E2E_POSTGRES_PORT:-55900}"
export E2E_ANVIL_PORT="${E2E_ANVIL_PORT:-55901}"
export E2E_ANVIL_URL="http://127.0.0.1:${E2E_ANVIL_PORT}"

tls="${E2E_TLS:-0}"
overlay=(-f compose.yaml -f e2e/compose.e2e.yaml --profile dev --profile agent)
if [ "$tls" = "1" ]; then
  # The host name is `localhost`, so Caddy issues the certificate from its own local authority
  # instead of asking a public one. Everything else is the overlay an operator would use.
  export PUBLIC_ORIGIN="https://localhost"
  export PUBLIC_HOST="localhost"
  export E2E_ORIGIN="${PUBLIC_ORIGIN}"
  # The TLS overlay requires the confirmation page's origin: another port on the same host.
  export APPROVE_TLS_PORT="8443"
  export APPROVE_ORIGIN="https://localhost:${APPROVE_TLS_PORT}"
  overlay=(-f compose.yaml -f compose.tls.yaml -f e2e/compose.e2e.yaml --profile dev --profile agent)
fi
compose=(docker compose -p "$E2E_PROJECT" "${overlay[@]}")
ui=(docker compose -p "${E2E_PROJECT}-ui" "${overlay[@]}")
lifecycle=(docker compose -p "${E2E_PROJECT}-lifecycle" "${overlay[@]}")
# `init` is not listed: it runs once and exits, and the others depend on it.
services=(postgres signer approve server caddy agent-gateway anvil)

remove() {
  for project in "$E2E_PROJECT" "${E2E_PROJECT}-restore" "${E2E_PROJECT}-lifecycle" "${E2E_PROJECT}-ui"; do
    docker compose -p "$project" "${overlay[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  done
}

logs() {
  for project in "$E2E_PROJECT" "${E2E_PROJECT}-restore" "${E2E_PROJECT}-lifecycle" "${E2E_PROJECT}-ui"; do
    docker compose -p "$project" "${overlay[@]}" \
      logs --no-color --tail 300 server signer approve caddy agent-gateway 2>/dev/null || true
  done
}

remove
"${compose[@]}" build

status=0

# First stack: the gates that drive people through the API. The backup gate ends on a restored
# copy of this stack under a second project name.
# A stack that does not come up healthy is a failed gate too: its logs are printed below.
# Over HTTPS this part is skipped: the gates below it do not depend on the scheme, and the backup
# gate's restored copy would get a new certificate authority.
if [ "$tls" != "1" ]; then
  "${compose[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && bunx playwright test release-gates.spec.ts) || status=$?
  fi
fi

# Second stack, empty: the lifecycle gates, which claim a fresh installation, end workspaces and
# wallets for good, and rotate the keyring. They cannot follow the gates above on the first
# stack: that ends as a restored copy behind an operator's fence, and its people's passkeys live
# only in the memory of the run above. Skipped over HTTPS, like the first stack.
if [ "$tls" != "1" ] && [ "$status" -eq 0 ]; then
  remove
  "${lifecycle[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-lifecycle" bunx playwright test lifecycle.spec.ts) || status=$?
  fi
fi

# Third stack, empty: the browser gate, which claims a fresh installation through the UI.
if [ "$status" -eq 0 ]; then
  remove
  "${ui[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ] && [ "$tls" = "1" ]; then
    # The test process trusts Caddy's local authority and nothing weaker: its requests still
    # verify the certificate chain and the host name.
    ca="$(mktemp)"
    for _ in $(seq 1 60); do
      "${ui[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$ca" >/dev/null 2>&1 && break
      sleep 1
    done
    [ -s "$ca" ] || status=1
    export NODE_EXTRA_CA_CERTS="$ca"
  fi
  if [ "$status" -eq 0 ]; then
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-ui" bunx playwright test browser.spec.ts) || status=$?
  fi
fi

if [ "$status" -ne 0 ]; then
  logs
fi
if [ "${1:-}" != "--keep" ]; then
  remove
fi
exit "$status"
