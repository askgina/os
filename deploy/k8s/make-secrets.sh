#!/usr/bin/env bash
# Creates the Secrets of a cluster that holds every trust domain (overlays/kind: CI and
# evaluation only, decision D4) from one run of deploy/init/init.mjs, the files Compose's `init`
# writes, in a throwaway container with no network. Apply the overlay first, so the namespaces
# exist. Nothing is printed but Secret names; the files never outlive the run.
#
#   deploy/k8s/make-secrets.sh    against the current kubectl context
#
# The four Secrets share two values (the signer's request secret, the confirm secret), so they
# are made together or not at all: when all exist the run changes nothing, and when only some
# exist it stops rather than make values the others do not share.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The image Compose runs `init` with (compose.yaml).
NODE_IMAGE="node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc"

secrets=(os/os-server-secrets os/os-db-secrets os-signer/os-signer-secrets os-signer/os-approve-secrets)
present=0
for secret in "${secrets[@]}"; do
  if kubectl get secret -n "${secret%%/*}" "${secret#*/}" >/dev/null 2>&1; then
    present=$((present + 1))
  fi
done
if [ "$present" -eq "${#secrets[@]}" ]; then
  echo "every Secret exists; nothing changed"
  exit 0
fi
if [ "$present" -ne 0 ]; then
  echo "only some of ${secrets[*]} exist; delete them all or restore the missing ones" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/server" "$work/signer" "$work/approve" "$work/db" "$work/data"
# init.mjs gives each file to the user of the service that reads it; the copies here go back to
# the user running this script, so kubectl can read them.
docker run --rm --network none --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  -v "$PWD/deploy/init:/init:ro" \
  -v "$work/server:/secrets/server" \
  -v "$work/signer:/secrets/signer" \
  -v "$work/approve:/secrets/approve" \
  -v "$work/db:/secrets/db" \
  -v "$work/data:/data/signer" \
  "$NODE_IMAGE" \
  sh -c 'node /init/init.mjs >/dev/null && chown -R "$0:$1" /secrets /data/signer' \
  "$(id -u)" "$(id -g)"

create() {
  local namespace="$1" name="$2" dir="$3"
  shift 3
  local files=()
  for file in "$@"; do
    files+=("--from-file=${file}=${dir}/${file}")
  done
  kubectl create secret generic -n "$namespace" "$name" "${files[@]}" >/dev/null
  echo "created Secret ${namespace}/${name}"
}

create os os-server-secrets "$work/server" \
  keyring.json signer-request-secret postgres-password notify-webhook-secret vapid-key.pem
create os os-db-secrets "$work/db" postgres-password
create os-signer os-signer-secrets "$work/signer" \
  signer-request-secret confirm-request-secret token-key vault-passphrase
create os-signer os-approve-secrets "$work/approve" confirm-request-secret
