#!/usr/bin/env bash
# Reproducible LOCAL compute stack on Floci (https://floci.io) — the same AWS
# architecture as production (EKS + ECR + RDS + IAM + Secrets), but emulated
# locally so the whole platform is reproducible without a real AWS account.
#
# Floci's EKS provisions a REAL k3s cluster, into which we install KEDA (+ the
# HTTP add-on) and CloudNativePG — the operators the Drop compute plane needs.
#
# REQUIREMENT (verified by spike 2026-06-21): Floci's EKS nests k3s via a REAL
# Docker daemon. It does NOT work against rootless OR rootful podman — Floci
# ignores DOCKER_HOST and drives the Docker socket directly. Use Docker Desktop
# (or colima/a rootful Docker daemon). The repo's *static* stack still uses
# podman; only this compute stack needs Docker.
set -euo pipefail

CLUSTER="${DROP_EKS_CLUSTER:-drop-local}"
FLOCI_PORT="${FLOCI_PORT:-4566}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_ENDPOINT_URL="http://localhost:${FLOCI_PORT}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing '$1' — install it first (brew install $2)"; exit 1; }; }

need floci floci-io/floci/floci
need aws awscli
need kubectl kubernetes-cli
need helm helm

say "Preflight: a REAL Docker daemon is required (Floci nests k3s via Docker)"
server="$(docker info --format '{{.ServerVersion}}' 2>/dev/null || true)"
if [ -z "$server" ]; then
  echo "✗ no Docker daemon reachable. Start Docker Desktop (or colima)."; exit 1
fi
if docker info 2>/dev/null | grep -qi podman; then
  echo "✗ the Docker socket points at podman — Floci EKS will fail to start k3s."
  echo "  Use Docker Desktop / colima for this stack (the static 'make start' stack still uses podman)."; exit 1
fi
echo "✓ Docker daemon $server"

say "Start Floci (AWS emulator) on :${FLOCI_PORT}"
floci start
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$AWS_ENDPOINT_URL/_floci/health" || true)" = "200" ] && break; sleep 1
done
echo "✓ Floci healthy at $AWS_ENDPOINT_URL"

say "Create the EKS cluster '$CLUSTER' (idempotent)"
if ! aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
  aws eks create-cluster --name "$CLUSTER" \
    --role-arn "arn:aws:iam::000000000000:role/drop-eks" \
    --resources-vpc-config "subnetIds=subnet-a,subnet-b" >/dev/null
fi
echo -n "  waiting for ACTIVE"
for _ in $(seq 1 120); do
  st="$(aws eks describe-cluster --name "$CLUSTER" --query 'cluster.status' --output text 2>/dev/null || true)"
  [ "$st" = "ACTIVE" ] && break; [ "$st" = "FAILED" ] && { echo " ✗ cluster FAILED — check 'floci logs' (k3s needs real Docker)"; exit 1; }
  printf '.'; sleep 2
done
echo " ✓ $CLUSTER ACTIVE"

say "Fetch kubeconfig"
aws eks update-kubeconfig --name "$CLUSTER" --kubeconfig "${KUBECONFIG:-$HOME/.kube/drop-local.config}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/drop-local.config}"
kubectl get nodes

say "Install operators: KEDA + KEDA HTTP add-on + CloudNativePG"
helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install keda kedacore/keda --namespace keda --create-namespace --wait
helm upgrade --install keda-http-add-on kedacore/keda-add-ons-http --namespace keda --wait
helm upgrade --install cnpg cnpg/cloudnative-pg --namespace cnpg-system --create-namespace --wait

say "Register the gvisor RuntimeClass (PROD sandbox for untrusted images)"
# Note: runsc is NOT installed on the locally-nested k3s — it needs nested virt/ptrace
# that this stack lacks. So locally PSA(baseline)+NetworkPolicy+ResourceQuota are the
# isolation guard, and v1 apps default to trusted:true (no runtimeClassName). We still
# register the object so the API can reference it and prod (EKS sandboxed nodes) works.
kubectl apply -f - >/dev/null 2>&1 <<'YAML' || true
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
YAML
echo "✓ gvisor RuntimeClass registered (untrusted-tenant sandbox; prod-only runtime)"

say "Done — compute plane is up"
echo "  KUBECONFIG=$KUBECONFIG"
echo "  point the API at it:  DROP_KUBECONFIG=$KUBECONFIG  (and DROP_COMPUTE=1)"
echo "  tear down:  infra/local/compute-down.sh"
