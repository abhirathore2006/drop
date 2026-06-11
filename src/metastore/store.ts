import type { BlobStore } from "../blob/types.ts";
import { PreconditionFailedError, readText } from "../blob/types.ts";
import { type Site, type VersionMeta, SiteNotFoundError } from "./types.ts";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o));

/**
 * MetaStore replaces the database. All state is S3 objects:
 *   sites/<name>/site.json              — the record (claim via If-None-Match, edit via If-Match CAS)
 *   sites/<name>/versions/<id>.json     — immutable per-publish audit
 *   sites/<name>/files/<id>/...         — the served files
 */
export class MetaStore {
  constructor(
    private blob: BlobStore,
    private now: () => Date = () => new Date(),
  ) {}

  siteKey(name: string) { return `sites/${name}/site.json`; }
  versionKey(name: string, id: string) { return `sites/${name}/versions/${id}.json`; }
  filesPrefix(name: string, id: string) { return `sites/${name}/files/${id}/`; }
  sitePrefix(name: string) { return `sites/${name}/`; }

  /** Returns the site record plus its current ETag, or null if it doesn't exist. */
  async getSite(name: string): Promise<{ site: Site; etag?: string } | null> {
    const r = await this.blob.get(this.siteKey(name));
    if (!r) return null;
    const site = JSON.parse(await readText(r)) as Site;
    return { site, etag: r.etag };
  }

  /** Convenience for read-only callers (the edge). */
  async getSitePlain(name: string): Promise<Site | null> {
    return (await this.getSite(name))?.site ?? null;
  }

  /**
   * Atomically claim a name. Returns the new Site, or null if already taken.
   * Uses If-None-Match so exactly one concurrent claimer wins.
   */
  async claimSite(name: string, owner: string): Promise<Site | null> {
    const ts = this.now().toISOString();
    const site: Site = {
      name, owner, collaborators: [], currentVersion: null, createdAt: ts, updatedAt: ts,
    };
    try {
      await this.blob.put(this.siteKey(name), enc(site), 0, "application/json", { ifNoneMatch: true });
      return site;
    } catch (e) {
      if (e instanceof PreconditionFailedError) return null; // someone else claimed it
      throw e;
    }
  }

  /**
   * Read-modify-write the site record with compare-and-swap (If-Match), retrying
   * on a lost-update race. Throws SiteNotFoundError if the site is gone.
   */
  async updateSite(name: string, mutate: (s: Site) => Site, retries = 5): Promise<Site> {
    for (let i = 0; ; i++) {
      const cur = await this.getSite(name);
      if (!cur) throw new SiteNotFoundError(name);
      const next = { ...mutate(cur.site), updatedAt: this.now().toISOString() };
      try {
        await this.blob.put(this.siteKey(name), enc(next), 0, "application/json", { ifMatch: cur.etag });
        return next;
      } catch (e) {
        if (e instanceof PreconditionFailedError && i < retries) continue; // raced; re-read
        throw e;
      }
    }
  }

  async deleteSite(name: string): Promise<void> {
    await this.blob.deletePrefix(this.sitePrefix(name));
  }

  /** All site names (rare op; used by `drop ls`). */
  async listSiteNames(): Promise<string[]> {
    const { prefixes } = await this.blob.list("sites/", "/");
    return prefixes.map((p) => p.slice("sites/".length, -1)).filter(Boolean);
  }

  async putVersion(name: string, v: VersionMeta): Promise<void> {
    await this.blob.put(this.versionKey(name, v.id), enc(v), 0, "application/json");
  }

  async getVersion(name: string, id: string): Promise<VersionMeta | null> {
    const r = await this.blob.get(this.versionKey(name, id));
    if (!r) return null;
    return JSON.parse(await readText(r)) as VersionMeta;
  }

  /** Version audit records, newest first. */
  async listVersions(name: string): Promise<VersionMeta[]> {
    const { keys } = await this.blob.list(`sites/${name}/versions/`);
    const metas: VersionMeta[] = [];
    for (const k of keys) {
      if (!k.endsWith(".json")) continue;
      const r = await this.blob.get(k);
      if (r) metas.push(JSON.parse(await readText(r)) as VersionMeta);
    }
    return metas.sort((a, b) => (a.id < b.id ? 1 : -1)); // sortable id → newest first
  }
}
