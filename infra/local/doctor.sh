#!/usr/bin/env bash
# make doctor — validate the toolchain + environment needed to run Drop locally.
#
# Non-destructive. Checks the static stack (make start), the compute plane
# (make cluster-up / drop deploy), and the CLI build path. Prints ✓ pass /
# ! warning / ✗ failure per check and exits non-zero if any required check fails.
#
# Engine is taken from DROP_CONTAINER_ENGINE (the Makefile passes $(CE)), else
# auto-detected (podman first, then docker).
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)/../.."

pass=0; warn=0; fail=0
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()    { printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; fail=$((fail+1)); }
warn_() { printf '  \033[33m!\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; warn=$((warn+1)); }
note()  { printf '  \033[2m·\033[0m %s\n' "$1"; }
sec()   { printf '\n\033[1m%s\033[0m\n' "$1"; }
have()  { command -v "$1" >/dev/null 2>&1; }

sec "Core toolchain (static stack: make start)"
NVMRC="$(cat .nvmrc 2>/dev/null || echo '?')"
NODE_BIN="$HOME/.nvm/versions/node/v$NVMRC/bin/node"
if [ -x "$NODE_BIN" ]; then ok "node $("$NODE_BIN" -v) (pinned $NVMRC)"
elif have node; then warn_ "node $(node -v) on PATH but pinned $NVMRC not under ~/.nvm" "nvm install   (uses .nvmrc → $NVMRC)"
else no "node not found" "install nvm, then 'nvm install' (.nvmrc → $NVMRC)"; fi
have npm  && ok "npm $(npm -v)"  || no "npm not found"
have curl && ok "curl present"   || no "curl not found" "needed by install.sh + healthchecks"
have git  && ok "git present"    || warn_ "git not found"

sec "Container engine"
CE="${DROP_CONTAINER_ENGINE:-}"
if [ -z "$CE" ]; then have podman && CE=podman || { have docker && CE=docker || CE=""; }; fi
if [ -z "$CE" ]; then
  no "no container engine found" "install podman / Docker Desktop / Rancher Desktop (dockerd) / colima"
else
  ok "engine: $CE ($($CE --version 2>/dev/null | head -1))"
  if [ "$CE" = "podman" ]; then
    if podman machine inspect >/dev/null 2>&1; then
      state=$(podman machine inspect --format '{{.State}}'           2>/dev/null)
      rootful=$(podman machine inspect --format '{{.Rootful}}'        2>/dev/null)
      mem=$(podman machine inspect --format '{{.Resources.Memory}}'   2>/dev/null)
      cpus=$(podman machine inspect --format '{{.Resources.CPUs}}'    2>/dev/null)
      [ "$state" = "running" ] && ok "podman machine running" || warn_ "podman machine not running ($state)" "podman machine start  (or make start)"
      [ "$rootful" = "true" ]  && ok "podman machine rootful" || no   "podman machine is NOT rootful" "the k3s compute plane needs it: make setup  (or podman machine set --rootful)"
      if [ -n "$mem" ] && [ "$mem" -ge 8192 ] 2>/dev/null; then ok "podman VM resources: ${cpus} CPU / ${mem} MiB"
      else warn_ "podman VM memory ${mem:-?} MiB (<8192)" "compute pods may stay Pending; recreate with make setup (VM_MEMORY=8192)"; fi
    else
      no "no podman machine" "make setup"
    fi
  else
    "$CE" info >/dev/null 2>&1 && ok "$CE daemon reachable" \
      || no "$CE daemon not reachable" "start Docker Desktop / Rancher Desktop (dockerd engine) / colima"
  fi
fi

sec "Compute plane tools (make cluster-up / drop deploy)"
if have kubectl; then ok "kubectl present ($(kubectl version --client -o yaml 2>/dev/null | awk '/gitVersion/{print $2; exit}'))"
else warn_ "kubectl not found" "brew install kubernetes-cli  (only needed for the compute plane)"; fi
have helm && ok "helm present ($(helm version --short 2>/dev/null | head -1))" \
  || warn_ "helm not found" "brew install helm  (only needed for the compute plane)"
BUILDER="${DROP_BUILDER:-$CE}"
[ -n "$BUILDER" ] && have "$BUILDER" && ok "image builder: $BUILDER (drop deploy --build)" \
  || warn_ "image builder '${BUILDER:-none}' not found" "set DROP_BUILDER to your container CLI for 'drop deploy --build'"

sec "Repo + config"
[ -d node_modules ] && ok "dependencies installed (node_modules)" || warn_ "deps not installed" "npm install  (or make setup)"
[ -f dist/api.js ]  && ok "bundles built (dist/)"                  || note "dist/ not built yet (make start / node build.mjs builds it)"
if [ -f .env ]; then
  if grep -q '^DROP_DEV_AUTH=0' .env 2>/dev/null; then ok ".env present (real Google auth: DROP_DEV_AUTH=0)"
  else ok ".env present"; fi
else warn_ ".env missing → DROP_DEV_AUTH defaults to dev-auth" "cp .env.example .env to configure real Google auth"; fi

sec "Compute cluster (optional — only if you've run make cluster-up)"
KCFG="${DROP_KUBECONFIG:-$HOME/.kube/drop-k3s.yaml}"
if [ -n "$CE" ] && "$CE" ps --format '{{.Names}}' 2>/dev/null | grep -qx "${DROP_K3S_NAME:-k3s}"; then
  ok "k3s container '${DROP_K3S_NAME:-k3s}' running"
  if [ -f "$KCFG" ] && KUBECONFIG="$KCFG" kubectl get nodes >/dev/null 2>&1; then
    ok "cluster reachable via $KCFG"
    keda=$(KUBECONFIG="$KCFG" kubectl -n keda get pods --no-headers 2>/dev/null | grep -c ' Running')
    [ "${keda:-0}" -gt 0 ] && ok "KEDA up ($keda pods Running)" || warn_ "KEDA not ready" "operators may still be starting; re-run make cluster-up"
  else warn_ "k3s container up but cluster not reachable at 127.0.0.1:6443" "make cluster-down && make cluster-up"; fi
else
  note "no k3s container — run 'make cluster-up' for the compute plane (not needed for static sites)"
fi

sec "Summary"
printf "  %d ok · %d warnings · %d failures\n" "$pass" "$warn" "$fail"
if [ "$fail" -eq 0 ]; then printf '  \033[32m✓ ready to run Drop\033[0m  (make start; make cluster-up for compute)\n'; exit 0
else printf '  \033[31m✗ fix the failures above before running\033[0m\n'; exit 1; fi
