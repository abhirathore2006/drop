// Local (Floci/MinIO) BucketStore: a bucket is an isolated PREFIX inside the platform's OWN S3 bucket
// (the same bucket that already holds site bytes), namespaced per tenant via bucketPrefix().
//
// !!! LOCAL ONLY — the returned credentials are the PLATFORM's own static S3 creds (DROP_S3_KEY_ID/
// !!! SECRET). They are NOT prefix-scoped: a tenant handed these keys could, in principle, read another
// !!! tenant's prefix. That is acceptable for LOCAL DEV against Floci, where every tenant shares one
// !!! test key pair anyway. In PROD this store MUST be replaced by an aws-iam store that mints a
// !!! per-tenant IAM/STS key pair scoped to exactly this prefix — see the prefix-scoped policy template
// !!! at infra/terraform/eks/bucket-policy.tf.example (rendered by prefixScopedPolicy() in ./types.ts).
//
// DECISION — creds idempotency: because the creds are the platform's static creds + a deterministic
// prefix, provision() is naturally IDEMPOTENT: calling it again (as the deploy-time binding does)
// returns the exact same material without persisting anything. rotate() therefore returns the same
// creds too (there is nothing tenant-specific to re-mint locally); a future aws-iam store's rotate()
// would mint a new key pair and MUST persist it in a platform secret so the binding can re-read it.
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import type { BucketStore, BucketScope, BucketCreds, BucketUsage } from "./types.ts";
import { bucketPrefix } from "./types.ts";

export interface FlociBucketOptions {
  bucket: string; // the platform S3 bucket (DROP_S3_BUCKET) — buckets live under a prefix inside it
  region: string;
  /** Host-side endpoint for THIS store's own S3 calls (usage/destroy). = DROP_S3_ENDPOINT locally;
   *  undefined → real AWS S3 (SDK default credential chain / IRSA). */
  clientEndpoint?: string;
  /** Endpoint RETURNED to apps (must be reachable from a tenant pod — the in-cluster S3 address).
   *  Defaults to clientEndpoint; "" (or undefined) means "use the AWS default" (prod). */
  appEndpoint?: string;
  keyId?: string; // platform static creds (local); undefined in prod (aws-iam store required there)
  secret?: string;
}

export class FlociBucketStore implements BucketStore {
  private client: S3Client;
  private bucket: string;
  private appEndpoint: string;
  private keyId: string;
  private secret: string;

  constructor(o: FlociBucketOptions) {
    this.bucket = o.bucket;
    this.appEndpoint = o.appEndpoint ?? o.clientEndpoint ?? "";
    this.keyId = o.keyId ?? "";
    this.secret = o.secret ?? "";
    this.client = new S3Client({
      region: o.region,
      endpoint: o.clientEndpoint,
      forcePathStyle: !!o.clientEndpoint, // required for Floci / MinIO
      credentials: o.keyId ? { accessKeyId: o.keyId, secretAccessKey: o.secret ?? "" } : undefined,
    });
  }

  private creds(ctx: BucketScope): BucketCreds {
    return {
      endpoint: this.appEndpoint,
      bucket: this.bucket,
      prefix: bucketPrefix(ctx.namespace, ctx.name),
      keyId: this.keyId,
      secret: this.secret,
    };
  }

  // Idempotent by construction (static creds + deterministic prefix); no state is written.
  async provision(ctx: BucketScope): Promise<BucketCreds> {
    return this.creds(ctx);
  }

  // Local store has no per-tenant key to re-mint — returns the same platform creds (documented above).
  async rotate(ctx: BucketScope): Promise<BucketCreds> {
    return this.creds(ctx);
  }

  async usage(ctx: BucketScope): Promise<BucketUsage> {
    const prefix = bucketPrefix(ctx.namespace, ctx.name);
    let bytes = 0;
    let objects = 0;
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) {
        bytes += o.Size ?? 0;
        objects += 1;
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return { bytes, objects };
  }

  async destroy(ctx: BucketScope): Promise<void> {
    const prefix = bucketPrefix(ctx.namespace, ctx.name);
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objs = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objs.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objs } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
}
