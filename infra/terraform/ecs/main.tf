# main.tf — Drop on AWS, Variant B (ECS Fargate, no Kubernetes).
#
# Mirrors the real shape of Drop (verified against the repo):
#   * ONE image (infra/Dockerfile, port 8080, DROP_HTTP_PORT=8080) runs both roles;
#     command override selects the role: api=["node","dist/api.js"],
#     edge=["node","dist/edge.js"].
#   * Health: api GET /healthz, edge GET /_drop_health (both 200 "ok").
#   * ONE INTERNAL ALB, host routing: api.<base_domain> -> api TG (8080);
#     *.<base_domain> (default) -> edge TG (8080). Single ACM wildcard cert on :443.
#   * RDS Postgres 18 (foundation) -> DROP_DATABASE_URL (secret). API migrates on boot
#     under a pg advisory lock; edge is read-only.
#   * S3 private bucket (foundation) for file bytes; access via the ECS TASK ROLE.
#
# This config does NOT own shared resources — it READS them from the foundation
# remote state (ECR, S3 bucket + access policy, RDS SG, Secrets, ACM cert, Route53
# zone, VPC, private subnets).

# ---------------------------------------------------------------------------
# Foundation remote state — single source of truth for shared resources.
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
  # Prefer an explicit base_domain; otherwise fall back to the foundation output.
  base_domain = var.base_domain != "" ? var.base_domain : data.terraform_remote_state.foundation.outputs.base_domain
  api_host    = "api.${local.base_domain}"

  # Shared resources from foundation (names match foundation's outputs).
  vpc_id             = data.terraform_remote_state.foundation.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.foundation.outputs.private_subnet_ids
  ecr_repository_url = data.terraform_remote_state.foundation.outputs.ecr_repository_url
  s3_bucket          = data.terraform_remote_state.foundation.outputs.s3_bucket
  s3_access_policy   = data.terraform_remote_state.foundation.outputs.s3_access_policy_arn
  rds_sg_id          = data.terraform_remote_state.foundation.outputs.rds_security_group_id
  acm_cert_arn       = data.terraform_remote_state.foundation.outputs.acm_certificate_arn
  route53_zone_id    = data.terraform_remote_state.foundation.outputs.route53_zone_id

  # Secrets Manager ARNs (foundation owns the secrets; we only grant read + reference).
  # Output names must match foundation/outputs.tf: secret_database_url_arn / secret_session_arn / secret_google_arn.
  secret_db_url        = data.terraform_remote_state.foundation.outputs.secret_database_url_arn
  secret_session       = data.terraform_remote_state.foundation.outputs.secret_session_arn
  secret_google_client = data.terraform_remote_state.foundation.outputs.secret_google_arn

  container_image = "${local.ecr_repository_url}:${var.image_tag}"
}

# ---------------------------------------------------------------------------
# Security groups
#   ALB-SG: :443 from corp_cidr (internal ALB).
#   APP-SG: :8080 from ALB-SG (tasks accept traffic only from the ALB).
#   + ingress rule adding :5432 to foundation's RDS SG, sourced from APP-SG.
# ---------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb-sg"
  description = "Drop internal ALB — HTTPS 443 from corp network."
  vpc_id      = local.vpc_id

  tags = { Name = "${var.name_prefix}-alb-sg" }
}

resource "aws_security_group_rule" "alb_ingress_https" {
  type              = "ingress"
  description       = "HTTPS from corporate/VPN range"
  security_group_id = aws_security_group.alb.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = [var.corp_cidr]
}

resource "aws_security_group_rule" "alb_egress_all" {
  type              = "egress"
  description       = "ALB to tasks"
  security_group_id = aws_security_group.alb.id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Drop ECS tasks — 8080 from ALB only."
  vpc_id      = local.vpc_id

  tags = { Name = "${var.name_prefix}-app-sg" }
}

resource "aws_security_group_rule" "app_ingress_from_alb" {
  type                     = "ingress"
  description              = "App port 8080 from ALB"
  security_group_id        = aws_security_group.app.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "app_egress_all" {
  type              = "egress"
  description       = "Tasks to S3 / RDS / ECR / Secrets / etc."
  security_group_id = aws_security_group.app.id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
}

# Allow the tasks to reach the foundation-owned RDS Postgres on 5432.
resource "aws_security_group_rule" "rds_ingress_from_app" {
  type                     = "ingress"
  description              = "Postgres 5432 from Drop ECS tasks"
  security_group_id        = local.rds_sg_id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
  source_security_group_id = aws_security_group.app.id
}

# ---------------------------------------------------------------------------
# Internal Application Load Balancer + target groups + listener + host rule.
#   default action -> edge TG (serves *.base_domain sites)
#   host == api.base_domain -> api TG
# ---------------------------------------------------------------------------
resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.private_subnet_ids

  tags = { Name = "${var.name_prefix}-alb" }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip" # Fargate (awsvpc) registers task ENIs by IP

  health_check {
    path                = "/healthz"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name_prefix}-api-tg" }
}

resource "aws_lb_target_group" "edge" {
  name        = "${var.name_prefix}-edge-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = "/_drop_health"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name_prefix}-edge-tg" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.acm_cert_arn # wildcard *.base_domain (covers api + sites)

  # Default: everything that isn't the API host goes to edge (serves the sites).
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge.arn
  }
}

# api.<base_domain> -> api TG (control plane + dashboard + OAuth callback).
resource "aws_lb_listener_rule" "api_host" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [local.api_host]
    }
  }
}

# ---------------------------------------------------------------------------
# ECS cluster
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${var.name_prefix}-cluster" }
}

# ---------------------------------------------------------------------------
# IAM
#   Execution role: pull from ECR, write logs, read the three secrets at launch.
#   Task role: app's own AWS identity — gets foundation's S3 access policy.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = { Name = "${var.name_prefix}-ecs-execution" }
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role injects the secrets, so it needs to read them at task launch.
data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid     = "ReadDropSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.secret_db_url,
      local.secret_session,
      local.secret_google_client,
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name_prefix}-ecs-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

# Task role — the application's runtime identity (S3 access via foundation policy).
resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = { Name = "${var.name_prefix}-ecs-task" }
}

resource "aws_iam_role_policy_attachment" "task_s3" {
  role       = aws_iam_role.task.name
  policy_arn = local.s3_access_policy # s3:Get/Put/DeleteObject on bucket/*, ListBucket on bucket
}

# ---------------------------------------------------------------------------
# CloudWatch log groups (awslogs driver)
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name_prefix}/api"
  retention_in_days = var.log_retention_days
  tags              = { Name = "${var.name_prefix}-api-logs" }
}

resource "aws_cloudwatch_log_group" "edge" {
  name              = "/ecs/${var.name_prefix}/edge"
  retention_in_days = var.log_retention_days
  tags              = { Name = "${var.name_prefix}-edge-logs" }
}

# ---------------------------------------------------------------------------
# Task definitions — same image, role selected by command override.
# Secrets are injected by ARN via `secrets` (valueFrom); non-secret config via
# `environment`. All three secrets are plain (no JSON key), so valueFrom is the
# bare secret ARN.
# ---------------------------------------------------------------------------
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.container_image
      essential = true
      command   = ["node", "dist/api.js"]

      portMappings = [
        { containerPort = 8080, protocol = "tcp" }
      ]

      environment = [
        { name = "DROP_HTTP_PORT", value = "8080" },
        { name = "DROP_DEV_AUTH", value = "0" },
        { name = "DROP_BASE_DOMAIN", value = local.base_domain },
        { name = "DROP_PUBLIC_URL", value = "https://${local.api_host}" }, # /auth/callback is the OAuth redirect
        { name = "DROP_S3_BUCKET", value = local.s3_bucket },
        { name = "DROP_S3_REGION", value = var.region },
        { name = "DROP_ALLOWED_DOMAINS", value = var.allowed_domains },
        { name = "DROP_ADMINS", value = var.admins },
        { name = "DROP_GOOGLE_CLIENT_ID", value = var.google_client_id },
      ]

      secrets = [
        { name = "DROP_DATABASE_URL", valueFrom = local.secret_db_url },
        { name = "DROP_SESSION_SECRET", valueFrom = local.secret_session },
        { name = "DROP_GOOGLE_CLIENT_SECRET", valueFrom = local.secret_google_client },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-api" }
}

resource "aws_ecs_task_definition" "edge" {
  family                   = "${var.name_prefix}-edge"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "edge"
      image     = local.container_image
      essential = true
      command   = ["node", "dist/edge.js"]

      portMappings = [
        { containerPort = 8080, protocol = "tcp" }
      ]

      environment = [
        { name = "DROP_HTTP_PORT", value = "8080" },
        { name = "DROP_BASE_DOMAIN", value = local.base_domain },
        { name = "DROP_S3_BUCKET", value = local.s3_bucket },
        { name = "DROP_S3_REGION", value = var.region },
        { name = "DROP_EDGE_DISK_CACHE", value = "/cache" }, # ephemeral per-task asset cache
      ]

      # Edge connects read-only; it still needs DATABASE_URL to read metadata.
      secrets = [
        { name = "DROP_DATABASE_URL", valueFrom = local.secret_db_url },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.edge.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "edge"
        }
      }
    }
  ])

  tags = { Name = "${var.name_prefix}-edge" }
}

# ---------------------------------------------------------------------------
# ECS services (Fargate, private subnets, APP-SG, wired to their TGs).
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  # Give the API time to run boot migrations before health checks fail it.
  health_check_grace_period_seconds = 120

  # Don't fight ECS rollouts that bump the active task-def revision.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = { Name = "${var.name_prefix}-api" }
}

resource "aws_ecs_service" "edge" {
  name            = "${var.name_prefix}-edge"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.edge.arn
  desired_count   = var.edge_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.edge.arn
    container_name   = "edge"
    container_port   = 8080
  }

  health_check_grace_period_seconds = 60

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = { Name = "${var.name_prefix}-edge" }
}

# ---------------------------------------------------------------------------
# Route53 — alias api.<base_domain> and *.<base_domain> at the internal ALB.
# ---------------------------------------------------------------------------
resource "aws_route53_record" "api" {
  zone_id = local.route53_zone_id
  name    = local.api_host
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "wildcard" {
  zone_id = local.route53_zone_id
  name    = "*.${local.base_domain}"
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
