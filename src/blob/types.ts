import type { Readable } from "node:stream";

/** Thrown when a conditional write (If-None-Match / If-Match) precondition fails. */
export class PreconditionFailedError extends Error {
  constructor(msg = "precondition failed") {
    super(msg);
    this.name = "PreconditionFailedError";
  }
}

export interface GetResult {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentEncoding?: string;
  etag?: string;
  size?: number;
}

export interface PutOptions {
  /** true → create only if the key does not already exist (If-None-Match: *). */
  ifNoneMatch?: boolean;
  /** write only if the current object's ETag matches (If-Match). */
  ifMatch?: string;
}

export interface ListResult {
  keys: string[];
  /** Common prefixes when a delimiter is supplied (the "subdirectories"). */
  prefixes: string[];
}

export interface ListPageOptions {
  delimiter?: string;
  cursor?: string; // opaque continuation token from a previous page
  limit?: number; // max keys+prefixes per page
}

export interface ListPage {
  keys: string[];
  prefixes: string[];
  nextCursor?: string; // present if there are more pages
}

export interface BlobStore {
  /** Stores the object. Throws PreconditionFailedError if a conditional fails. */
  put(
    key: string,
    body: Readable | Buffer | Uint8Array,
    size: number,
    contentType: string,
    opts?: PutOptions,
  ): Promise<{ etag?: string }>;

  /** Returns null when the key does not exist. */
  get(key: string): Promise<GetResult | null>;

  /** Delete a single object by exact key. */
  delete(key: string): Promise<void>;

  deletePrefix(prefix: string): Promise<void>;

  list(prefix: string, delimiter?: string): Promise<ListResult>;

  /** A single page of a listing, with a continuation cursor for the next page. */
  listPage(prefix: string, opts?: ListPageOptions): Promise<ListPage>;

  /** Idempotently create the bucket (Floci / MinIO / AWS). */
  ensureBucket(): Promise<void>;
}

/** Reads a GetResult body fully to a string (small JSON metadata objects). */
export async function readText(r: GetResult): Promise<string> {
  return await new Response(r.body).text();
}
