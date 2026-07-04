import { loadTcpConfig } from "../src/config.ts";
import { StaticRouteSource, type TcpRouteSource, type TcpTarget } from "../src/edge-tcp/route-source.ts";
import { MetastoreRouteSource } from "../src/edge-tcp/meta-source.ts";
import { makeDb } from "../src/db/db.ts";
import { createEdgeTcpServer } from "../src/edge-tcp/server.ts";
import { Collector } from "../src/metrics/collector.ts";
import { MetricsStore } from "../src/metrics/store.ts";

const cfg = loadTcpConfig();

// A2b: when a database is configured, route from the metastore (`tcp_endpoints`, read-only — the API
// owns migrations + writes), so `drop expose` / `drop unexpose` take effect with no router restart.
// Without a DB the env-only StaticRouteSource remains the fallback (tests + static local dev). Read
// the DB URL + base domain straight from env so this entry stays decoupled from loadConfig's S3/DB
// requirements (same posture as the rest of loadTcpConfig).
// (G2) TCP byte metering shares the traffic_minutes rollup with the HTTP edge, keyed by workload. It
// needs the metastore, so it's only wired on the DB-backed (A2b) path; the static-route fallback has
// no store to write to (comment) and skips metrics entirely.
let metrics: Collector | null = null;
let metricsStore: MetricsStore | null = null;

let source: TcpRouteSource;
const databaseUrl = process.env.DROP_DATABASE_URL;
if (databaseUrl) {
  const { db } = makeDb(databaseUrl);
  const baseDomain = process.env.DROP_BASE_DOMAIN ?? "drop.example.com";
  source = new MetastoreRouteSource(db, { baseDomain });
  metrics = new Collector();
  metricsStore = new MetricsStore(db);
  console.log(`drop-edge-tcp routing from metastore (base domain *.${baseDomain})`);
} else {
  // A2a static route table: {"sni": {"app.drop.example.com": {"host":"app.ns.svc","port":443,"workload":"app"}},
  //                          "port": {"7000": {"host":"redis.ns.svc","port":6379,"workload":"redis"}}}
  const staticSource = new StaticRouteSource();
  if (cfg.staticRoutesJson) {
    try {
      const parsed = JSON.parse(cfg.staticRoutesJson) as {
        sni?: Record<string, TcpTarget>;
        port?: Record<string, TcpTarget>;
      };
      for (const [name, t] of Object.entries(parsed.sni ?? {})) staticSource.setSni(name, t);
      for (const [p, t] of Object.entries(parsed.port ?? {})) staticSource.setPort(Number(p), t);
    } catch (e) {
      console.error(`DROP_TCP_STATIC_ROUTES is not valid JSON: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  source = staticSource;
  console.log("drop-edge-tcp routing from the static env route table (DROP_TCP_STATIC_ROUTES)");
}

const server = createEdgeTcpServer({
  source,
  sharedPorts: cfg.sharedPorts,
  dynamicPorts: cfg.dynamicPorts,
  idleTimeoutMs: cfg.idleTimeoutMs,
  maxConnsPerWorkload: cfg.maxConnsPerWorkload,
  handshakeTimeoutMs: cfg.handshakeTimeoutMs,
  // (G2) One log line per closed connection with the final byte counts, AND fold it into the shared
  // traffic rollup keyed by workload (requests += 1, bytes add; durationMs is not histogrammed — see
  // Collector.recordStream). Metering is a no-op when the static-route fallback left `metrics` null.
  onClose: (s) => {
    console.log(`drop-edge-tcp close workload=${s.workload} in=${s.bytesIn} out=${s.bytesOut} durMs=${s.durationMs} reason=${s.reason}`);
    metrics?.recordStream(s.workload, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, durationMs: s.durationMs });
  },
});

// (G2) Flush loop — mirrors the HTTP edge's. Only runs on the DB-backed path (metricsStore set).
if (metrics && metricsStore) {
  const flushMs = Number(process.env.DROP_METRICS_FLUSH_INTERVAL_MS ?? "15000") || 15000;
  const m = metrics;
  const store = metricsStore;
  setInterval(() => {
    if (m.size() === 0) return;
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    store.flushTraffic(minute, m.flush()).catch((e) => console.error("tcp traffic flush failed:", (e as Error).message));
  }, flushMs).unref();
}

const infos = await server.listen();
for (const i of infos) console.log(`drop-edge-tcp listening on :${i.port} (${i.kind})`);
const dyn = cfg.dynamicPorts.length;
console.log(`drop-edge-tcp ready — ${cfg.sharedPorts.length} shared port(s), ${dyn} dynamic port(s)`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
