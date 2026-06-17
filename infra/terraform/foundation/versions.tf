# Terraform + provider version pins for the Drop "foundation" root config.
# foundation owns the SHARED resources (ECR, S3, ACM, RDS, Secrets) that both the
# eks and ecs variants read back via a terraform_remote_state data source.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Used for the DROP_SESSION_SECRET we generate in-state.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name_prefix
      ManagedBy = "terraform"
      Component = "foundation"
    }
  }
}
