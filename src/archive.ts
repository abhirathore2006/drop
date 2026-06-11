import { extract } from "tar-stream";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { posix } from "node:path";

export interface Limits {
  maxFiles: number;
  maxBytes: number;
}

export type PutFn = (relPath: string, body: Readable, size: number, contentType: string) => Promise<void>;

const TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html",
  ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".xml": "application/xml",
};

function contentType(p: string): string {
  const i = p.lastIndexOf(".");
  return (i >= 0 && TYPES[p.slice(i).toLowerCase()]) || "application/octet-stream";
}

/** Clean relative slash path, or throws on traversal / absolute paths. */
function sanitize(name: string): string {
  const n = name.replace(/\\/g, "/"); // normalize Windows separators
  if (n.startsWith("/")) throw new Error(`absolute path not allowed: ${name}`);
  if (n.split("/").includes("..")) throw new Error(`path traversal not allowed: ${name}`);
  const clean = posix.normalize(n).replace(/^\/+/, "");
  if (!clean || clean === ".") throw new Error("empty path");
  return clean;
}

/**
 * Reads a gzipped tar, invoking `put` for each regular file. Rejects path
 * traversal and enforces limits. Returns file count and total uncompressed bytes.
 */
export async function extractTarGz(
  gz: Readable,
  put: PutFn,
  lim: Limits,
): Promise<{ files: number; bytes: number }> {
  const ex = extract();
  let files = 0;
  let bytes = 0;
  let aborted: Error | null = null;

  // On any failure we record it, drain the rest of the archive (so the parser
  // reaches "finish"), then reject — rather than destroying mid-stream, which
  // emits unhandled premature-close errors.
  const done = new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      if (aborted || header.type !== "file") {
        stream.on("end", next);
        stream.on("error", () => {});
        stream.resume();
        return;
      }
      let clean: string;
      try {
        clean = sanitize(header.name);
      } catch (e) {
        aborted = e as Error;
        stream.resume();
        return next();
      }
      files++;
      const size = header.size ?? 0;
      bytes += size;
      if (files > lim.maxFiles) aborted = new Error(`too many files (limit ${lim.maxFiles})`);
      else if (bytes > lim.maxBytes) aborted = new Error(`upload too large (limit ${lim.maxBytes} bytes)`);
      if (aborted) {
        stream.resume();
        return next();
      }
      put(clean, stream as unknown as Readable, size, contentType(clean))
        .then(() => next())
        .catch((e) => {
          aborted = e as Error;
          stream.resume();
          next();
        });
    });
    ex.on("finish", () => (aborted ? reject(aborted) : resolve()));
    ex.on("error", reject);

    const gunzip = createGunzip();
    gunzip.on("error", reject); // corrupt gzip
    gz.on("error", reject);
    gz.pipe(gunzip).pipe(ex);
  });

  await done;
  return { files, bytes };
}
