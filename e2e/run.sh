#!/usr/bin/env bash
# Start the whole stack as a throwaway Compose project, run the release gates against it, and
# remove it again.
#   ./e2e/run.sh           build, start, test, remove
#   ./e2e/run.sh --keep    leave the stack running afterwards, for looking around
set -euo pipefail
cd "$(dirname "$0")/.."

export E2E_PROJECT="${E2E_PROJECT:-os-e2e}"
export HTTP_PORT="${HTTP_PORT:-55902}"
export PUBLIC_ORIGIN="http://localhost:${HTTP_PORT}"
export PUBLIC_HOST="localhost:${HTTP_PORT}"
export OS_HOSTNAME="localhost"
export E2E_ORIGIN="${PUBLIC_ORIGIN}"
export E2E_POSTGRES_PORT="${E2E_POSTGRES_PORT:-55900}"
export E2E_ANVIL_PORT="${E2E_ANVIL_PORT:-55901}"
export E2E_ANVIL_URL="http://127.0.0.1:${E2E_ANVIL_PORT}"

overlay=(-f compose.yaml -f e2e/compose.e2e.yaml --profile dev --profile agent)
compose=(docker compose -p "$E2E_PROJECT" "${overlay[@]}")
ui=(docker compose -p "${E2E_PROJECT}-ui" "${overlay[@]}")
# `init` is not listed: it runs once and exits, and the others depend on it.
services=(postgres signer server caddy agent-gateway anvil)

remove() {
  for project in "$E2E_PROJECT" "${E2E_PROJECT}-restore" "${E2E_PROJECT}-ui"; do
    docker compose -p "$project" "${overlay[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  done
}

logs() {
  for project in "$E2E_PROJECT" "${E2E_PROJECT}-restore" "${E2E_PROJECT}-ui"; do
    docker compose -p "$project" "${overlay[@]}" \
      logs --no-color --tail 300 server signer caddy agent-gateway 2>/dev/null || true
  done
}

remove
"${compose[@]}" build

status=0

# First stack: the gates that drive people through the API. The backup gate ends on a restored
# copy of this stack under a second project name.
# A stack that does not come up healthy is a failed gate too: its logs are printed below.
"${compose[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
if [ "$status" -eq 0 ]; then
  (cd e2e && bunx playwright test release-gates.spec.ts) || status=$?
fi

# Second stack, empty: the browser gate, which claims a fresh installation through the UI.
if [ "$status" -eq 0 ]; then
  remove
  "${ui[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
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
