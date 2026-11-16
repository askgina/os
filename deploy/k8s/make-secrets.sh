#!/usr/bin/env bash
# Creates the Secrets of a cluster that holds every trust domain (overlays/kind: CI and
# evaluation only) from one run of deploy/init/init.mjs, the files Compose's `init`
# writes, in a throwaway container with no network. Apply the overlay first, so the namespaces
# exist. Prints init.mjs's file names and the Secret names, never a value; on failure, the step.
#
#   deploy/k8s/make-secrets.sh    against the current kubectl context
#
# The four Secrets share two values (the signer's request secret, the confirm secret), so they
# are made together or not at all: when all exist the run changes nothing, and when only some
# exist it stops rather than make values the others do not share.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."

step="starting"
trap 'status=$?; echo "make-secrets.sh: failed while ${step} (exit ${status}, line ${LINENO})" >&2' ERR

# The image Compose runs `init` with (compose.yaml).
NODE_IMAGE="node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc"

step="checking which Secrets exist"
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

# Every path init.mjs (--domain=all, the default) writes, chowns or chmods is a tmpfs inside the
# container: the four secret directories and the signer's data directory, whose ownership it
# sets. It reads only /init (the script, read-only); /import is for split hosts and unused here.
# The root file system stays read-only. init.mjs gives each file to the user of the service that
# reads it; the container then streams the four directories out as a tar, which the user running
# this script unpacks as its own, so no file here is ever owned by another user. init.mjs's own
# lines (file names and whether each was created) go to stderr.
step="generating the files with deploy/init/init.mjs"
docker run --rm --network none --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --tmpfs /secrets/server --tmpfs /secrets/signer --tmpfs /secrets/approve \
  --tmpfs /secrets/db --tmpfs /data/signer \
  -v "$PWD/deploy/init:/init:ro" \
  "$NODE_IMAGE" \
  sh -c 'node /init/init.mjs >&2 && tar -C /secrets -cf - server signer approve db' |
  tar -C "$work" -xf -

create() {
  local namespace="$1" name="$2" dir="$3"
  shift 3
  step="creating Secret ${namespace}/${name}"
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
