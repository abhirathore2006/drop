import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { makeDb } from "../src/db/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { UserStore } from "../src/users/store.ts";
import { OrgStore } from "../src/orgs/store.ts";
import { AuditStore } from "../src/audit/store.ts";
import { DevHeaderVerifier, ChainVerifier } from "../src/auth/oidc.ts";
import { SessionVerifier } from "../src/auth/session-token.ts";
import { createApp } from "../src/api/server.ts";
import { KubeApiClient } from "../src/kube/client.ts";
import { makeSecretStore } from "../src/secrets/factory.ts";
import { makeImageStore } from "../src/images/factory.ts";
import type { Verifier } from "../src/auth/types.ts";
import type { KubeClient } from "../src/kube/types.ts";

const cfg = loadConfig();

const blob = new S3Blob({
  bucket: cfg.s3Bucket,
  endpoint: cfg.s3Endpoint,
  region: cfg.s3Region,
  keyId: cfg.s3KeyId,
  secret: cfg.s3Secret,
});
await blob.ensureBucket();

const { db } = makeDb(cfg.databaseUrl);
await runMigrations(db); // advisory-locked; multi-replica safe
const users = new UserStore(db);
await users.seedAdmins(cfg.admins); // DROP_ADMINS bootstrap
const meta = new MetaStore(db);

let verifier: Verifier;
if (cfg.devAuth) {
  console.warn("WARNING: DROP_DEV_AUTH=1 — trusting sub:email tokens. Dev only.");
  // Also accept real Google-login session cookies when Google is configured, so the
  // browser dashboard works in dev mode too (dev sub:email tokens still work).
  const chain: Verifier[] = [];
  if (cfg.sessionSecret) chain.push(new SessionVerifier(cfg.sessionSecret));
  chain.push(new DevHeaderVerifier());
  verifier = chain.length === 1 ? chain[0]! : new ChainVerifier(chain);
  if (cfg.googleClientId && cfg.googleClientSecret && cfg.sessionSecret) {
    console.log(`Google login also enabled in dev mode — OAuth callback: ${cfg.publicUrl}/auth/callback`);
  }
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

// Compute plane is opt-in: set DROP_KUBECONFIG to enable container-app deploys
// (POST /v1/apps). Without it, the API is static-only and /v1/apps returns 501.
let kubeApi: KubeApiClient | undefined;
let kube: KubeClient | undefined;
if (process.env.DROP_KUBECONFIG) {
  kubeApi = new KubeApiClient(process.env.DROP_KUBECONFIG);
  kube = kubeApi;
  console.log(`drop-api compute plane enabled (kubeconfig: ${process.env.DROP_KUBECONFIG})`);
  // The tenant egress allowlist blocks cross-tenant + platform-DB traffic by excluding
  // the in-cluster pod/service CIDRs from outbound 443. The default (10.0.0.0/8) only
  // covers LOCAL k3s — on EKS the pod/service CIDRs are often outside 10/8, which would
  // SILENTLY leave cross-tenant 443 egress open. Fail loud-ish: insist it's set in prod.
  if (!process.env.DROP_BLOCKED_EGRESS_CIDRS) {
    console.warn(
      "WARNING: DROP_BLOCKED_EGRESS_CIDRS unset — tenant egress isolation assumes the cluster pod/service CIDRs are inside 10.0.0.0/8 (local k3s only). Set it to the real pod+service CIDRs on EKS/any non-10.x cluster.",
    );
  }
}

const secrets = makeSecretStore(cfg, kubeApi);
const images = makeImageStore(cfg, kube);
if (kube) console.log(`drop-api secrets backend: ${cfg.secretBackend} · image backend: ${cfg.imageBackend}`);
const orgs = new OrgStore(db);
const audit = new AuditStore(db);
const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit });
serve({ fetch: app.fetch, port: cfg.httpPort }, () => {
  console.log(`drop-api listening on :${cfg.httpPort}`);
});
