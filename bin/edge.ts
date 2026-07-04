import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { makeDb } from "../src/db/db.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { PreviewStore } from "../src/previews/store.ts";
import { createEdge } from "../src/edge/server.ts";
import { createWsUpgradeHandler } from "../src/edge/ws-proxy.ts";
import { Collector } from "../src/metrics/collector.ts";
import { MetricsStore } from "../src/metrics/store.ts";

const cfg = loadConfig();

const blob = new S3Blob({
  bucket: cfg.s3Bucket,
  endpoint: cfg.s3Endpoint,
  region: cfg.s3Region,
  keyId: cfg.s3KeyId,
  secret: cfg.s3Secret,
});
const { db } = makeDb(cfg.databaseUrl); // read-only; the API owns migrations
const meta = new MetaStore(db);
const previews = new PreviewStore(db); // (E1) preview registry — read-only here (the API is the sole writer)

// (G2) Per-host request metering. The edge accumulates in-process and flushes to `traffic_minutes`
// every ~15s (env DROP_METRICS_FLUSH_INTERVAL_MS). Writing this rollup is the one metastore WRITE the
// edge performs (it stays a migration READER — the API still owns migrations). Multiple edge replicas
// UPSERT the same (host, minute) additively (see MetricsStore.flushTraffic).
const metrics = new Collector();
const metricsStore = new MetricsStore(db);

const app = createEdge({
  meta,
  blob,
  baseDomain: cfg.baseDomain,
  diskCacheDir: cfg.edgeDiskCacheDir,
  diskCacheBytes: cfg.edgeDiskCacheBytes,
  interceptorUrl: cfg.interceptorUrl,
  previews,
  metrics,
  authRateLimit: { limit: cfg.authRateLimit, windowMs: cfg.authRateWindowMs }, // (K1) auth-host abuse brake
});
const server = serve({ fetch: app.fetch, port: cfg.httpPort }, () => {
  console.log(`drop-edge listening on :${cfg.httpPort} for *.${cfg.baseDomain}`);
});

// WebSocket upgrades bypass Hono: a Node-level 'upgrade' listener runs the same visibility
// gate pre-upgrade, then splices the socket to the app upstream (A1). Attaching a listener
// is also what makes the HTTP server surface upgrades instead of dropping them.
server.on(
  "upgrade",
  createWsUpgradeHandler({
    meta,
    baseDomain: cfg.baseDomain,
    interceptorUrl: cfg.interceptorUrl,
    direct: cfg.wsDirect,
    maxPerHost: cfg.wsMaxPerHost,
    idleTimeoutMs: cfg.wsIdleTimeoutMs,
    // (G2) Fold each closed WS stream into the same per-host row as HTTP (requests += 1, bytes add).
    onClose: (s) => metrics.recordStream(s.host, { bytesIn: s.bytesIn, bytesOut: s.bytesOut }),
  }),
);

// (G2) Flush loop: snapshot the collector every ~15s and UPSERT into `traffic_minutes`, stamped at the
// current minute (so ~4 flushes/min merge into one row). Best-effort — a transient DB error logs and
// the next tick retries; `unref()` so it never keeps the process alive on its own.
setInterval(() => {
  if (metrics.size() === 0) return; // nothing served this window — skip the round-trip
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  metricsStore.flushTraffic(minute, metrics.flush()).catch((e) => console.error("traffic flush failed:", (e as Error).message));
}, cfg.metricsFlushIntervalMs).unref();
