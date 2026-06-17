# Remote state for foundation. S3 with S3-NATIVE locking (use_lockfile) — NO
# DynamoDB table. The eks/ecs roots read this state via terraform_remote_state
# pointed at key = "drop/foundation.tfstate".
#
# Replace the bucket name (and region, if you don't pass it at init time). The
# bucket itself must exist before `terraform init` — it is intentionally NOT
# managed here (bootstrap chicken-and-egg).
terraform {
  backend "s3" {
    bucket       = "REPLACE_ME-tfstate"
    key          = "drop/foundation.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
