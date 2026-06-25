#!/usr/bin/env bash
# Tear down the engine-agnostic local compute plane created by cluster-up.sh.
# Removes the k3s container (its cluster state — apps, databases, PVCs — is
# ephemeral and goes with it). Floci + Postgres are left running unless you also
# pass DROP_STOP_DATA=1 (then `make stop` stops them too). The kubeconfig file is
# left in place; it just stops resolving once the container is gone.
set -uo pipefail

K3S_NAME="${DROP_K3S_NAME:-k3s}"

CE="${DROP_CONTAINER_ENGINE:-}"
if [ -z "$CE" ]; then
  if command -v podman >/dev/null 2>&1; then CE=podman
  elif command -v docker >/dev/null 2>&1; then CE=docker
  else echo "✗ no container engine found"; exit 1; fi
fi

echo "▸ removing k3s container '$K3S_NAME' ($CE)"
"$CE" rm -f "$K3S_NAME" >/dev/null 2>&1 && echo "✓ k3s removed" || echo "(no k3s container)"

if [ "${DROP_STOP_DATA:-0}" = "1" ]; then
  echo "▸ stopping Floci + Postgres"
  DROP_CONTAINER_ENGINE="$CE" make stop >/dev/null 2>&1 || true
  echo "✓ data containers stopped"
else
  echo "(Floci + Postgres left running — DROP_STOP_DATA=1 to stop them too)"
fi
echo "✓ compute plane down"
