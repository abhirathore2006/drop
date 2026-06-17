import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { BlobStore, GetResult, ListResult, PutOptions } from "./types.ts";
import { PreconditionFailedError } from "./types.ts";

export interface S3Options {
  bucket: string;
  endpoint?: string;
  region: string;
  keyId?: string;
  secret?: string;
}

function status(e: unknown): number | undefined {
  return (e as any)?.$metadata?.httpStatusCode;
}
function errName(e: unknown): string {
  return (e as any)?.name ?? "";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(body: Readable | Buffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body; // Buffer is a Uint8Array
  const chunks: Buffer[] = [];
  for await (const c of body as Readable) chunks.push(Buffer.from(c));
  return new Uint8Array(Buffer.concat(chunks));
}

export class S3Blob implements BlobStore {
  private client: S3Client;
  private bucket: string;

  constructor(o: S3Options) {
    this.bucket = o.bucket;
    this.client = new S3Client({
      region: o.region,
      endpoint: o.endpoint,
      forcePathStyle: !!o.endpoint, // required for Floci / MinIO
      credentials: o.keyId ? { accessKeyId: o.keyId, secretAccessKey: o.secret ?? "" } : undefined,
    });
  }

  async ensureBucket(retries = 10): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (e) {
        const n = errName(e);
        if (n === "BucketAlreadyOwnedByYou" || n === "BucketAlreadyExists") return;
        if (i >= retries) throw e;
        await sleep(1000); // storage may still be starting
      }
    }
  }

  async put(
    key: string,
    body: Readable | Buffer | Uint8Array,
    _size: number,
    contentType: string,
    opts: PutOptions = {},
  ): Promise<{ etag?: string }> {
    // Materialize the body: the S3 SDK can't checksum a flowing Node stream, and
    // static-site files are small enough to buffer one at a time.
    const bytes = await collect(body);
    // AWS guidance: retry the upload on 409 ConditionalRequestConflict.
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: contentType,
            ...(opts.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
            ...(opts.ifMatch ? { IfMatch: opts.ifMatch } : {}),
          }),
        );
        return { etag: out.ETag };
      } catch (e) {
        if (status(e) === 412 || errName(e) === "PreconditionFailed") {
          throw new PreconditionFailedError(`precondition failed for ${key}`);
        }
        if ((status(e) === 409 || errName(e) === "ConditionalRequestConflict") && attempt < 5) {
          await sleep(50 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const web = (out.Body as any).transformToWebStream() as ReadableStream<Uint8Array>;
      return {
        body: web,
        contentType: out.ContentType ?? "application/octet-stream",
        contentEncoding: out.ContentEncoding,
        etag: out.ETag,
        size: out.ContentLength,
      };
    } catch (e) {
      if (status(e) === 404 || errName(e) === "NoSuchKey" || errName(e) === "NotFound") return null;
      throw e;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
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

  async list(prefix: string, delimiter?: string): Promise<ListResult> {
    const keys: string[] = [];
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: delimiter,
          ContinuationToken: token,
        }),
      );
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      for (const p of out.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return { keys, prefixes };
  }
}
