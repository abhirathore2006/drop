// The bucket-store boundary. The API depends on this port, never on a concrete backend — so the
// same "tenant object storage" flow works over a prefix in the platform's own S3 bucket (local
// Floci) or a per-tenant real bucket / prefix + scoped IAM policy (prod), chosen at deploy time.
// Same shape as SecretStore / ImageStore: a real impl + a fake for tests, selected by config.
//
// Buckets are S3-side, so this port is INDEPENDENT of the compute plane (no KubeClient). Credentials
// are surfaced to the caller ONCE (RevealOnce posture) and never persisted in the metastore — the
// deploy-time binding re-derives them by calling provision() again (which MUST be idempotent for the
// floci-local store; see the DECISION note below).

/** The addressing context for a bucket resource. `namespace` is the tenant namespace — the isolation
 *  boundary that keeps two tenants' prefixes disjoint (see bucketPrefix). `org` is the owning org id,
 *  carried for a future per-tenant real-bucket naming scheme (aws-iam store). */
export interface BucketScope {
  name: string; // the bucket workload name (globally unique in Drop)
  namespace: string; // tenant namespace (isolation)
  org: string; // owning org id
}

/** The connection material an app needs to talk to its bucket. Returned by provision()/rotate() and
 *  written straight through the write-only secret path (S3_ENDPOINT/S3_BUCKET/S3_PREFIX/
 *  S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — never stored in the metastore or a manifest. */
export interface BucketCreds {
  endpoint: string; // S3 endpoint reachable from the app pod (in-cluster address locally; real S3 in prod)
  bucket: string; // the S3 bucket name
  prefix: string; // the tenant/resource key prefix — the isolation boundary
  keyId: string; // access key id
  secret: string; // secret access key
}

/** Eventually-consistent size accounting for a bucket (a ListObjectsV2 sweep totalling object sizes). */
export interface BucketUsage {
  bytes: number;
  objects: number;
}

export interface BucketStore {
  /** Provision (or resolve) a tenant bucket and return its connection creds. MUST be idempotent — the
   *  deploy-time binding calls this again to re-derive the same creds without persisting them. */
  provision(ctx: BucketScope): Promise<BucketCreds>;
  /** Re-mint the access credentials for a bucket (printed once; never stored). For the floci-local
   *  store the creds are the platform's static creds, so rotate returns the same material (documented).
   *  A future aws-iam store re-mints an IAM/STS key pair and must persist it in a platform secret. */
  rotate(ctx: BucketScope): Promise<BucketCreds>;
  /** Delete every object under the resource's prefix (best-effort; called on bucket delete). */
  destroy(ctx: BucketScope): Promise<void>;
  /** Total bytes + object count under the resource's prefix. Eventually-consistent — fine for quota. */
  usage(ctx: BucketScope): Promise<BucketUsage>;
}

// ---- pure prefix + IAM-policy derivation (the isolation-test asset) ----

/** The single authority for a bucket's key prefix within the shared platform bucket. Keyed on the
 *  tenant namespace first, so two tenants' prefixes NEVER overlap — the isolation invariant. The
 *  floci-local store uses this to scope reads/writes; the terraform per-tenant IAM policy
 *  (infra/terraform/eks/bucket-policy.tf.example) grants exactly this prefix in prod. */
export function bucketPrefix(namespace: string, name: string): string {
  return `buckets/${namespace}/${name}/`;
}

/** A minimal IAM policy document type (the fields we render for a prefix-scoped grant). */
export interface IamPolicyDocument {
  Version: "2012-10-17";
  Statement: Array<{
    Sid: string;
    Effect: "Allow";
    Action: string[];
    Resource: string[];
    Condition?: Record<string, Record<string, string[]>>;
  }>;
}

/**
 * Render the per-tenant, prefix-scoped S3 IAM policy for a bucket — the SAME shape the terraform
 * template emits in prod, exposed here as a PURE function so the isolation guarantee is table-testable:
 * two tenants' policies must grant disjoint `Resource` ARNs (object access) and disjoint list-prefix
 * conditions. The object grant is `arn:aws:s3:::<bucket>/<prefix>*`; the list grant is on the bucket
 * ARN but conditioned to `s3:prefix = <prefix>*` so a tenant can't even enumerate another's keys.
 */
export function prefixScopedPolicy(bucket: string, prefix: string): IamPolicyDocument {
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TenantObjectAccess",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`${bucketArn}/${prefix}*`],
      },
      {
        Sid: "TenantListScoped",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [bucketArn],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
    ],
  };
}
