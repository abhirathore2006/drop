# Inputs for the Drop EKS root config.

variable "region" {
  description = "AWS region for all resources (keep in sync with backend.tf region)."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names and tags."
  type        = string
  default     = "drop"
}

variable "tfstate_bucket" {
  description = "S3 bucket holding Terraform remote state (used to read the foundation state)."
  type        = string
}

# ---------------------------------------------------------------------------
# Non-secret application config (becomes Helm values → ConfigMap/pod env).
# ---------------------------------------------------------------------------

variable "google_client_id" {
  description = "Google OAuth Web client ID (not secret). Redirect URI is https://api.<base_domain>/auth/callback."
  type        = string
}

variable "allowed_domains" {
  description = "Comma-separated Google Workspace domains allowed to sign in (empty = any Google account)."
  type        = string
  default     = ""
}

variable "admins" {
  description = "Comma-separated emails seeded as platform admins on API boot."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# EKS sizing / version.
# ---------------------------------------------------------------------------

variable "cluster_version" {
  description = "Kubernetes control-plane version for the EKS cluster."
  type        = string
  default     = "1.31"
}

variable "node_instance_types" {
  description = "Instance types for the managed node group."
  type        = list(string)
  default     = ["t3.large"]
}

variable "node_desired_size" {
  description = "Desired number of worker nodes."
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of worker nodes."
  type        = number
  default     = 2
}

variable "node_max_size" {
  description = "Maximum number of worker nodes."
  type        = number
  default     = 4
}

variable "namespace" {
  description = "Kubernetes namespace Drop is deployed into."
  type        = string
  default     = "drop"
}

variable "service_account_name" {
  description = "Kubernetes ServiceAccount name used by Drop pods (target of IRSA)."
  type        = string
  default     = "drop"
}
