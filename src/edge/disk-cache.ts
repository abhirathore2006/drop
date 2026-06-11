import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface DiskEntry {
  body: Uint8Array;
  contentType: string;
  contentEncoding?: string;
}

interface Meta {
  contentType: string;
  contentEncoding?: string;
}

/**
 * Optional L2 cache: stores immutable file bytes on local disk, keyed by a hash
 * of the (versioned, immutable) S3 path. Survives process restarts on a
 * persistent volume; the OS page cache keeps hot files at RAM speed. Use a
 * node-local / per-pod directory (not a shared RWX volume across replicas).
 */
export class DiskCache {
  private ready: Promise<void>;
  constructor(private dir: string, private maxBytes: number) {
    this.ready = fs.mkdir(dir, { recursive: true }).then(() => {});
  }

  private path(key: string): string {
    return join(this.dir, createHash("sha256").update(key).digest("hex"));
  }

  async get(key: string): Promise<DiskEntry | null> {
    await this.ready;
    const p = this.path(key);
    try {
      const [body, metaRaw] = await Promise.all([fs.readFile(p), fs.readFile(p + ".meta", "utf8")]);
      const meta = JSON.parse(metaRaw) as Meta;
      fs.utimes(p, new Date(), new Date()).catch(() => {}); // touch → LRU by mtime
      return { body: new Uint8Array(body), contentType: meta.contentType, contentEncoding: meta.contentEncoding };
    } catch {
      return null;
    }
  }

  async set(key: string, e: DiskEntry): Promise<void> {
    await this.ready;
    const p = this.path(key);
    const tmp = `${p}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, e.body);
      await fs.rename(tmp, p); // atomic — never serve a partial file
      await fs.writeFile(`${p}.meta`, JSON.stringify({ contentType: e.contentType, contentEncoding: e.contentEncoding }));
      this.evict().catch(() => {});
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Coarse size-bounded LRU: drop oldest (by mtime) until under budget. */
  private async evict(): Promise<void> {
    const names = (await fs.readdir(this.dir)).filter((f) => !f.endsWith(".meta") && !f.endsWith(".tmp"));
    const stats = await Promise.all(
      names.map(async (f) => {
        const s = await fs.stat(join(this.dir, f)).catch(() => null);
        return s ? { f, size: s.size, mtime: s.mtimeMs } : null;
      }),
    );
    const files = stats.filter((x): x is { f: string; size: number; mtime: number } => x !== null);
    let total = files.reduce((a, b) => a + b.size, 0);
    if (total <= this.maxBytes) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const v of files) {
      if (total <= this.maxBytes) break;
      await fs.rm(join(this.dir, v.f), { force: true }).catch(() => {});
      await fs.rm(join(this.dir, `${v.f}.meta`), { force: true }).catch(() => {});
      total -= v.size;
    }
  }
}
