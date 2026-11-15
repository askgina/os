#!/usr/bin/env bash
# Make the three self-signed certificates of a split deployment's mutual TLS: the signer's, the
# control plane's and the `approve` service's. Each side trusts exactly the other's certificate,
# so there is no certificate authority and no CA key to guard.
#   deploy/split/make-peer-certs.sh <signer host name> [output directory]
# The signer's certificate names <signer host name> (what the control plane's SIGNER_URL uses)
# and `signer` (what `approve` uses on the signer host's internal network). Existing files are
# never overwritten. Prints each certificate's SHA-256 fingerprint and where each file goes.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <signer host name> [output directory]" >&2
  exit 2
fi
signer_host="$1"
out="${2:-.}"
if ! [[ "$signer_host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "not a host name: $signer_host" >&2
  exit 2
fi

for name in signer control approve; do
  for file in "$out/$name.crt" "$out/$name.key"; do
    if [ -e "$file" ]; then
      echo "refusing to overwrite $file" >&2
      exit 1
    fi
  done
done
mkdir -p "$out"
umask 077

make_cert() {
  local name="$1" common_name="$2"
  shift 2
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 730 \
    -subj "/CN=$common_name" "$@" -keyout "$out/$name.key" -out "$out/$name.crt"
  chmod 0400 "$out/$name.key" "$out/$name.crt"
  fingerprint="$(openssl x509 -in "$out/$name.crt" -noout -fingerprint -sha256)"
  echo "$name.crt SHA-256 ${fingerprint#*=}"
}

make_cert signer os-signer -addext "subjectAltName=DNS:$signer_host,DNS:signer"
make_cert control os-control
make_cert approve os-approve

cat <<EOF

Signer host: signer.crt, signer.key, control.crt, approve.crt (the signer);
             approve.crt, approve.key, signer.crt (the approve service).
Control host: control.crt, control.key, signer.crt. The keys never leave their host.
EOF
