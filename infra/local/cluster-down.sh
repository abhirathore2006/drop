#!/usr/bin/env bash
# Bring the engine-agnostic local compute plane (cluster-up.sh) down.
#
# DEFAULT: STOPS the k3s container — the cluster state (KEDA, apps, databases,
# imported images) is PRESERVED in the stopped container, so the next cluster-up
# restarts it in seconds with no operator reinstall.
# DROP_WIPE=1: REMOVES the container instead → the cluster is destroyed and the
# next cluster-up rebuilds it from scratch.
# Floci + Postgres are left running unless DROP_STOP_DATA=1 (then `make stop`).
set -uo pipefail

K3S_NAME="${DROP_K3S_NAME:-k3s}"

CE="${DROP_CONTAINER_ENGINE:-}"
if [ -z "$CE" ]; then
  if command -v podman >/dev/null 2>&1; then CE=podman
  elif command -v docker >/dev/null 2>&1; then CE=docker
  else echo "✗ no container engine found"; exit 1; fi
fi

if [ "${DROP_WIPE:-0}" = "1" ]; then
  echo "▸ removing k3s container '$K3S_NAME' ($CE) [DROP_WIPE=1 — cluster will be rebuilt next up]"
  "$CE" rm -f "$K3S_NAME" >/dev/null 2>&1 && echo "✓ k3s removed (cluster wiped)" || echo "(no k3s container)"
else
  echo "▸ stopping k3s container '$K3S_NAME' ($CE)"
  "$CE" stop "$K3S_NAME" >/dev/null 2>&1 && echo "✓ k3s stopped (cluster preserved; next 'make up' restarts in seconds — DROP_WIPE=1 to remove)" || echo "(no k3s container)"
fi

if [ "${DROP_STOP_DATA:-0}" = "1" ]; then
  echo "▸ stopping Floci + Postgres"
  DROP_CONTAINER_ENGINE="$CE" make stop >/dev/null 2>&1 || true
  echo "✓ data containers stopped"
else
  echo "(Floci + Postgres left running — DROP_STOP_DATA=1 to stop them too)"
fi
echo "✓ compute plane down"
