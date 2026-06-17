# Remote state for the Drop EKS root config.
#
# S3 backend with S3-NATIVE locking (use_lockfile = true). There is intentionally
# NO dynamodb_table — locking is handled by the state lockfile in S3.
#
# Replace the bucket below with your real state bucket. The region must be a literal
# here (backend blocks cannot use variables); keep it in sync with var.region.
terraform {
  backend "s3" {
    bucket       = "REPLACE_ME-tfstate"
    key          = "drop/eks.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
