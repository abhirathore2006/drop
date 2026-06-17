# Outputs for the Drop EKS root config.

output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "cluster_oidc_provider_arn" {
  description = "OIDC provider ARN used for IRSA."
  value       = module.eks.oidc_provider_arn
}

output "drop_irsa_role_arn" {
  description = "IAM role ARN assumed by the Drop ServiceAccount (S3 access via IRSA)."
  value       = module.drop_irsa.iam_role_arn
}

output "alb_controller_role_arn" {
  description = "IAM role ARN for the AWS Load Balancer Controller."
  value       = module.alb_controller_irsa.iam_role_arn
}

output "namespace" {
  description = "Kubernetes namespace Drop is deployed into."
  value       = kubernetes_namespace.drop.metadata[0].name
}

output "ingress_alb_hostname" {
  description = "Hostname of the internal ALB created by the Ingress (empty until provisioned)."
  value       = local.alb_hostname
}

output "api_url" {
  description = "Public URL of the Drop control plane / API."
  value       = "https://${local.api_host}"
}

output "base_domain" {
  description = "Base domain for published sites (*.base_domain)."
  value       = local.base_domain
}

output "kubeconfig_command" {
  description = "Command to update local kubeconfig for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}
