# backend.tf — remote state for the ECS root config.
# S3 backend with S3-native locking (use_lockfile) — NO DynamoDB table.
# The bucket name is a placeholder; override at `terraform init` time with:
#   terraform init -backend-config="bucket=<your>-tfstate" -backend-config="region=<region>"
# (backend blocks cannot use variables, hence the literal placeholder + -backend-config.)
terraform {
  backend "s3" {
    bucket       = "REPLACE_ME-tfstate"
    key          = "drop/ecs.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
