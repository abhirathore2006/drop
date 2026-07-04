// Synthetic uptime poller (G2b). Runs inside the API on its own interval (housekeeping-style). For
// each qualifying workload it performs ONE probe and records the outcome into `uptime_checks`:
//  - sites + apps → a GET through the EDGE (Host: <name>.<base>, so the edge routes it) — apps are
//    probed only when they can't scale to zero unattended (scale.min ≥ 1 OR healthcheck.keep_warm);
//    a scale-to-zero app WITHOUT keep_warm is skipped so the probe never wakes it.
//  - databases → a TCP connect to the CNPG rw Service, ONLY when compute is in-cluster reachable
//    (cfg.tunnelDirect); otherwise skipped (the local API can't reach the Service DNS).
// Everything with a network side effect (the HTTP + TCP probe) and the clock is injectable, so the
// qualification rules + gating are exhaustively table-testable with fakes.
import { request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { connect as netConnect } from "node:net";
import type { WorkloadType } from "../metastore/types.ts";

/** A workload the poller may probe. `scaleMin`/`keepWarm` come from the app's current-version config;
 *  `namespace` is only used for the database TCP path (null when the org namespace is unresolved). */
export interface UptimeTarget {
  name: string;
  type: WorkloadType;
  namespace: string | null;
  runtimeState: "running" | "stopped";
  scaleMin: number; // app scale.min (0 = scale-to-zero); 0 for non-apps
  keepWarm: boolean; // app healthcheck.keep_warm opt-in
}

/** The metastore read the poller needs (MetaStore satisfies this). */
export interface UptimeMetaSource {
  listUptimeTargets(): Promise<UptimeTarget[]>;
}

/** The rollup write the poller needs (MetricsStore satisfies this). */
export interface UptimeSink {
  recordUptime(name: string, minute: Date, r: { ok: boolean; latencyMs: number; status: number }): Promise<void>;
}

export interface HttpOutcome {
  ok: boolean;
  status: number;
  latencyMs: number;
}
export interface TcpOutcome {
  ok: boolean;
  latencyMs: number;
}

/** GET the edge with an overridden Host header (the edge routes on it). OK = a non-5xx response within
 *  the timeout (the edge + routing are healthy and the workload answered); 5xx / timeout / connect
 *  failure = DOWN. A 4xx (a password gate's 401, a not-found) counts as reachable — deliberately, so a
 *  gated-but-healthy site isn't a false negative (documented in docs/observability.html). */
export type HttpProbe = (t: { origin: string; host: string }) => Promise<HttpOutcome>;
/** Open a TCP connection; OK iff it connects within the timeout. Used for databases (no HTTP layer). */
export type TcpProbe = (host: string, port: number) => Promise<TcpOutcome>;

function nodeHttpProbe(timeoutMs: number): HttpProbe {
  return (t) =>
    new Promise<HttpOutcome>((resolve) => {
      let u: URL;
      try {
        u = new URL(t.origin);
      } catch {
        return resolve({ ok: false, status: 0, latencyMs: 0 });
      }
      const mod = u.protocol === "https:" ? httpsReq : httpReq;
      const start = Date.now();
      const done = (ok: boolean, status: number) => resolve({ ok, status, latencyMs: Date.now() - start });
      const req = mod(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          method: "GET",
          path: "/",
          timeout: timeoutMs,
          headers: { host: t.host }, // the edge routes on this (fetch forbids overriding Host — hence node:http)
          ...(u.protocol === "https:" ? { rejectUnauthorized: false } : {}), // in-cluster edge cert is not the poller's trust concern
        },
        (res) => {
          res.resume(); // drain + discard the body
          const status = res.statusCode ?? 0;
          res.on("end", () => done(status >= 200 && status < 500, status));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(false, 0);
      });
      req.on("error", () => done(false, 0));
      req.end();
    });
}

function nodeTcpProbe(timeoutMs: number): TcpProbe {
  return (host, port) =>
    new Promise<TcpOutcome>((resolve) => {
      const start = Date.now();
      const s = netConnect({ host, port });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
        resolve({ ok, latencyMs: Date.now() - start });
      };
      s.setTimeout(timeoutMs);
      s.once("connect", () => done(true));
      s.once("timeout", () => done(false));
      s.once("error", () => done(false));
    });
}

export interface UptimePollerOptions {
  meta: UptimeMetaSource;
  metrics: UptimeSink;
  baseDomain: string;
  /** The edge origin the poller GETs (e.g. http://drop-edge.drop-system.svc). Unset → HTTP probes are
   *  skipped entirely (sites + apps) with a startup note; only databases (TCP) are probed. */
  edgeInternalUrl?: string;
  /** Whether database TCP probes are reachable (cfg.tunnelDirect: the in-cluster API posture). */
  probeDatabases: boolean;
  now?: () => Date;
  timeoutMs?: number; // per-probe timeout (default 5s)
  httpProbe?: HttpProbe;
  tcpProbe?: TcpProbe;
}

export interface ProbeResult {
  name: string;
  type: WorkloadType;
  ok: boolean;
  latencyMs: number;
  status: number;
}

const floorMinute = (d: Date): Date => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export class UptimePoller {
  private now: () => Date;
  private timeoutMs: number;
  private httpProbe: HttpProbe;
  private tcpProbe: TcpProbe;

  constructor(private o: UptimePollerOptions) {
    this.now = o.now ?? (() => new Date());
    this.timeoutMs = o.timeoutMs ?? 5_000;
    this.httpProbe = o.httpProbe ?? nodeHttpProbe(this.timeoutMs);
    this.tcpProbe = o.tcpProbe ?? nodeTcpProbe(this.timeoutMs);
  }

  /** Whether (and how) a target is probed. Pure — the gating rules live here so they're table-testable. */
  probeKind(t: UptimeTarget): "http" | "tcp" | null {
    if (t.type === "site") return "http"; // a published static site is always-on
    if (t.type === "app") {
      if (t.runtimeState === "stopped") return null; // intentionally offline — don't record it as down
      if (t.scaleMin >= 1 || t.keepWarm) return "http";
      return null; // scale-to-zero without keep_warm: a probe would wake the pod — skip
    }
    if (t.type === "database") return this.o.probeDatabases && t.namespace ? "tcp" : null;
    return null; // buckets/caches aren't uptime-probed in v1
  }

  /** Probe every qualifying workload once + record the outcomes. Returns the per-target results (for
   *  logging/tests). Never throws on an individual probe — a failed probe IS the down signal. */
  async sweep(): Promise<ProbeResult[]> {
    const minute = floorMinute(this.now());
    const targets = await this.o.meta.listUptimeTargets();
    const results: ProbeResult[] = [];
    for (const t of targets) {
      const kind = this.probeKind(t);
      if (!kind) continue;
      let outcome: { ok: boolean; latencyMs: number; status: number };
      if (kind === "tcp") {
        const r = await this.tcpProbe(`${t.name}-rw.${t.namespace}.svc`, 5432);
        outcome = { ok: r.ok, latencyMs: r.latencyMs, status: 0 };
      } else {
        if (!this.o.edgeInternalUrl) continue; // HTTP probes disabled (no edge origin configured)
        const r = await this.httpProbe({ origin: this.o.edgeInternalUrl, host: `${t.name}.${this.o.baseDomain}` });
        outcome = { ok: r.ok, latencyMs: r.latencyMs, status: r.status };
      }
      await this.o.metrics.recordUptime(t.name, minute, outcome);
      results.push({ name: t.name, type: t.type, ...outcome });
    }
    return results;
  }
}
