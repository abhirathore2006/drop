// In-memory BucketStore for tests (mirrors FakeSecretStore / FakeImageStore). Records provisions,
// rotations, and destroys so tests can assert on them, and exposes SCRIPTABLE usage so a test can
// simulate a non-empty bucket (the force-delete + storage-budget paths need this).
import type { BucketStore, BucketScope, BucketCreds, BucketUsage } from "./types.ts";
import { bucketPrefix } from "./types.ts";

export class FakeBucketStore implements BucketStore {
  readonly provisions: string[] = []; // "ns/name" per provision call
  readonly rotations: string[] = [];
  readonly destroyed: string[] = [];
  /** Scriptable per-bucket usage, keyed by "ns/name". Absent → an empty bucket (0/0). */
  readonly usageByKey = new Map<string, BucketUsage>();
  /** A monotonically-bumped rotation counter per bucket, so a test can prove rotate() changed the
   *  secret material even though the fake's creds are otherwise deterministic. */
  private rotateCount = new Map<string, number>();

  private key(ctx: BucketScope): string {
    return `${ctx.namespace}/${ctx.name}`;
  }

  private creds(ctx: BucketScope): BucketCreds {
    const n = this.rotateCount.get(this.key(ctx)) ?? 0;
    return {
      endpoint: "http://fake-s3.local",
      bucket: "platform-bucket",
      prefix: bucketPrefix(ctx.namespace, ctx.name),
      keyId: `AKIA-${ctx.name}`,
      secret: `secret-${ctx.name}-${n}`,
    };
  }

  async provision(ctx: BucketScope): Promise<BucketCreds> {
    this.provisions.push(this.key(ctx));
    return this.creds(ctx);
  }

  async rotate(ctx: BucketScope): Promise<BucketCreds> {
    const k = this.key(ctx);
    this.rotations.push(k);
    this.rotateCount.set(k, (this.rotateCount.get(k) ?? 0) + 1);
    return this.creds(ctx);
  }

  async usage(ctx: BucketScope): Promise<BucketUsage> {
    return this.usageByKey.get(this.key(ctx)) ?? { bytes: 0, objects: 0 };
  }

  async destroy(ctx: BucketScope): Promise<void> {
    this.destroyed.push(this.key(ctx));
    this.usageByKey.delete(this.key(ctx));
  }
}
