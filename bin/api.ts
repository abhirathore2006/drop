import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { DevHeaderVerifier } from "../src/auth/oidc.ts";
import { SessionVerifier } from "../src/auth/session-token.ts";
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
  // Server-mediated login: the API owns the Google OAuth client and issues its own
  // session tokens, which it verifies here. Clients only need DROP_API.
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    throw new Error("DROP_GOOGLE_CLIENT_ID and DROP_GOOGLE_CLIENT_SECRET are required (or set DROP_DEV_AUTH=1)");
  }
  if (!cfg.sessionSecret) throw new Error("DROP_SESSION_SECRET is required (signs Drop session tokens)");
  if (cfg.allowedDomains.length === 0) {
    console.warn("WARNING: DROP_ALLOWED_DOMAINS is empty — ANY Google account can authenticate.");
  }
  console.log(`OAuth callback: ${cfg.publicUrl}/auth/callback (register this in the Google client)`);
  verifier = new SessionVerifier(cfg.sessionSecret);
}

const app = createApp({ cfg, meta, blob, verifier });
serve({ fetch: app.fetch, port: cfg.httpPort }, () => {
  console.log(`drop-api listening on :${cfg.httpPort}`);
});
