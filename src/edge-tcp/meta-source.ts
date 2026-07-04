import type { TcpRouteSource, TcpTarget } from "./route-source.ts";
import { TcpEndpointStore, type TcpEndpointResolved } from "./store.ts";
import type { Db } from "../db/db.ts";

// The metastore-backed TcpRouteSource (A2b): resolves a live connection to its in-cluster upstream by
// reading `tcp_endpoints` joined to the workload's type + tenant namespace, with the SAME read-only
// posture the HTTP edge uses for sites. A small in-process TTL cache fronts the DB so a busy shared
// port (many short psql connections) doesn't issue a query per SYN.

// Where a resolved target's upstream lives. An app is fronted by its ClusterIP Service on the standard
// app service port; a managed database is reached through its CNPG read-write Service on 5432.
const APP_SERVICE_PORT = 80; // appManifests emits Service :80 → targetPort <internalPort>
const DB_RW_PORT = 5432;

const DEFAULT_TTL_MS = 5000; // ~5s: a just-exposed/unexposed workload converges within this window.

interface CacheEntry {
  value: TcpTarget | null; // negative results are cached too (an unexposed name/port shouldn't hammer the DB)
  expiresAt: number;
}

export interface MetastoreRouteSourceOptions {
  /** `<name>.<baseDomain>` is the SNI hostname shape; the leftmost label is the workload name. */
  baseDomain: string;
  /** Cache TTL in ms (default 5000). Bounds how stale a route can be after an expose/unexpose. */
  ttlMs?: number;
  /** Injectable clock (tests) — same seam the router/server use. */
  now?: () => number;
}

export class MetastoreRouteSource implements TcpRouteSource {
  private readonly store: TcpEndpointStore;
  private readonly suffix: string; // ".<baseDomain>", lowercased
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(db: Db, opts: MetastoreRouteSourceOptions) {
    this.store = new TcpEndpointStore(db);
    this.suffix = "." + opts.baseDomain.toLowerCase().replace(/^\.+|\.+$/g, "");
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Read-through the TTL cache: a fresh hit (incl. a cached miss) returns immediately; otherwise run
   *  `load`, cache its result for `ttlMs`, and return it. */
  private async cached(key: string, load: () => Promise<TcpTarget | null>): Promise<TcpTarget | null> {
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expiresAt) return hit.value;
    const value = await load();
    this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** Map a resolved expose row to its upstream target. A row with no routable namespace/type yields
   *  null (the join already dropped a namespace-less row). */
  private target(r: TcpEndpointResolved | null): TcpTarget | null {
    if (!r) return null;
    if (r.type === "database") {
      return { host: `${r.siteName}-rw.${r.namespace}.svc.cluster.local`, port: DB_RW_PORT, workload: r.siteName };
    }
    if (r.type === "app") {
      return { host: `${r.siteName}.${r.namespace}.svc.cluster.local`, port: APP_SERVICE_PORT, workload: r.siteName };
    }
    return null; // sites / buckets have no TCP upstream
  }

  resolveSni(name: string): Promise<TcpTarget | null> {
    const host = name.toLowerCase();
    // Only route `<workload>.<baseDomain>`; anything else has no routing key here.
    if (!host.endsWith(this.suffix)) return Promise.resolve(null);
    const workload = host.slice(0, host.length - this.suffix.length);
    if (!workload || workload.includes(".")) return Promise.resolve(null); // must be a single leftmost label
    return this.cached(`sni:${workload}`, async () => this.target(await this.store.resolveSni(workload)));
  }

  resolvePort(port: number): Promise<TcpTarget | null> {
    return this.cached(`port:${port}`, async () => this.target(await this.store.resolvePort(port)));
  }
}
