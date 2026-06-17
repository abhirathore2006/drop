# =============================================================================
# Drop FOUNDATION — shared resources read by both the eks and ecs variants.
#   - ECR repository for the single unified image (api + edge bundles).
#   - Private S3 bucket for site file bytes + an IAM policy granting Drop's S3 perms.
#   - ACM wildcard cert (*.<base_domain>) validated via Route53 DNS.
#   - RDS PostgreSQL 18 (the API migrates on boot; the edge is read-only).
#   - Secrets Manager: DROP_SESSION_SECRET, DROP_GOOGLE_CLIENT_SECRET, DROP_DATABASE_URL.
# =============================================================================

# -----------------------------------------------------------------------------
# ECR — holds <name_prefix>/drop; the k8s Deployment / ECS task overrides the
# command per role: api=["node","dist/api.js"], edge=["node","dist/edge.js"].
# -----------------------------------------------------------------------------
resource "aws_ecr_repository" "drop" {
  name                 = "${var.name_prefix}/drop"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${var.name_prefix}-ecr" }
}

# Keep ECR tidy: expire all but the most recent images.
resource "aws_ecr_lifecycle_policy" "drop" {
  repository = aws_ecr_repository.drop.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# -----------------------------------------------------------------------------
# S3 — private bucket for Drop's file bytes (DROP_S3_BUCKET / DROP_S3_REGION).
# Versioned, fully public-access-blocked, SSE on. Access is via an IAM role
# (IRSA on EKS / task role on ECS) using the policy below — no access keys.
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "sites" {
  bucket = "${var.name_prefix}-sites"
  tags   = { Name = "${var.name_prefix}-sites" }
}

resource "aws_s3_bucket_versioning" "sites" {
  bucket = aws_s3_bucket.sites.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "sites" {
  bucket                  = aws_s3_bucket.sites.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sites" {
  bucket = aws_s3_bucket.sites.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# IAM policy for the Drop role: object CRUD on bucket/*, ListBucket on the bucket.
# eks/ecs roots attach this to the pod (IRSA) / task role.
resource "aws_iam_policy" "s3_access" {
  name        = "${var.name_prefix}-s3-access"
  description = "Drop access to the sites bucket (object CRUD + list)."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Objects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.sites.arn}/*"
      },
      {
        Sid      = "ListBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.sites.arn
      },
    ]
  })

  tags = { Name = "${var.name_prefix}-s3-access" }
}

# -----------------------------------------------------------------------------
# ACM — one wildcard cert *.<base_domain>. Covers api.<base_domain> AND every
# *.<base_domain> site. Terminated at the internal ALB's HTTPS :443 listener.
# Validated via Route53 DNS records.
# -----------------------------------------------------------------------------
resource "aws_acm_certificate" "wildcard" {
  domain_name       = "*.${var.base_domain}"
  validation_method = "DNS"

  # Also cover the apex base_domain (harmless; *. does not match the apex itself).
  subject_alternative_names = [var.base_domain]

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name_prefix}-wildcard" }
}

resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "wildcard" {
  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL 18 — all Drop metadata. API migrates on boot under a
# pg_advisory_lock (multi-replica safe); the edge connects read-only.
# DB subnet group lives in the existing private subnets. SG below allows 5432
# from the corp/VPC CIDR only (the ALB is internal; no public DB exposure).
# -----------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "Drop RDS PostgreSQL access (5432) from corp/VPC CIDR."
  vpc_id      = var.vpc_id

  ingress {
    description = "PostgreSQL from corp/VPC CIDR"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.corp_cidr]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-rds" }
}

# Well-known module to reduce risk on the DB.
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = "${var.name_prefix}-pg"

  engine               = "postgres"
  engine_version       = "18"
  family               = "postgres18"
  major_engine_version = "18"
  instance_class       = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = 5432

  # We manage the master password value ourselves (it flows into DROP_DATABASE_URL).
  manage_master_user_password = false

  multi_az               = false
  create_db_subnet_group = true
  subnet_ids             = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period          = 7
  deletion_protection              = true
  skip_final_snapshot              = false
  final_snapshot_identifier_prefix = "${var.name_prefix}-pg-final"

  tags = { Name = "${var.name_prefix}-pg" }
}

# -----------------------------------------------------------------------------
# Secrets Manager — the three secret keys the Helm chart / ECS task wire in:
#   DROP_SESSION_SECRET     (generated here)
#   DROP_GOOGLE_CLIENT_SECRET (from a sensitive var)
#   DROP_DATABASE_URL       (built from the RDS endpoint + creds)
# -----------------------------------------------------------------------------
resource "random_password" "session_secret" {
  length  = 64
  special = false # hex-like; matches `openssl rand -hex 32` expectations
}

resource "aws_secretsmanager_secret" "session" {
  name        = "${var.name_prefix}/DROP_SESSION_SECRET"
  description = "Drop session signing secret."
  tags        = { Name = "${var.name_prefix}-session-secret" }
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session_secret.result
}

resource "aws_secretsmanager_secret" "google" {
  name        = "${var.name_prefix}/DROP_GOOGLE_CLIENT_SECRET"
  description = "Google OAuth client secret."
  tags        = { Name = "${var.name_prefix}-google-secret" }
}

resource "aws_secretsmanager_secret_version" "google" {
  secret_id     = aws_secretsmanager_secret.google.id
  secret_string = var.google_client_secret
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${var.name_prefix}/DROP_DATABASE_URL"
  description = "Postgres connection string for Drop (DROP_DATABASE_URL)."
  tags        = { Name = "${var.name_prefix}-database-url" }
}

# postgres://user:pass@host:5432/db — module.rds.db_instance_endpoint already
# includes :5432, so don't append it again.
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgres://%s:%s@%s/%s",
    var.db_username,
    var.db_password,
    module.rds.db_instance_endpoint,
    var.db_name,
  )
}
