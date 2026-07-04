import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { WorkloadType } from "../metastore/types.ts";

// The exposure registry (A2b) over `tcp_endpoints`. One row per exposed workload (site_name PK).
// The API's expose routes are the SOLE writer; the edge-tcp router (MetastoreRouteSource) reads the
// resolve* queries with the same read-only posture the edge uses for sites.

export type TcpMode = "sni" | "port";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export interface TcpEndpoint {
  siteName: string;
  port: number | null; // set for mode='port'; null for mode='sni'
  mode: TcpMode;
  protocol: string; // 'postgres' | 'redis' | 'tcp'
  createdBy: string;
  createdAt: string;
}

/** An expose row joined to its workload's runtime coordinates (type + tenant namespace) — everything
 *  the router needs to resolve a connection, and everything the API needs to build the tenant
 *  "allow from edge-tcp" NetworkPolicy for the exposed workload. */
export interface TcpEndpointResolved extends TcpEndpoint {
  type: WorkloadType;
  namespace: string;
}

/** An expose row + its workload type (no namespace) — for org/user-scoped list views. */
export interface TcpEndpointWithType extends TcpEndpoint {
  type: WorkloadType;
}

/** Thrown by exposePort when every port in the configured dynamic pool is taken (→ HTTP 409). SNI
 *  mode exists precisely to conserve this scarce pool (the NLB listener quota is the real ceiling). */
export class PortPoolExhaustedError extends Error {
  readonly name = "PortPoolExhaustedError";
  constructor(readonly from: number, readonly to: number) {
    super(`no free TCP port in ${from}-${to} — the dynamic pool is exhausted (use --sni to conserve it)`);
  }
}

function toEndpoint(row: Record<string, unknown>): TcpEndpoint {
  return {
    siteName: row.site_name as string,
    port: (row.port as number | null) ?? null,
    mode: row.mode as TcpMode,
    protocol: row.protocol as string,
    createdBy: row.created_by as string,
    createdAt: iso(row.created_at),
  };
}

function toResolved(row: Record<string, unknown>): TcpEndpointResolved | null {
  const namespace = row.org_namespace as string | null;
  if (!namespace) return null; // no owning-org namespace (pre-orgs row) → not routable
  return { ...toEndpoint(row), type: (row.type as WorkloadType) ?? "app", namespace };
}

export class TcpEndpointStore {
  constructor(private db: Db) {}

  /** The expose row for a workload, or null when it isn't exposed. */
  async get(siteName: string): Promise<TcpEndpoint | null> {
    const row = await this.db.selectFrom("tcp_endpoints").selectAll().where("site_name", "=", siteName).executeTakeFirst();
    return row ? toEndpoint(row as Record<string, unknown>) : null;
  }

  /** Expose (or re-expose) a workload in SNI mode — routed by its TLS SNI hostname on a shared port,
   *  so NO dynamic port is consumed. Upserts on site_name; switching from port→sni frees the port. */
  async exposeSni(siteName: string, protocol: string, createdBy: string): Promise<TcpEndpoint> {
    const row = await this.db
      .insertInto("tcp_endpoints")
      .values({ site_name: siteName, port: null, mode: "sni", protocol, created_by: createdBy, created_at: sql`now()` })
      .onConflict((oc) => oc.column("site_name").doUpdateSet({ port: null, mode: "sni", protocol, created_by: createdBy, created_at: sql`now()` }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEndpoint(row as Record<string, unknown>);
  }

  /** Expose (or re-expose) a workload on a dedicated port — the LOWEST free port in [from,to]. Runs in
   *  one transaction (drop any prior row for the site, scan used ports, insert) so two concurrent
   *  allocations can't hand out the same port (the partial unique index is the final backstop; a race
   *  that slips past the in-tx scan surfaces as a unique violation the caller can retry). Throws
   *  PortPoolExhaustedError when the pool is full. */
  async exposePort(siteName: string, protocol: string, createdBy: string, from: number, to: number): Promise<TcpEndpoint> {
    return await this.db.transaction().execute(async (tx) => {
      // Drop any existing expose row for this site first (re-expose / sni→port switch) so its old port
      // (if any) is freed and reusable within this same allocation scan.
      await tx.deleteFrom("tcp_endpoints").where("site_name", "=", siteName).execute();
      const usedRows = await tx
        .selectFrom("tcp_endpoints")
        .select("port")
        .where("mode", "=", "port")
        .where("port", ">=", from)
        .where("port", "<=", to)
        .execute();
      const used = new Set(usedRows.map((r) => r.port as number));
      let chosen: number | null = null;
      for (let p = from; p <= to; p++) {
        if (!used.has(p)) {
          chosen = p;
          break;
        }
      }
      if (chosen === null) throw new PortPoolExhaustedError(from, to);
      const row = await tx
        .insertInto("tcp_endpoints")
        .values({ site_name: siteName, port: chosen, mode: "port", protocol, created_by: createdBy, created_at: sql`now()` })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toEndpoint(row as Record<string, unknown>);
    });
  }

  /** Remove a workload's exposure (idempotent). */
  async unexpose(siteName: string): Promise<void> {
    await this.db.deleteFrom("tcp_endpoints").where("site_name", "=", siteName).execute();
  }

  /** Every currently-allocated dynamic port, cluster-wide + ascending — the edge-tcp Service publishes
   *  a listener per one (so the NLB burns a listener only per live port). */
  async allActivePorts(): Promise<number[]> {
    const rows = await this.db.selectFrom("tcp_endpoints").select("port").where("mode", "=", "port").orderBy("port").execute();
    return rows.map((r) => r.port as number).filter((p) => p != null);
  }

  private resolveBase() {
    // The router's read: expose row + workload type + owning-org namespace, in one query.
    return this.db
      .selectFrom("tcp_endpoints")
      .innerJoin("sites", "sites.name", "tcp_endpoints.site_name")
      .leftJoin("organisations", "organisations.id", "sites.org_id")
      .select([
        "tcp_endpoints.site_name as site_name",
        "tcp_endpoints.port as port",
        "tcp_endpoints.mode as mode",
        "tcp_endpoints.protocol as protocol",
        "tcp_endpoints.created_by as created_by",
        "tcp_endpoints.created_at as created_at",
        "sites.type as type",
        "organisations.namespace as org_namespace",
      ]);
  }

  /** Resolve a workload's SNI-mode target (expose row must exist AND be mode='sni'), or null. */
  async resolveSni(siteName: string): Promise<TcpEndpointResolved | null> {
    const row = await this.resolveBase().where("tcp_endpoints.site_name", "=", siteName).where("tcp_endpoints.mode", "=", "sni").executeTakeFirst();
    return row ? toResolved(row as Record<string, unknown>) : null;
  }

  /** Resolve a dynamic port's target (mode='port' row with this port), or null when unallocated. */
  async resolvePort(port: number): Promise<TcpEndpointResolved | null> {
    const row = await this.resolveBase().where("tcp_endpoints.port", "=", port).where("tcp_endpoints.mode", "=", "port").executeTakeFirst();
    return row ? toResolved(row as Record<string, unknown>) : null;
  }

  /** Expose rows (+ workload type) for a set of site names — the `drop expose ls` list view. Empty
   *  input → empty result (never a bare `IN ()`). */
  async listBySiteNames(names: string[]): Promise<TcpEndpointWithType[]> {
    if (names.length === 0) return [];
    const rows = await this.db
      .selectFrom("tcp_endpoints")
      .innerJoin("sites", "sites.name", "tcp_endpoints.site_name")
      .select([
        "tcp_endpoints.site_name as site_name",
        "tcp_endpoints.port as port",
        "tcp_endpoints.mode as mode",
        "tcp_endpoints.protocol as protocol",
        "tcp_endpoints.created_by as created_by",
        "tcp_endpoints.created_at as created_at",
        "sites.type as type",
      ])
      .where("tcp_endpoints.site_name", "in", names)
      .orderBy("tcp_endpoints.site_name")
      .execute();
    return rows.map((r) => ({ ...toEndpoint(r as Record<string, unknown>), type: (r.type as WorkloadType) ?? "app" }));
  }

  /** Every exposed workload in one tenant namespace (join sites+orgs) — feeds the per-namespace
   *  tenant "allow from edge-tcp" NetworkPolicies the API re-applies on expose/unexpose/deploy. */
  async listForNamespace(namespace: string): Promise<TcpEndpointResolved[]> {
    const rows = await this.resolveBase().where("organisations.namespace", "=", namespace).orderBy("tcp_endpoints.site_name").execute();
    return rows.map((r) => toResolved(r as Record<string, unknown>)).filter((r): r is TcpEndpointResolved => r !== null);
  }
}
