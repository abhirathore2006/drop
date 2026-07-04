import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { makeDb } from "../src/db/db.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { PreviewStore } from "../src/previews/store.ts";
import { createEdge } from "../src/edge/server.ts";
import { createWsUpgradeHandler } from "../src/edge/ws-proxy.ts";

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

const app = createEdge({
  meta,
  blob,
  baseDomain: cfg.baseDomain,
  diskCacheDir: cfg.edgeDiskCacheDir,
  diskCacheBytes: cfg.edgeDiskCacheBytes,
  interceptorUrl: cfg.interceptorUrl,
  previews,
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
  }),
);
