# Inputs for the foundation root config. example.com placeholders only; supply
# real values via terraform.tfvars (see terraform.tfvars.example).

variable "region" {
  description = "AWS region for all foundation resources."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource name and tag."
  type        = string
  default     = "drop"
}

variable "base_domain" {
  description = "Base domain Drop serves under. api.<base_domain> is the control plane; *.<base_domain> are sites. The ACM wildcard cert is *.<base_domain>."
  type        = string
  default     = "drop.example.com"
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for base_domain, used for ACM DNS validation."
  type        = string
}

# --- Existing network (we do NOT create a VPC) ---
variable "vpc_id" {
  description = "ID of the EXISTING VPC to place foundation resources in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs (used for the RDS DB subnet group). Compute variants reuse these too."
  type        = list(string)
}

# --- Database ---
variable "db_username" {
  description = "Master username for the RDS PostgreSQL instance."
  type        = string
  default     = "drop"
}

variable "db_password" {
  description = "Master password for the RDS PostgreSQL instance."
  type        = string
  sensitive   = true
}

variable "db_name" {
  description = "Initial database name created on the RDS instance."
  type        = string
  default     = "drop"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Allocated storage (GiB) for the RDS instance."
  type        = number
  default     = 20
}

# --- Secrets ---
variable "google_client_secret" {
  description = "Google OAuth client secret (DROP_GOOGLE_CLIENT_SECRET). Provide via tfvars or TF_VAR_; never commit."
  type        = string
  sensitive   = true
}

# --- Access ---
variable "corp_cidr" {
  description = "Corporate / VPC CIDR allowed to reach RDS (5432). Keep this private; the ALB is internal."
  type        = string
  default     = "10.0.0.0/8"
}
