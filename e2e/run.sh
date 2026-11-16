#!/usr/bin/env bash
# Start the whole stack as a throwaway Compose project, run the release gates against it, and
# remove it again.
#   ./e2e/run.sh           build, start, test, remove
#   ./e2e/run.sh --keep    leave the stack running afterwards, for looking around
#   E2E_TLS=1 ./e2e/run.sh the browser gate only, over HTTPS with compose.tls.yaml (ports 80, 443)
#   E2E_SPLIT=1 ./e2e/run.sh the split gates and the release gates, with the signer and its
#                            confirmation page in a second project (deploy/split), as on their
#                            own host; needs `openssl`, and `sudo nft` for the nftables gate
#   E2E_REPLICAS=1 ./e2e/run.sh  the replica gates, then the release gates, each on a fresh
#                            stack with two server replicas (e2e/compose.replicas.yaml)
#   E2E_OPENBAO=1 ./e2e/run.sh   the OpenBao gates, then the release gates, each on a fresh
#                            stack whose keys live in OpenBao Transit (e2e/compose.openbao.yaml)
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
split="${E2E_SPLIT:-0}"
export E2E_SPLIT="$split"
export E2E_REPLICAS="${E2E_REPLICAS:-0}"
export E2E_OPENBAO="${E2E_OPENBAO:-0}"
export E2E_OPENBAO_PORT="${E2E_OPENBAO_PORT:-55905}"
# The fake Hyperliquid testnet and mainnet venues of the venue gates' stack
# (e2e/compose.venue.yaml), on the loopback.
export E2E_VENUE_PORT="${E2E_VENUE_PORT:-55906}"
export E2E_VENUE_MAINNET_PORT="${E2E_VENUE_MAINNET_PORT:-55907}"
# A variant whose own gates run on a stack of their own before the release gates: `replicas` or
# `openbao`, or none.
variant=""
if [ "$E2E_REPLICAS" = "1" ]; then variant="replicas"; fi
if [ "$E2E_OPENBAO" = "1" ]; then variant="openbao"; fi
selected=0
for flag in "$tls" "$split" "$E2E_REPLICAS" "$E2E_OPENBAO"; do
  if [ "$flag" = "1" ]; then selected=$((selected + 1)); fi
done
if [ "$selected" -gt 1 ]; then
  echo "E2E_TLS, E2E_SPLIT, E2E_REPLICAS and E2E_OPENBAO are separate runs" >&2
  exit 2
fi
overlay=(-f compose.yaml -f e2e/compose.e2e.yaml --profile dev --profile agent)
if [ "$E2E_REPLICAS" = "1" ]; then
  overlay=(-f compose.yaml -f e2e/compose.e2e.yaml -f e2e/compose.replicas.yaml --profile dev --profile agent)
fi
if [ "$E2E_OPENBAO" = "1" ]; then
  overlay=(-f compose.yaml -f e2e/compose.e2e.yaml -f e2e/compose.openbao.yaml --profile dev --profile agent)
fi
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
signer_overlay=()
if [ "$split" = "1" ]; then
  # Two projects, as two hosts: the control plane, and `<project>-signer` with the signer, the
  # confirmation page and its edge. They share one internal network, which only the server and
  # the signer join, the signer under the name in its certificate.
  export SIGNER_HOSTNAME="os-signer-host"
  export E2E_WIRE_NETWORK="${E2E_PROJECT}-wire"
  # Required by signer.compose.yaml; the e2e overlay publishes nothing.
  export SIGNER_BIND_ADDRESS="127.0.0.1"
  E2E_SPLIT_DIR="$(mktemp -d)"
  export E2E_SPLIT_DIR
  # What the operator puts on each host (deploy/split/make-peer-certs.sh).
  export SIGNER_HOST_FILES="${E2E_SPLIT_DIR}/signer-host"
  export CONTROL_HOST_FILES="${E2E_SPLIT_DIR}/control-host"
  overlay=(-f deploy/split/control.compose.yaml -f e2e/compose.split-control.yaml --profile dev --profile agent)
  signer_overlay=(-f deploy/split/signer.compose.yaml -f e2e/compose.split-signer.yaml)
fi
compose=(docker compose -p "$E2E_PROJECT" "${overlay[@]}")
ui=(docker compose -p "${E2E_PROJECT}-ui" "${overlay[@]}")
# The lifecycle gates' stack: the plain one with Web Push on (e2e/compose.lifecycle.yaml), so
# erasing a person can remove a device they added. Only without TLS, split or a variant.
lifecycle=(docker compose -p "${E2E_PROJECT}-lifecycle" -f compose.yaml -f e2e/compose.e2e.yaml -f e2e/compose.lifecycle.yaml --profile dev --profile agent)
# The venue gates' stack: the plain one plus the fake Hyperliquid testnet and mainnet venues and
# the server's VENUES_FILE naming both (e2e/compose.venue.yaml). Only without TLS, split or a
# variant.
venue=(docker compose -p "${E2E_PROJECT}-venue" -f compose.yaml -f e2e/compose.e2e.yaml -f e2e/compose.venue.yaml --profile dev --profile agent)
# `init` is not listed: it runs once and exits, and the others depend on it; so do
# `openbao-bootstrap` and the server.
services=(postgres signer approve server caddy agent-gateway anvil)
logged=(server signer approve caddy agent-gateway)
if [ "$E2E_OPENBAO" = "1" ]; then
  services+=(openbao)
  logged+=(openbao openbao-bootstrap)
fi
projects=("$E2E_PROJECT" "${E2E_PROJECT}-restore" "${E2E_PROJECT}-lifecycle" "${E2E_PROJECT}-venue" "${E2E_PROJECT}-ui")
if [ -n "$variant" ]; then
  projects+=("${E2E_PROJECT}-${variant}")
fi

remove() {
  for project in "${projects[@]}"; do
    docker compose -p "$project" "${overlay[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    if [ "$split" = "1" ]; then
      docker compose -p "${project}-signer" "${signer_overlay[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  done
  if [ "$split" = "1" ]; then
    docker network rm "$E2E_WIRE_NETWORK" >/dev/null 2>&1 || true
  fi
}

logs() {
  for project in "${projects[@]}"; do
    if [ "$split" = "1" ]; then
      docker compose -p "$project" "${overlay[@]}" \
        logs --no-color --tail 300 init server caddy agent-gateway 2>/dev/null || true
      docker compose -p "${project}-signer" "${signer_overlay[@]}" \
        logs --no-color --tail 300 init signer approve caddy 2>/dev/null || true
    elif [ "$project" = "${E2E_PROJECT}-venue" ]; then
      # With the fake venues' own logs; the venue gates print what they took when one fails.
      "${venue[@]}" logs --no-color --tail 300 "${logged[@]}" fake-hyperliquid fake-hyperliquid-mainnet 2>/dev/null || true
    else
      # Every container of each service: with two replicas, both servers.
      docker compose -p "$project" "${overlay[@]}" \
        logs --no-color --tail 300 "${logged[@]}" 2>/dev/null || true
    fi
  done
}

remove
"${compose[@]}" build
if [ "$split" = "1" ]; then
  docker compose -p "${E2E_PROJECT}-signer" "${signer_overlay[@]}" build
fi

status=0

# First stack: the gates that drive people through the API. The backup gate ends on a restored
# copy of this stack under a second project name.
# A stack that does not come up healthy is a failed gate too: its logs are printed below.
# Over HTTPS this part is skipped: the gates below it do not depend on the scheme, and the backup
# gate's restored copy would get a new certificate authority.
if [ "$split" = "1" ]; then
  # Split: the same release gates, with the signer and its confirmation page in the second
  # project, after the split gates. Each set runs whatever the other found.
  signer=(docker compose -p "${E2E_PROJECT}-signer" "${signer_overlay[@]}")
  mkdir -p "$SIGNER_HOST_FILES" "$CONTROL_HOST_FILES"
  ./deploy/split/make-peer-certs.sh "$SIGNER_HOSTNAME" "${E2E_SPLIT_DIR}/certs" >/dev/null
  # A second set nobody trusts, for the gate that a stranger on the wire cannot get in.
  ./deploy/split/make-peer-certs.sh "$SIGNER_HOSTNAME" "${E2E_SPLIT_DIR}/stranger" >/dev/null
  for file in signer.crt signer.key control.crt approve.crt approve.key; do
    cp "${E2E_SPLIT_DIR}/certs/${file}" "$SIGNER_HOST_FILES/"
  done
  for file in control.crt control.key signer.crt; do
    cp "${E2E_SPLIT_DIR}/certs/${file}" "$CONTROL_HOST_FILES/"
  done
  docker network create --internal "$E2E_WIRE_NETWORK" >/dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    "${signer[@]}" up -d --wait --wait-timeout 300 signer approve caddy || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    # The operator copies the signer's request secret to the control host, and nothing else.
    "${signer[@]}" exec -T signer cat /run/secrets/signer/signer-request-secret \
      >"${CONTROL_HOST_FILES}/signer-request-secret" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    "${compose[@]}" up -d --wait --wait-timeout 300 postgres server caddy agent-gateway anvil || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    # Each its own results directory: one run would clear the other's failure trace.
    (cd e2e && bunx playwright test split.spec.ts --output test-results/split) || status=$?
    (cd e2e && bunx playwright test release-gates.spec.ts --output test-results/release-gates) || status=$?
  fi
elif [ -n "$variant" ]; then
  # The variant's own gates on a fresh stack: they claim the installation themselves. Then,
  # only if they pass, every release gate on another fresh stack of the same kind.
  own=(docker compose -p "${E2E_PROJECT}-${variant}" "${overlay[@]}")
  "${own[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-${variant}" bunx playwright test "${variant}.spec.ts") || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    remove
    "${compose[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    (cd e2e && bunx playwright test release-gates.spec.ts) || status=$?
  fi
elif [ "$tls" != "1" ]; then
  "${compose[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && bunx playwright test release-gates.spec.ts) || status=$?
  fi
fi

# Second stack, empty: the lifecycle gates, which claim a fresh installation, end workspaces and
# wallets for good, and rotate the keyring. They cannot follow the gates above on the first
# stack: that ends as a restored copy behind an operator's fence, and its people's passkeys live
# only in the memory of the run above. Skipped over HTTPS, like the first stack, and split: the
# split changes where the signer runs, not what the lifecycle gates prove. Skipped for a variant
# too: its own gates and the release gates are what it changes.
if [ "$tls" != "1" ] && [ "$split" != "1" ] && [ -z "$variant" ] && [ "$status" -eq 0 ]; then
  remove
  "${lifecycle[@]}" up -d --wait --wait-timeout 300 "${services[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-lifecycle" E2E_LIFECYCLE=1 bunx playwright test lifecycle.spec.ts) || status=$?
  fi
fi

# Third stack, empty: the venue gates (specs/non-evm-operations.md), with fake Hyperliquid testnet
# and mainnet venues that check every signature themselves (e2e/compose.venue.yaml). Only this
# stack names a venue, so every other gate runs as a deployment without VENUES_FILE does. Skipped
# over HTTPS, split and for a variant, like the lifecycle gates: those change how the stack is
# laid out, not what an order proves.
if [ "$tls" != "1" ] && [ "$split" != "1" ] && [ -z "$variant" ] && [ "$status" -eq 0 ]; then
  remove
  "${venue[@]}" up -d --wait --wait-timeout 300 "${services[@]}" fake-hyperliquid fake-hyperliquid-mainnet || status=$?
  if [ "$status" -eq 0 ]; then
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-venue" E2E_VENUE=1 bunx playwright test venue.spec.ts) || status=$?
  fi
fi

# Fourth stack, empty: the browser gate, which claims a fresh installation through the UI.
# Skipped split: the release gates already approve on the signer project's confirmation page.
# Skipped for a variant: the browser drives the same API through the same edge.
if [ "$split" != "1" ] && [ -z "$variant" ] && [ "$status" -eq 0 ]; then
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
    # Chromium fails every request in flight with ERR_NETWORK_CHANGED when an address on this
    # machine changes, and each container's interface gets its IPv6 address about a second after
    # the container starts. Wait until no address is still being assigned.
    for _ in $(seq 1 40); do
      [ -z "$(ip -6 addr show tentative 2>/dev/null)" ] && break
      sleep 0.5
    done
    (cd e2e && E2E_PROJECT="${E2E_PROJECT}-ui" bunx playwright test browser.spec.ts) || status=$?
  fi
fi

if [ "$status" -ne 0 ]; then
  logs
fi
if [ "${1:-}" != "--keep" ]; then
  remove
  if [ "$split" = "1" ]; then
    rm -rf "$E2E_SPLIT_DIR"
  fi
fi
exit "$status"
