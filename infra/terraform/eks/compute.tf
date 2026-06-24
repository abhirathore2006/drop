# ---------------------------------------------------------------------------
# Compute plane (gated on var.compute_enabled).
#
# Installing these turns the EKS deploy from STATIC-ONLY into the full Drop PaaS
# (container apps + managed databases + write-only secrets). It mirrors the
# verified local stack in infra/local/compute-up.sh:
#   - KEDA + the KEDA HTTP add-on      (apps: scale-to-zero / HTTP routing)
#   - CloudNativePG + Barman Cloud     (managed Postgres + scheduled backups)
#   - External Secrets Operator        (only for the "aws" secret backend)
#   - a gvisor RuntimeClass            (sandbox for untrusted tenant images)
# The Drop chart's compute.enabled (set in main.tf) then grants the API the RBAC
# + in-cluster auth to drive all of it.
#
# Leave var.compute_enabled = false for a static-sites-only EKS deploy (identical
# feature set to the ecs/ config, just on Kubernetes).
# ---------------------------------------------------------------------------
locals {
  compute = var.compute_enabled ? 1 : 0
}

resource "helm_release" "keda" {
  count            = local.compute
  name             = "keda"
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  namespace        = "keda"
  create_namespace = true
  wait             = true
}

resource "helm_release" "keda_http_add_on" {
  count      = local.compute
  name       = "keda-add-ons-http"
  repository = "https://kedacore.github.io/charts"
  chart      = "keda-add-ons-http"
  namespace  = "keda"
  wait       = true
  depends_on = [helm_release.keda]
}

resource "helm_release" "cnpg" {
  count            = local.compute
  name             = "cnpg"
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = "0.28.3" # pin to the version verified locally (compute-up.sh)
  namespace        = "cnpg-system"
  create_namespace = true
  wait             = true
}

resource "helm_release" "external_secrets" {
  count            = local.compute
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  namespace        = "external-secrets"
  create_namespace = true
  wait             = true
}

# The Barman Cloud Plugin ships as a multi-doc release manifest (kubectl apply), not a first-class
# Helm chart — the documented install path. Requires kubectl + cluster auth in the apply environment.
resource "null_resource" "barman_plugin" {
  count = local.compute
  triggers = {
    version = "v0.13.0"
  }
  provisioner "local-exec" {
    command = "kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml"
  }
  depends_on = [helm_release.cnpg]
}

# Registers the sandbox RuntimeClass referenced by untrusted tenant pods. NOTE: the `runsc` handler
# must also exist on the nodes (a gVisor-enabled node group / DaemonSet) for sandboxed pods to start.
resource "kubernetes_manifest" "gvisor_runtimeclass" {
  count = local.compute
  manifest = {
    apiVersion = "node.k8s.io/v1"
    kind       = "RuntimeClass"
    metadata   = { name = "gvisor" }
    handler    = "runsc"
  }
}
