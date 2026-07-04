// Selects the BucketStore backend from config, mirroring makeSecretStore / makeImageStore.
//
// v1 has ONE backend: the floci-prefix store (a prefix in the platform bucket). It works both
// locally (Floci, static creds) and — degraded — in prod (real S3 via IRSA, but the returned
// per-app creds are empty because prefix-scoped IAM key minting is NOT implemented yet). A real
// `aws-iam` backend (mint a per-tenant, prefix-scoped IAM/STS key pair; persist it in a platform
// secret so provision() stays idempotent) is OUT of scope for v1 — the prefix-scoped policy it
// must attach is templated at infra/terraform/eks/bucket-policy.tf.example.
import type { Config } from "../config.ts";
import type { BucketStore } from "./types.ts";
import { FlociBucketStore } from "./floci.ts";

export function makeBucketStore(cfg: Config): BucketStore {
  return new FlociBucketStore({
    bucket: cfg.s3Bucket,
    region: cfg.s3Region,
    clientEndpoint: cfg.s3Endpoint, // host-side (usage/destroy run in the API)
    // Endpoint handed to apps: the in-cluster S3 address (same one CNPG backups use locally). Prod
    // leaves it unset → apps use the AWS S3 default for the region.
    appEndpoint: cfg.bucketAppEndpoint ?? cfg.dbBackupEndpoint ?? cfg.s3Endpoint,
    keyId: cfg.s3KeyId,
    secret: cfg.s3Secret,
  });
}
