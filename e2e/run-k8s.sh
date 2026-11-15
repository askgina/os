#!/usr/bin/env bash
# The control plane on Kubernetes, proven on kind (specs/beyond-one-machine.md, milestone 5):
# build the images, start a throwaway kind cluster, load the images into it, apply
# deploy/k8s/overlays/kind, create its Secrets, wait for every workload, publish the two origins
# with `kubectl port-forward`, run e2e/test/kubernetes.spec.ts, and delete the cluster again. On
# failure it prints every object, the description of every pod that is not ready and the logs of
# every container.
#   ./e2e/run-k8s.sh           build, start, test, delete
#   ./e2e/run-k8s.sh --keep    leave the cluster running afterwards, for looking around
# Needs docker, kind and kubectl on PATH; the versions CI pins are in .github/workflows/ci.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${E2E_K8S_CLUSTER:-os-e2e}"
# kind v0.33.0's node image for Kubernetes 1.37.0, by digest as kind's release notes ask.
NODE_IMAGE="kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
OVERLAY="deploy/k8s/overlays/kind"
# The origins the overlay's configuration names, as the Compose gates use them (e2e/run.sh).
HTTP_PORT=55902
APPROVE_HTTP_PORT=55903
ANVIL_PORT=55901
export E2E_ORIGIN="http://localhost:${HTTP_PORT}"
export APPROVE_ORIGIN="http://localhost:${APPROVE_HTTP_PORT}"
export E2E_ANVIL_URL="http://127.0.0.1:${ANVIL_PORT}"
NAMESPACES=(os os-agents os-signer os-probe)
IMAGES=(askgina-os-server:local askgina-os-signer:local askgina-os-approve:local)

forwards=()
logdir="$(mktemp -d)"

diagnose() {
  echo "::group::kubectl get all,networkpolicy,pvc --all-namespaces"
  kubectl get all,networkpolicy,pvc --all-namespaces -o wide || true
  echo "::endgroup::"
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
  rm -rf "$logdir"
  exit "$status"
}

keep=0
if [ "${1:-}" = "--keep" ]; then
  keep=1
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

kubectl apply --kustomize "$OVERLAY"
./deploy/k8s/make-secrets.sh

kubectl rollout status --namespace os statefulset/postgres --timeout=300s
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

(cd e2e && bunx playwright test kubernetes.spec.ts)
