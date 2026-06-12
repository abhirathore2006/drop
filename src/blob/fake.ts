import type { Readable } from "node:stream";
import type { BlobStore, GetResult, ListResult, ListPage, ListPageOptions, PutOptions } from "./types.ts";
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

  async delete(key: string): Promise<void> {
    this.objs.delete(key);
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

  async listPage(prefix: string, opts: ListPageOptions = {}): Promise<ListPage> {
    const all = await this.list(prefix, opts.delimiter);
    // Merge keys + prefixes into one ordered stream, page by numeric cursor.
    const items = [...all.prefixes.map((p) => ({ p })), ...all.keys.map((k) => ({ k }))].sort((a, b) =>
      (("p" in a ? a.p : a.k!) < ("p" in b ? b.p : b.k!) ? -1 : 1),
    );
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = items.slice(start, start + limit);
    const next = start + limit < items.length ? String(start + limit) : undefined;
    return {
      keys: page.filter((x) => "k" in x).map((x: any) => x.k),
      prefixes: page.filter((x) => "p" in x).map((x: any) => x.p),
      nextCursor: next,
    };
  }
}
