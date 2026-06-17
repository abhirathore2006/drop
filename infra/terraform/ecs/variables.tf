# variables.tf — inputs for the Drop ECS Fargate root config.
# Shared infrastructure (VPC, ECR, S3, ACM, RDS, Secrets, Route53 zone) is OWNED by
# the foundation config and READ here via terraform_remote_state. Only the inputs
# specific to this config (or needed to locate the foundation state) live here.

variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names and tags."
  type        = string
  default     = "drop"
}

variable "base_domain" {
  description = <<-EOT
    Apex domain Drop serves under. Sites are served at *.base_domain and the API/
    dashboard at api.base_domain. If left empty, the value is read from the
    foundation remote state output `base_domain`.
  EOT
  type        = string
  default     = ""
}

# --- Foundation remote state location -----------------------------------------
variable "tfstate_bucket" {
  description = "S3 bucket holding Terraform remote state (foundation + this config)."
  type        = string
}

# --- Application config (non-secret) ------------------------------------------
variable "image_tag" {
  description = "Container image tag to deploy from the foundation ECR repo (e.g. 0.1.0)."
  type        = string
  default     = "latest"
}

variable "google_client_id" {
  description = "Google OAuth Web client ID (DROP_GOOGLE_CLIENT_ID). Not secret."
  type        = string
  default     = ""
}

variable "allowed_domains" {
  description = "Comma-separated Google Workspace domains allowed to sign in (DROP_ALLOWED_DOMAINS). Empty = any Google account."
  type        = string
  default     = ""
}

variable "admins" {
  description = "Comma-separated emails seeded as platform admins on API boot (DROP_ADMINS)."
  type        = string
  default     = ""
}

# --- Networking ----------------------------------------------------------------
variable "corp_cidr" {
  description = "CIDR allowed to reach the INTERNAL ALB on :443 (corporate/VPN range)."
  type        = string
  default     = "10.0.0.0/8"
}

# --- Sizing --------------------------------------------------------------------
variable "api_desired_count" {
  description = "Number of api tasks to run."
  type        = number
  default     = 2
}

variable "edge_desired_count" {
  description = "Number of edge tasks to run."
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory (MiB). Must be valid for the chosen CPU."
  type        = number
  default     = 512
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for ECS task logs."
  type        = number
  default     = 30
}
