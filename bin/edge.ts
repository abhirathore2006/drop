import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { createEdge } from "../src/edge/server.ts";

const cfg = loadConfig();

const blob = new S3Blob({
  bucket: cfg.s3Bucket,
  endpoint: cfg.s3Endpoint,
  region: cfg.s3Region,
  keyId: cfg.s3KeyId,
  secret: cfg.s3Secret,
});
const meta = new MetaStore(blob);

const app = createEdge({
  meta,
  blob,
  baseDomain: cfg.baseDomain,
  diskCacheDir: cfg.edgeDiskCacheDir,
  diskCacheBytes: cfg.edgeDiskCacheBytes,
});
serve({ fetch: app.fetch, port: cfg.httpPort }, () => {
  console.log(`drop-edge listening on :${cfg.httpPort} for *.${cfg.baseDomain}`);
});
