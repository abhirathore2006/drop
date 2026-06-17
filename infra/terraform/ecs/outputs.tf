# outputs.tf — handy references after apply.

output "alb_dns_name" {
  description = "Internal ALB DNS name (Route53 records alias to this)."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the ALB (for alias records elsewhere)."
  value       = aws_lb.this.zone_id
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "api_service_name" {
  description = "Name of the api ECS service."
  value       = aws_ecs_service.api.name
}

output "edge_service_name" {
  description = "Name of the edge ECS service."
  value       = aws_ecs_service.edge.name
}

output "api_target_group_arn" {
  description = "ARN of the api target group."
  value       = aws_lb_target_group.api.arn
}

output "edge_target_group_arn" {
  description = "ARN of the edge target group."
  value       = aws_lb_target_group.edge.arn
}

output "app_security_group_id" {
  description = "Security group attached to the ECS tasks (APP-SG)."
  value       = aws_security_group.app.id
}

output "task_role_arn" {
  description = "IAM task role used by the containers (S3 access)."
  value       = aws_iam_role.task.arn
}

output "api_url" {
  description = "API base URL (control plane + dashboard + OAuth callback host)."
  value       = "https://api.${local.base_domain}"
}

output "sites_url_pattern" {
  description = "Wildcard host pattern that serves published sites via the edge."
  value       = "https://*.${local.base_domain}"
}
