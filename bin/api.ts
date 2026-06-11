import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { DevHeaderVerifier, GoogleVerifier } from "../src/auth/oidc.ts";
import { createApp } from "../src/api/server.ts";
import type { Verifier } from "../src/auth/types.ts";

const cfg = loadConfig();

const blob = new S3Blob({
  bucket: cfg.s3Bucket,
  endpoint: cfg.s3Endpoint,
  region: cfg.s3Region,
  keyId: cfg.s3KeyId,
  secret: cfg.s3Secret,
});
await blob.ensureBucket();
const meta = new MetaStore(blob);

let verifier: Verifier;
if (cfg.devAuth) {
  console.warn("WARNING: DROP_DEV_AUTH=1 — trusting sub:email tokens. Dev only.");
  verifier = new DevHeaderVerifier();
} else {
  if (!cfg.googleClientId) throw new Error("DROP_GOOGLE_CLIENT_ID is required (or set DROP_DEV_AUTH=1)");
  if (cfg.allowedDomains.length === 0) {
    console.warn("WARNING: DROP_ALLOWED_DOMAINS is empty — ANY Google account can authenticate.");
  }
  verifier = new GoogleVerifier({ audience: cfg.googleClientId, allowedDomains: cfg.allowedDomains });
}

const app = createApp({ cfg, meta, blob, verifier });
console.log(`drop-api listening on :${cfg.httpPort}`);

export default { port: cfg.httpPort, fetch: app.fetch };
