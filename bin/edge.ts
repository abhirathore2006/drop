import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { makeDb } from "../src/db/db.ts";
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
const { db } = makeDb(cfg.databaseUrl); // read-only; the API owns migrations
const meta = new MetaStore(db);

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
