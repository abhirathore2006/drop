#!/usr/bin/env bash
# Reproducible LOCAL compute plane — ENGINE-AGNOSTIC (Docker / Rancher Desktop / podman).
#
# This is the lightweight sibling of compute-up.sh. Instead of Floci's EKS (which
# nests k3s via the *Docker* socket and so refuses podman), this runs k3s DIRECTLY
# as a privileged container in whatever engine you have, pulls its kubeconfig out,
# and installs the Drop compute operators into it. Because nothing here drives the
# Docker socket, it works identically on:
#
#   • Docker Desktop            (DROP_CONTAINER_ENGINE=docker)
#   • Rancher Desktop (dockerd) (DROP_CONTAINER_ENGINE=docker)   ← moby engine, not containerd
#   • colima                    (DROP_CONTAINER_ENGINE=docker)
#   • podman                    (DROP_CONTAINER_ENGINE=podman)   ← this repo's default
#
# The engine is auto-detected (podman first, else docker); override with
# DROP_CONTAINER_ENGINE. The Drop API itself is engine-agnostic: it only needs
# DROP_KUBECONFIG pointing at the cluster this script creates.
#
# Default install = the APPS plane (KEDA + HTTP add-on + gvisor) — exactly what's
# needed for `drop deploy`. Set DROP_COMPUTE_FULL=1 to also install the DATABASES +
# SECRETS plane (cert-manager + CloudNativePG + Barman + External Secrets), matching
# compute-up.sh. All versions are pinned below for reproducibility (override via env).
set -uo pipefail

# Run from the repo root so `make floci postgres` and relative manifests resolve.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.." || { echo "✗ cannot find repo root"; exit 1; }

# ── Pinned versions (override via env) ─────────────────────────────────────────
K3S_IMAGE="${DROP_K3S_IMAGE:-docker.io/rancher/k3s:v1.34.1-k3s1}"
KEDA_VERSION="${DROP_KEDA_VERSION:-2.20.1}"
KEDA_HTTP_VERSION="${DROP_KEDA_HTTP_VERSION:-0.15.0}"
CERT_MANAGER_VERSION="${DROP_CERT_MANAGER_VERSION:-v1.20.2}"
CNPG_VERSION="${DROP_CNPG_VERSION:-0.28.3}"
ESO_VERSION="${DROP_ESO_VERSION:-2.6.0}"
BARMAN_VERSION="${DROP_BARMAN_VERSION:-v0.13.0}"

# Container name = the API's default DROP_K3S_CONTAINER ("k3s") so the local containerd image
# backend (podman exec <name> ctr images import) finds it with no extra env.
K3S_NAME="${DROP_K3S_NAME:-k3s}"
KUBECONFIG_PATH="${DROP_KUBECONFIG:-$HOME/.kube/drop-k3s.yaml}"
# Static node IP on a dedicated network. Without this, a stopped k3s container gets a NEW IP on
# restart and k3s dies ("failed to find interface with specified node ip"). A fixed --ip + matching
# --node-ip makes `make down`/`up` (stop/start) resume cleanly.
K3S_NET="${DROP_K3S_NET:-drop-net}"
K3S_IP="${DROP_K3S_IP:-10.89.0.2}"
K3S_SUBNET="${DROP_K3S_SUBNET:-10.89.0.0/24}"
FLOCI_PORT="${FLOCI_PORT:-4566}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing '$1' — install it first"; exit 1; }; }

need kubectl
need helm

# ── Resolve the container engine ───────────────────────────────────────────────
CE="${DROP_CONTAINER_ENGINE:-}"
if [ -z "$CE" ]; then
  if command -v podman >/dev/null 2>&1; then CE=podman
  elif command -v docker >/dev/null 2>&1; then CE=docker
  else echo "✗ no container engine — install podman, Docker Desktop, Rancher Desktop, or colima"; exit 1; fi
fi
command -v "$CE" >/dev/null 2>&1 || { echo "✗ DROP_CONTAINER_ENGINE='$CE' not found on PATH"; exit 1; }

say "Container engine: $CE"
if [ "$CE" = "podman" ]; then
  podman machine start >/dev/null 2>&1 || true
  # k3s must run ROOTFUL. A rootless (userns) podman machine can't give kubelet /dev/kmsg or the
  # cpuset cgroup, so k3s dies ("operation not permitted" / "failed to find cpuset cgroup"). Flip
  # the machine to rootful if it isn't already (idempotent; needs a stop/start).
  if [ "$(podman machine inspect --format '{{.Rootful}}' 2>/dev/null)" != "true" ]; then
    echo "  switching the podman machine to rootful (required for k3s)…"
    podman machine stop      >/dev/null 2>&1 || true
    podman machine set --rootful >/dev/null 2>&1 || true
    podman machine start     >/dev/null 2>&1 || true
  fi
else
  if ! "$CE" info >/dev/null 2>&1; then
    echo "✗ the '$CE' daemon is not reachable. Start Docker Desktop / Rancher Desktop (dockerd engine) / colima."
    echo "  (Rancher Desktop in containerd/nerdctl mode has no Docker socket — switch it to the dockerd/moby engine.)"
    exit 1
  fi
fi
# host alias k3s pods use to reach sibling containers (Floci) on the host — full mode only.
HOST_ALIAS="host.docker.internal"; [ "$CE" = "podman" ] && HOST_ALIAS="host.containers.internal"

# ── k3s as a container (idempotent) ────────────────────────────────────────────
# Reuse a running container; RESTART a stopped one (preserves the cluster — KEDA, apps, DBs,
# imported images — so `make down`/`up` cycles in seconds); else create fresh. The operator
# install below is idempotent (helm upgrade --install), so it's a fast no-op on a restart.
say "k3s cluster '$K3S_NAME' ($K3S_IMAGE)"
if "$CE" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$K3S_NAME"; then
  echo "✓ already running — reusing"
elif "$CE" ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$K3S_NAME"; then
  echo "  restarting stopped k3s container (cluster preserved)…"
  "$CE" start "$K3S_NAME" >/dev/null
else
  # Dedicated network with a fixed subnet so we can pin the node IP (stable across restarts).
  "$CE" network inspect "$K3S_NET" >/dev/null 2>&1 || "$CE" network create --subnet "$K3S_SUBNET" "$K3S_NET" >/dev/null
  # Optional corp CA so k3s can pull through a TLS-inspecting proxy.
  if [ -n "${DROP_CORP_CA:-}" ] && [ -f "${DROP_CORP_CA:-}" ]; then
    echo "  mounting corp CA ${DROP_CORP_CA}"
    "$CE" run -d --name "$K3S_NAME" --privileged --network "$K3S_NET" --ip "$K3S_IP" -p 6443:6443 \
      -v "${DROP_CORP_CA}:/etc/ssl/certs/ca-certificates.crt:ro" \
      -e K3S_KUBECONFIG_MODE=644 "$K3S_IMAGE" server --disable traefik --node-ip "$K3S_IP" --tls-san 127.0.0.1 >/dev/null
  else
    echo "  (behind a TLS-inspecting proxy? in-cluster image pulls will fail x509 —"
    echo "   set DROP_CORP_CA=/path/to/ca-bundle.pem so k3s trusts your corp CA)"
    "$CE" run -d --name "$K3S_NAME" --privileged --network "$K3S_NET" --ip "$K3S_IP" -p 6443:6443 \
      -e K3S_KUBECONFIG_MODE=644 "$K3S_IMAGE" server --disable traefik --node-ip "$K3S_IP" --tls-san 127.0.0.1 >/dev/null
  fi
  echo "  started (fresh cluster, node-ip $K3S_IP)"
fi

echo -n "  waiting for node Ready"
for _ in $(seq 1 90); do
  "$CE" exec "$K3S_NAME" kubectl get nodes 2>/dev/null | grep -q ' Ready' && break
  printf '.'; sleep 2
done
echo

say "Write kubeconfig → $KUBECONFIG_PATH"
mkdir -p "$(dirname "$KUBECONFIG_PATH")"
"$CE" exec "$K3S_NAME" cat /etc/rancher/k3s/k3s.yaml > "$KUBECONFIG_PATH"
export KUBECONFIG="$KUBECONFIG_PATH"
kubectl get nodes || { echo "✗ cluster not reachable at 127.0.0.1:6443 (port forward?)"; exit 1; }

# ── APPS plane (always): KEDA + HTTP add-on + gvisor ───────────────────────────
say "Operators: KEDA $KEDA_VERSION + HTTP add-on $KEDA_HTTP_VERSION"
helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
helm repo update kedacore >/dev/null 2>&1 || helm repo update >/dev/null 2>&1
helm upgrade --install keda kedacore/keda --version "$KEDA_VERSION" \
  --namespace keda --create-namespace --wait --timeout 10m
helm upgrade --install keda-http-add-on kedacore/keda-add-ons-http --version "$KEDA_HTTP_VERSION" \
  --namespace keda --wait --timeout 10m

say "Register the gvisor RuntimeClass (untrusted-image sandbox; prod-only runtime)"
# runsc is NOT installed on this nested k3s (needs nested virt/ptrace it lacks), so apps
# default to trusted (no runtimeClassName). We register the object so the API can reference
# it and so prod (EKS sandboxed nodes) behaves the same.
kubectl apply -f - >/dev/null 2>&1 <<'YAML' || true
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
YAML
echo "✓ gvisor RuntimeClass registered"

# ── DATABASES + SECRETS plane (opt-in: DROP_COMPUTE_FULL=1) ─────────────────────
if [ "${DROP_COMPUTE_FULL:-0}" = "1" ]; then
  say "Full plane: cert-manager $CERT_MANAGER_VERSION + CNPG $CNPG_VERSION + Barman $BARMAN_VERSION + ESO $ESO_VERSION"
  helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
  helm repo update >/dev/null 2>&1

  # cert-manager is a hard prerequisite of the Barman Cloud Plugin (issues its gRPC TLS certs).
  helm upgrade --install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace \
    --version "$CERT_MANAGER_VERSION" --set crds.enabled=true --wait
  helm upgrade --install cnpg cnpg/cloudnative-pg --namespace cnpg-system --create-namespace \
    --version "$CNPG_VERSION" --wait
  kubectl apply -f "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${BARMAN_VERSION}/manifest.yaml"
  kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=180s || true

  # External Secrets (only needed for DROP_SECRET_BACKEND=aws). Point its AWS client at the
  # in-cluster-reachable Floci endpoint (host alias differs per engine; override to taste).
  ESO_ENDPOINT="${DROP_SECRET_MANAGER_IN_CLUSTER_ENDPOINT:-http://${HOST_ALIAS}:${FLOCI_PORT}}"
  helm upgrade --install external-secrets external-secrets/external-secrets --namespace external-secrets --create-namespace \
    --version "$ESO_VERSION" --set installCRDs=true \
    --set "extraEnv[0].name=AWS_ENDPOINT_URL" --set "extraEnv[0].value=${ESO_ENDPOINT}" \
    --set "extraEnv[1].name=AWS_REGION" --set "extraEnv[1].value=${REGION}" --wait
  kubectl -n external-secrets create secret generic floci-aws-creds \
    --from-literal=access-key-id="${AWS_ACCESS_KEY_ID:-test}" --from-literal=secret-access-key="${AWS_SECRET_ACCESS_KEY:-test}" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f - <<YAML
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata: { name: floci }
spec:
  provider:
    aws:
      service: SecretsManager
      region: ${REGION}
      auth:
        secretRef:
          accessKeyIDSecretRef: { name: floci-aws-creds, key: access-key-id, namespace: external-secrets }
          secretAccessKeySecretRef: { name: floci-aws-creds, key: secret-access-key, namespace: external-secrets }
YAML

  kubectl apply -f "$SCRIPT_DIR/db-hibernation.yaml" || true
  echo "✓ databases + secrets plane ready"
fi

# ── Local S3 + metadata DB (same engine) ───────────────────────────────────────
say "Floci (S3) + Postgres via $CE"
DROP_CONTAINER_ENGINE="$CE" make floci postgres

say "Done — compute plane is up on '$CE'"
echo "  KUBECONFIG=$KUBECONFIG_PATH"
echo "  run the API against the cluster:"
echo "    DROP_KUBECONFIG=$KUBECONFIG_PATH \\"
echo "    DROP_S3_ENDPOINT=http://localhost:${FLOCI_PORT} DROP_S3_BUCKET=drop DROP_S3_KEY_ID=test DROP_S3_SECRET=test \\"
echo "    DROP_DATABASE_URL=postgres://drop:drop@localhost:5432/drop node dist/api.js"
echo "  (or 'make start' for the static-only stack — no cluster needed)"
if [ "${DROP_COMPUTE_FULL:-0}" != "1" ]; then
  echo "  apps plane only — re-run with DROP_COMPUTE_FULL=1 to add managed databases + the aws secret backend"
fi
echo "  tear down:            make cluster-down"
