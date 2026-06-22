#!/usr/bin/env bash
# Phase A live verification — re-runs the exact probes that found the security &
# resource-limits issues and asserts they are now FIXED on the running k3s stack.
# Requires: the compute stack up (k3s + KEDA + api with DROP_KUBECONFIG, dev-auth),
# kubectl, and node (for the drop CLI). Run after `make compute-up` + the api/edge.
# Node sizing: deploys 3 apps at the 512Mi default alongside KEDA — give the node
# ~4Gi+ allocatable memory (e.g. `podman machine set --memory 8192`) or the cold app
# stays Pending (Insufficient memory) and the scale-from-zero check times out.
set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:$PATH"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/drop-k3s.yaml}"
API="${DROP_API:-http://localhost:8473}"
DROP="node $(cd "$(dirname "$0")/../.." && pwd)/dist/drop.js"
fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

T=$(mktemp -d)
mkapp() { mkdir -p "$T/$1"; printf 'app:\n  image: %s\n  services:\n    - internal_port: %s\n      protocol: http\n  scale: { min: %s, max: 2 }\n  env: { OWNER_SECRET: %s }\n' "$2" "$3" "$4" "$1" > "$T/$1/drop.yaml"; }
mkapp alpha nginx:alpine 80 1
mkapp beta  nginx:alpine 80 1
mkapp coldapp nginx:alpine 80 0

echo "▸ deploy two apps under DIFFERENT owners (alice, bob) + a scale-to-zero app"
$DROP dev-login alice alice@example.com --api "$API" >/dev/null 2>&1
$DROP deploy "$T/alpha"   alpha   --api "$API" >/dev/null 2>&1 || bad "deploy alpha failed"
$DROP deploy "$T/coldapp" coldapp --api "$API" >/dev/null 2>&1 || bad "deploy coldapp failed"
$DROP dev-login bob bob@example.com --api "$API" >/dev/null 2>&1
$DROP deploy "$T/beta" beta --api "$API" >/dev/null 2>&1 || bad "deploy beta failed"

NS_A=$(kubectl get deploy -A -l app.kubernetes.io/name=alpha -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null)
NS_B=$(kubectl get deploy -A -l app.kubernetes.io/name=beta  -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null)
echo "  alpha ns=$NS_A   beta ns=$NS_B"

echo "▸ SEC-4: per-owner namespaces are distinct"
[ -n "$NS_A" ] && [ -n "$NS_B" ] && [ "$NS_A" != "$NS_B" ] && ok "alpha and beta are in different tenant namespaces" || bad "expected distinct per-owner namespaces"

echo "▸ SEC-1 / LIM-1 / LIM-2: isolation objects exist in the tenant ns"
kubectl get networkpolicy -n "$NS_A" --no-headers 2>/dev/null | grep -q . && ok "NetworkPolicy present" || bad "no NetworkPolicy"
kubectl get resourcequota  -n "$NS_A" --no-headers 2>/dev/null | grep -q . && ok "ResourceQuota present"  || bad "no ResourceQuota"
kubectl get limitrange     -n "$NS_A" --no-headers 2>/dev/null | grep -q . && ok "LimitRange present"     || bad "no LimitRange"

echo "▸ LIM-1: app has resource limits (never unbounded)"
LIM=$(kubectl get deploy alpha -n "$NS_A" -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}' 2>/dev/null)
[ -n "$LIM" ] && ok "alpha has a memory limit ($LIM)" || bad "alpha is unbounded (no limit)"

echo "▸ SEC-5: env is in a Secret, not inline in the pod spec"
kubectl get secret alpha-env -n "$NS_A" >/dev/null 2>&1 && ok "env Secret alpha-env exists" || bad "no env Secret"
INLINE=$(kubectl get deploy alpha -n "$NS_A" -o jsonpath='{.spec.template.spec.containers[0].env}' 2>/dev/null)
[ -z "$INLINE" ] && ok "no inline env in the pod spec" || bad "env is inline in the pod spec: $INLINE"

echo "▸ SEC-1: cross-tenant traffic is BLOCKED (alice's pod cannot reach bob's service)"
kubectl run xtenant -n "$NS_A" --image=curlimages/curl:latest --restart=Never --command -- sleep 600 >/dev/null 2>&1
kubectl wait --for=condition=Ready pod/xtenant -n "$NS_A" --timeout=90s >/dev/null 2>&1
code=$(kubectl exec -n "$NS_A" xtenant -- curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://beta.$NS_B.svc.cluster.local/" 2>/dev/null)
[ "$code" = "000" ] && ok "cross-tenant blocked (timeout, http $code)" || bad "cross-tenant REACHABLE (http $code) — NetworkPolicy not isolating"

echo "▸ SEC-1b: a tenant pod CANNOT reach the KEDA interceptor (egress allows only intra-ns/DNS/443)"
icode=$(kubectl exec -n "$NS_A" xtenant -- curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: coldapp.drop.localhost' http://keda-add-ons-http-interceptor-proxy.keda:8080/ 2>/dev/null)
[ "$icode" = "000" ] && ok "tenant->interceptor blocked by egress (http $icode) — defense in depth" || bad "tenant reached the interceptor on :8080 (http $icode) — egress too open"

echo "▸ scale-from-zero works THROUGH the per-app ingress policy (driven by the interceptor, as the edge does)"
echo -n "    waiting for coldapp -> 0"; for i in $(seq 1 40); do r=$(kubectl get deploy coldapp -n "$NS_A" -o jsonpath='{.status.replicas}' 2>/dev/null); { [ -z "$r" ] || [ "$r" = "0" ]; } && break; printf '.'; sleep 3; done; echo
# The interceptor lives in the keda ns — reachable by the platform EDGE, not by tenants
# (proved above). Port-forward it here to stand in for the edge and wake the cold app.
kubectl port-forward -n keda svc/keda-add-ons-http-interceptor-proxy 18080:8080 >/tmp/drop-verify-pf.log 2>&1 &
PF=$!; trap 'kill $PF 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s -o /dev/null --max-time 1 http://localhost:18080/ 2>/dev/null && break; sleep 1; done
wake=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -H 'Host: coldapp.drop.localhost' http://localhost:18080/ 2>/dev/null)
kill $PF 2>/dev/null; trap - EXIT
[ "$wake" = "200" ] && ok "cold app woke 0->1 through the interceptor (http $wake)" || bad "wake-from-zero failed (http $wake) — interceptor/ingressPolicy issue"

kubectl delete pod xtenant -n "$NS_A" --ignore-not-found >/dev/null 2>&1
rm -rf "$T"
echo; [ "$fail" = 0 ] && echo "ALL ISOLATION CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
