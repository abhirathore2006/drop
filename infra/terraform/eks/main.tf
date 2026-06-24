# =============================================================================
# Drop on AWS — EKS root config (Variant A — Kubernetes)
# =============================================================================
# Deploys the Drop Helm chart (api + edge, one image, command overridden per
# Deployment) into an EKS cluster created in the foundation's existing VPC.
#
# Shape (verified against the repo):
#   - ONE internal ALB (created by the AWS Load Balancer Controller from the
#     chart's Ingress). Host routing: api.<base_domain> -> api Service (8080),
#     *.<base_domain> -> edge Service (8080). HTTPS :443 with one ACM wildcard cert.
#   - api health GET /healthz; edge health GET /_drop_health (both 200 "ok").
#   - RDS PostgreSQL 18 -> DROP_DATABASE_URL (secret). API migrates on boot under a
#     pg_advisory_lock (multi-replica safe); the edge is read-only and never migrates.
#   - S3 private bucket for file bytes; access via IRSA (no static keys).
#
# foundation OWNS the shared resources (VPC inputs, ECR, S3 bucket + access policy,
# ACM wildcard cert, Secrets Manager secrets, Route53 zone, RDS). This config READS
# them via the foundation remote state + data sources.
# =============================================================================

# ---------------------------------------------------------------------------
# Foundation remote state — shared values owned by the foundation config.
# ---------------------------------------------------------------------------
data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket = var.tfstate_bucket
    key    = "drop/foundation.tfstate"
    region = var.region
  }
}

locals {
  fnd = data.terraform_remote_state.foundation.outputs

  # Foundation-provided shared values (see foundation outputs).
  vpc_id             = local.fnd.vpc_id
  private_subnet_ids = local.fnd.private_subnet_ids
  base_domain        = local.fnd.base_domain          # e.g. drop.example.com
  api_host           = "api.${local.fnd.base_domain}" # control plane + OAuth callback
  ecr_repository_url = local.fnd.ecr_repository_url
  s3_bucket          = local.fnd.s3_bucket
  s3_region          = local.fnd.region              # foundation exports the region (the bucket lives in it)
  s3_access_policy   = local.fnd.s3_access_policy_arn # IAM policy: Get/Put/Delete + ListBucket
  acm_certificate    = local.fnd.acm_certificate_arn  # wildcard *.<base_domain>
  route53_zone_id    = local.fnd.route53_zone_id

  # Secrets Manager secret ARNs (foundation owns the secrets; we read values here).
  # aws_secretsmanager_secret_version.secret_id accepts the ARN. Output names must
  # match foundation/outputs.tf: secret_google_arn / secret_session_arn / secret_database_url_arn.
  secret_google_client_secret_arn = local.fnd.secret_google_arn
  secret_session_secret_arn       = local.fnd.secret_session_arn
  secret_database_url_arn         = local.fnd.secret_database_url_arn

  tags = {
    Project   = var.name_prefix
    ManagedBy = "terraform"
    Config    = "eks"
  }
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# EKS cluster (terraform-aws-modules/eks/aws ~> 20) in the foundation's VPC.
# ---------------------------------------------------------------------------
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "${var.name_prefix}-eks"
  cluster_version = var.cluster_version

  # Use the EXISTING VPC + private subnets from the foundation.
  vpc_id     = local.vpc_id
  subnet_ids = local.private_subnet_ids

  # Public endpoint for kubectl/terraform admin access; tighten in production.
  cluster_endpoint_public_access = true

  # Grant the caller running terraform admin access to the cluster.
  enable_cluster_creator_admin_permissions = true

  # IRSA: create the OIDC provider so ServiceAccounts can assume IAM roles.
  enable_irsa = true

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      desired_size   = var.node_desired_size
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      subnet_ids     = local.private_subnet_ids
    }
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Provider config derived from the EKS cluster.
# ---------------------------------------------------------------------------
data "aws_eks_cluster_auth" "this" {
  name = module.eks.cluster_name
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  token                  = data.aws_eks_cluster_auth.this.token
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    token                  = data.aws_eks_cluster_auth.this.token
  }
}

# ---------------------------------------------------------------------------
# IRSA — IAM role assumable by the Drop ServiceAccount via the cluster OIDC
# provider, with the foundation's S3 access policy attached.
# Perms (in the foundation policy): s3:GetObject/PutObject/DeleteObject on
# bucket/*, s3:ListBucket on the bucket.
# ---------------------------------------------------------------------------
module "drop_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.name_prefix}-s3"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["${var.namespace}:${var.service_account_name}"]
    }
  }

  # Attach the foundation-owned S3 access policy to this role.
  role_policy_arns = {
    s3 = local.s3_access_policy
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# AWS Load Balancer Controller — needed for the ALB Ingress.
# IRSA role + policy for the controller, then the Helm release.
# ---------------------------------------------------------------------------
data "http" "alb_controller_policy" {
  url = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.8.1/docs/install/iam_policy.json"
}

resource "aws_iam_policy" "alb_controller" {
  name        = "${var.name_prefix}-alb-controller"
  description = "Policy for the AWS Load Balancer Controller (Drop EKS)."
  policy      = data.http.alb_controller_policy.response_body
  tags        = local.tags
}

module "alb_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.name_prefix}-alb-controller"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  role_policy_arns = {
    alb = aws_iam_policy.alb_controller.arn
  }

  tags = local.tags
}

resource "kubernetes_service_account" "alb_controller" {
  metadata {
    name      = "aws-load-balancer-controller"
    namespace = "kube-system"
    labels = {
      "app.kubernetes.io/name"      = "aws-load-balancer-controller"
      "app.kubernetes.io/component" = "controller"
    }
    annotations = {
      "eks.amazonaws.com/role-arn" = module.alb_controller_irsa.iam_role_arn
    }
  }
}

resource "helm_release" "alb_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "1.8.1"
  namespace  = "kube-system"

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }
  set {
    name  = "region"
    value = var.region
  }
  set {
    name  = "vpcId"
    value = local.vpc_id
  }
  set {
    name  = "serviceAccount.create"
    value = "false"
  }
  set {
    name  = "serviceAccount.name"
    value = kubernetes_service_account.alb_controller.metadata[0].name
  }

  depends_on = [
    kubernetes_service_account.alb_controller,
    module.eks,
  ]
}

# ---------------------------------------------------------------------------
# Application namespace.
# ---------------------------------------------------------------------------
resource "kubernetes_namespace" "drop" {
  metadata {
    name = var.namespace
  }
}

# ---------------------------------------------------------------------------
# Secrets — read the three Drop secrets from the foundation's Secrets Manager
# and materialize them as a Kubernetes Secret consumed by the chart via
# secret.existingSecret.
# Keys: DROP_GOOGLE_CLIENT_SECRET / DROP_SESSION_SECRET / DROP_DATABASE_URL.
# ---------------------------------------------------------------------------
data "aws_secretsmanager_secret_version" "google_client_secret" {
  secret_id = local.secret_google_client_secret_arn
}

data "aws_secretsmanager_secret_version" "session_secret" {
  secret_id = local.secret_session_secret_arn
}

data "aws_secretsmanager_secret_version" "database_url" {
  secret_id = local.secret_database_url_arn
}

resource "kubernetes_secret" "drop" {
  metadata {
    name      = "${var.name_prefix}-secrets"
    namespace = kubernetes_namespace.drop.metadata[0].name
  }

  type = "Opaque"

  # Key names must match the chart's secret.*Key defaults.
  data = {
    DROP_GOOGLE_CLIENT_SECRET = data.aws_secretsmanager_secret_version.google_client_secret.secret_string
    DROP_SESSION_SECRET       = data.aws_secretsmanager_secret_version.session_secret.secret_string
    DROP_DATABASE_URL         = data.aws_secretsmanager_secret_version.database_url.secret_string
  }
}

# ---------------------------------------------------------------------------
# Drop Helm release — the local chart at infra/helm/drop.
# Value keys are exactly those in infra/helm/drop/values.yaml + README.md.
#
# Ingress is className=alb with ALB annotations: internal scheme, IP targets
# (target-type=ip works with the chart's Service ports), HTTPS:443 listener with
# the foundation's ACM wildcard cert.
#
# healthcheck-path: the chart sets PER-SERVICE ALB health-check annotations
# (api Service -> /healthz, edge Service -> /_drop_health), which the AWS Load
# Balancer Controller applies per target group. So each TG is checked on the right
# path automatically; the Ingress-level healthcheck-path below is just a fallback.
# ---------------------------------------------------------------------------
resource "helm_release" "drop" {
  name      = var.name_prefix
  chart     = "${path.module}/../../helm/drop"
  namespace = kubernetes_namespace.drop.metadata[0].name

  # Image — from the foundation's ECR repository.
  set {
    name  = "image.repository"
    value = local.ecr_repository_url
  }

  # DNS.
  set {
    name  = "baseDomain"
    value = local.base_domain
  }
  set {
    name  = "apiHost"
    value = local.api_host
  }

  # Non-secret config.
  set {
    name  = "config.s3Bucket"
    value = local.s3_bucket
  }
  set {
    name  = "config.s3Region"
    value = local.s3_region
  }
  set {
    name  = "config.allowedDomains"
    value = var.allowed_domains
  }
  set {
    name  = "config.admins"
    value = var.admins
  }
  set {
    name  = "googleClientId"
    value = var.google_client_id
  }

  # Secret — reference the kubernetes_secret created above.
  set {
    name  = "secret.existingSecret"
    value = kubernetes_secret.drop.metadata[0].name
  }

  # ServiceAccount — pin the name (the chart default is drop.fullname, which would
  # NOT match the IRSA trust policy below) and annotate with the IRSA role ARN.
  set {
    name  = "serviceAccount.name"
    value = var.service_account_name
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.drop_irsa.iam_role_arn
  }

  # Ingress — ALB class + annotations.
  set {
    name  = "ingress.className"
    value = "alb"
  }
  set {
    name  = "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/scheme"
    value = "internal"
  }
  set {
    name  = "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/target-type"
    value = "ip"
  }
  set {
    name  = "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/listen-ports"
    value = "[{\"HTTPS\":443}]"
    type  = "string"
  }
  set {
    name  = "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/certificate-arn"
    value = local.acm_certificate
  }
  # Default ALB healthcheck path. The API answers GET /healthz.
  # (The edge answers GET /_drop_health — override per-edge-Service if you split TGs.)
  set {
    name  = "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/healthcheck-path"
    value = "/healthz"
  }

  # Compute plane — OFF unless var.compute_enabled. When on, this grants the API
  # the in-cluster RBAC and tells it which ECR + egress CIDRs to use for tenants.
  # The operators it depends on are installed in compute.tf.
  #
  # Emitted ONLY when enabled: Helm treats the string "false" as truthy
  # ({{- if "false" }} is true), so setting compute.enabled=false would wrongly
  # turn compute ON. Omitting the keys lets the chart default (bool false) hold.
  dynamic "set" {
    for_each = var.compute_enabled ? [1] : []
    content {
      name  = "compute.enabled"
      value = "true"
    }
  }
  dynamic "set" {
    for_each = var.compute_enabled ? [var.image_registry] : []
    content {
      name  = "compute.imageRegistry"
      value = set.value
    }
  }
  dynamic "set" {
    for_each = var.compute_enabled ? [var.blocked_egress_cidrs] : []
    content {
      name  = "compute.blockedEgressCidrs"
      value = set.value
    }
  }

  depends_on = [
    helm_release.alb_controller,
    kubernetes_secret.drop,
    module.drop_irsa,
    # Compute operators (empty list when compute disabled, so no-op for static deploys).
    helm_release.keda,
    helm_release.keda_http_add_on,
    helm_release.cnpg,
    helm_release.external_secrets,
    null_resource.barman_plugin,
    kubernetes_manifest.gvisor_runtimeclass,
  ]
}

# ---------------------------------------------------------------------------
# Route53 alias records pointing api.<base_domain> + *.<base_domain> at the
# ingress-created internal ALB. We discover the ALB via the Ingress hostname,
# then resolve it to an aws_lb to get the alias zone id.
# ---------------------------------------------------------------------------
data "kubernetes_ingress_v1" "drop" {
  metadata {
    name      = "${var.name_prefix}-drop"
    namespace = kubernetes_namespace.drop.metadata[0].name
  }

  depends_on = [helm_release.drop]
}

locals {
  # The ALB hostname published on the Ingress status by the LB Controller.
  alb_hostname = try(
    data.kubernetes_ingress_v1.drop.status[0].load_balancer[0].ingress[0].hostname,
    ""
  )
}

# Look up the ALB by its DNS name to obtain the hosted-zone id needed for aliases.
data "aws_lb" "drop" {
  count    = local.alb_hostname == "" ? 0 : 1
  dns_name = local.alb_hostname
}

resource "aws_route53_record" "api" {
  count   = local.alb_hostname == "" ? 0 : 1
  zone_id = local.route53_zone_id
  name    = local.api_host
  type    = "A"

  alias {
    name                   = data.aws_lb.drop[0].dns_name
    zone_id                = data.aws_lb.drop[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "wildcard" {
  count   = local.alb_hostname == "" ? 0 : 1
  zone_id = local.route53_zone_id
  name    = "*.${local.base_domain}"
  type    = "A"

  alias {
    name                   = data.aws_lb.drop[0].dns_name
    zone_id                = data.aws_lb.drop[0].zone_id
    evaluate_target_health = true
  }
}
