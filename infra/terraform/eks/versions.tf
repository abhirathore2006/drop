# Provider + Terraform version pins for the Drop EKS (Variant A — Kubernetes) root config.
#
# This config provisions an EKS cluster in the foundation's existing VPC, wires up
# IRSA for S3 access, installs the AWS Load Balancer Controller, and deploys the
# Drop Helm chart (api + edge) behind one internal ALB Ingress.
#
# NOTE: The Drop API runs Postgres schema migrations on boot under a pg_advisory_lock,
# so a multi-replica rollout is safe (one pod migrates, the rest wait then serve).
# The edge connects read-only and never migrates.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    # Used to fetch the AWS Load Balancer Controller IAM policy document.
    http = {
      source  = "hashicorp/http"
      version = "~> 3.0"
    }
    # Used by the compute plane to kubectl-apply the Barman Cloud Plugin manifest.
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# The kubernetes/helm providers are configured in main.tf (they depend on the EKS
# module outputs). The AWS provider is configured here so var.region + default_tags
# apply consistently with the foundation/ecs configs.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name_prefix
      ManagedBy = "terraform"
      Config    = "eks"
    }
  }
}
