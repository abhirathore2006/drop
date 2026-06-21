#!/usr/bin/env bash
# Tear down the local Floci compute stack (cluster + Floci). Forward-only data
# in the k3s cluster is ephemeral; CloudNativePG PVCs live in the cluster, so
# deleting the cluster discards local app databases.
set -euo pipefail

CLUSTER="${DROP_EKS_CLUSTER:-drop-local}"
export AWS_ENDPOINT_URL="http://localhost:${FLOCI_PORT:-4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "▸ deleting EKS cluster $CLUSTER"
aws eks delete-cluster --name "$CLUSTER" >/dev/null 2>&1 || true
echo "▸ stopping Floci"
floci stop 2>/dev/null || true
echo "✓ compute stack down"
