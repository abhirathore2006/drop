# versions.tf — Terraform & provider version pins for the Drop ECS Fargate root config.
# Variant B: ECS on Fargate (no Kubernetes), so only the AWS provider is needed.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name_prefix
      ManagedBy = "terraform"
      Config    = "ecs"
    }
  }
}
