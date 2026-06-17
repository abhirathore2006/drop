import type { Readable } from "node:stream";
import type { BlobStore, GetResult, ListResult, PutOptions } from "./types.ts";
import { PreconditionFailedError } from "./types.ts";

interface Obj {
  data: Uint8Array;
  contentType: string;
  etag: string;
}

async function toBytes(body: Readable | Buffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Buffer[] = [];
  for await (const c of body as Readable) chunks.push(Buffer.from(c));
  return new Uint8Array(Buffer.concat(chunks));
}

/** In-memory BlobStore that faithfully simulates ETags + conditional writes. */
export class FakeBlob implements BlobStore {
  private objs = new Map<string, Obj>();
  private seq = 0;

  async ensureBucket(): Promise<void> {}

  async put(
    key: string,
    body: Readable | Buffer | Uint8Array,
    _size: number,
    contentType: string,
    opts: PutOptions = {},
  ): Promise<{ etag: string }> {
    const existing = this.objs.get(key);
    if (opts.ifNoneMatch && existing) {
      throw new PreconditionFailedError(`object already exists: ${key}`);
    }
    if (opts.ifMatch !== undefined && (!existing || existing.etag !== opts.ifMatch)) {
      throw new PreconditionFailedError(`etag mismatch: ${key}`);
    }
    const data = await toBytes(body);
    const etag = `"fake-${++this.seq}"`;
    this.objs.set(key, { data, contentType, etag });
    return { etag };
  }

  async get(key: string): Promise<GetResult | null> {
    const o = this.objs.get(key);
    if (!o) return null;
    return {
      body: new Response(o.data).body as ReadableStream<Uint8Array>,
      contentType: o.contentType,
      etag: o.etag,
      size: o.data.byteLength,
    };
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objs.keys()]) if (k.startsWith(prefix)) this.objs.delete(k);
  }

  async list(prefix: string, delimiter?: string): Promise<ListResult> {
    const keys: string[] = [];
    const prefixes = new Set<string>();
    for (const k of this.objs.keys()) {
      if (!k.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) {
          prefixes.add(prefix + rest.slice(0, i + delimiter.length));
          continue;
        }
      }
      keys.push(k);
    }
    return { keys: keys.sort(), prefixes: [...prefixes].sort() };
  }
}
