# Outputs consumed by the eks/ecs roots via:
#   data "terraform_remote_state" "foundation" {
#     backend = "s3"
#     config  = { bucket = "...", key = "drop/foundation.tfstate", region = "..." }
#   }

output "ecr_repository_url" {
  description = "ECR repository URL for the Drop image (set as image.repository / ECS image)."
  value       = aws_ecr_repository.drop.repository_url
}

output "s3_bucket" {
  description = "Name of the private sites bucket (DROP_S3_BUCKET)."
  value       = aws_s3_bucket.sites.bucket
}

output "s3_access_policy_arn" {
  description = "ARN of the IAM policy granting Drop's S3 perms; attach to the IRSA / task role."
  value       = aws_iam_policy.s3_access.arn
}

output "acm_certificate_arn" {
  description = "ARN of the validated *.<base_domain> wildcard cert for the ALB HTTPS listener."
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)."
  value       = module.rds.db_instance_endpoint
}

output "rds_security_group_id" {
  description = "Security group ID guarding the RDS instance."
  value       = aws_security_group.rds.id
}

output "secret_google_arn" {
  description = "ARN of the DROP_GOOGLE_CLIENT_SECRET secret."
  value       = aws_secretsmanager_secret.google.arn
}

output "secret_session_arn" {
  description = "ARN of the DROP_SESSION_SECRET secret."
  value       = aws_secretsmanager_secret.session.arn
}

output "secret_database_url_arn" {
  description = "ARN of the DROP_DATABASE_URL secret."
  value       = aws_secretsmanager_secret.database_url.arn
}

# Pass-throughs so eks/ecs roots get network + naming context from one place.
output "route53_zone_id" {
  description = "Route53 hosted zone ID for base_domain."
  value       = var.route53_zone_id
}

output "vpc_id" {
  description = "VPC ID the foundation resources live in."
  value       = var.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (reused by the compute variants)."
  value       = var.private_subnet_ids
}

output "base_domain" {
  description = "Base domain Drop serves under."
  value       = var.base_domain
}

output "region" {
  description = "AWS region for all Drop resources."
  value       = var.region
}
