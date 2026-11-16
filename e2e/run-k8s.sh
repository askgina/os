#!/usr/bin/env bash
# The control plane on Kubernetes, proven on kind (specs/beyond-one-machine.md):
# build the images, start a throwaway kind cluster, load the images into it, apply
# deploy/k8s/overlays/kind, create its Secrets, wait for every workload, publish the two origins
# with `kubectl port-forward`, run e2e/test/kubernetes.spec.ts, and delete the cluster again. On
# failure it prints every object, the description of every pod that is not ready and the logs of
# every container.
#   ./e2e/run-k8s.sh           build, start, test, delete
#   ./e2e/run-k8s.sh --keep    leave the cluster running afterwards, for looking around
#   ./e2e/run-k8s.sh --ha      the same with Postgres as a CloudNativePG cluster:
#                              installs the operator, applies deploy/k8s/overlays/kind-ha and runs
#                              e2e/test/kubernetes-ha.spec.ts instead
# Needs docker, kind, kubectl, curl and sha256sum on PATH; the versions CI pins are in
# .github/workflows/ci.yml, the operator's here.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${E2E_K8S_CLUSTER:-os-e2e}"
# kind v0.33.0's node image for Kubernetes 1.37.0, by digest as kind's release notes ask.
NODE_IMAGE="kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
OVERLAY="deploy/k8s/overlays/kind"
SPEC="kubernetes.spec.ts"
# The CloudNativePG operator for --ha: its release manifest by SHA-256, and the operator image
# that manifest names by tag, pinned here by digest.
CNPG_VERSION="1.30.1"
CNPG_MANIFEST_SHA256="37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb"
CNPG_OPERATOR_IMAGE="ghcr.io/cloudnative-pg/cloudnative-pg:${CNPG_VERSION}"
CNPG_OPERATOR_DIGEST="sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07"
# The documentation addresses components/postgres-cnpg holds for the Kubernetes API.
API_SERVICE_PLACEHOLDER="192.0.2.50/32"
API_ENDPOINT_PLACEHOLDER="192.0.2.51/32"
# The origins the overlay's configuration names, as the Compose gates use them (e2e/run.sh).
HTTP_PORT=25902
APPROVE_HTTP_PORT=25903
ANVIL_PORT=25901
export E2E_ORIGIN="http://localhost:${HTTP_PORT}"
export APPROVE_ORIGIN="http://localhost:${APPROVE_HTTP_PORT}"
export E2E_ANVIL_URL="http://127.0.0.1:${ANVIL_PORT}"
NAMESPACES=(os os-agents os-signer os-probe)
IMAGES=(askgina-os-server:local askgina-os-signer:local askgina-os-approve:local)

forwards=()
logdir="$(mktemp -d)"
workdir="$(mktemp -d)"
ha=0

diagnose() {
  echo "::group::kubectl get all,networkpolicy,pvc --all-namespaces"
  kubectl get all,networkpolicy,pvc --all-namespaces -o wide || true
  echo "::endgroup::"
  if [ "$ha" = "1" ]; then
    # The operator's view: phase, instances, current and target primary, conditions.
    echo "::group::kubectl get clusters.postgresql.cnpg.io --namespace os -o yaml"
    kubectl get clusters.postgresql.cnpg.io --namespace os -o yaml || true
    echo "::endgroup::"
    echo "::group::kubectl get jobs,leases --namespace os"
    kubectl get jobs,leases --namespace os -o wide || true
    echo "::endgroup::"
  fi
  echo "::group::events"
  kubectl get events --all-namespaces --sort-by=.lastTimestamp || true
  echo "::endgroup::"
  for namespace in "${NAMESPACES[@]}"; do
    local pods
    pods="$(kubectl get pods --namespace "$namespace" -o name 2>/dev/null || true)"
    for pod in $pods; do
      local ready
      ready="$(kubectl get --namespace "$namespace" "$pod" \
        -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
      if [ "$ready" != "True" ]; then
        echo "::group::describe ${namespace}/${pod}"
        kubectl describe --namespace "$namespace" "$pod" || true
        echo "::endgroup::"
      fi
      echo "::group::logs ${namespace}/${pod}"
      kubectl logs --namespace "$namespace" "$pod" --all-containers --prefix --timestamps || true
      kubectl logs --namespace "$namespace" "$pod" --all-containers --prefix --previous \
        2>/dev/null || true
      echo "::endgroup::"
    done
  done
  # The network plugin enforces the policies; its log says when it skipped them.
  echo "::group::logs kube-system/kindnet"
  kubectl logs --namespace kube-system --selector app=kindnet --all-containers --prefix \
    --tail=300 || true
  echo "::endgroup::"
  for log in "$logdir"/*.log; do
    [ -e "$log" ] || continue
    echo "::group::$(basename "$log")"
    cat "$log"
    echo "::endgroup::"
  done
}

finish() {
  local status=$?
  for pid in "${forwards[@]}"; do
    # The loop first, then its `kubectl`, which would otherwise outlive it.
    kill -STOP "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done
  if [ "$status" -ne 0 ]; then
    diagnose
  fi
  if [ "$keep" != "1" ]; then
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
  rm -rf "$logdir" "$workdir"
  exit "$status"
}

keep=0
for argument in "$@"; do
  case "$argument" in
    --keep) keep=1 ;;
    --ha) ha=1 ;;
    *)
      echo "usage: e2e/run-k8s.sh [--keep] [--ha]" >&2
      exit 1
      ;;
  esac
done
if [ "$ha" = "1" ]; then
  OVERLAY="deploy/k8s/overlays/kind-ha"
  SPEC="kubernetes-ha.spec.ts"
  NAMESPACES+=(cnpg-system)
fi
trap finish EXIT

# One `kubectl port-forward` to a Service; restarted if it dies (it follows one pod).
forward() {
  local namespace="$1" service="$2" ports="$3"
  (
    while true; do
      kubectl port-forward --namespace "$namespace" "service/${service}" "$ports" \
        >>"${logdir}/port-forward-${service}.log" 2>&1 || true
      sleep 1
    done
  ) &
  forwards+=("$!")
}

# Wait until `url` answers 200, for up to `seconds`.
answers() {
  local url="$1" seconds="$2"
  for _ in $(seq 1 "$seconds"); do
    if curl -fsS -o /dev/null --max-time 2 "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "no answer from ${url} after ${seconds} seconds" >&2
  return 1
}

for image in server signer approve; do
  docker build --file "apps/${image}/Dockerfile" --tag "askgina-os-${image}:local" .
done

kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 180s
kubectl config use-context "kind-${CLUSTER}"
kind load docker-image --name "$CLUSTER" "${IMAGES[@]}"

# The CloudNativePG operator, from its release manifest checked against the pinned digest, with
# its own image pinned by digest too. Applied server-side, as its CRDs are too large for the
# annotation a client-side apply writes.
install_operator() {
  local started="$SECONDS" manifest="${workdir}/cnpg-${CNPG_VERSION}.yaml"
  curl -fsSLo "$manifest" \
    "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}/cnpg-${CNPG_VERSION}.yaml"
  echo "${CNPG_MANIFEST_SHA256}  ${manifest}" | sha256sum --check --strict
  sed -i "s#${CNPG_OPERATOR_IMAGE}\$#${CNPG_OPERATOR_IMAGE}@${CNPG_OPERATOR_DIGEST}#" "$manifest"
  # The Deployment's image and OPERATOR_IMAGE_NAME, which the instances' init container uses.
  local pinned
  pinned="$(grep -c "${CNPG_OPERATOR_IMAGE}@${CNPG_OPERATOR_DIGEST}\$" "$manifest" || true)"
  if [ "$pinned" != "2" ] || grep -q "${CNPG_OPERATOR_IMAGE}\$" "$manifest"; then
    echo "the operator manifest names its image ${pinned} times, not the 2 this pins" >&2
    return 1
  fi
  kubectl apply --server-side --filename "$manifest"
  kubectl rollout status --namespace cnpg-system deployment/cnpg-controller-manager --timeout=300s
  echo "CloudNativePG ${CNPG_VERSION} running after $((SECONDS - started)) seconds"
}

# The overlay with components/postgres-cnpg's placeholders for the Kubernetes API replaced by
# this cluster's addresses: the Service's cluster address on 443 and its endpoint on 6443.
render_ha() {
  local service endpoint port rendered="${workdir}/kind-ha.yaml"
  service="$(kubectl get service --namespace default kubernetes -o jsonpath='{.spec.clusterIP}')"
  endpoint="$(kubectl get endpointslices --namespace default \
    --selector kubernetes.io/service-name=kubernetes \
    -o jsonpath='{.items[0].endpoints[0].addresses[0]}')"
  port="$(kubectl get endpointslices --namespace default \
    --selector kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].ports[0].port}')"
  echo "Kubernetes API: ${service}:443, endpoint ${endpoint}:${port}" >&2
  if [ -z "$service" ] || [ -z "$endpoint" ] || [ "$port" != "6443" ]; then
    echo "unexpected Kubernetes API address: '${service}', '${endpoint}:${port}'" >&2
    return 1
  fi
  kubectl kustomize "$OVERLAY" \
    | sed -e "s#${API_SERVICE_PLACEHOLDER}#${service}/32#" \
      -e "s#${API_ENDPOINT_PLACEHOLDER}#${endpoint}/32#" >"$rendered"
  if grep -q -e "$API_SERVICE_PLACEHOLDER" -e "$API_ENDPOINT_PLACEHOLDER" "$rendered" ||
    ! grep -q "cidr: ${endpoint}/32" "$rendered"; then
    echo "the Kubernetes API's addresses were not filled into ${OVERLAY}" >&2
    return 1
  fi
  echo "$rendered"
}

if [ "$ha" = "1" ]; then
  install_operator
  rendered="$(render_ha)"
  # The operator's admission webhook may refuse for a few seconds after its pod is Ready.
  applied=0
  for _ in $(seq 1 30); do
    if kubectl apply --filename "$rendered"; then
      applied=1
      break
    fi
    sleep 2
  done
  if [ "$applied" != "1" ]; then
    echo "${OVERLAY} could not be applied in 60 seconds" >&2
    exit 1
  fi
else
  kubectl apply --kustomize "$OVERLAY"
fi
./deploy/k8s/make-secrets.sh

if [ "$ha" = "1" ]; then
  # Three instances: the image pull, initdb on the first and two copies from it.
  started="$SECONDS"
  kubectl wait --namespace os clusters.postgresql.cnpg.io/os-db --for=condition=Ready \
    --timeout=900s
  echo "os-db Ready with its instances after $((SECONDS - started)) seconds"
else
  kubectl rollout status --namespace os statefulset/postgres --timeout=300s
fi
kubectl rollout status --namespace os deployment/anvil --timeout=300s
kubectl rollout status --namespace os-signer statefulset/signer --timeout=300s
kubectl rollout status --namespace os-signer deployment/approve --timeout=300s
kubectl rollout status --namespace os-signer deployment/approve-edge --timeout=300s
kubectl rollout status --namespace os deployment/server --timeout=300s
kubectl rollout status --namespace os deployment/edge --timeout=300s
kubectl rollout status --namespace os-agents deployment/agent-gateway --timeout=300s

forward os edge "${HTTP_PORT}:8080"
forward os-signer approve-edge "${APPROVE_HTTP_PORT}:8081"
forward os anvil "${ANVIL_PORT}:8545"
answers "${E2E_ORIGIN}/readyz" 120
answers "${APPROVE_ORIGIN}/healthz" 60
chain_ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 2 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$E2E_ANVIL_URL"; then
    chain_ready=1
    break
  fi
  sleep 1
done
if [ "$chain_ready" != "1" ]; then
  echo "no answer from the chain at ${E2E_ANVIL_URL} after 60 seconds" >&2
  exit 1
fi

(cd e2e && bunx playwright test "$SPEC")
