#!/usr/bin/env bash
# Phase B live verification — apps serve through the Drop EDGE like static sites.
# Proves the full path: edge -> KEDA interceptor -> tenant app, including waking a
# scaled-to-zero app from a cold request, while type=site hostnames keep serving
# the static path unchanged.
#
# Local wiring (the edge needs to reach the in-cluster interceptor):
#   1. kubectl port-forward -n keda svc/keda-add-ons-http-interceptor-proxy 18080:8080 &
#   2. start the edge pointed at it:
#        DROP_INTERCEPTOR_URL=http://localhost:18080 DROP_BASE_DOMAIN=drop.localhost \
#        DROP_DATABASE_URL=... DROP_S3_* ... node dist/edge.js   # on :8474
#   3. start the api with DROP_KUBECONFIG (compute) + dev-auth.
# In prod the ingress/ALB fronts the edge and the edge resolves the interceptor by
# in-cluster DNS — no port-forward needed.
set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:$PATH"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/drop-k3s.yaml}"
API="${DROP_API:-http://localhost:8473}"
EDGE="${DROP_EDGE:-http://localhost:8474}"
BASE="${DROP_BASE_DOMAIN:-drop.localhost}"
DROP="node $(cd "$(dirname "$0")/../.." && pwd)/dist/drop.js"
fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

# Preflight: edge must be up (with DROP_INTERCEPTOR_URL set — see header).
[ "$(curl -s -o /dev/null -w '%{http_code}' "$EDGE/_drop_health" 2>/dev/null)" = "200" ] \
  || { echo "✗ edge not reachable at $EDGE (start dist/edge.js with DROP_INTERCEPTOR_URL — see header)"; exit 1; }

T=$(mktemp -d)
mkdir -p "$T/edgecold"
printf 'app:\n  image: nginx:alpine\n  services:\n    - internal_port: 80\n      protocol: http\n  scale: { min: 0, max: 2 }\n' > "$T/edgecold/drop.yaml"

echo "▸ deploy a scale-to-zero app (alice)"
$DROP dev-login alice alice@example.com --api "$API" >/dev/null 2>&1
$DROP deploy "$T/edgecold" edgecold --api "$API" >/dev/null 2>&1 || bad "deploy edgecold failed"
NS=$(kubectl get deploy -A -l app.kubernetes.io/name=edgecold -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null)
[ -n "$NS" ] && ok "edgecold deployed (ns=$NS)" || bad "edgecold not found in any namespace"

echo -n "▸ wait for edgecold -> 0 replicas"
for i in $(seq 1 40); do r=$(kubectl get deploy edgecold -n "$NS" -o jsonpath='{.status.replicas}' 2>/dev/null); { [ -z "$r" ] || [ "$r" = "0" ]; } && break; printf '.'; sleep 3; done; echo
r=$(kubectl get deploy edgecold -n "$NS" -o jsonpath='{.status.replicas}' 2>/dev/null)
{ [ -z "$r" ] || [ "$r" = "0" ]; } && ok "edgecold is at zero replicas" || bad "edgecold did not scale to zero (replicas=$r)"

echo "▸ B2: a cold request THROUGH THE EDGE wakes the app 0->1 and returns 200"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -H "Host: edgecold.$BASE" "$EDGE/" 2>/dev/null)
after=$(kubectl get deploy edgecold -n "$NS" -o jsonpath='{.status.replicas}' 2>/dev/null)
[ "$code" = "200" ] && ok "edge -> interceptor -> app woke from zero (http $code, replicas now ${after:-0})" \
  || bad "edge dispatch/wake failed (http $code) — check DROP_INTERCEPTOR_URL + the port-forward"

echo "▸ unknown app hostname through the edge -> 404 (no proxy)"
nf=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: doesnotexist.$BASE" "$EDGE/" 2>/dev/null)
[ "$nf" = "404" ] && ok "unknown host -> 404" || bad "unknown host returned $nf (expected 404)"

# cleanup: tear down the app (also exercises the delete -> kube teardown path)
curl -s -X DELETE -H 'authorization: Bearer alice:alice@example.com' "$API/v1/sites/edgecold" >/dev/null 2>&1
rm -rf "$T"
echo; [ "$fail" = 0 ] && echo "EDGE DISPATCH VERIFIED" || { echo "SOME CHECKS FAILED"; exit 1; }
