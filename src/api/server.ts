import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Readable, Transform } from "node:stream";
import { randomBytes } from "node:crypto";
import * as streamConsumers from "node:stream/consumers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPassword, parseDropYaml, CONFIG_FILE_YAML, type SiteConfig } from "../site-config.ts";
import { installScript } from "./install.ts";
import { VERSION } from "../version.ts";
import type { Config } from "../config.ts";
import type { BlobStore } from "../blob/types.ts";
import type { Db } from "../db/db.ts";
import type { Identity, Verifier } from "../auth/types.ts";
import { authMiddleware, type AuthEnv } from "../auth/middleware.ts";
import { MetaStore } from "../metastore/store.ts";
import type { Site, Visibility } from "../metastore/types.ts";
import { UserStore } from "../users/store.ts";
import { can, canCreateInOrg, canManageOrg, capabilitiesFor, type Action, type Actor } from "../authz/permissions.ts";
import { ServiceTokenStore, validateScopes } from "../tokens/store.ts";
import { TunnelTicketStore } from "../tokens/tunnel-tickets.ts";
import { OrgStore, validateOrgSlug, type Org } from "../orgs/store.ts";
import { validateName } from "../names.ts";
import { extractTarGz } from "../archive.ts";
import { newVersionId } from "../version-id.ts";
import { sanitizeAppConfig, assertHttpOnly, assertProcesses, expandProcesses, type AppConfig, type AppUse } from "../app-config.ts";
import { sanitizeDatabaseConfig, generateDbPassword, validateDbPassword, validateDbStorage, validateDbExtensions, storageToBytes } from "../db-config.ts";
import { sanitizeCacheConfig, validateCacheMemory, cacheMemoryToBytes, type CacheConfig } from "../cache-config.ts";
import type { BucketStore } from "../buckets/types.ts";
import { makeBucketStore } from "../buckets/factory.ts";
import { QuotaStore, validateQuota, QUOTA_KEYS } from "../quotas/store.ts";
import { sanitizeStackConfig, validateStackEdges, resolveResourceName, type StackSpec, type StackResource, type StackResourceKind } from "../stack-config.ts";
import { planStack, StackCycleError, type LivePresence, type PlanStep } from "../stacks/plan.ts";
import { diffStack, mergeUpgrade, type Resolution } from "../stacks/diff.ts";
import { StackStore, type StackRow } from "../stacks/store.ts";
import { TemplateStore, validateTemplateSlug } from "../templates/store.ts";
import type { TemplateVisibility } from "../db/schema.ts";
import { substituteTemplate, sanitizeVariables } from "../templates/vars.ts";
import { stripStackSpec } from "../templates/strip.ts";
import { appManifests, releaseJobManifest, tenantManifests, appUseEnvName, appUseUrl, type ExposedWorkload } from "../kube/manifests.ts";
import { TcpEndpointStore, PortPoolExhaustedError, type TcpEndpoint } from "../edge-tcp/store.ts";
import { PreviewStore, validatePreviewLabel } from "../previews/store.ts";
import { databaseManifests, poolerManifest, poolerName, type PoolerMode } from "../kube/cnpg.ts";
import { cacheManifests, cacheHost } from "../kube/valkey.ts";
import { sanitizeAuthConfig, type AuthConfig } from "../auth-config.ts";
import { authManifests, authExternalUrl, type AuthManifestContext } from "../auth-resource/manifests.ts";
import { GoTrueEngine } from "../auth-resource/gotrue.ts";
import type { AuthEngine, AdminOp } from "../auth-resource/engine.ts";
import { generateJwtSecret, mintAdminToken } from "../auth-resource/jwt.ts";
import { PasswordSyncError, type KubeClient, type AppStatus, type DatabaseStatus } from "../kube/types.ts";
import { LockStore, LockHeldError } from "../metastore/lock.ts";
import type { SecretStore } from "../secrets/types.ts";
import type { ImageStore } from "../images/types.ts";
import { fingerprint, validateSecretKey } from "../secrets/secrets.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { makeSqlQueryExecutor, type SqlQueryExecutor } from "./sql-query.ts";
import { consoleShell, consoleAsset } from "./dashboard.ts";
import { normalizeStatus } from "./status.ts";
import { MetricsStore } from "../metrics/store.ts";
import { aggregateSeries, parseRange, rangeWindowMs, summarizeUptime, formatPrometheus } from "../metrics/aggregate.ts";
import type { AuditStore, AuditEntry } from "../audit/store.ts";
import { EventStore, type EmitInput } from "../events/store.ts";
import { AppConfigStore, ConfigValidationError } from "../appconfig/store.ts";

export interface Deps {
  cfg: Config;
  meta: MetaStore;
  blob: BlobStore;
  db: Db;
  users: UserStore;
  verifier: Verifier;
  kube?: KubeClient; // optional: when absent, /v1/apps returns 501 (static-only instance)
  secrets: SecretStore; // app-secrets backend (kube locally, AWS Secrets Manager / etc. in prod)
  images: ImageStore; // image-push backend (containerd-import locally, registry/ECR in prod)
  orgs: OrgStore; // organisations (resource grouping + org-level permissions)
  audit: AuditStore; // append-only trail of mutating/admin actions
  bucket?: BucketStore; // (I1) tenant object storage; defaults to makeBucketStore(cfg)
  quotas?: QuotaStore; // (item 10) per-org quota overrides; defaults over `db`
  locks?: LockStore; // lease-based advisory locks (serialize deploy/release per app); defaults over `db`
  stacks?: StackStore; // stack metadata + resource mapping (B2); defaults over `db`
  templates?: TemplateStore; // (D1) template registry (templates + template_versions); defaults over `db`
  tcp?: TcpEndpointStore; // (A2b) TCP exposure registry (tcp_endpoints); defaults over `db`
  tokens?: ServiceTokenStore; // (J1) service accounts / scoped CI tokens; defaults over `db`
  previews?: PreviewStore; // (E1) preview registry (previews); defaults over `db`
  tickets?: TunnelTicketStore; // (A3) db:proxy single-use tunnel tickets; defaults over `db`. Share ONE instance with the tunnel upgrade handler (bin/api.ts) so issuance + redemption hit the same table.
  metrics?: MetricsStore; // (G2/G2b) edge traffic + uptime rollups; defaults over `db`
  events?: EventStore; // (G3) alerting/notifications event feed + org webhook delivery; defaults over `db`. Share ONE instance with the crash-loop/preview sweeps (bin/api.ts) so emit/resolve/webhook all hit the same delivery path.
  appConfigs?: AppConfigStore; // (L4) per-app NON-SECRET runtime config KV (app_configs); defaults over `db`
  authEngine?: AuthEngine; // (K1) the managed-auth engine port; defaults to GoTrue pinned via cfg.authEngineImage
  // (K1) The transport the user-admin proxy uses to reach the in-cluster auth engine's admin API. Tests
  // inject a fake (routes through the FakeEngine's records); prod defaults to an in-cluster fetch. Absent
  // + no default reachability → the proxy 501s (compute off / local API can't reach the pod network).
  authAdmin?: (req: { baseUrl: string; method: string; path: string; token: string; body?: unknown }) => Promise<{ status: number; json: unknown }>;
  // (I4) The SQL-console executor port. Tests inject a scripted fake (no real Postgres — the repo uses
  // PGlite); the default is the real pg connector, which reads the `<db>-app` creds and dials
  // `<db>-rw.<ns>.svc` — reachable ONLY in-cluster (the query route 501s out-of-cluster before it runs).
  queryExecutor?: SqlQueryExecutor;
  now?: () => Date;
}

// Serialize a deploy's release-Job + rollout per app so two deploys can't interleave migrations. TTL
// bounds a crashed holder; it must exceed the longest release timeout (15m cap) plus rollout slack.
const DEPLOY_LOCK_TTL_MS = 20 * 60 * 1000;
// Serialize a stack `up` per stack (same lease mechanism). The reconcile runs several deploys back to
// back; the TTL bounds a crashed holder generously (16 resources × rollout slack).
const STACK_LOCK_TTL_MS = 30 * 60 * 1000;

export function createApp(d: Deps): Hono<AuthEnv> {
  const now = d.now ?? (() => new Date());
  const locks = d.locks ?? new LockStore(d.db); // serialize deploy/release per app
  const stacks = d.stacks ?? new StackStore(d.db); // stack metadata + resource mapping
  const templates = d.templates ?? new TemplateStore(d.db); // (D1) template registry
  const buckets = d.bucket ?? makeBucketStore(d.cfg); // (I1) tenant object storage (floci-prefix locally)
  const quotas = d.quotas ?? new QuotaStore(d.db); // (item 10) per-org quota overrides
  const tcp = d.tcp ?? new TcpEndpointStore(d.db); // (A2b) TCP exposure registry
  const tokens = d.tokens ?? new ServiceTokenStore(d.db); // (J1) service accounts / scoped CI tokens
  const appConfigs = d.appConfigs ?? new AppConfigStore(d.db); // (L4) per-app runtime config KV
  const previews = d.previews ?? new PreviewStore(d.db); // (E1) preview registry
  const tickets = d.tickets ?? new TunnelTicketStore(d.db, now, d.cfg.tunnelTicketTtlMs); // (A3) db:proxy tunnel tickets
  const metrics = d.metrics ?? new MetricsStore(d.db); // (G2/G2b) edge traffic + uptime rollups
  const events = d.events ?? new EventStore(d.db); // (G3) alerting/notifications feed + org webhook delivery
  // (I4) SQL-console executor. Default: the real pg connector reading the `<db>-app` creds via the kube
  // client (the same secret-read mechanism as the app binding). It is only ever CALLED in-cluster — the
  // query route 501s when out-of-cluster (or when compute is off, via resolveDb) BEFORE invoking it — so
  // the `d.kube!` deref is safe. Tests inject `queryExecutor` (a scripted fake) instead.
  const runQuery: SqlQueryExecutor = d.queryExecutor ?? makeSqlQueryExecutor({ readAppCreds: (ns, name) => d.kube!.readDatabaseAppSecret(ns, name) });
  const authEngine = d.authEngine ?? new GoTrueEngine(d.cfg.authEngineImage); // (K1) managed-auth engine (pinned image)
  // (K1) In-cluster transport to an auth engine's admin API. Default: fetch the engine's ClusterIP
  // Service DNS (`<name>.<ns>.svc.cluster.local:<port>`). Reachable only from an in-cluster API; a
  // local API can't reach the pod network → the fetch rejects and the proxy returns a 502 (documented).
  const authAdmin =
    d.authAdmin ??
    (async (req: { baseUrl: string; method: string; path: string; token: string; body?: unknown }) => {
      const res = await fetch(req.baseUrl + req.path, {
        method: req.method,
        headers: { authorization: `Bearer ${req.token}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    });

  const siteUrl = (name: string) => `https://${name}.${d.cfg.baseDomain}`;
  // (E1) The preview hostname, `<name>--<label>.<baseDomain>` — reserved via src/names.ts (site
  // names) + src/previews/store.ts (labels), each forbidding "--" so the edge's split is unambiguous.
  const previewUrl = (name: string, label: string) => `https://${name}--${label}.${d.cfg.baseDomain}`;
  // Shared shape for a site's preview list — used by the dedicated GET route (`drop preview ls`)
  // AND embedded into the site detail response (console panel), so the two can never drift.
  const previewsFor = async (name: string) => {
    const rows = await previews.listForSite(name);
    // (E2) `hasDb` (a --with-db clone) is surfaced so `drop preview ls` + the console can badge it; `kind`
    // lets a client tell an app preview from a site one. Both default sensibly for E1 site rows.
    return rows.map((p) => ({ label: p.label, versionId: p.versionId, url: previewUrl(name, p.label), createdBy: p.createdBy, createdAt: p.createdAt, expiresAt: p.expiresAt, kind: p.kind, hasDb: p.hasDb }));
  };
  const app = new Hono<AuthEnv>();
  // In-flight DB password rotations, keyed by name. Serializes per database so two concurrent
  // rotations can't stomp the shared Job/Secret and diverge the role from the creds Secret.
  // Process-local: covers the double-submit / two-admin case on a single API instance (the common
  // one); a multi-replica deployment would want a distributed lock — noted in Future.md.
  const rotatingPasswords = new Set<string>();

  app.get("/healthz", (c) => c.text("ok"));

  // Public server-mediated login routes (/auth/*) — clients only need DROP_API.
  registerAuthRoutes(app, d.cfg, d.db, d.users, d.audit);

  // Dashboard (public page; its JS calls /v1/* with the session cookie).
  // The console SPA shell. Served at the root AND at its client-side routes so deep links and
  // browser refresh load the same shell (the React app reads location and renders the route).
  const shell = () => consoleShell(d.cfg);
  app.get("/", shell);
  app.get("/admin", shell);
  app.get("/app/:name", shell);
  app.get("/database/:name", shell);
  app.get("/site/:name", shell);
  app.get("/bucket/:name", shell); // I1: bucket detail page
  app.get("/stack/:name", shell); // C1: the read-only stack canvas
  // M1 information architecture — top-level sections the sidebar navigates to.
  app.get("/stacks", shell);
  app.get("/templates", shell);
  app.get("/template/:slug", shell); // D1: deep link for docs-site badges
  app.get("/activity", shell);
  app.get("/settings", shell);

  // Public docs site — the same static files GitHub Pages serves (docs/), now
  // shipped with the deployment and served at /docs. Uses relative links, so it
  // works equally at https://api.…/docs/ and on GitHub Pages.
  app.get("/docs", (c) => c.redirect("/docs/"));
  // Served-by-app signal: when THIS api serves the docs, announce its own origin
  // so docs/assets/site.js rewrites the placeholder API URL to the live instance.
  // Registered before the static handler so it shadows the shipped no-op of the
  // same name; on static hosts (GitHub Pages, etc.) the no-op runs and the docs
  // keep their documented placeholder. Must precede the /docs/* serveStatic.
  app.get("/docs/drop-served.js", (c) => {
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(/:$/, "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";
    return c.body(`window.__DROP_API_ORIGIN__ = ${JSON.stringify(`${proto}://${host}`)};\n`, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
  });
  app.use(
    "/docs/*",
    serveStatic({
      root: d.cfg.docsDir,
      rewriteRequestPath: (p) => p.replace(/^\/docs/, "") || "/",
    }),
  );

  // Self-contained CLI installer: `curl <API>/install.sh | sh` installs the CLI
  // (served from /cli below) and auto-configures it to point at this instance.
  app.get("/install.sh", (c) => {
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(/:$/, "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";
    return c.body(installScript(`${proto}://${host}`), 200, { "content-type": "text/x-shellscript; charset=utf-8" });
  });
  const serveCli = async (file: string): Promise<Response> => {
    try {
      const buf = await readFile(join(d.cfg.cliDir, file));
      return new Response(buf, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
  app.get("/cli/drop.mjs", () => serveCli("drop.js"));
  app.get("/cli/mcp.mjs", () => serveCli("mcp.js"));
  // Public: the version of the CLI this instance serves (built from the same commit as the API),
  // so `drop update` can show "current → target" before re-installing.
  app.get("/version", (c) => c.json({ version: VERSION }));
  // The admin console's static assets (built to <cliDir>/ui/ by build.mjs) — hashed
  // assets/* are immutable, everything else no-cache; traversal rejected in consoleAsset.
  app.get("/ui/*", (c) => consoleAsset(d.cfg, c.req.path.replace(/^\/ui\//, "")));

  app.use(
    "/v1/*",
    authMiddleware(d.verifier, { isSuspended: async (email) => (await d.users.getUser(email))?.status === "suspended" }),
  );

  // (G2) Prometheus scrape — admin-gated, with its OWN auth pass (it lives outside /v1/*, at the
  // conventional `/metrics` path a scraper expects). It exposes the LAST flushed minute per site from
  // `traffic_minutes` (one cheap indexed query) — NOT a live in-process counter, because the API is not
  // the meter, the edge is. All-gauges (each value is a per-minute snapshot, not monotonic).
  app.use("/metrics", authMiddleware(d.verifier, { isSuspended: async (email) => (await d.users.getUser(email))?.status === "suspended" }));
  app.get("/metrics", async (c) => {
    if (!(await isPlatformAdmin(c.get("identity").email))) return c.json({ error: "admin only" }, 403);
    const since = new Date(now().getTime() - 5 * 60_000); // drop sites that stopped serving minutes ago
    const rows = await metrics.latestTrafficPerSite(since);
    return c.body(formatPrometheus(rows), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  // First touch provisions the user AND their personal org (idempotent), so resources always have an
  // org to belong to and single-user flows keep working with no explicit org. A SERVICE-TOKEN principal
  // (J1) is NOT a person: never mint a user row / personal org for it (that would surface `token:…@org`
  // in admin user lists). The `token:` prefix is a safe discriminator — a real login email can't start
  // with it (a colon is invalid before the @; dev-auth's `sub:email` keeps the colon part in `sub`).
  const ensureUser = async (email: string) => {
    if (email.startsWith("token:")) return;
    await d.users.upsertOnLogin(email, null);
    await d.orgs.ensurePersonalOrg(email);
  };

  // Build the authorization Actor for the CALLING identity against a resource. Takes the whole Identity
  // (not just the email) so a SERVICE-TOKEN actor (J1) is resolved to a scope-based Actor bound to THIS
  // resource — grants come from its scopes, never from roles (all role fields stay null/member).
  async function actorFor(identity: Identity, site: Site | null): Promise<Actor> {
    const email = identity.email;
    if (identity.token) {
      // Token actor: fence it to its own org + this resource; can() checks scopeAllows(verb, name).
      return {
        email,
        platformRole: "member",
        siteRole: null,
        orgRole: null,
        token: { scopes: identity.token.scopes, orgId: identity.token.orgId, resourceName: site?.name ?? "", resourceOrgId: site?.orgId ?? null },
      };
    }
    const u = await d.users.getUser(email);
    const siteRole = site ? (site.members.find((m) => m.email === email)?.role ?? null) : null;
    const orgRole = await d.orgs.roleOf(site?.orgId ?? null, email); // org-wide role on the resource's org
    return { email, platformRole: u?.role ?? "member", siteRole, orgRole };
  }

  // Resolve the target org for a CREATE (explicit ?org=<slug> or the caller's personal org) +
  // authorize it. Uses ONLY the query param — never reads the body (publish streams a tarball).
  const resolveCreateOrg = async (c: any, email: string): Promise<{ org: Org } | { err: Response }> => {
    // Service tokens (J1) act ONLY on EXISTING resources within scope — they never claim new names.
    // Explicit, early deny (before any org resolution) so a token deploy of a not-yet-created name is a
    // clean 403 rather than falling through role checks with a misleading "not a member" message.
    if (c.get("identity").token) return { err: c.json({ error: "service tokens cannot create new resources; they act on existing ones only" }, 403) };
    const orgSlug = c.req.query("org");
    let org: Org;
    if (!orgSlug) {
      org = await d.orgs.ensurePersonalOrg(email);
    } else {
      const found = await d.orgs.getOrgBySlug(String(orgSlug));
      if (!found) return { err: c.json({ error: `no such org: ${orgSlug}` }, 404) };
      const role = await d.orgs.roleOf(found.id, email);
      const platformRole = (await d.users.getUser(email))?.role ?? "member";
      if (!canCreateInOrg(role, platformRole)) return { err: c.json({ error: `not a member of org ${orgSlug} with create rights` }, 403) };
      org = found;
    }
    // Per-org workload cap (item 10 override → DROP_MAX_WORKLOADS_PER_ORG default; 0 = unlimited). Only
    // the CREATE path passes through here — re-deploys of an existing workload don't claim a new name.
    const cap = await quotas.resolvedMaxWorkloads(org.id, d.cfg.maxWorkloadsPerOrg);
    if (cap > 0 && (await d.meta.countSitesInOrg(org.id)) >= cap) {
      await emitEvent({ orgId: org.id, kind: "quota", severity: "warning", title: `workload cap reached (${cap})`, detail: { cap, reason: "workloads" } }); // throttled via dedup (one open quota incident per org)
      return { err: c.json({ error: `workload cap reached for this org (${cap}) — delete one or ask an admin to raise the limit` }, 429) };
    }
    return { org };
  };

  // ---- storage quota (item 10) — approximate, documented org storage accounting ----
  // Sum of database PVC REQUESTS (not live disk use) + bucket object bytes. Eventually-consistent:
  // a bucket sweep totals object sizes; a database contributes its requested PVC size. Fine for a budget.
  const orgStorageUsage = async (orgId: string, ns: string) => {
    const dbReqs = await d.meta.orgDatabaseStorageRequests(orgId);
    let dbBytes = 0;
    for (const s of dbReqs) dbBytes += storageToBytes(s) ?? 0;
    const bucketNames = await d.meta.orgSiteNames(orgId, "bucket");
    let bucketBytes = 0;
    for (const bn of bucketNames) {
      const u = await buckets.usage({ name: bn, namespace: ns, org: orgId }).catch(() => ({ bytes: 0, objects: 0 }));
      bucketBytes += u.bytes;
    }
    // (I2) Persistent caches contribute their PVC request (their memory) to the budget; ephemeral
    // caches have no PVC → nothing. cacheCount is the count of persistent caches (the only ones costing storage).
    const cacheReqs = await d.meta.orgCacheStorageRequests(orgId);
    let cacheBytes = 0;
    for (const m of cacheReqs) cacheBytes += cacheMemoryToBytes(m) ?? 0;
    return { dbBytes, dbCount: dbReqs.length, bucketBytes, bucketCount: bucketNames.length, cacheBytes, cacheCount: cacheReqs.length };
  };
  // Returns an error string when adding `addBytes` would exceed the org's storage budget (when set), else null.
  const checkStorageBudget = async (orgId: string, ns: string, addBytes: number): Promise<string | null> => {
    const budget = await quotas.resolvedStorageBudgetBytes(orgId);
    if (budget == null) return null; // no budget configured → unlimited
    const cur = await orgStorageUsage(orgId, ns);
    const total = cur.dbBytes + cur.bucketBytes + cur.cacheBytes + addBytes;
    if (total > budget) {
      await emitEvent({ orgId, kind: "quota", severity: "warning", title: "storage budget exceeded", detail: { budget, wouldUse: total, reason: "storage" } }); // throttled via dedup
      return `org storage budget exceeded: ${total} bytes would be used > ${budget} byte budget (databases ${cur.dbBytes} + buckets ${cur.bucketBytes} + caches ${cur.cacheBytes} + new ${addBytes})`;
    }
    return null;
  };

  // ---- bucket binding (I1) — inject S3_* creds into an app's write-only secret so they never appear
  // in a manifest. Single binding → unprefixed keys; multiple → `<LABEL>_`-prefixed (label = the bucket
  // name for a direct deploy, the stack resource key for a stack). provision() is idempotent, so this is
  // re-run safe at every deploy. Writes through d.secrets.setSecret + records the key in the registry so
  // the ESO binding (external backends) syncs them; kube backend envFroms `<app>-secret` directly. ----
  const bucketEnvKeys = (label: string, multiple: boolean) => {
    const p = multiple ? label.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" : "";
    return { endpoint: `${p}S3_ENDPOINT`, bucket: `${p}S3_BUCKET`, prefix: `${p}S3_PREFIX`, keyId: `${p}S3_ACCESS_KEY_ID`, secret: `${p}S3_SECRET_ACCESS_KEY` };
  };
  const writeBucketBindings = async (
    entries: { bucketName: string; envLabel: string }[],
    site: Site,
    actorEmail: string,
  ): Promise<void> => {
    if (entries.length === 0) return;
    const multiple = entries.length > 1;
    const scope = { owner: site.owner, app: site.name, namespace: site.namespace };
    for (const e of entries) {
      const creds = await buckets.provision({ name: e.bucketName, namespace: site.namespace, org: site.orgId ?? "" });
      const keys = bucketEnvKeys(e.envLabel, multiple);
      const pairs: [string, string][] = [
        [keys.endpoint, creds.endpoint],
        [keys.bucket, creds.bucket],
        [keys.prefix, creds.prefix],
        [keys.keyId, creds.keyId],
        [keys.secret, creds.secret],
      ];
      for (const [k, v] of pairs) {
        if (k.endsWith("S3_ENDPOINT") && v === "") continue; // prod real-S3 default → no explicit endpoint
        await d.secrets.setSecret(scope, k, v);
        await d.meta.upsertSecretKey(site.name, k, fingerprint(v), actorEmail);
      }
    }
  };

  // ---- cache binding (I2) — inject REDIS_URL into an app's write-only secret so the password never
  // appears in a manifest, response, or the metastore. Exactly like bucket bindings: single binding →
  // unprefixed `REDIS_URL`; multiple → `<LABEL>_REDIS_URL` (label = the cache name for a direct deploy,
  // the stack resource key for a stack). The password is READ BACK from the `<name>-cache` Secret
  // (kube.readCachePassword — the one server-side secret read) to compose the URL; it is never
  // regenerated at bind time (that would desync it from the running Valkey). Re-run safe at every deploy. ----
  const cacheEnvKey = (label: string, multiple: boolean) => {
    const p = multiple ? label.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" : "";
    return `${p}REDIS_URL`;
  };
  const writeCacheBindings = async (entries: { cacheName: string; envLabel: string }[], site: Site, actorEmail: string): Promise<void> => {
    if (entries.length === 0 || !d.kube) return;
    const multiple = entries.length > 1;
    const scope = { owner: site.owner, app: site.name, namespace: site.namespace };
    for (const e of entries) {
      const password = await d.kube.readCachePassword(site.namespace, e.cacheName);
      if (password == null) throw new Error(`cache "${e.cacheName}" is not ready yet (no requirepass secret) — create it before deploying an app that uses it`);
      const url = `redis://:${encodeURIComponent(password)}@${cacheHost(e.cacheName, site.namespace)}:6379`;
      const key = cacheEnvKey(e.envLabel, multiple);
      await d.secrets.setSecret(scope, key, url);
      await d.meta.upsertSecretKey(site.name, key, fingerprint(url), actorEmail);
    }
  };
  // ---- auth binding (K1) — inject AUTH_URL + AUTH_JWT_SECRET into an app's write-only secret. Mirrors
  // the cache/bucket binding path. AUTH_URL is the engine's public base (auth--<name>.<base>); the
  // AUTH_JWT_SECRET is READ BACK from `<name>-auth-keys` (server-side only) so a binding app can verify
  // GoTrue's HS256 tokens locally. On rotation we ALSO inject AUTH_JWT_SECRET_PREVIOUS (the old secret)
  // so tokens signed before the rotation still verify during the grace window (documented). There is NO
  // AUTH_JWKS_URL / anon/service key — OSS GoTrue is HS256-only and has no anon keys (see docs/auth.html).
  // Single binding → unprefixed keys; multiple → `<LABEL>_`-prefixed. Re-run safe at every deploy. ----
  const authEnvKey = (label: string, multiple: boolean, base: string) => (multiple ? label.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" : "") + base;
  const writeAuthBindings = async (entries: { authName: string; envLabel: string }[], site: Site, actorEmail: string): Promise<void> => {
    if (entries.length === 0 || !d.kube) return;
    const multiple = entries.length > 1;
    const scope = { owner: site.owner, app: site.name, namespace: site.namespace };
    for (const e of entries) {
      const secret = await d.kube.readAuthJwtSecret(site.namespace, e.authName);
      if (secret == null) throw new Error(`auth "${e.authName}" is not ready yet (no keys secret) — create it before deploying an app that uses it`);
      const pairs: [string, string][] = [
        [authEnvKey(e.envLabel, multiple, "AUTH_URL"), authExternalUrl(e.authName, d.cfg.baseDomain)],
        [authEnvKey(e.envLabel, multiple, "AUTH_JWT_SECRET"), secret], // HS256 shared secret (write-only) — apps verify tokens with it
      ];
      for (const [k, v] of pairs) {
        await d.secrets.setSecret(scope, k, v);
        await d.meta.upsertSecretKey(site.name, k, fingerprint(v), actorEmail);
      }
    }
  };

  // (K1) The shared auth provisioning primitive — used by POST /v1/auths/:name AND the stack reconcile
  // loop. Applies the engine manifests (generating/rotating the JWT secret only when `jwtSecret` is
  // set) and records the version row carrying the sanitized AuthConfig + bound `db` name.
  const provisionAuth = async (opts: { name: string; namespace: string; db: string; cfg: AuthConfig; jwtSecret?: string; publishedBy: string }): Promise<void> => {
    if (!d.kube) throw new Error("compute is not enabled on this instance");
    const host = `auth--${opts.name}.${d.cfg.baseDomain}`;
    const ctx: AuthManifestContext = { name: opts.name, namespace: opts.namespace, host, db: opts.db, ...(opts.jwtSecret ? { jwtSecret: opts.jwtSecret } : {}) };
    const manifests = authManifests(opts.cfg, authEngine, ctx);
    await d.kube.applyAuth(opts.namespace, opts.name, manifests);
    const verId = newVersionId(now());
    await d.meta.putVersion(opts.name, { id: verId, publishedBy: opts.publishedBy, createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: { ...opts.cfg, db: opts.db } });
    await d.meta.updateSite(opts.name, (s) => ({ ...s, currentVersion: verId }));
  };

  // (K1) The stored AuthConfig (+ bound `db`) on an auth resource's current version, or undefined.
  const currentAuthConfig = async (site: Site): Promise<import("../metastore/types.ts").StoredAuthConfig | undefined> => {
    if (!site.currentVersion) return undefined;
    const cur = (await d.meta.listVersions(site.name)).find((v) => v.id === site.currentVersion);
    return cur?.config as import("../metastore/types.ts").StoredAuthConfig | undefined;
  };

  // (K1) On key rotation, re-inject AUTH_JWT_SECRET (+ AUTH_JWT_SECRET_PREVIOUS for the grace window) +
  // AUTH_URL into every app in the same org that binds this auth resource, then restart it so its pods
  // pick up the new secret (envFrom Secrets are read at pod start). Best-effort per app — one failing
  // consumer never fails the rotation. Grace: the previous secret keeps verifying pre-rotation tokens
  // until the next rotate/redeploy overwrites it (documented, HS256 deviation).
  const rebindAuthConsumers = async (authSite: Site, newSecret: string, previous: string | null, actorEmail: string): Promise<void> => {
    if (!d.kube || !authSite.orgId) return;
    const appNames = await d.meta.orgSiteNames(authSite.orgId, "app");
    for (const appName of appNames) {
      const appSite = await d.meta.getSitePlain(appName);
      if (!appSite) continue;
      const cfg = await currentAppConfig(appSite);
      const authUses = (cfg?.uses ?? []).filter((u) => u.auth === authSite.name);
      if (authUses.length === 0) continue;
      const multiple = (cfg!.uses ?? []).filter((u) => u.auth).length > 1;
      const scope = { owner: appSite.owner, app: appName, namespace: appSite.namespace };
      const pairs: [string, string][] = [
        [authEnvKey(authSite.name, multiple, "AUTH_URL"), authExternalUrl(authSite.name, d.cfg.baseDomain)],
        [authEnvKey(authSite.name, multiple, "AUTH_JWT_SECRET"), newSecret],
      ];
      if (previous) pairs.push([authEnvKey(authSite.name, multiple, "AUTH_JWT_SECRET_PREVIOUS"), previous]);
      try {
        for (const [k, v] of pairs) {
          await d.secrets.setSecret(scope, k, v);
          await d.meta.upsertSecretKey(appName, k, fingerprint(v), actorEmail);
        }
        const keys = (await d.meta.listSecretKeys(appName)).map((k) => k.key);
        await d.secrets.ensureBinding(scope, keys);
        if (appSite.runtimeState !== "stopped") await d.kube.restartApp(appSite.namespace, appName, now().toISOString());
      } catch (e) {
        console.error(`auth rotate: rebinding ${appName} failed: ${(e as Error).message}`);
      }
    }
  };

  const isPlatformAdmin = async (email: string) => (await d.users.getUser(email))?.role === "admin";
  // Append an audit event WITHOUT ever failing the action it records: a broken audit write must
  // not 500 a delete/transfer/etc. Awaited (not fire-and-forget) so the trail is ordered + the
  // record is durable before we respond — the only swallowed outcome is the write itself failing.
  const audit = (e: AuditEntry) => d.audit.record(e).catch((err) => console.error(`audit ${e.action} (${e.target ?? "-"}):`, (err as Error).message));
  // (G3) Emit an alerting event WITHOUT ever failing the action it records — same best-effort posture as
  // `audit`. Thin one-liner at the deploy-fail / stack-halt / quota emit points; the store dedups + fires
  // the org webhook (fire-and-forget) internally.
  const emitEvent = (e: EmitInput) => events.emit(e).catch((err) => console.error(`event ${e.kind} (${e.siteName ?? e.orgId}):`, (err as Error).message));
  // (G3) Close an open incident on recovery (a successful redeploy / stack up) — same best-effort posture.
  const resolveEvent = (siteName: string, kind: string) => events.resolve(siteName, kind).catch((err) => console.error(`event resolve ${kind} (${siteName}):`, (err as Error).message));
  // Resolve a resource's owning org to a display shape ({slug,name,kind}) for the console/CLI, or null.
  const orgOf = async (orgId: string | null) => {
    if (!orgId) return null;
    const o = await d.orgs.getOrg(orgId);
    return o ? { slug: o.slug, name: o.name, kind: o.kind } : null;
  };

  // ---- TCP exposure (A2b) helpers -------------------------------------------------------------
  // An app's stored AppConfig = its current version's config (apps keep config on the version row,
  // not sites.config). undefined when the app was never deployed.
  const currentAppConfig = async (site: Site): Promise<AppConfig | undefined> => {
    if (!site.currentVersion) return undefined;
    const cur = (await d.meta.listVersions(site.name)).find((v) => v.id === site.currentVersion);
    return cur?.config as AppConfig | undefined;
  };
  // (H3) The web process's replica floor for an app's stored config — decides whether a peer reaches it
  // directly in-cluster (min ≥ 1) or must wake it through the edge (min 0 / not yet deployed → 0).
  const webMinReplicas = (cfg: AppConfig | undefined): number => {
    if (!cfg) return 0; // never deployed → no pods → route through the wake path
    return expandProcesses(cfg, "x").find((p) => p.web)?.scale.min ?? 0;
  };
  // (H3) Resolve the `<KEY>_URL` service-discovery env a DIRECT-DEPLOY (or rollback) app's `{app}` uses
  // inject. Unlike bucket/cache/auth creds this is NON-secret (a Service URL), so it is NOT persisted to
  // the write-only secret store — it is recomputed on every deploy AND rollback from the LIVE target (its
  // current scale decides direct-svc vs wake-via-edge). `u.app` is the target app NAME; a bound target is
  // same-namespace (enforced at deploy), so `namespace` is the consumer's own ns. A gone/mistyped target
  // is skipped here (the deploy-time validation loop is the gate that 400s it).
  const resolveAppUsesEnv = async (uses: AppUse[] | undefined, namespace: string): Promise<{ name: string; value: string }[]> => {
    const out: { name: string; value: string }[] = [];
    for (const u of uses ?? []) {
      if (!u.app) continue;
      const tSite = await d.meta.getSitePlain(u.app);
      if (!tSite || tSite.type !== "app") continue;
      const min = webMinReplicas(await currentAppConfig(tSite));
      out.push({ name: appUseEnvName(u.app), value: appUseUrl({ targetName: u.app, namespace, publicHost: `${u.app}.${d.cfg.baseDomain}`, minReplicas: min }) });
    }
    return out;
  };
  // The sni-mode connect PORT for a protocol: postgres rides the shared PG port; other TLS-SNI
  // protocols ride the first tls-sni shared port. Falls back to 5432 (the default shared port).
  const sharedPortForProtocol = (protocol: string): number => {
    const sp = d.cfg.tcpSharedPorts;
    if (protocol === "postgres") return sp.find((s) => s.protocol === "postgres")?.port ?? 5432;
    return sp.find((s) => s.protocol === "tls-sni")?.port ?? sp.find((s) => s.protocol === "postgres")?.port ?? 5432;
  };
  // The connect string for an expose row + an optional sslmode note. SNI mode connects to the wildcard
  // host on the shared port (the SNI hostname IS the routing key); port mode connects to the raw LB
  // host on the allocated port.
  const connectFor = (name: string, ep: TcpEndpoint): { connect: string; sslmode?: string } => {
    if (ep.mode === "sni") {
      const connect = `${name}.${d.cfg.baseDomain}:${sharedPortForProtocol(ep.protocol)}`;
      return { connect, ...(ep.protocol === "postgres" ? { sslmode: "connect with sslmode=require (prefer verify-full with the cluster CA)" } : {}) };
    }
    return { connect: `${d.cfg.tcpLbHost}:${ep.port}` };
  };
  // The container port edge-tcp is allowed to reach on an app pod (for the tenant allow policy): the
  // app's first declared service port, defaulting to the platform default container port.
  const appContainerPort = async (name: string): Promise<number> => {
    const site = await d.meta.getSitePlain(name);
    const cfg = site ? await currentAppConfig(site) : undefined;
    return cfg?.services?.[0]?.internalPort ?? 8080;
  };
  // Every exposed workload in a namespace → the tenant allow-from-edge-tcp policy inputs.
  const exposedWorkloadsFor = async (ns: string): Promise<ExposedWorkload[]> => {
    const rows = await tcp.listForNamespace(ns);
    const out: ExposedWorkload[] = [];
    for (const r of rows) {
      if (r.type === "database") out.push({ name: r.siteName, kind: "database", port: 5432 });
      else if (r.type === "app") out.push({ name: r.siteName, kind: "app", port: await appContainerPort(r.siteName) });
    }
    return out;
  };
  // Apply the tenant isolation objects WITH the current exposed-workload allow policies. Called from
  // deploy / db-create (so a redeploy keeps the allow rule) and expose / unexpose (so it's added/pruned).
  const applyTenantWithExposed = async (kube: KubeClient, ns: string): Promise<void> => {
    const workloads = await exposedWorkloadsFor(ns);
    await kube.applyTenant(ns, tenantManifests(ns, { blockedEgressCidrs: d.cfg.blockedEgressCidrs, edgeTcp: { namespace: d.cfg.edgeTcpNamespace, workloads } }));
  };
  // Patch the edge-tcp Service's port list to the shared ports + every live dynamic port (cluster-wide).
  // Best-effort: returns a note (never throws) when the L4 plane isn't deployed yet — the registry
  // row still stands and the local edge-tcp routes from the DB regardless.
  const patchEdgeTcpService = async (kube: KubeClient): Promise<{ patched: boolean; note?: string }> => {
    const active = await tcp.allActivePorts();
    const ports = [
      ...d.cfg.tcpSharedPorts.map((s) => ({ name: `${s.protocol === "postgres" ? "pg" : "sni"}-${s.port}`, port: s.port })),
      ...active.map((p) => ({ name: `dyn-${p}`, port: p })),
    ];
    try {
      await kube.patchEdgeTcpPorts(d.cfg.edgeTcpNamespace, d.cfg.edgeTcpService, ports);
      return { patched: true };
    } catch (e) {
      return { patched: false, note: (e as Error).message };
    }
  };

  app.get("/v1/me", async (c) => {
    const email = c.get("identity").email;
    await ensureUser(email); // ensure the personal org exists on first console/CLI touch
    // (G3) The frame's unread badge folds in here (the lighter option vs a dedicated poll) — one cheap
    // indexed COUNT of OPEN incidents across every org the caller belongs to, org-context-independent so
    // the badge is correct whatever org the switcher is on (including "all orgs").
    return c.json({ email, admin: await isPlatformAdmin(email), unresolvedEvents: await events.countUnresolvedForUser(email) });
  });

  // ---- organisations (logical resource grouping + org-level permissions) ----
  app.get("/v1/orgs", async (c) => {
    const email = c.get("identity").email;
    await ensureUser(email);
    const orgs = await d.orgs.listUserOrgs(email);
    return c.json({ orgs: orgs.map((o) => ({ slug: o.slug, name: o.name, kind: o.kind, role: o.role })) });
  });

  app.post("/v1/orgs", async (c) => {
    const email = c.get("identity").email;
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string; name?: string };
    const slugErr = validateOrgSlug(body.slug);
    if (slugErr) return c.json({ error: slugErr }, 400);
    await ensureUser(email);
    if (await d.orgs.getOrgBySlug(body.slug!)) return c.json({ error: `org slug "${body.slug}" is taken` }, 409);
    const org = await d.orgs.createOrg(body.slug!, body.name ?? body.slug!, email);
    await audit({ actor: email, action: "org.create", target: org.slug, targetType: "org", orgId: org.id, detail: { name: org.name } });
    return c.json({ slug: org.slug, name: org.name, kind: org.kind, role: "owner" });
  });

  // resolve an org by slug + the caller's role; 404/403 helper for the org sub-routes.
  const resolveOrg = async (c: any, email: string) => {
    const slug = c.req.param("slug");
    const org = await d.orgs.getOrgBySlug(slug);
    if (!org) return { err: c.json({ error: "no such org" }, 404) };
    const role = await d.orgs.roleOf(org.id, email);
    const platformRole = (await d.users.getUser(email))?.role ?? "member";
    if (!role && platformRole !== "admin") return { err: c.json({ error: "not a member" }, 403) };
    return { org, role, platformRole };
  };

  app.get("/v1/orgs/:slug", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    return c.json({ slug: r.org.slug, name: r.org.name, kind: r.org.kind, members: await d.orgs.members(r.org.id) });
  });

  // ---- org usage: workload counts (+ the cap) and the live cluster ResourceQuota consumption ----
  app.get("/v1/orgs/:slug/usage", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email); // member or platform admin
    if ("err" in r) return r.err;
    const workloads = await d.meta.orgWorkloadCounts(r.org.id);
    // Cluster quota is best-effort: a static-only tenant has no compute namespace, and a cluster
    // read failure must never fail the usage call — so it degrades to null.
    let quota = null;
    if (d.kube) {
      try {
        quota = await d.kube.getTenantUsage(r.org.namespace);
      } catch {
        /* leave quota null */
      }
    }
    // (item 10) storage section: database PVC requests + bucket object bytes vs the org budget (null =
    // unset). Approximate + eventually-consistent; best-effort so a bucket-sweep error never 500s usage.
    let storage: {
      databases: { count: number; requestedBytes: number };
      buckets: { count: number; bytes: number };
      caches: { count: number; bytes: number };
      budget: number | null;
    };
    try {
      const use = await orgStorageUsage(r.org.id, r.org.namespace);
      storage = {
        databases: { count: use.dbCount, requestedBytes: use.dbBytes },
        buckets: { count: use.bucketCount, bytes: use.bucketBytes },
        caches: { count: use.cacheCount, bytes: use.cacheBytes }, // (I2) persistent-cache PVC requests
        budget: await quotas.resolvedStorageBudgetBytes(r.org.id),
      };
    } catch {
      storage = { databases: { count: 0, requestedBytes: 0 }, buckets: { count: 0, bytes: 0 }, caches: { count: 0, bytes: 0 }, budget: null };
    }
    return c.json({
      org: { slug: r.org.slug, name: r.org.name, kind: r.org.kind },
      workloads,
      cap: await quotas.resolvedMaxWorkloads(r.org.id, d.cfg.maxWorkloadsPerOrg), // 0 = unlimited (override-aware)
      quota, // { hard, used } | null
      storage,
    });
  });

  // ---- (G3) org events feed — a keyset page of the org's alerting incidents (any member) ----
  // `?unresolved=1` returns just the OPEN incident count (a light poll); otherwise a newest-first page.
  app.get("/v1/orgs/:slug/events", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email); // member or platform admin
    if ("err" in r) return r.err;
    if (c.req.query("unresolved") === "1") return c.json({ count: await events.countUnresolved(r.org.id) });
    const cursor = c.req.query("cursor") || undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 500);
    return c.json(await events.list(r.org.id, { cursor, limit }));
  });

  // ---- (G3) per-org outbound webhook (Slack/Teams incoming-webhook URL, or any endpoint) ----
  // GET (owner/admin): the current config with the secret MASKED (never returned). POST: set/replace it
  // (audited `org.webhook.set`). DELETE: remove it.
  app.get("/v1/orgs/:slug/webhook", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const wh = await events.getWebhook(r.org.id);
    return c.json({ webhook: wh ? { url: wh.url, hasSecret: !!wh.secret, updatedBy: wh.updatedBy, updatedAt: wh.updatedAt } : null });
  });

  app.post("/v1/orgs/:slug/webhook", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; secret?: unknown };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    // Only http(s) — a webhook is an outbound POST; anything else (file:, etc.) is rejected out of hand.
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "url must be a valid http(s) URL" }, 400);
    const secret = typeof body.secret === "string" && body.secret.length ? body.secret : null;
    await events.setWebhook(r.org.id, url, secret, email);
    await audit({ actor: email, action: "org.webhook.set", target: r.org.slug, targetType: "org", orgId: r.org.id, detail: { host: new URL(url).host, signed: !!secret } });
    return c.json({ webhook: { url, hasSecret: !!secret, updatedBy: email } });
  });

  app.delete("/v1/orgs/:slug/webhook", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    await events.deleteWebhook(r.org.id);
    await audit({ actor: email, action: "org.webhook.remove", target: r.org.slug, targetType: "org", orgId: r.org.id });
    return c.json({ removed: true });
  });

  app.post("/v1/orgs/:slug/members", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    if (r.org.kind === "personal") return c.json({ error: "the personal org can't take members; create a team org" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string };
    const role = (["owner", "admin", "member", "viewer"].includes(String(body.role)) ? body.role : "member") as "owner" | "admin" | "member" | "viewer";
    if (!body.email) return c.json({ error: "email required" }, 400);
    await ensureUser(body.email.toLowerCase());
    await d.orgs.addMember(r.org.id, body.email, role);
    await audit({ actor: email, action: "org.member.add", target: r.org.slug, targetType: "org", orgId: r.org.id, detail: { member: body.email.toLowerCase(), role } });
    return c.json({ slug: r.org.slug, email: body.email.toLowerCase(), role });
  });

  app.delete("/v1/orgs/:slug/members/:email", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const target = decodeURIComponent(c.req.param("email")).toLowerCase();
    if (target === r.org.createdBy) return c.json({ error: "can't remove the org's founding owner" }, 409);
    await d.orgs.removeMember(r.org.id, target);
    await audit({ actor: email, action: "org.member.remove", target: r.org.slug, targetType: "org", orgId: r.org.id, detail: { member: target } });
    return c.json({ removed: target });
  });

  // Change an existing member's org role (owner/admin only). "owner" is NOT assignable here — the
  // one-owner-per-org invariant (a partial unique index) makes ownership a transfer, not a role edit —
  // and the founding owner is immutable (mirrors the DELETE guard). addMember upserts the new role.
  app.patch("/v1/orgs/:slug/members/:email", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const target = decodeURIComponent(c.req.param("email")).toLowerCase();
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    const role = String(body.role);
    if (role !== "admin" && role !== "member" && role !== "viewer") return c.json({ error: "role must be admin|member|viewer" }, 400);
    if (target === r.org.createdBy) return c.json({ error: "can't change the org's founding owner's role" }, 409);
    if (!(await d.orgs.roleOf(r.org.id, target))) return c.json({ error: "not a member of this org" }, 404);
    await d.orgs.addMember(r.org.id, target, role); // upsert → updates the role in place
    await audit({ actor: email, action: "org.member.role", target: r.org.slug, targetType: "org", orgId: r.org.id, detail: { member: target, role } });
    return c.json({ slug: r.org.slug, email: target, role });
  });

  // ---- service accounts / scoped CI tokens (J1) ----
  // Org-owned bearer credentials for automation (CI), managed by the org's owner/admin (canManageOrg).
  // The secret is returned ONCE at create (same posture as db password); only its hash is stored. Scopes
  // reuse the permission verbs, optionally resource-qualified (verb:name | verb:*). A token can act ONLY
  // within its org and NEVER on admin / org-management surfaces — enforced in can()'s token path and by
  // the natural failure of isPlatformAdmin/canManageOrg for a `token:…@org` principal.
  app.post("/v1/orgs/:slug/tokens", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; scopes?: unknown; expires_days?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
      return c.json({ error: "name required (1–64 chars: letters, digits, space, _ or -)" }, 400);
    }
    const scopeErr = validateScopes(body.scopes);
    if (scopeErr) return c.json({ error: scopeErr }, 400);
    const scopes = body.scopes as string[];
    // Optional expiry, in whole days (1–3650). Absent → never expires.
    let expiresAt: Date | null = null;
    if (body.expires_days != null && body.expires_days !== "") {
      const days = Number(body.expires_days);
      if (!Number.isInteger(days) || days <= 0 || days > 3650) return c.json({ error: "expires_days must be a whole number of days between 1 and 3650" }, 400);
      expiresAt = new Date(now().getTime() + days * 86_400_000);
    }
    const { token, row } = await tokens.create(r.org.id, name, scopes, expiresAt, email);
    await audit({ actor: email, action: "token.create", target: name, targetType: "token", orgId: r.org.id, detail: { id: row.id, scopes, expiresAt: row.expiresAt } });
    // The secret is returned ONCE — never stored, never returned again (RevealOnce posture).
    return c.json({ token, id: row.id, name: row.name, scopes: row.scopes, expiresAt: row.expiresAt, createdBy: row.createdBy, createdAt: row.createdAt });
  });

  app.get("/v1/orgs/:slug/tokens", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    return c.json({ tokens: await tokens.list(r.org.id) }); // never any hashes/secrets
  });

  app.delete("/v1/orgs/:slug/tokens/:id", async (c) => {
    const email = c.get("identity").email;
    const r = await resolveOrg(c, email);
    if ("err" in r) return r.err;
    if (!canManageOrg(r.role, r.platformRole)) return c.json({ error: "owner/admin only" }, 403);
    const id = c.req.param("id");
    const existing = await tokens.get(id);
    if (!existing || existing.orgId !== r.org.id) return c.json({ error: "no such token" }, 404); // scoped to THIS org
    const revoked = await tokens.revoke(id); // soft mark; subsequent verify → null → 401
    await audit({ actor: email, action: "token.revoke", target: existing.name, targetType: "token", orgId: r.org.id, detail: { id, alreadyRevoked: !revoked } });
    return c.json({ revoked: id, name: existing.name });
  });

  // ---- publish ----
  app.post("/v1/sites/:name/versions", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);
    // (E1) ?preview=<label> publishes a version WITHOUT touching current_version — validate the
    // label up front (before consuming the upload) so a bad label never costs a wasted body read.
    const previewLabel = c.req.query("preview");
    if (previewLabel !== undefined) {
      const labelErr = validatePreviewLabel(previewLabel);
      if (labelErr) return c.json({ error: labelErr }, 400);
    }

    // resolve or claim
    let site = await d.meta.getSitePlain(name);
    if (!site) {
      await ensureUser(email); // FK: owner membership references users
      const orgRes = await resolveCreateOrg(c, email);
      if ("err" in orgRes) return orgRes.err;
      const claimed = await d.meta.claimSite(name, email, "site", { id: orgRes.org.id, namespace: orgRes.org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "site") return c.json({ error: `name "${name}" is an ${site.type}, not a site` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "publish")) return c.json({ error: `site is owned by ${site.owner}` }, 403); // same authz as an ordinary publish (E1)

    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    const verId = newVersionId(now());
    const prefix = d.meta.filesPrefix(name, verId);
    const nodeStream = Readable.fromWeb(c.req.raw.body as Parameters<typeof Readable.fromWeb>[0]);

    let result: { files: number; bytes: number };
    // drop.yaml is parsed at publish time, never served (it may carry credentials).
    const captured: { yaml?: Buffer } = {};
    try {
      result = await extractTarGz(
        nodeStream,
        async (rel, body, size, ct) => {
          if (rel === CONFIG_FILE_YAML) { captured.yaml = await streamConsumers.buffer(body); return; }
          await d.blob.put(prefix + rel, body, size, ct);
        },
        { maxFiles: d.cfg.maxFiles, maxBytes: d.cfg.maxUploadBytes },
      );
    } catch (e) {
      await d.blob.deletePrefix(prefix).catch(() => {});
      return c.json({ error: `bad upload: ${(e as Error).message}` }, 400);
    }

    let config: SiteConfig | undefined;
    if (captured.yaml) {
      try {
        config = parseDropYaml(captured.yaml.toString("utf8"));
      } catch (e) {
        await d.blob.deletePrefix(prefix).catch(() => {});
        return c.json({ error: `invalid drop.yaml: ${(e as Error).message}` }, 400);
      }
    }
    if (config?.name && config.name !== name) {
      await d.blob.deletePrefix(prefix).catch(() => {});
      return c.json({ error: `drop.yaml name "${config.name}" does not match target site "${name}"` }, 400);
    }

    await d.meta.putVersion(name, {
      id: verId,
      publishedBy: email,
      createdAt: now().toISOString(),
      fileCount: result.files,
      bytes: result.bytes,
      config,
    });

    if (previewLabel !== undefined) {
      // (E1) Preview publish: the version above is stored exactly like any other — current_version
      // is LEFT UNTOUCHED, so the live site keeps serving whatever it was serving before. The
      // preview is reachable ONLY at its own <name>--<label> host. Re-publishing the same label
      // re-points it (upsert) at this new version.
      const expiresAt = new Date(now().getTime() + clampExpireDays(c.req.query("expire_days")) * 24 * 60 * 60 * 1000);
      await previews.upsert(name, previewLabel, verId, email, expiresAt);
      // Preview bytes are VERSION bytes — the SAME retention/GC (pruneVersions) applies to them as to
      // any other version, unaware of any live preview still referencing it. A preview can therefore
      // outlive its own version's bytes if enough OTHER versions get published first; that's accepted,
      // documented behavior (see docs/previews.html) rather than new cross-feature protection.
      void pruneVersions(d, name);
      await audit({
        actor: email,
        action: "preview.create",
        target: name,
        targetType: site.type,
        orgId: site.orgId,
        detail: { label: previewLabel, versionId: verId, expiresAt: expiresAt.toISOString() },
      });
      return c.json({
        url: siteUrl(name), // the site's own URL — unaffected, current_version untouched
        version: verId,
        files: result.files,
        bytes: result.bytes,
        preview: { label: previewLabel, url: previewUrl(name, previewLabel), versionId: verId, expiresAt: expiresAt.toISOString() },
      });
    }

    // commit point: flip the live pointer (+ denormalize config). A bundle that
    // carries basicAuth implies password visibility.
    const hasBasicAuth = !!config?.basicAuth && Object.keys(config.basicAuth.users).length > 0;
    await d.meta.updateSite(name, (s) => ({
      ...s,
      currentVersion: verId,
      config,
      visibility: hasBasicAuth ? "password" : s.visibility,
    }));

    void pruneVersions(d, name);
    return c.json({ url: siteUrl(name), version: verId, files: result.files, bytes: result.bytes });
  });

  // ---- previews (E1): create is folded into publish (?preview=<label>); list + remove are dedicated ----
  // List a site's active (unexpired-or-not-yet-swept) previews — `drop preview ls` + the console panel.
  app.get("/v1/sites/:name/previews", async (c) => {
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "read")) return c.json({ error: "not permitted" }, 403);
    return c.json({ name, previews: await previewsFor(name) });
  });

  // Remove one preview by label (idempotent 404 on unknown; same authz tier as creating one). (E2) An
  // APP preview (kind='app') ALSO tears down its parallel `<name>-p-<label>` manifest set (+ its
  // --with-db clone), idempotently — the SAME code path the expiry sweep uses.
  app.delete("/v1/sites/:name/previews/:label", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const label = c.req.param("label");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    // A site preview is `publish`-gated (E1); an app preview is `deploy`-gated (E2) — the same verb that
    // created it (so a `deploy:<app>`-scoped CI token can remove one it made).
    const rmCap = site.type === "app" ? "deploy" : "publish";
    if (!can(await actorFor(c.get("identity"), site), rmCap)) return c.json({ error: "not permitted" }, 403);
    // Read the row BEFORE deleting it — we need kind/hasDb to know what to tear down.
    const row = await previews.get(name, label);
    const removed = await previews.remove(name, label);
    if (!removed) return c.json({ error: `no such preview "${label}" on ${name}` }, 404);
    if (row?.kind === "app" && d.kube) {
      const previewName = `${name}-p-${label}`;
      await d.kube.deleteApp(site.namespace, previewName); // idempotent (404-safe), same path as app delete
      if (row.hasDb) await d.kube.deleteDatabase(site.namespace, `${previewName}-db`); // its empty --with-db clone
    }
    await audit({ actor: email, action: "preview.delete", target: name, targetType: site.type, orgId: site.orgId, detail: { label, kind: row?.kind ?? "site", ...(row?.hasDb ? { hadDb: true } : {}) } });
    return c.json({ removed: true, name, label });
  });

  // ---- deploy (container app) ----
  app.post("/v1/apps/:name", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const appCfg = sanitizeAppConfig(body);
    if (!appCfg) return c.json({ error: "app config requires an image" }, 400);
    // (E2) ?preview=<label> deploys a PARALLEL, ephemeral manifest set instead of touching the live app —
    // validate the label up front (before any claim/apply) so a bad one 400s cheaply. `--with-db` clones
    // a fresh EMPTY database from the parent's bound-db spec; else the preview reuses the parent's DB.
    const previewLabel = c.req.query("preview");
    const isPreview = previewLabel !== undefined;
    if (isPreview) {
      const labelErr = validatePreviewLabel(previewLabel!);
      if (labelErr) return c.json({ error: labelErr }, 400);
    }
    // (A2b) A `services[].protocol: tcp` app is rejected by assertHttpOnly UNLESS it has an expose
    // row (the documented order is: expose first, then deploy the tcp service). A TCP-exposed app must
    // also run with scale.min >= 1 (a TCP SYN can't wake a scaled-to-zero pod). Pure-HTTP is unchanged.
    const exposeRow = await tcp.get(name);
    try {
      assertProcesses(appCfg); // at most one web process
      if (exposeRow) {
        if ((appCfg.scale?.min ?? 0) < 1) {
          throw new Error("a TCP-exposed app must run with scale.min >= 1 (a TCP SYN can't wake a scaled-to-zero pod) — set scale.min: 1");
        }
      } else {
        assertHttpOnly(appCfg); // v1: one HTTP service (443-only)
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (appCfg.name && appCfg.name !== name) {
      return c.json({ error: `app name "${appCfg.name}" does not match target "${name}"` }, 400);
    }

    // resolve or claim — apps share the one name namespace with sites
    let site = await d.meta.getSitePlain(name);
    // (E2) A preview is a branch OF an existing app — it reuses the parent's secrets/bindings, so the
    // parent must already exist. Never claim-create a bare app just to preview it.
    if (isPreview && !site) return c.json({ error: `cannot preview "${name}": deploy the app first (a preview reuses the parent's secrets/bindings)` }, 404);
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email);
      if ("err" in orgRes) return orgRes.err;
      const claimed = await d.meta.claimSite(name, email, "app", { id: orgRes.org.id, namespace: orgRes.org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "deploy")) return c.json({ error: `app is owned by ${site.owner}` }, 403);

    // Resolve declared bindings (app.uses): each must be an existing resource in the SAME org.
    // DB bindings wire the namespace-scoped CNPG `<db>-app`/`<db>-ca` Secrets; bucket bindings (I1)
    // inject S3_* creds through the write-only secret path. A cross-org target is both unauthorized
    // and unreachable — reject with a named 400 before touching kube.
    for (const u of appCfg.uses ?? []) {
      if (u.database) {
        const dbSite = await d.meta.getSitePlain(u.database);
        if (!dbSite || dbSite.type !== "database") {
          return c.json({ error: `app uses database "${u.database}", which does not exist` }, 400);
        }
        if (dbSite.orgId !== site.orgId) {
          return c.json({ error: `database "${u.database}" belongs to a different organisation and cannot be bound` }, 400);
        }
      } else if (u.bucket) {
        const bSite = await d.meta.getSitePlain(u.bucket);
        if (!bSite || bSite.type !== "bucket") {
          return c.json({ error: `app uses bucket "${u.bucket}", which does not exist` }, 400);
        }
        if (bSite.orgId !== site.orgId) {
          return c.json({ error: `bucket "${u.bucket}" belongs to a different organisation and cannot be bound` }, 400);
        }
      } else if (u.cache) {
        const cSite = await d.meta.getSitePlain(u.cache);
        if (!cSite || cSite.type !== "cache") {
          return c.json({ error: `app uses cache "${u.cache}", which does not exist` }, 400);
        }
        if (cSite.orgId !== site.orgId) {
          return c.json({ error: `cache "${u.cache}" belongs to a different organisation and cannot be bound` }, 400);
        }
      } else if (u.auth) {
        const aSite = await d.meta.getSitePlain(u.auth);
        if (!aSite || aSite.type !== "auth") {
          return c.json({ error: `app uses auth "${u.auth}", which does not exist` }, 400);
        }
        if (aSite.orgId !== site.orgId) {
          return c.json({ error: `auth "${u.auth}" belongs to a different organisation and cannot be bound` }, 400);
        }
      } else if (u.app) {
        // (H3) app→app service discovery: the target must be another app in the SAME org AND namespace.
        // Cross-org/cross-namespace is refused (400) — the isolation model is the product, not a hole to
        // punch casually; within an org all resources share the namespace, so same-org ⇒ same-namespace.
        if (u.app === name) return c.json({ error: `app "${name}" cannot use itself` }, 400);
        const pSite = await d.meta.getSitePlain(u.app);
        if (!pSite || pSite.type !== "app") {
          return c.json({ error: `app uses app "${u.app}", which does not exist` }, 400);
        }
        if (pSite.orgId !== site.orgId) {
          return c.json({ error: `app "${u.app}" belongs to a different organisation and cannot be bound` }, 400);
        }
        if (pSite.namespace !== site.namespace) {
          return c.json({ error: `app "${u.app}" is in a different namespace and cannot be bound (cross-namespace service discovery is refused)` }, 400);
        }
      }
    }

    // (E2) ?preview=<label>: deploy a PARALLEL, ephemeral manifest set `<name>-p-<label>` (Deployment +
    // Service + HTTPScaledObject) at host `<name>--<label>.<baseDomain>`, scale FORCED {min:0,max:1},
    // running the freshly-resolved image. It reuses the parent's write-only secrets + config + bindings
    // READ-ONLY (sharedSecretName) and NEVER touches the parent's current_version or manifests. A
    // preview counts against the org workload cap; --with-db additionally clones an EMPTY database from
    // the parent's bound-db spec (torn down at expiry) and counts against the storage budget.
    if (isPreview) {
      const kube = d.kube;
      const ns = site.namespace;
      const orgId = site.orgId;
      const withDb = c.req.query("with_db") === "true" || c.req.query("with_db") === "1";
      const previewName = `${name}-p-${previewLabel}`;
      const existing = await previews.get(name, previewLabel!); // a re-deploy of the SAME label reuses its workload/db slot
      // Quota: an app preview is a live workload. Previews live OUTSIDE the `sites` table, so add the
      // org's existing app-preview count to its site count explicitly before comparing to the cap. A
      // re-deploy of an existing label isn't a NEW workload, so it's exempt.
      if (orgId && !existing) {
        const cap = await quotas.resolvedMaxWorkloads(orgId, d.cfg.maxWorkloadsPerOrg);
        if (cap > 0) {
          const used = (await d.meta.countSitesInOrg(orgId)) + (await previews.countAppPreviewsForOrg(orgId));
          if (used >= cap) return c.json({ error: `workload cap reached for this org (${cap}) — remove a preview/app or ask an admin to raise the limit` }, 429);
        }
      }
      await applyTenantWithExposed(kube, ns); // namespace + NetworkPolicy + quota + LimitRange
      // --with-db: clone the parent's FIRST bound database SPEC (storage/extensions/hibernation) into a
      // fresh, EMPTY CNPG cluster `<name>-p-<label>-db`. Same-org (the parent's db was org-validated in the
      // uses loop above). L2: seed it from the parent db (from-backup / data copy) — v1 ships an EMPTY db.
      const dbUse = (appCfg.uses ?? []).find((u) => u.database);
      let previewDbName: string | undefined;
      if (withDb) {
        if (!dbUse?.database) return c.json({ error: "--with-db needs the app to bind a database (uses: [{ database }]) to clone its spec from" }, 400);
        const local = !!d.cfg.s3Endpoint;
        if (!local && !d.cfg.dbBackupRoleArn) return c.json({ error: "database backups not configured: set DROP_DB_BACKUP_ROLE_ARN (IRSA role)" }, 501);
        previewDbName = `${previewName}-db`;
        const dbExists = !!existing?.hasDb; // a re-deploy keeps the SAME empty clone — never re-rotate its creds
        const dbVersions = await d.meta.listVersions(dbUse.database);
        const parentDbCfg = dbVersions.find((v) => v.config)?.config as { storage?: string; hibernation?: "none" | "scheduled"; extensions?: string[] } | undefined;
        const dsCap = await quotas.resolvedMaxDbStorage(orgId ?? "");
        const cloneCfg = sanitizeDatabaseConfig({ storage: parentDbCfg?.storage, hibernation: parentDbCfg?.hibernation, extensions: parentDbCfg?.extensions }, dsCap.bytes, d.cfg.dbExtensionAllowlist)!;
        if (!dbExists) {
          const budgetErr = await checkStorageBudget(orgId ?? "", ns, storageToBytes(cloneCfg.storage) ?? 0);
          if (budgetErr) return c.json({ error: budgetErr }, 429);
        }
        const backupEndpoint = d.cfg.dbBackupEndpoint ?? d.cfg.s3Endpoint;
        const storeEgress = local && d.cfg.dbBackupEgressCidr && backupEndpoint ? { cidr: d.cfg.dbBackupEgressCidr, port: Number(new URL(backupEndpoint).port) || 443 } : undefined;
        const dbManifests = databaseManifests(cloneCfg, {
          name: previewDbName,
          namespace: ns,
          destinationPath: `s3://${d.cfg.s3Bucket}/databases/${ns}/${previewDbName}`,
          ...(dbExists ? {} : { appPassword: generateDbPassword() }), // creds set once, at first clone
          apiServerCidrs: d.cfg.blockedEgressCidrs,
          ...(local ? { s3: { endpointURL: backupEndpoint, accessKeyId: d.cfg.s3KeyId, secretAccessKey: d.cfg.s3Secret }, objectStoreEgress: storeEgress } : { iamRoleArn: d.cfg.dbBackupRoleArn }),
        });
        await kube.applyDatabase(ns, previewDbName, dbManifests);
      }
      // The preview's uses point at the SAME resources as the parent (read-only reuse), except a
      // --with-db preview's database use is redirected to its OWN empty clone.
      const previewUses = withDb && dbUse ? (appCfg.uses ?? []).map((u) => (u === dbUse ? { ...u, database: previewDbName } : u)) : appCfg.uses;
      const previewSandbox = !appCfg.trusted;
      const previewPullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
      const previewVerId = newVersionId(now());
      const previewAppUrlEnv = await resolveAppUsesEnv(previewUses, ns);
      const previewCfg = { ...appCfg, scale: { min: 0, max: 1 }, uses: previewUses }; // scale FORCED {0,1} — a preview is cheap
      const manifests = appManifests(previewCfg, {
        name: previewName,
        namespace: ns,
        host: `${name}--${previewLabel}.${d.cfg.baseDomain}`, // the E1 `--` convention; the interceptor keys on this
        sandbox: previewSandbox,
        imagePullSecret: previewPullSecret,
        versionId: previewVerId,
        sharedSecretName: name, // envFrom the PARENT's <name>-env + <name>-secret (read-only reuse — no per-preview secret set)
        ...(previewAppUrlEnv.length ? { appUrlEnv: previewAppUrlEnv } : {}),
      });
      try {
        await locks.withLock(`deploy:${previewName}`, DEPLOY_LOCK_TTL_MS, async () => {
          // No release Job for a preview: it shares the parent's already-migrated DB (running the release
          // against it could mutate prod). A --with-db clone is empty — schema seeding is a documented L2.
          await kube.applyApp(ns, previewName, manifests);
        });
      } catch (e) {
        if (e instanceof LockHeldError) return c.json({ error: `a deploy is already in progress for ${previewName}` }, 409);
        throw e;
      }
      const expiresAt = new Date(now().getTime() + clampExpireDays(c.req.query("expire_days")) * 24 * 60 * 60 * 1000);
      // version_id holds the deployed IMAGE ref (an app preview has no static version row — it never
      // writes to the parent's version history); kind='app' + has_db drive the sweep + rm teardown.
      await previews.upsert(name, previewLabel!, appCfg.image, email, expiresAt, { kind: "app", hasDb: withDb });
      await audit({ actor: email, action: "preview.create", target: name, targetType: "app", orgId, detail: { label: previewLabel, image: appCfg.image, withDb, ...(previewDbName ? { db: previewDbName } : {}), expiresAt: expiresAt.toISOString() } });
      return c.json({
        name,
        preview: { label: previewLabel, url: previewUrl(name, previewLabel!), image: appCfg.image, withDb, ...(previewDbName ? { db: previewDbName } : {}), expiresAt: expiresAt.toISOString() },
      });
    }

    const verId = newVersionId(now());
    const ns = site.namespace; // per-owner tenant namespace (isolation)
    const kube = d.kube;
    const theSite = site;
    await applyTenantWithExposed(kube, ns); // namespace + NetworkPolicy + quota + LimitRange (+ A2b edge-tcp allow policies)
    const sandbox = !appCfg.trusted;
    const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
    // (H3) Resolve `<KEY>_URL` service-discovery env for each `{app}` use (a non-secret plain container
    // env — see resolveAppUsesEnv). Passed into the manifest context, not the write-only secret path.
    const appUrlEnv = await resolveAppUsesEnv(appCfg.uses, ns);
    // versionId (H1): stamps `drop.dev/version` on the pod template so THIS deploy always rolls
    // pods, even when the image tag is unchanged from the previous version. tcpExposed (A2b) lets the
    // manifest layer accept a `protocol: tcp` service for an exposed app.
    const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: verId, tcpExposed: !!exposeRow, ...(appUrlEnv.length ? { appUrlEnv } : {}) });
    // A stopped deploy (--no-start / already-stopped) rolls out nothing yet, so it also SKIPS the
    // release phase — the point of --no-start is to configure secrets first, and the release command
    // (which needs those secrets/the DB) would otherwise fail against an unconfigured app.
    const willStop = theSite.runtimeState === "stopped" || c.req.query("start") === "false";

    // Serialize the release + rollout per app so two concurrent deploys can't interleave migrations.
    // A held lock → 409 (another deploy is mid-flight). Everything cluster-mutating lives inside.
    let result: { halt: true; reason: string; logs: string } | { halt: false; stopped: boolean };
    try {
      result = await locks.withLock(`deploy:${name}`, DEPLOY_LOCK_TTL_MS, async () => {
        // (I1) Bucket bindings: provision creds and write them to the app's write-only secret BEFORE
        // the release Job / rollout, so both see the S3_* env. Idempotent (provision is), so a redeploy
        // just re-writes the same values. For a direct deploy the env-key label is the bucket name.
        await writeBucketBindings(
          (appCfg.uses ?? []).filter((u) => u.bucket).map((u) => ({ bucketName: u.bucket!, envLabel: u.bucket! })),
          theSite,
          email,
        );
        // (I2) Cache bindings: read back each bound cache's requirepass password and write REDIS_URL to
        // the app's write-only secret BEFORE the release Job / rollout (so both see it). For a direct
        // deploy the env-key label is the cache name. Same idempotent, re-run-safe posture as buckets.
        await writeCacheBindings(
          (appCfg.uses ?? []).filter((u) => u.cache).map((u) => ({ cacheName: u.cache!, envLabel: u.cache! })),
          theSite,
          email,
        );
        // (K1) Auth bindings: read back each bound auth resource's JWT secret and write AUTH_URL +
        // AUTH_JWT_SECRET to the app's write-only secret BEFORE the release Job / rollout. For a direct
        // deploy the env-key label is the auth resource name. Same idempotent posture as buckets/caches.
        await writeAuthBindings(
          (appCfg.uses ?? []).filter((u) => u.auth).map((u) => ({ authName: u.auth!, envLabel: u.auth! })),
          theSite,
          email,
        );
        // Release phase: run a Job (same image/env/bindings/secrets) BEFORE applying the new
        // manifests. On failure the deploy HALTS — the old Deployment/HSO is untouched, so the old
        // version keeps serving. GC prior release Jobs first; a deterministic version-named Job
        // stays briefly for `drop logs --release`.
        if (appCfg.release && !willStop) {
          await kube.deleteReleaseJobs(ns, name);
          const job = releaseJobManifest(appCfg, { name, namespace: ns, host: "", versionId: verId, sandbox, imagePullSecret });
          const rr = await kube.runReleaseJob(ns, name, job, (appCfg.release.timeout ?? 300) * 1000);
          if (!rr.ok) return { halt: true as const, reason: rr.reason, logs: rr.logs };
        }
        await kube.applyApp(ns, name, manifests);
        // Reconcile the secret-injection wiring (no-op for kube; (re)writes the ESO ExternalSecret
        // for external backends) using the current key registry.
        const secretKeys = (await d.meta.listSecretKeys(name)).map((k) => k.key);
        await d.secrets.ensureBinding({ owner: theSite.owner, app: name, namespace: ns }, secretKeys);
        // Don't roll out a running pod until the operator opts in. A fresh app often needs its
        // secrets/config set BEFORE first boot (e.g. a DB password) or it crash-loops — `--no-start`
        // (?start=false) deploys it STOPPED so you can configure it, then `drop start` gives it a
        // healthy first boot. A redeploy of an already-stopped app likewise stays down until start.
        let stopped = theSite.runtimeState === "stopped";
        if (c.req.query("start") === "false" && !stopped) {
          await d.meta.setRuntimeState(name, "stopped");
          stopped = true;
        }
        if (stopped) await kube.stopApp(ns, name);

        // (H1) Persist the full sanitized AppConfig — including the resolved image ref — on the
        // version row. This is what makes rollback possible: a later rollback re-applies exactly
        // this stored config via appManifests, rather than needing to reconstruct it.
        await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: appCfg });
        await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId }));
        return { halt: false as const, stopped };
      });
    } catch (e) {
      if (e instanceof LockHeldError) return c.json({ error: `a deploy is already in progress for ${name}` }, 409);
      throw e;
    }
    if (result.halt) {
      await audit({ actor: email, action: "app.release.failed", target: name, targetType: "app", orgId: theSite.orgId, detail: { reason: result.reason, version: verId } });
      if (theSite.orgId) await emitEvent({ orgId: theSite.orgId, siteName: name, kind: "deploy_failed", severity: "error", title: `deploy failed: ${name}`, detail: { reason: result.reason, version: verId } });
      // The old version keeps serving; return the release logs so the failure is diagnosable inline.
      return c.json({ error: `release command failed (${result.reason}) — the previous version keeps serving`, releaseLogs: (result.logs ?? "").slice(-4000) }, 422);
    }
    await resolveEvent(name, "deploy_failed"); // recovery: a clean deploy closes any open deploy-failed incident
    return c.json({ url: siteUrl(name), name, version: verId, image: appCfg.image, started: !result.stopped });
  });

  // ---- image push: CLI builds locally + streams a `docker save` tarball; we make it pullable by
  // the cluster (containerd-import locally, registry/ECR in prod) and return the in-cluster ref.
  // The developer never needs registry credentials. `drop deploy --build` chains this → POST /v1/apps.
  app.put("/v1/apps/:name/image", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    // resolve or claim — pushing an image is part of deploying an app; share the one name namespace
    let site = await d.meta.getSitePlain(name);
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email);
      if ("err" in orgRes) return orgRes.err;
      const claimed = await d.meta.claimSite(name, email, "app", { id: orgRes.org.id, namespace: orgRes.org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "deploy")) return c.json({ error: `app is owned by ${site.owner}` }, 403);

    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    // The CLI tags the built image `drop.local/<app>:<tag>` before `docker save`, so the archive
    // carries that ref; we MUST reuse the same tag (not a server-minted one) or the imported image
    // and the Deployment's image string would diverge → ImagePullBackOff. Validate it's a safe tag.
    const version = c.req.query("tag") ?? "";
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(version)) return c.json({ error: "missing or invalid ?tag" }, 400);
    // Cap the upload (DoS bound): the backend imports/pushes the whole stream, so count bytes through
    // a transform and abort past the limit rather than buffering an unbounded body.
    const max = d.cfg.imageMaxBytes;
    let seen = 0;
    let tooBig = false;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        seen += (chunk as Buffer).length;
        if (seen > max) {
          tooBig = true;
          return cb(new Error(`image exceeds the ${max}-byte limit`));
        }
        cb(null, chunk);
      },
    });
    const raw = Readable.fromWeb(c.req.raw.body as Parameters<typeof Readable.fromWeb>[0]);
    raw.on("error", (e) => limit.destroy(e instanceof Error ? e : new Error(String(e)))); // client abort → don't crash
    raw.pipe(limit);
    try {
      const pushed = await d.images.push({ owner: site.owner, app: name, namespace: site.namespace }, version, limit);
      return c.json({ image: pushed.image, version });
    } catch (e) {
      if (tooBig) return c.json({ error: `image too large (limit ${max} bytes)` }, 413);
      return c.json({ error: `image push failed: ${(e as Error).message}` }, 400);
    }
  });

  // ---- app secrets: write-only (set/list-keys/delete; values are NEVER returned) ----
  // Gated at `configure` (owner/admin), like set-visibility / db:password. The value lives only in
  // the SecretStore backend + the pod env — never in a response, log, or the metastore.
  const resolveAppForSecrets = async (c: any): Promise<{ site: Site; email: string } | { err: Response }> => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return { err: c.json({ error: "no such app" }, 404) };
    if (site.type !== "app") return { err: c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409) };
    if (!can(await actorFor(c.get("identity"), site), "configure")) return { err: c.json({ error: "owner only" }, 403) };
    return { site, email };
  };

  app.put("/v1/apps/:name/secrets/:key", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const key = c.req.param("key");
    const keyErr = validateSecretKey(key);
    if (keyErr) return c.json({ error: keyErr }, 400);
    const r = await resolveAppForSecrets(c);
    if ("err" in r) return r.err;
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value !== "string" || body.value.length === 0) return c.json({ error: "value required (non-empty string)" }, 400);
    if (body.value.length > 64 * 1024) return c.json({ error: "value too large (max 64KiB)" }, 400);
    const scope = { owner: r.site.owner, app: r.site.name, namespace: r.site.namespace };
    await d.secrets.setSecret(scope, key, body.value);
    const fp = fingerprint(body.value);
    await d.meta.upsertSecretKey(r.site.name, key, fp, r.email);
    await d.secrets.ensureBinding(scope, (await d.meta.listSecretKeys(r.site.name)).map((k) => k.key));
    return c.json({ key, fingerprint: fp, updatedBy: r.email, updatedAt: now().toISOString() }); // NEVER the value
  });

  app.get("/v1/apps/:name/secrets", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const r = await resolveAppForSecrets(c);
    if ("err" in r) return r.err;
    // key NAMES + metadata only — never values. (Restart to apply pending changes; the UI compares
    // fingerprints to flag "changed".)
    return c.json({ secrets: await d.meta.listSecretKeys(r.site.name) });
  });

  app.delete("/v1/apps/:name/secrets/:key", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const key = c.req.param("key");
    const keyErr = validateSecretKey(key);
    if (keyErr) return c.json({ error: keyErr }, 400);
    const r = await resolveAppForSecrets(c);
    if ("err" in r) return r.err;
    const scope = { owner: r.site.owner, app: r.site.name, namespace: r.site.namespace };
    await d.secrets.deleteSecret(scope, key);
    await d.meta.deleteSecretKey(r.site.name, key);
    await d.secrets.ensureBinding(scope, (await d.meta.listSecretKeys(r.site.name)).map((k) => k.key));
    return c.json({ key, deleted: true });
  });

  // ---- app runtime config (L4): a per-app, NON-SECRET key/value store (flip a flag without a redeploy) ----
  // Read: `GET .../config` returns the map + an ETag `version`; supports `If-None-Match` → 304. It's served
  // to the APP itself (via an injected per-app read token — a J1 service token whose ONLY scope is the
  // token-only `config.read:<name>` verb) AND to the console/CLI (a session or a person's token) — so the
  // GET authorizes with `read` OR `config.read`. Mutations are `configure`-gated + audited. The config
  // token is minted LAZILY on the FIRST `config set` (not at deploy — see ensureConfigToken).
  const CONFIG_TOKEN_KEY = "DROP_CONFIG_TOKEN";
  const CONFIG_URL_KEY = "DROP_CONFIG_URL";
  const configEtag = (version: number) => `W/"${version}"`;
  const ifNoneMatchVersion = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const m = /(\d+)/.exec(raw); // the client echoes back `W/"<version>"`; pull the integer
    return m ? Number(m[1]) : null;
  };

  // Lazily provision the app's config-read token on the first `config set`. Idempotent: the token's secret
  // is injected as DROP_CONFIG_TOKEN, so if that key is already in the app's secret registry we've minted
  // before and do nothing. Deliberately NOT done in the deploy handler (that's off-limits + we want the
  // token only for apps that actually use config). Writes DROP_CONFIG_TOKEN (the J1 secret, scope
  // `config.read:<name>`) + DROP_CONFIG_URL (the endpoint the @drop/config SDK polls) into the app's
  // write-only secret via the SAME path bindings use — no deploy-handler change. They land in the pod on
  // the app's NEXT restart/deploy (envFrom Secrets are read at pod start); thereafter config changes are
  // hot (the SDK polls, no restart). An app in the org-migration window (no orgId) can't scope a token, so
  // the mint is skipped (console/CLI still work via session; the SDK just has no injected token).
  const ensureConfigToken = async (site: Site, actorEmail: string): Promise<void> => {
    if (!site.orgId) return;
    const keys = await d.meta.listSecretKeys(site.name);
    if (keys.some((k) => k.key === CONFIG_TOKEN_KEY)) return; // already minted
    const { token } = await tokens.create(site.orgId, `config-${site.name}`, [`config.read:${site.name}`], null, actorEmail);
    const scope = { owner: site.owner, app: site.name, namespace: site.namespace };
    const url = `${d.cfg.publicUrl}/v1/apps/${site.name}/config`;
    for (const [k, v] of [[CONFIG_TOKEN_KEY, token], [CONFIG_URL_KEY, url]] as [string, string][]) {
      await d.secrets.setSecret(scope, k, v);
      await d.meta.upsertSecretKey(site.name, k, fingerprint(v), actorEmail);
    }
    await d.secrets.ensureBinding(scope, (await d.meta.listSecretKeys(site.name)).map((k) => k.key));
    await audit({ actor: actorEmail, action: "config.token.mint", target: site.name, targetType: "app", orgId: site.orgId, detail: { scope: `config.read:${site.name}` } });
  };

  app.get("/v1/apps/:name/config", async (c) => {
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such app" }, 404);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    // Accept BOTH principals: a person/session with `read`, and the injected app token with `config.read`.
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "read") && !can(actor, "config.read")) return c.json({ error: "not permitted" }, 403);
    const snap = await appConfigs.get(name);
    const etag = configEtag(snap.version);
    if (ifNoneMatchVersion(c.req.header("if-none-match")) === snap.version) {
      return c.body(null, 304, { ETag: etag, "Cache-Control": "no-cache" }); // unchanged → cheap poll
    }
    return c.json({ config: snap.map, version: snap.version }, 200, { ETag: etag, "Cache-Control": "no-cache" });
  });

  app.put("/v1/apps/:name/config/:key", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const r = await resolveAppForSecrets(c); // resolves the app + gates on `configure` (same tier as secrets)
    if ("err" in r) return r.err;
    const key = c.req.param("key");
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value !== "string") return c.json({ error: "value required (string)" }, 400);
    let snap: { map: Record<string, string>; version: number };
    try {
      snap = await appConfigs.set(r.site.name, key, body.value, r.email);
    } catch (e) {
      if (e instanceof ConfigValidationError) return c.json({ error: e.message }, 400); // bad key / too large / looks like a secret
      throw e;
    }
    await ensureConfigToken(r.site, r.email); // lazy-mint the per-app read token on the first set
    await audit({ actor: r.email, action: "config.set", target: r.site.name, targetType: "app", orgId: r.site.orgId, detail: { key } });
    return c.json({ key, value: body.value, version: snap.version }, 200, { ETag: configEtag(snap.version) });
  });

  app.delete("/v1/apps/:name/config/:key", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const r = await resolveAppForSecrets(c);
    if ("err" in r) return r.err;
    const key = c.req.param("key");
    const snap = await appConfigs.rm(r.site.name, key);
    await audit({ actor: r.email, action: "config.rm", target: r.site.name, targetType: "app", orgId: r.site.orgId, detail: { key } });
    return c.json({ key, deleted: true, version: snap.version }, 200, { ETag: configEtag(snap.version) });
  });

  // ---- app lifecycle: restart / stop (true-offline) / start (editor+; operational) ----
  const lifecycle = (action: "restart" | "stop" | "start") => async (c: any) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such app" }, 404);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    if (!can(await actorFor(c.get("identity"), site), "deploy")) return c.json({ error: "not permitted" }, 403);
    const ns = site.namespace;
    if (action === "restart") {
      // A restart while stopped would silently no-op (the pods are pinned to 0) — be explicit.
      if (site.runtimeState === "stopped") return c.json({ error: "app is stopped — `start` it first" }, 409);
      await d.kube.restartApp(ns, name, now().toISOString());
      return c.json({ name, restarted: true });
    }
    if (action === "stop") {
      await d.kube.stopApp(ns, name);
      await d.meta.setRuntimeState(name, "stopped");
      return c.json({ name, state: "stopped" });
    }
    await d.kube.startApp(ns, name);
    await d.meta.setRuntimeState(name, "running");
    return c.json({ name, state: "running" });
  };
  app.post("/v1/apps/:name/restart", lifecycle("restart"));
  app.post("/v1/apps/:name/stop", lifecycle("stop"));
  app.post("/v1/apps/:name/start", lifecycle("start"));

  // ---- create database (managed Postgres via CNPG) ----
  app.post("/v1/databases/:name", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    // Resolve the owning org FIRST (without claiming yet) so the per-database storage cap can reflect
    // the org's item-10 override, not just the flat 1Gi default. For a create this is the target org;
    // for a re-apply it's the existing resource's org.
    let site = await d.meta.getSitePlain(name);
    const isCreate = !site; // first claim → generate the app password; a re-apply must NOT rotate it
    let org: { id: string; namespace: string };
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email);
      if ("err" in orgRes) return orgRes.err;
      org = { id: orgRes.org.id, namespace: orgRes.org.namespace };
    } else {
      org = { id: site.orgId ?? "", namespace: site.namespace };
    }

    // Per-org storage cap override (item 10): validate + sanitize against the resolved cap (falls back
    // to the 1Gi platform ceiling). Enforced on the control plane so raw API/MCP callers are rejected
    // with a clear error; sanitize would otherwise silently clamp.
    const cap = await quotas.resolvedMaxDbStorage(org.id);
    const storageErr = validateDbStorage(body, cap.bytes, cap.label);
    if (storageErr) return c.json({ error: storageErr }, 400);
    // (I3) extensions: validated against the platform allowlist (config). Loud rejection of a disallowed
    // extension up front; effective at CREATE only (postInitApplicationSQL). A re-apply keeps the
    // existing db's already-created extensions — bootstrap.initdb is immutable — so changing them here is
    // a no-op against the running cluster (see the `db ext add` 409 route + docs "requires recreate").
    const extErr = validateDbExtensions(body, d.cfg.dbExtensionAllowlist);
    if (extErr) return c.json({ error: extErr }, 400);
    const dbCfg = sanitizeDatabaseConfig(body, cap.bytes, d.cfg.dbExtensionAllowlist);
    if (!dbCfg) return c.json({ error: "invalid database config" }, 400);
    if (dbCfg.name && dbCfg.name !== name) {
      return c.json({ error: `database name "${dbCfg.name}" does not match target "${name}"` }, 400);
    }

    // Org storage budget (item 10): a NEW database's PVC request must fit the remaining budget (when
    // one is set). Approximate + documented — computed from DB requests + bucket bytes. Rejects at claim
    // time (no name is taken on rejection). Re-applies don't re-check (the storage is already counted).
    if (isCreate) {
      const budgetErr = await checkStorageBudget(org.id, org.namespace, storageToBytes(dbCfg.storage) ?? 0);
      if (budgetErr) return c.json({ error: budgetErr }, 429);
      const claimed = await d.meta.claimSite(name, email, "database", org);
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "database") return c.json({ error: `name "${name}" is a ${site.type}, not a database` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "db:create")) return c.json({ error: `database is owned by ${site.owner}` }, 403);

    // Local (Floci/MinIO): static S3 creds + an explicit endpointURL. Prod: real S3 via
    // IRSA. Fail closed in prod if no IAM role is configured — otherwise we'd provision a
    // DB whose backups silently never work (inheritFromIAMRole with no role bound).
    const local = !!d.cfg.s3Endpoint;
    if (!local && !d.cfg.dbBackupRoleArn) {
      return c.json({ error: "database backups not configured: set DROP_DB_BACKUP_ROLE_ARN (IRSA role)" }, 501);
    }

    const verId = newVersionId(now());
    const ns = site.namespace;
    await applyTenantWithExposed(d.kube, ns); // (+ A2b: keep any edge-tcp allow policies for exposed workloads in this ns)
    // CNPG runs IN-CLUSTER, so its object-store endpoint differs from the API's host-side
    // s3Endpoint: locally Floci is reachable on the pod network via DROP_DB_BACKUP_S3_ENDPOINT,
    // not the host's localhost:4566. When that endpoint is a non-443 store, also open a scoped
    // egress to it (DROP_DB_BACKUP_S3_EGRESS_CIDR). Prod omits both → real S3 on 443 (IRSA).
    const backupEndpoint = d.cfg.dbBackupEndpoint ?? d.cfg.s3Endpoint;
    const storeEgress =
      local && d.cfg.dbBackupEgressCidr && backupEndpoint
        ? { cidr: d.cfg.dbBackupEgressCidr, port: Number(new URL(backupEndpoint).port) || 443 }
        : undefined;
    const manifests = databaseManifests(dbCfg, {
      name,
      namespace: ns,
      destinationPath: `s3://${d.cfg.s3Bucket}/databases/${ns}/${name}`,
      ...(isCreate ? { appPassword: generateDbPassword() } : {}), // only on create — never re-rotate on update
      apiServerCidrs: d.cfg.blockedEgressCidrs, // DB egress re-allows the in-cluster API on these CIDRs only
      ...(local
        ? { s3: { endpointURL: backupEndpoint, accessKeyId: d.cfg.s3KeyId, secretAccessKey: d.cfg.s3Secret }, objectStoreEgress: storeEgress }
        : { iamRoleArn: d.cfg.dbBackupRoleArn }),
    });
    await d.kube.applyDatabase(ns, name, manifests);

    // Persist the DatabaseConfig on the version row (item 10) so the org storage budget can read the
    // requested PVC size back; also the natural home for future db rollback/inspection.
    await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: dbCfg });
    await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId }));
    // Connection reference — NEVER the password. CNPG creates the `<name>-rw` primary
    // Service and a `<name>-app` Secret (user/db "app") in the tenant namespace; the app
    // reads that Secret itself (same namespace).
    return c.json({
      name,
      version: verId,
      engine: dbCfg.engine,
      host: `${name}-rw.${ns}.svc.cluster.local`,
      port: 5432,
      database: "app",
      user: "app",
      credentialsSecret: `${name}-app`,
    });
  });

  // ---- set / rotate the managed DB's `app` password (owner/admin) ----
  // Sensitive: rotating credentials can break other readers, so it is gated at `configure`
  // (owner/admin), like visibility — not the editor-level `db:create`. The new password is
  // returned ONCE (the only time the platform reveals it); apps otherwise read it in-namespace
  // from the `<name>-app` Secret. Existing connections keep working until pods restart.
  app.post("/v1/databases/:name/password", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (site.type !== "database") return c.json({ error: `name "${name}" is a ${site.type}, not a database` }, 409);
    if (!can(await actorFor(c.get("identity"), site), "configure")) return c.json({ error: "owner only" }, 403);

    const body = (await c.req.json().catch(() => ({}))) as {
      password?: unknown;
      setSecret?: { app?: unknown; key?: unknown }; // rotate + store straight into an app secret (never returned)
      show?: unknown; // with setSecret, ALSO return the password
    };

    // Optional: write the rotated password directly into a target app's write-only secret, so the
    // plaintext never returns to the client. Validate the target + authz BEFORE rotating, so a bad
    // target never rotates the DB needlessly.
    let secretTarget: { site: Site; key: string } | null = null;
    if (body.setSecret) {
      const appName = typeof body.setSecret.app === "string" ? body.setSecret.app : "";
      const key = typeof body.setSecret.key === "string" ? body.setSecret.key : "";
      const keyErr = validateSecretKey(key);
      if (keyErr) return c.json({ error: keyErr }, 400);
      const appSite = await d.meta.getSitePlain(appName);
      if (!appSite) return c.json({ error: `no such app: ${appName}` }, 404);
      if (appSite.type !== "app") return c.json({ error: `name "${appName}" is a ${appSite.type}, not an app` }, 409);
      if (!can(await actorFor(c.get("identity"), appSite), "configure")) return c.json({ error: `not permitted to set secrets on ${appName}` }, 403);
      secretTarget = { site: appSite, key };
    }
    const show = body.show === true;

    let password: string;
    if (body.password != null) {
      const err = validateDbPassword(body.password);
      if (err) return c.json({ error: err }, 400);
      password = body.password as string;
    } else {
      password = generateDbPassword();
    }

    if (rotatingPasswords.has(name)) return c.json({ error: "a password rotation is already in progress for this database" }, 409);
    rotatingPasswords.add(name);
    const ns = site.namespace;
    try {
      await d.kube.setDatabasePassword(ns, name, password);
    } catch (e) {
      // The role WAS rotated but the creds Secret didn't sync: the password is now the only live
      // copy, so return it (200 + warning) rather than hiding it behind a 502.
      if (e instanceof PasswordSyncError) return c.json({ name, user: "app", password, warning: e.message });
      return c.json({ error: `password rotation failed: ${(e as Error).message}` }, 502);
    } finally {
      rotatingPasswords.delete(name);
    }
    // Rotation succeeded (the error/partial paths returned above). Never log the password itself.
    await audit({ actor: email, action: "db.password.rotate", target: name, targetType: "database", orgId: site.orgId, detail: secretTarget ? { setSecret: { app: secretTarget.site.name, key: secretTarget.key } } : {} });

    // Store the new password directly as the app's secret (never printed unless --show).
    if (secretTarget) {
      const scope = { owner: secretTarget.site.owner, app: secretTarget.site.name, namespace: secretTarget.site.namespace };
      try {
        await d.secrets.setSecret(scope, secretTarget.key, password);
        const fp = fingerprint(password);
        await d.meta.upsertSecretKey(secretTarget.site.name, secretTarget.key, fp, email);
        await d.secrets.ensureBinding(scope, (await d.meta.listSecretKeys(secretTarget.site.name)).map((k) => k.key));
        return c.json({
          name,
          user: "app",
          secretSet: { app: secretTarget.site.name, key: secretTarget.key, fingerprint: fp },
          note: `secret ${secretTarget.key} set on ${secretTarget.site.name} — start/restart it to apply`,
          ...(show ? { password } : {}), // omitted unless explicitly requested
        });
      } catch (e) {
        // Rotation succeeded but storing the secret failed — return the password so it isn't lost.
        return c.json({ name, user: "app", password, warning: `password rotated but storing it as ${secretTarget.key} on ${secretTarget.site.name} failed: ${(e as Error).message} — set it manually now` });
      }
    }
    return c.json({ name, user: "app", password }); // returned ONCE — store it now
  });

  // (J3) Resolve an APP for an action (exec-ticket). Existence → TYPE (a non-app is a 409 carrying the
  // plan's rationale: a database's SQL surface is `drop db proxy` (A3), and a shell on the CNPG operand
  // pod is an operator action, not a tenant one) → authz. The compute (501) check is left to the caller
  // so a database name still 409s here rather than being masked by a 501.
  const resolveApp = async (c: any, action: Action): Promise<{ site: Site; email: string } | { err: Response }> => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return { err: c.json({ error: "no such app" }, 404) };
    if (site.type !== "app") {
      return { err: c.json({ error: `exec applies to apps only, not a ${site.type} — for a database use \`drop db proxy\` (an authenticated psql tunnel); a shell on the operand pod is an operator action, not a tenant one` }, 409) };
    }
    if (!can(await actorFor(c.get("identity"), site), action)) return { err: c.json({ error: "not permitted" }, 403) };
    return { site, email };
  };

  // ---- managed-database backups + hibernation (Future.md #3; restore deferred to db:migrate) ----
  // Resolve a database workload + authorize the caller for `action` (compute must be enabled).
  const resolveDb = async (c: any, action: Action): Promise<{ site: Site; email: string } | { err: Response }> => {
    if (!d.kube) return { err: c.json({ error: "compute is not enabled on this instance" }, 501) };
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return { err: c.json({ error: "no such database" }, 404) };
    if (site.type !== "database") return { err: c.json({ error: `name "${name}" is a ${site.type}, not a database` }, 409) };
    if (!can(await actorFor(c.get("identity"), site), action)) return { err: c.json({ error: "not permitted" }, 403) };
    return { site, email };
  };

  // List backups + the last successful one (read access — backup metadata carries no data).
  app.get("/v1/databases/:name/backups", async (c) => {
    const r = await resolveDb(c, "read");
    if ("err" in r) return r.err;
    let backups: Awaited<ReturnType<KubeClient["listDatabaseBackups"]>> = [];
    try {
      backups = await d.kube!.listDatabaseBackups(r.site.namespace, r.site.name);
    } catch {
      /* best-effort — never fail the call on a transient cluster error */
    }
    const lastSuccess = backups.find((b) => b.phase === "completed");
    return c.json({ backups, lastSuccessAt: lastSuccess?.stoppedAt ?? lastSuccess?.startedAt ?? null });
  });

  // Trigger an on-demand backup (editor+; operational, like deploy). Returns the Backup object name.
  app.post("/v1/databases/:name/backups", async (c) => {
    const r = await resolveDb(c, "db:create");
    if ("err" in r) return r.err;
    // DNS-1123-safe unique name: <db>-ob-<base36 ms><4 hex>. base36(time) + hex random are both lowercase alnum.
    const backupName = `${r.site.name}-ob-${now().getTime().toString(36)}${randomBytes(2).toString("hex")}`;
    try {
      await d.kube!.triggerDatabaseBackup(r.site.namespace, r.site.name, backupName);
    } catch (e) {
      return c.json({ error: `backup failed to start: ${(e as Error).message}` }, 502);
    }
    await audit({ actor: r.email, action: "db.backup.trigger", target: r.site.name, targetType: "database", orgId: r.site.orgId, detail: { backup: backupName } });
    return c.json({ name: r.site.name, backup: backupName, started: true });
  });

  // Hibernate / wake (editor+; the DB analog of app stop/start — scales the cluster to/from zero).
  const dbHibernation = (action: "hibernate" | "wake") => async (c: any) => {
    const r = await resolveDb(c, "db:create");
    if ("err" in r) return r.err;
    try {
      if (action === "hibernate") await d.kube!.hibernateDatabase(r.site.namespace, r.site.name);
      else await d.kube!.wakeDatabase(r.site.namespace, r.site.name);
    } catch (e) {
      return c.json({ error: `${action} failed: ${(e as Error).message}` }, 502);
    }
    await audit({ actor: r.email, action: `db.${action}`, target: r.site.name, targetType: "database", orgId: r.site.orgId });
    return c.json({ name: r.site.name, hibernated: action === "hibernate" });
  };
  app.post("/v1/databases/:name/hibernate", dbHibernation("hibernate"));
  app.post("/v1/databases/:name/wake", dbHibernation("wake"));

  // ---- connection pooling (CNPG Pooler / PgBouncer, I3) ----
  // Enable → emit a `<db>-pooler-rw` Pooler (one PgBouncer instance fronting the primary); disable →
  // delete it. An app binds through it with `uses: [{ database, via: pooler }]` (PGHOST → the pooler
  // Service). Gated at `configure` (owner/admin) — it's an infra-shape change, like visibility.
  app.post("/v1/databases/:name/pooler", async (c) => {
    const r = await resolveDb(c, "configure");
    if ("err" in r) return r.err;
    const body = (await c.req.json().catch(() => ({}))) as { enable?: unknown; mode?: unknown };
    const enable = body.enable !== false; // default: enable (POST .../pooler {} turns it on)
    const mode: PoolerMode = body.mode === "session" ? "session" : "transaction";
    const ns = r.site.namespace;
    if (enable) {
      try {
        await d.kube!.applyPooler(ns, poolerManifest({ name: r.site.name, namespace: ns, mode }));
      } catch (e) {
        return c.json({ error: `pooler enable failed: ${(e as Error).message}` }, 502);
      }
      await audit({ actor: r.email, action: "db.pooler.enable", target: r.site.name, targetType: "database", orgId: r.site.orgId, detail: { mode } });
      return c.json({ name: r.site.name, pooler: { enabled: true, mode, host: `${poolerName(r.site.name)}.${ns}.svc.cluster.local` } });
    }
    try {
      await d.kube!.deletePooler(ns, r.site.name);
    } catch (e) {
      return c.json({ error: `pooler disable failed: ${(e as Error).message}` }, 502);
    }
    await audit({ actor: r.email, action: "db.pooler.disable", target: r.site.name, targetType: "database", orgId: r.site.orgId, detail: {} });
    return c.json({ name: r.site.name, pooler: { enabled: false } });
  });

  // ---- extensions (I3) — CREATE-time only. Adding to an existing db is a v1 limitation (bootstrap
  // is immutable), so this route is HONEST: it 409s and points at recreate. `db ext ls` reads the
  // stored config off the detail route (out.database.extensions) — no separate GET needed.
  app.post("/v1/databases/:name/extensions", async (c) => {
    const r = await resolveDb(c, "configure");
    if ("err" in r) return r.err;
    return c.json(
      {
        error:
          "adding an extension to an existing database is a v1 limitation — extensions are created at bootstrap only (CNPG's initdb is immutable). Recreate the database with `--ext`, or run the extension SQL via a superuser migration.",
      },
      409,
    );
  });

  // ---- db:proxy authenticated tunnel tickets (A3) ----
  // Mint a short-lived, single-use ticket for the psql tunnel. Gated at `connect` (owner/editor, org
  // owner/admin/member — NOT viewer): opening a raw SQL session is a routine developer action but must
  // be above metadata-only viewers. The ticket is the credential the WebSocket upgrade presents; the
  // upgrade runs OUTSIDE this Hono app (a Node `upgrade` listener in bin/api.ts) so bearer auth can't
  // ride it — the ticket, bound to (user, db) and single-use, is what makes the raw-TCP upgrade safe.
  // NOT audited here: issuance can be speculative (the CLI fetches a fresh ticket per accepted local
  // connection and may never dial). The REDEMPTION — the actual connection — is what's audited
  // (`db.tunnel.open`, in the tunnel handler). The tunnel itself may still 501 at upgrade if this API
  // runs outside the cluster (DROP_TUNNEL_DIRECT unset) — issuing a ticket doesn't promise reachability.
  app.post("/v1/databases/:name/tunnel-ticket", async (c) => {
    const r = await resolveDb(c, "connect");
    if ("err" in r) return r.err;
    const { ticket, expiresAt } = await tickets.issue(r.site.name, r.email);
    return c.json({
      db: r.site.name,
      ticket, // shown once — the CLI uses it immediately for the WS upgrade, then it's spent
      expiresAt,
      wsPath: `/v1/databases/${r.site.name}/tunnel`,
      note: "single-use, 60s TTL — present it as ?ticket=… on a WebSocket upgrade to wsPath (the API dials the DB in-cluster)",
    });
  });

  // ---- SQL console: read-only query API (I4) ----
  // A read-only SQL surface for the DB detail page + `drop db query`. Gated at `query` (owner/editor, org
  // owner/admin/member — NOT viewer: a query reads ALL row data, stricter than metadata-only `read`). The
  // executor enforces read-only at the SESSION level (BEGIN READ ONLY + default_transaction_read_only),
  // NOT by parsing — a write inside a READ ONLY tx errors at the engine, so there is no SQL-grammar
  // allowlist to bypass. Bounded: 5s statement_timeout, 500-row cap, ~1MB serialized-byte cap. EVERY
  // query is AUDITED (`db.query`, with the statement text) — i.e. queries are logged (see the docs). No
  // `--unsafe-write` escalation v1: use `drop db proxy` + a real client for writes. In-cluster ONLY: the
  // executor dials `<db>-rw.<ns>.svc`, reachable only when DROP_TUNNEL_DIRECT (the same reachability signal
  // db:proxy uses) — a local/out-of-cluster API returns an honest 501 instead of hanging.
  const QUERY_ROW_CAP = 500;
  const QUERY_BYTE_CAP = 1_000_000; // ~1MB serialized
  const QUERY_TIMEOUT_MS = 5_000;
  app.post("/v1/databases/:name/query", async (c) => {
    const r = await resolveDb(c, "query"); // compute-off → 501; unknown → 404; non-database → 409; not-permitted → 403
    if ("err" in r) return r.err;
    // In-cluster only. Out-of-cluster the API has no route to `<db>-rw.<ns>.svc`, so 501 honestly (the
    // CLI/console point the user at `drop db proxy` + a local psql) rather than dialing into a black hole.
    if (!d.cfg.tunnelDirect) return c.json({ error: "SQL console requires an in-cluster API (use `drop db proxy` + psql locally)" }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { sql?: unknown };
    if (typeof body.sql !== "string" || body.sql.trim() === "") return c.json({ error: "sql is required (a non-empty SQL string)" }, 400);
    const sql = body.sql;
    let result;
    try {
      result = await runQuery({ namespace: r.site.namespace, database: r.site.name, sql, rowCap: QUERY_ROW_CAP, byteCap: QUERY_BYTE_CAP, statementTimeoutMs: QUERY_TIMEOUT_MS });
    } catch (e) {
      // Audit the ATTEMPT too — the statement text is the security-relevant record, success or not.
      await audit({ actor: r.email, action: "db.query", target: r.site.name, targetType: "database", orgId: r.site.orgId, detail: { sql, ok: false } });
      // A SQL/engine (or connect) failure surfaces the sanitized message (no stack) as a 400.
      return c.json({ error: (e as Error).message }, 400);
    }
    await audit({ actor: r.email, action: "db.query", target: r.site.name, targetType: "database", orgId: r.site.orgId, detail: { sql, ok: true, rowCount: result.rowCount, truncated: result.truncated } });
    return c.json({ columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated, elapsedMs: result.elapsedMs });
  });

  // ---- `drop exec` shell tickets (J3) ----
  // Mint a short-lived, single-use ticket for an interactive shell into a running app pod. Gated at
  // `exec` (owner/editor, org owner/admin/member — NOT viewer). STRICTER FRAMING than logs: a shell can
  // `env` the container, so an app's WRITE-ONLY injected secrets become readable — see the permission
  // description + docs. The command is BOUND INTO THE TICKET here, so the WS upgrade (which runs outside
  // Hono) can't escalate to a different command than the one just authorized. Default `/bin/sh`. NOT
  // audited here (issuance can be speculative); the REDEMPTION — the actual session — is audited
  // (`app.exec`, with the command, in the exec bridge). Apps only: a non-app 409s (resolveApp), and a
  // compute-off instance 501s (checked after the type gate so a database name still gets its 409).
  app.post("/v1/apps/:name/exec-ticket", async (c) => {
    const r = await resolveApp(c, "exec");
    if ("err" in r) return r.err;
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { command?: unknown };
    let command = ["/bin/sh"];
    if (body.command !== undefined) {
      if (!Array.isArray(body.command) || body.command.some((s) => typeof s !== "string")) {
        return c.json({ error: "command must be an array of strings (argv), e.g. [\"/bin/bash\"]" }, 400);
      }
      if (body.command.length === 0) return c.json({ error: "command must not be empty (omit it to default to /bin/sh)" }, 400);
      if (body.command.length > 64) return c.json({ error: "command has too many arguments (max 64)" }, 400);
      command = body.command as string[];
    }
    const { ticket, expiresAt } = await tickets.issue(r.site.name, r.email, { kind: "exec", command });
    return c.json({
      app: r.site.name,
      ticket, // shown once — the CLI uses it immediately for the WS upgrade, then it's spent
      expiresAt,
      command,
      wsPath: `/v1/apps/${r.site.name}/exec`,
      note: "single-use, 60s TTL — present it as ?ticket=… on a WebSocket upgrade to wsPath; the command is bound to this ticket and cannot be changed at upgrade",
    });
  });

  // ---- tenant object storage (buckets, I1) ----
  // Buckets are S3-side: no compute plane required (never gated on d.kube). Create/rotate reveal the
  // access credentials ONCE (RevealOnce posture) and never store them in the metastore; the detail
  // route (GET /v1/sites/:name) surfaces endpoint/bucket/prefix + usage but NEVER the creds.
  const bucketCredsResponse = (name: string, creds: { endpoint: string; bucket: string; prefix: string; keyId: string; secret: string }) => ({
    name,
    endpoint: creds.endpoint,
    bucket: creds.bucket,
    prefix: creds.prefix,
    accessKeyId: creds.keyId,
    secretAccessKey: creds.secret, // returned ONCE — never persisted, never returned again
  });

  // Create (claim + provision). Credentials come back once. Counts toward the org workload cap +
  // storage budget (a fresh bucket is empty, but a create is refused if the org is already over budget).
  app.post("/v1/buckets/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    let site = await d.meta.getSitePlain(name);
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email); // workload cap (override-aware)
      if ("err" in orgRes) return orgRes.err;
      const budgetErr = await checkStorageBudget(orgRes.org.id, orgRes.org.namespace, 0);
      if (budgetErr) return c.json({ error: budgetErr }, 429);
      const claimed = await d.meta.claimSite(name, email, "bucket", { id: orgRes.org.id, namespace: orgRes.org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "bucket") return c.json({ error: `name "${name}" is a ${site.type}, not a bucket` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "db:create")) return c.json({ error: `bucket is owned by ${site.owner}` }, 403); // create-tier (editor+), like db:create

    const creds = await buckets.provision({ name, namespace: site.namespace, org: site.orgId ?? "" });
    await audit({ actor: email, action: "bucket.create", target: name, targetType: "bucket", orgId: site.orgId, detail: { prefix: creds.prefix } });
    return c.json(bucketCredsResponse(name, creds));
  });

  // Rotate credentials (owner/admin — like db password). Returns the new creds once.
  app.post("/v1/buckets/:name/rotate", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such bucket" }, 404);
    if (site.type !== "bucket") return c.json({ error: `name "${name}" is a ${site.type}, not a bucket` }, 409);
    if (!can(await actorFor(c.get("identity"), site), "configure")) return c.json({ error: "owner only" }, 403);
    const creds = await buckets.rotate({ name, namespace: site.namespace, org: site.orgId ?? "" });
    await audit({ actor: email, action: "bucket.rotate", target: name, targetType: "bucket", orgId: site.orgId, detail: {} });
    return c.json(bucketCredsResponse(name, creds));
  });

  // List the caller's buckets (optionally scoped to one org). No creds — just name/owner/org.
  app.get("/v1/buckets", async (c) => {
    const email = c.get("identity").email;
    const orgSlug = c.req.query("org");
    let orgFilterId: string | null = null;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      orgFilterId = org.id;
    }
    const names = await d.meta.listUserSites(email);
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (!s || s.type !== "bucket") continue;
      if (orgFilterId && s.orgId !== orgFilterId) continue;
      out.push({ name: s.name, type: s.type, owner: s.owner, org: await orgOf(s.orgId) });
    }
    return c.json({ buckets: out });
  });

  // ---- managed cache (Valkey, I2) ----
  // A single-replica Valkey, deliberately tiny (no HA/clustering) and EPHEMERAL by default. The
  // requirepass password is generated at create, written into the `<name>-cache` Secret, and REVEALED
  // ONCE inside the returned REDIS_URL — never returned again (apps read it via the `uses: [{cache}]`
  // binding, which reads the Secret back to compose REDIS_URL into the app's write-only secret).
  app.post("/v1/caches/:name", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const memErr = validateCacheMemory(body);
    if (memErr) return c.json({ error: memErr }, 400);
    const cacheCfg = sanitizeCacheConfig(body);
    if (!cacheCfg) return c.json({ error: "invalid cache config" }, 400);
    if (cacheCfg.name && cacheCfg.name !== name) return c.json({ error: `cache name "${cacheCfg.name}" does not match target "${name}"` }, 400);

    // Resolve the owning org first (without claiming) so the storage budget reflects the target org.
    let site = await d.meta.getSitePlain(name);
    const isCreate = !site; // first claim → generate the requirepass; a re-apply must NOT rotate it
    let org: { id: string; namespace: string };
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email); // workload cap (override-aware)
      if ("err" in orgRes) return orgRes.err;
      org = { id: orgRes.org.id, namespace: orgRes.org.namespace };
    } else {
      org = { id: site.orgId ?? "", namespace: site.namespace };
    }

    // Storage budget (item 10): only a PERSISTENT cache's PVC counts. Checked at claim time (no name is
    // taken on rejection). Re-applies don't re-check (already counted).
    if (isCreate) {
      const addBytes = cacheCfg.persistent ? cacheMemoryToBytes(cacheCfg.memory) ?? 0 : 0;
      const budgetErr = await checkStorageBudget(org.id, org.namespace, addBytes);
      if (budgetErr) return c.json({ error: budgetErr }, 429);
      const claimed = await d.meta.claimSite(name, email, "cache", org);
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "cache") return c.json({ error: `name "${name}" is a ${site.type}, not a cache` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "db:create")) return c.json({ error: `cache is owned by ${site.owner}` }, 403); // create-tier (editor+), like db:create

    const verId = newVersionId(now());
    const ns = site.namespace;
    await applyTenantWithExposed(d.kube, ns); // namespace + NetworkPolicy (default-deny; intra-ns allowed) + quota + LimitRange
    // Generate the password ONLY at create; on a re-apply read it back so applyCache doesn't rotate the
    // Secret (and the running Valkey keeps its password). A never-created re-apply (edge case) regenerates.
    const password = isCreate ? generateDbPassword() : (await d.kube.readCachePassword(ns, name)) ?? generateDbPassword();
    const manifests = cacheManifests(cacheCfg, { name, namespace: ns, password });
    await d.kube.applyCache(ns, name, manifests);

    // Persist the CacheConfig on the version row so the storage budget + detail can read memory/persistent.
    await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: cacheCfg });
    await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId }));
    await audit({ actor: email, action: "cache.create", target: name, targetType: "cache", orgId: site.orgId, detail: { memory: cacheCfg.memory, persistent: cacheCfg.persistent } });

    const host = cacheHost(name, ns);
    const url = `redis://:${encodeURIComponent(password)}@${host}:6379`; // REVEALED ONCE — the password is embedded here and never returned again
    return c.json({ name, version: verId, memory: cacheCfg.memory, persistent: cacheCfg.persistent, host, port: 6379, url });
  });

  // List the caller's caches (optionally scoped to one org). No creds — just name/owner/org.
  app.get("/v1/caches", async (c) => {
    const email = c.get("identity").email;
    const orgSlug = c.req.query("org");
    let orgFilterId: string | null = null;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      orgFilterId = org.id;
    }
    const names = await d.meta.listUserSites(email);
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (!s || s.type !== "cache") continue;
      if (orgFilterId && s.orgId !== orgFilterId) continue;
      out.push({ name: s.name, type: s.type, owner: s.owner, org: await orgOf(s.orgId) });
    }
    return c.json({ caches: out });
  });

  // ---- managed auth resource (GoTrue engine, K1) ----
  // A per-app end-user auth pool: a GoTrue engine (Deployment 1/1) whose users live in a bound
  // same-org Postgres, reachable at auth--<name>.<baseDomain> through the normal edge (with the
  // carefully-scoped visibility exemption + rate limit — see src/edge/auth-exempt.ts). JWT is HS256:
  // the shared signing secret is generated at create into the write-only `<name>-auth-keys` Secret and
  // NEVER returned to a client (binding apps read it via the write-only path). Provider client SECRETS
  // are set out-of-band with `drop secrets set <auth> GOTRUE_EXTERNAL_<PROVIDER>_SECRET=…`.
  app.post("/v1/auths/:name", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const authCfg = sanitizeAuthConfig(body);
    if (!authCfg) return c.json({ error: "invalid auth config" }, 400);
    if (authCfg.name && authCfg.name !== name) return c.json({ error: `auth name "${authCfg.name}" does not match target "${name}"` }, 400);

    // Resolve the owning org first (without claiming) so the same-org DB check + workload cap apply.
    let site = await d.meta.getSitePlain(name);
    const isCreate = !site;
    let org: { id: string; namespace: string };
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email); // workload cap (override-aware)
      if ("err" in orgRes) return orgRes.err;
      org = { id: orgRes.org.id, namespace: orgRes.org.namespace };
    } else {
      org = { id: site.orgId ?? "", namespace: site.namespace };
    }

    // An auth resource REQUIRES a same-org database (v1: an EXISTING one, named via `db:`). The
    // `--with-db` sugar is CLI-side composition (it creates a db first, then calls this with `db:`).
    // On a re-apply, `db` is recovered from the stored version (immutable) unless re-supplied identically.
    const dbName = (typeof body.db === "string" && body.db ? body.db : undefined) ?? (isCreate ? undefined : (await currentAuthConfig(site!))?.db);
    if (!dbName) return c.json({ error: "an auth resource requires a database: pass { db: <existing-database-name> } (or use --with-db to create one)" }, 400);
    const dbSite = await d.meta.getSitePlain(dbName);
    if (!dbSite || dbSite.type !== "database") return c.json({ error: `database "${dbName}" does not exist` }, 400);
    if (dbSite.orgId !== org.id) return c.json({ error: `database "${dbName}" belongs to a different organisation and cannot back this auth resource` }, 400);

    if (isCreate) {
      const claimed = await d.meta.claimSite(name, email, "auth", org);
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "auth") return c.json({ error: `name "${name}" is a ${site.type}, not an auth resource` }, 409);
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "db:create")) return c.json({ error: `auth resource is owned by ${site.owner}` }, 403); // create-tier (editor+)

    const ns = site.namespace;
    await applyTenantWithExposed(d.kube, ns);
    // Generate the HS256 JWT secret ONLY at create; a re-apply leaves the existing keys Secret (never
    // silently rotates — `rotate-keys` is the explicit path). A never-created re-apply regenerates.
    const jwtSecret = isCreate ? generateJwtSecret() : (await d.kube.readAuthJwtSecret(ns, name)) == null ? generateJwtSecret() : undefined;
    await provisionAuth({ name, namespace: ns, db: dbName, cfg: authCfg, jwtSecret, publishedBy: email });
    await audit({ actor: email, action: isCreate ? "auth.create" : "auth.update", target: name, targetType: "auth", orgId: site.orgId, detail: { db: dbName, signup: authCfg.signup, providers: Object.keys(authCfg.providers ?? {}) } });
    return c.json({ name, db: dbName, url: authExternalUrl(name, d.cfg.baseDomain), signup: authCfg.signup, jwtAlg: authEngine.jwtAlg, engine: authEngine.id });
  });

  // List the caller's auth resources (optionally scoped to one org). No key material — just name/owner/org.
  app.get("/v1/auths", async (c) => {
    const email = c.get("identity").email;
    const orgSlug = c.req.query("org");
    let orgFilterId: string | null = null;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      orgFilterId = org.id;
    }
    const names = await d.meta.listUserSites(email);
    const out: unknown[] = [];
    for (const n of names) {
      const s = await d.meta.getSitePlain(n);
      if (!s || s.type !== "auth") continue;
      if (orgFilterId && s.orgId !== orgFilterId) continue;
      out.push({ name: s.name, type: s.type, owner: s.owner, org: await orgOf(s.orgId), url: authExternalUrl(s.name, d.cfg.baseDomain) });
    }
    return c.json({ auths: out });
  });

  // Rotate the HS256 JWT signing secret. `configure`-gated (owner/admin — like a DB password rotation),
  // audited. The engine re-signs with the new secret; GoTrue itself verifies only the CURRENT secret, so
  // the grace window is realized for BINDING APPS — a redeploy re-injects the new AUTH_JWT_SECRET, and
  // the previous one is echoed to bound apps as AUTH_JWT_SECRET_PREVIOUS until the next rotate/redeploy.
  app.post("/v1/auths/:name/rotate-keys", async (c) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such auth resource" }, 404);
    if (site.type !== "auth") return c.json({ error: `name "${name}" is a ${site.type}, not an auth resource` }, 409);
    if (!can(await actorFor(c.get("identity"), site), "configure")) return c.json({ error: "owner only" }, 403);
    const stored = await currentAuthConfig(site);
    if (!stored) return c.json({ error: "auth resource has no stored config — re-create it" }, 409);
    const previous = await d.kube.readAuthJwtSecret(site.namespace, name);
    const jwtSecret = generateJwtSecret();
    const { db, ...cfg } = stored;
    await provisionAuth({ name, namespace: site.namespace, db, cfg, jwtSecret, publishedBy: email });
    // Re-inject the new secret (+ the previous, for the grace window) into every app currently bound to
    // this auth resource, so their local JWT verification keeps working across the rotation.
    await rebindAuthConsumers(site, jwtSecret, previous, email);
    await audit({ actor: email, action: "auth.rotate-keys", target: name, targetType: "auth", orgId: site.orgId, detail: { grace: previous != null } });
    return c.json({ name, rotated: true, grace: previous != null });
  });

  // ---- user-admin proxy (K1): list / create-with-temp-password / disable / delete GoTrue users ----
  // `configure`-gated (owner/admin) + audited. The server mints a short-TTL service-role admin JWT
  // (signed with the resource's HS256 secret) and proxies to the engine's admin API IN-CLUSTER — the
  // token never leaves the server, no user CRUD is exposed via MCP (agents don't touch end users, v1).
  const c500 = (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json" } });
  const authAdminCall = async (
    site: Site,
    op: AdminOp,
    arg: string | undefined,
    reqBody: unknown | undefined,
  ): Promise<{ status: number; json: unknown } | { err: Response }> => {
    if (!d.kube) return { err: c500("compute is not enabled on this instance", 501) };
    const secret = await d.kube.readAuthJwtSecret(site.namespace, site.name);
    if (secret == null) return { err: c500(`auth "${site.name}" is not ready yet (no keys secret)`, 409) };
    const token = mintAdminToken(secret);
    const route = authEngine.adminPath(op, arg);
    const baseUrl = `http://${site.name}.${site.namespace}.svc.cluster.local:${authEngine.containerPort}`;
    try {
      const r = await authAdmin({ baseUrl, method: route.method, path: route.path, token, body: reqBody });
      return r;
    } catch (e) {
      return { err: c500(`could not reach the auth engine for ${site.name} (${(e as Error).message}) — is compute in-cluster?`, 502) };
    }
  };

  const resolveAuthForAdmin = async (c: any) => {
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return { err: c.json({ error: "no such auth resource" }, 404) };
    if (site.type !== "auth") return { err: c.json({ error: `name "${name}" is a ${site.type}, not an auth resource` }, 409) };
    if (!can(await actorFor(c.get("identity"), site), "configure")) return { err: c.json({ error: "owner only" }, 403) };
    return { site };
  };

  app.get("/v1/auths/:name/users", async (c) => {
    const r = await resolveAuthForAdmin(c);
    if ("err" in r) return r.err;
    const res = await authAdminCall(r.site, "listUsers", undefined, undefined);
    if ("err" in res) return res.err;
    return c.json(res.json as object, res.status as 200);
  });

  app.post("/v1/auths/:name/users", async (c) => {
    const r = await resolveAuthForAdmin(c);
    if ("err" in r) return r.err;
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!body.email) return c.json({ error: "email is required" }, 400);
    // No-SMTP onboarding: create the user pre-confirmed with a temp password (revealed once to the admin
    // who created them — the console shows it via RevealOnce). Auto-generate one if the caller omitted it.
    const password = body.password || generateDbPassword();
    const res = await authAdminCall(r.site, "createUser", undefined, { email: body.email, password, email_confirm: true });
    if ("err" in res) return res.err;
    await audit({ actor: c.get("identity").email, action: "auth.user.create", target: r.site.name, targetType: "auth", orgId: r.site.orgId, detail: { email: body.email } });
    // Echo the temp password back ONCE (RevealOnce) so the admin can hand it to the user.
    return c.json({ ...(res.json as object), tempPassword: password }, res.status as 200);
  });

  app.delete("/v1/auths/:name/users/:id", async (c) => {
    const r = await resolveAuthForAdmin(c);
    if ("err" in r) return r.err;
    const id = c.req.param("id");
    const res = await authAdminCall(r.site, "deleteUser", id, undefined);
    if ("err" in res) return res.err;
    await audit({ actor: c.get("identity").email, action: "auth.user.delete", target: r.site.name, targetType: "auth", orgId: r.site.orgId, detail: { userId: id } });
    return c.json(res.json as object, res.status as 200);
  });

  // Disable (ban) / enable a user — a PUT update on the admin API. `disable=true` bans (revokes access
  // within the token TTL), `disable=false` re-enables. Audited as auth.user.disable/enable.
  app.post("/v1/auths/:name/users/:id/disable", async (c) => {
    const r = await resolveAuthForAdmin(c);
    if ("err" in r) return r.err;
    const id = c.req.param("id");
    const disable = ((await c.req.json().catch(() => ({}))) as { disable?: boolean }).disable !== false;
    const res = await authAdminCall(r.site, "updateUser", id, { ban_duration: disable ? "876000h" : "none" });
    if ("err" in res) return res.err;
    await audit({ actor: c.get("identity").email, action: disable ? "auth.user.disable" : "auth.user.enable", target: r.site.name, targetType: "auth", orgId: r.site.orgId, detail: { userId: id } });
    return c.json(res.json as object, res.status as 200);
  });

  // ---- rollback ----
  // Static sites flip the version pointer (bytes for every version already exist in blob storage).
  // Apps (H1) re-apply the target version's STORED config as a fresh manifest set — see below.
  // Databases have no analogous stored-config/version-bytes path; "rolling back" would desync
  // metadata from the running CNPG cluster — restore-from-backup is the equivalent there.
  app.post("/v1/sites/:name/rollback", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "rollback")) return c.json({ error: "not permitted" }, 403);
    if (site.type === "database") return c.json({ error: "rollback is for static sites/apps; restore-from-backup a database instead" }, 409);

    const body = (await c.req.json().catch(() => ({}))) as { to?: string };
    let target = body.to ?? "";
    const versions = await d.meta.listVersions(name);
    if (!target) {
      target = versions.find((v) => v.id !== site.currentVersion)?.id ?? "";
      if (!target) return c.json({ error: "no previous version" }, 400);
    } else if (!versions.some((v) => v.id === target)) {
      return c.json({ error: "unknown version" }, 400);
    }

    if (site.type === "site") {
      const targetConfig = versions.find((v) => v.id === target)?.config as SiteConfig | undefined;
      await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: target, config: targetConfig }));
      return c.json({ url: siteUrl(name), version: target });
    }

    // ---- app rollback (H1) ----
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const appCfg = versions.find((v) => v.id === target)?.config as AppConfig | undefined;
    // A version deployed before H1 shipped never recorded its config — nothing to re-apply.
    if (!appCfg) return c.json({ error: `version ${target} predates rollback support (no stored config) — re-deploy instead` }, 409);
    const ns = site.namespace;
    const kube = d.kube;
    const theSite = site;
    const rollbackExposed = !!(await tcp.get(name)); // (A2b) preserve the tcp-service allowance on rollback
    try {
      await locks.withLock(`deploy:${name}`, DEPLOY_LOCK_TTL_MS, async () => {
        const sandbox = !appCfg.trusted;
        const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
        // (H3) app→app `<KEY>_URL` env is a plain container env, NOT persisted to the secret store, so it
        // must be RE-RESOLVED on rollback too (from the stored config's `{app}` uses against the target's
        // CURRENT live scale) — otherwise the rolled-back pods would come back missing their peer URLs.
        const appUrlEnv = await resolveAppUsesEnv(appCfg.uses, ns);
        // Same context construction as deploy (sandbox/imagePullSecret/host); versionId stamps the
        // pod-template annotation so a rollback to a version with the SAME image tag as what's
        // currently running still rolls the pods.
        const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: target, tcpExposed: rollbackExposed, ...(appUrlEnv.length ? { appUrlEnv } : {}) });
        // Rollback re-applies a KNOWN-good, previously-deployed version — the release phase is
        // intentionally SKIPPED here (unlike a fresh deploy): re-running a migration command against
        // a database that has already moved past it (or moved differently since) would be wrong, not
        // merely redundant.
        await kube.applyApp(ns, name, manifests);
        const secretKeys = (await d.meta.listSecretKeys(name)).map((k) => k.key);
        await d.secrets.ensureBinding({ owner: theSite.owner, app: name, namespace: ns }, secretKeys);
        if (theSite.runtimeState === "stopped") await kube.stopApp(ns, name); // stay down across rollback, mirroring deploy
        await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: target }));
      });
    } catch (e) {
      if (e instanceof LockHeldError) return c.json({ error: `a deploy is already in progress for ${name}` }, 409);
      throw e;
    }
    return c.json({ url: siteUrl(name), version: target });
  });

  // ---- get site ----
  app.get("/v1/sites/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    // Resolve the actor ONCE: it gates the read AND yields the capability set the console renders on
    // (M2) — so the client never re-derives permissions from owner/role math.
    const actor = await actorFor(c.get("identity"), site);
    if (!can(actor, "read")) return c.json({ error: "not permitted" }, 403);
    const versions = await d.meta.listVersions(name);
    const out: Record<string, unknown> = {
      name: site.name,
      type: site.type,
      owner: site.owner,
      org: await orgOf(site.orgId),
      collaborators: site.collaborators,
      members: site.members,
      visibility: site.visibility,
      current: site.currentVersion,
      url: siteUrl(name),
      versions,
      capabilities: capabilitiesFor(actor), // (M2) resolved can() verbs for the CURRENT actor on THIS resource
    };
    // Per-type live detail — best-effort: a cluster read failure (compute off / object gone)
    // must never fail the metadata read, so it's wrapped and simply omitted on error.
    if (d.kube && site.type === "app") {
      const ns = site.namespace;
      const a: Record<string, unknown> = { image: null, scale: null, resources: null, status: null };
      try {
        const m = await d.kube.getApp(ns, name);
        const ctr = (m?.deployment as any)?.spec?.template?.spec?.containers?.[0];
        a.image = ctr?.image ?? null;
        a.scale = (m?.httpScaledObject as any)?.spec?.replicas ?? null;
        a.resources = ctr?.resources?.limits ?? null; // { cpu, memory }
      } catch {
        /* leave image/scale null */
      }
      try {
        a.status = await d.kube.getAppStatus(ns, name); // {replicas, ready} | null
      } catch {
        /* leave status null */
      }
      a.runtimeState = site.runtimeState; // "running" | "stopped"
      if (site.runtimeState === "stopped" && a.status) (a.status as Record<string, unknown>).reason = "Stopped";
      out.app = a;
    } else if (d.kube && site.type === "database") {
      const ns = site.namespace;
      // Static connection metadata (derived from name+namespace, no cluster call) is ALWAYS
      // returned; only the live status depends on a cluster read and degrades on its own.
      const dbInfo: Record<string, unknown> = {
        host: `${name}-rw.${ns}.svc.cluster.local`,
        port: 5432,
        database: "app",
        user: "app", // the bootstrap role/owner — username is "app"; password lives in the Secret
        credentialsSecret: `${name}-app`, // the password lives in this Secret; never returned here
        status: null,
      };
      try {
        dbInfo.status = await d.kube.getDatabaseStatus(ns, name); // {phase, ready, instances} | null
      } catch {
        /* leave status null */
      }
      // (I3) extensions: read from the stored current-version DatabaseConfig (create-time list — never
      // a live cluster read). pooler: live existence + mode from the CNPG Pooler, best-effort.
      const dbVer = versions.find((v) => v.id === site.currentVersion)?.config as { extensions?: string[] } | undefined;
      dbInfo.extensions = dbVer?.extensions ?? [];
      try {
        const p = await d.kube.getPooler(ns, name);
        dbInfo.pooler = p ? { enabled: true, mode: p.mode, host: `${poolerName(name)}.${ns}.svc.cluster.local` } : { enabled: false };
      } catch {
        dbInfo.pooler = { enabled: false };
      }
      out.database = dbInfo;
    } else if (site.type === "cache") {
      // (I2) Cache detail: static connection metadata (host/port/memory/persistent from the stored config)
      // + live status. NEVER the password — that's revealed once at create and bound via REDIS_URL.
      const ns = site.namespace;
      const cacheVer = versions.find((v) => v.id === site.currentVersion)?.config as CacheConfig | undefined;
      const ci: Record<string, unknown> = {
        host: cacheHost(name, ns),
        port: 6379,
        memory: cacheVer?.memory ?? "256Mi",
        persistent: cacheVer?.persistent ?? false,
        status: null,
      };
      if (d.kube) {
        try {
          ci.status = await d.kube.getCacheStatus(ns, name); // {replicas, ready, ...} | null
        } catch {
          /* leave status null */
        }
      }
      out.cache = ci;
    } else if (site.type === "auth") {
      // (K1) Auth detail: config surface (providers/signup/redirects/jwt_ttl) + key age + live status.
      // NEVER the JWT secret or any key material. `keyMintedAt` is the current version's createdAt (the
      // secret is (re)minted at create/rotate, both of which bump the version) — no cluster secret read.
      const ns = site.namespace;
      const stored = await currentAuthConfig(site);
      const curVer = versions.find((v) => v.id === site.currentVersion);
      const ai: Record<string, unknown> = {
        url: authExternalUrl(name, d.cfg.baseDomain),
        engine: authEngine.id,
        jwtAlg: authEngine.jwtAlg,
        db: stored?.db ?? null,
        signup: stored?.signup ?? "open",
        providers: Object.keys(stored?.providers ?? {}),
        redirectUrls: stored?.redirect_urls ?? [],
        jwtTtl: stored?.jwt_ttl ?? "1h",
        keyMintedAt: curVer?.createdAt ?? null, // when the JWT secret was last (re)minted — NOT the key itself
        status: null,
      };
      if (d.kube) {
        try {
          ai.status = await d.kube.getAuthStatus(ns, name); // {replicas, ready, ...} | null
        } catch {
          /* leave status null */
        }
      }
      out.auth = ai;
    } else if (site.type === "bucket") {
      // (I1) Bucket detail: endpoint/bucket/prefix + a size sweep. NO credentials — those are revealed
      // once at create/rotate only. Best-effort: an S3 read failure degrades to zeros, never 500s.
      const ctx = { name, namespace: site.namespace, org: site.orgId ?? "" };
      const b: Record<string, unknown> = { endpoint: "", bucket: "", prefix: "", bytes: 0, objects: 0 };
      try {
        const info = await buckets.provision(ctx); // idempotent; we surface only non-secret fields
        b.endpoint = info.endpoint;
        b.bucket = info.bucket;
        b.prefix = info.prefix;
        const u = await buckets.usage(ctx);
        b.bytes = u.bytes;
        b.objects = u.objects;
      } catch {
        /* leave endpoint/bucket/prefix empty + zero usage */
      }
      out.bucket = b;
    } else if (site.type === "site") {
      // (E1) Active site previews (created via publish?preview=). Same shape as the dedicated
      // GET .../previews route (previewsFor). (E2) app previews are read separately below — the app
      // case of this mutually-exclusive type chain is already claimed by the `out.app` block above.
      out.previews = await previewsFor(name);
    }
    // (E2) App previews — a standalone read (the `if (…type === "app")` branch above owns `out.app`, so
    // this can't ride the type chain). The console panel reads `d.previews` for both sites and apps.
    if (site.type === "app") out.previews = await previewsFor(name);
    // (A2b) TCP exposure state — surfaced on apps + databases so the console/CLI can show the connect
    // string. Registry-only (no cluster read): present iff the workload has an expose row.
    if (site.type === "app" || site.type === "database") {
      const ep = await tcp.get(name);
      if (ep) {
        const { connect, sslmode } = connectFor(name, ep);
        out.tcp = { mode: ep.mode, port: ep.port, protocol: ep.protocol, connect, ...(sslmode ? { sslmode } : {}) };
      }
    }
    // (G2b) Uptime summary — last-24h OK % + the most recent synthetic check. Probeable types only
    // (sites/apps/databases); buckets/caches aren't uptime-probed in v1. Best-effort: a metrics read
    // failure must never fail the metadata read, so it degrades to omitted.
    if (site.type === "site" || site.type === "app" || site.type === "database") {
      try {
        const rows = await metrics.uptimeSince(name, new Date(now().getTime() - 24 * 60 * 60_000));
        out.uptime = summarizeUptime(rows, now());
      } catch {
        /* leave uptime unset */
      }
    }
    // Normalized status contract (M0): ONE server-side mapping from the raw signals to the
    // console/CLI enum — the client trusts this field and only falls back to mirroring it
    // when talking to an older API (console/src/lib/status.ts).
    out.status = normalizeStatus({
      type: site.type,
      runtimeState: site.runtimeState,
      appStatus: ((out.app as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["appStatus"],
      dbStatus: ((out.database as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["dbStatus"],
      cacheStatus: ((out.cache as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["cacheStatus"],
      authStatus: ((out.auth as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["authStatus"],
    });
    return c.json(out);
  });

  // ---- edge request metrics (G2): time-bucketed rollup for the detail-page numbers + M4 sparklines ----
  // authz `read`. `?range=1h|24h|7d` → server-side aggregation (raw minutes for 1h, 10-min buckets for
  // 24h, hourly for 7d) so the point count stays bounded. `series` + window `totals` (see aggregateSeries).
  app.get("/v1/sites/:name/metrics", async (c) => {
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "read")) return c.json({ error: "not permitted" }, 403);
    const range = parseRange(c.req.query("range"));
    const since = new Date(now().getTime() - rangeWindowMs(range));
    const rows = await metrics.trafficSeries(name, since);
    return c.json({ range, ...aggregateSeries(rows, range) });
  });

  // ---- uptime strip (G2b): the synthetic-check history + summary, for the console line + M4 strip ----
  app.get("/v1/sites/:name/uptime", async (c) => {
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "read")) return c.json({ error: "not permitted" }, 403);
    // v1 serves a 24h window (M4 consumes wider ranges later); one row per checked minute.
    const nowTs = now();
    const rows = await metrics.uptimeSince(name, new Date(nowTs.getTime() - 24 * 60 * 60_000));
    return c.json({ range: "24h", checks: rows, summary: summarizeUptime(rows, nowTs) });
  });

  // ---- recent workload logs (crash diagnostics; apps + databases) ----
  // G1: `?follow=1` streams the workload's logs live as chunked text/plain instead of a one-shot
  // tail. Multi-pod apps: v1 follows the FIRST READY pod only — no multiplexing across replicas
  // (see KubeClient.getWorkloadLogsStream).
  app.get("/v1/sites/:name/logs", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    // logs (not read): a viewer is metadata-only — pod logs can leak env-injected secrets.
    if (!can(await actorFor(c.get("identity"), site), "logs")) return c.json({ error: "not permitted" }, 403);
    const tail = Math.min(Number(c.req.query("tail") ?? "100") || 100, 1000);
    // ?release=1 resolves the LATEST release Job's pod instead of the app pods (drop logs --release).
    const wantRelease = c.req.query("release") === "1" || c.req.query("release") === "true";
    const wantFollow = c.req.query("follow") === "1" || c.req.query("follow") === "true";
    if (wantFollow && wantRelease) return c.json({ error: "?follow does not support ?release — a release Job runs once and exits" }, 400);

    if (wantFollow) {
      // No pods to follow: static sites have none; without a cluster there's nothing to stream.
      if (!d.kube || site.type === "site") return c.body("", 200, { "content-type": "text/plain; charset=utf-8" });
      // A client disconnect must abort the upstream kube request (no leaked sockets): pass the
      // incoming request's AbortSignal straight through — @hono/node-server aborts it when the
      // response socket closes before the body finishes writing (see its `makeCloseHandler`).
      const stream = await d.kube.getWorkloadLogsStream(site.namespace, name, { tailLines: tail, signal: c.req.raw.signal });
      if (!stream) return c.body("", 200, { "content-type": "text/plain; charset=utf-8" });
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (!d.kube || site.type === "site") return c.json({ logs: "" }); // static sites have no pods
    let logs = "";
    try {
      logs = wantRelease ? await d.kube.getReleaseLogs(site.namespace, name, tail) : await d.kube.getWorkloadLogs(site.namespace, name, tail);
    } catch {
      /* best-effort — never fail the call on a transient cluster error */
    }
    return c.json({ logs });
  });

  // ---- per-process status (drop ps): aggregate the web + worker Deployments for an app ----
  app.get("/v1/apps/:name/processes", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "read")) return c.json({ error: "not permitted" }, 403);
    if (site.type !== "app") return c.json({ error: `${name} is a ${site.type}, not an app` }, 409);
    let processes: Awaited<ReturnType<KubeClient["listAppProcesses"]>> = [];
    if (d.kube) {
      try {
        processes = await d.kube.listAppProcesses(site.namespace, name);
      } catch {
        /* best-effort — a cluster read failure degrades to an empty list, never a 500 */
      }
      // A stopped app is pinned to 0 in the cluster; surface that on the web process like the site GET.
      if (site.runtimeState === "stopped") processes = processes.map((p) => (p.web ? { ...p, reason: "Stopped" } : p));
    }
    return c.json({ name, runtimeState: site.runtimeState, processes });
  });

  // ---- set visibility (owner/admin) ----
  app.post("/v1/sites/:name/visibility", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "configure")) return c.json({ error: "owner only" }, 403);
    // Visibility is an EDGE gate that only the static-site path enforces — the app-dispatch path
    // proxies straight to the interceptor. Reject it on apps/databases so a private/password setting
    // can't be persisted and then silently served openly (fail-open). (Per-app gating is future work.)
    if (site.type !== "site") return c.json({ error: `visibility applies to static sites only, not a ${site.type}` }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { visibility?: string; password?: string };
    const vis = body.visibility as Visibility;
    if (vis !== "public" && vis !== "private" && vis !== "password") {
      return c.json({ error: "visibility must be public|private|password" }, 400);
    }
    if (vis === "password" && !body.password) return c.json({ error: "password required for password visibility" }, 400);
    const hash = vis === "password" ? hashPassword(body.password!) : null;
    await d.meta.setVisibility(name, vis, hash);
    await audit({ actor: email, action: "site.visibility.set", target: name, targetType: site.type, orgId: site.orgId, detail: { visibility: vis } });
    return c.json({ name, visibility: vis });
  });

  // ---- TCP (L4) exposure (A2b): opt-in, default off, audited ----
  // Expose a workload over the L4 plane. `mode:sni` routes by the TLS SNI hostname on a shared port
  // (no port consumed); `mode:port` allocates the lowest free dynamic port (409 on exhaustion). Apps
  // must run scale.min>=1 (a TCP SYN can't wake a scaled-to-zero pod); databases are always-on. On
  // success the API adds the tenant "allow from edge-tcp" NetworkPolicy + (port mode) publishes the
  // port on the edge-tcp Service. Compute off → the registry row is still recorded (the local edge-tcp
  // routes from the DB); provisioning is deferred.
  app.post("/v1/sites/:name/expose", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "expose")) return c.json({ error: "not permitted" }, 403);
    if (site.type !== "app" && site.type !== "database") {
      return c.json({ error: `TCP exposure applies to apps and databases only, not a ${site.type}` }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { mode?: string; protocol?: string };
    const mode = body.mode === "port" ? "port" : body.mode === "sni" ? "sni" : null;
    if (!mode) return c.json({ error: 'mode must be "sni" or "port"' }, 400);
    // Protocol default: databases → postgres; apps → tcp. Accepted set: postgres|redis|tcp.
    const protoRaw = (body.protocol ?? (site.type === "database" ? "postgres" : "tcp")).toLowerCase();
    if (protoRaw !== "postgres" && protoRaw !== "redis" && protoRaw !== "tcp") {
      return c.json({ error: "protocol must be postgres|redis|tcp" }, 400);
    }
    // No-scale-to-zero for TCP (apps only; databases are always-on). Enforced when the app has a stored
    // config; a not-yet-deployed app defers to deploy (which enforces scale.min>=1 for exposed apps).
    if (site.type === "app") {
      const cfg = await currentAppConfig(site);
      if (cfg && (cfg.scale?.min ?? 0) < 1) {
        return c.json({ error: "a TCP-exposed app must run with scale.min >= 1 (a TCP SYN can't wake a scaled-to-zero pod) — redeploy with scale.min: 1, then expose" }, 400);
      }
    }
    let ep: TcpEndpoint;
    try {
      ep = mode === "port"
        ? await tcp.exposePort(name, protoRaw, email, d.cfg.tcpPortFrom, d.cfg.tcpPortTo)
        : await tcp.exposeSni(name, protoRaw, email);
    } catch (e) {
      if (e instanceof PortPoolExhaustedError) return c.json({ error: e.message }, 409);
      throw e;
    }
    let note: string | undefined;
    if (d.kube) {
      await applyTenantWithExposed(d.kube, site.namespace); // adds the allow-from-edge-tcp policy for this workload
      if (mode === "port") {
        const r = await patchEdgeTcpService(d.kube);
        if (!r.patched) note = `port allocated; edge-tcp Service not patched yet (${r.note})`;
      }
    } else {
      note = "provisioning deferred (compute off) — the registry row is recorded and the local edge-tcp routes from the DB";
    }
    await audit({ actor: email, action: "tcp.expose", target: name, targetType: site.type, orgId: site.orgId, detail: { mode, protocol: protoRaw, port: ep.port } });
    const { connect, sslmode } = connectFor(name, ep);
    return c.json({ name, tcp: { mode: ep.mode, protocol: ep.protocol, port: ep.port, connect, ...(sslmode ? { sslmode } : {}) }, ...(note ? { note } : {}) });
  });

  // Unexpose: drop the registry row, prune the tenant allow policy, release any dynamic port. Idempotent.
  app.delete("/v1/sites/:name/expose", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "expose")) return c.json({ error: "not permitted" }, 403);
    const existing = await tcp.get(name);
    if (!existing) return c.json({ name, tcp: null }); // not exposed — idempotent
    await tcp.unexpose(name);
    let note: string | undefined;
    if (d.kube) {
      await applyTenantWithExposed(d.kube, site.namespace); // prunes this workload's allow-from-edge-tcp policy
      if (existing.mode === "port") {
        const r = await patchEdgeTcpService(d.kube);
        if (!r.patched) note = `port released; edge-tcp Service not patched yet (${r.note})`;
      }
    } else {
      note = "compute off — registry row removed";
    }
    await audit({ actor: email, action: "tcp.unexpose", target: name, targetType: site.type, orgId: site.orgId, detail: { mode: existing.mode, port: existing.port } });
    return c.json({ name, tcp: null, ...(note ? { note } : {}) });
  });

  // List your TCP-exposed workloads + their connect strings (org-scoped with ?org=<slug>). Powers
  // `drop expose ls`. Scoped to what the caller can see (their org resources / per-resource grants).
  app.get("/v1/expose", async (c) => {
    const email = c.get("identity").email;
    const orgSlug = c.req.query("org");
    let names: string[];
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      names = (await d.meta.listSitesPage({ orgId: org.id, limit: 1000 })).names;
    } else {
      names = await d.meta.listUserSites(email);
    }
    const exposed = (await tcp.listBySiteNames(names)).map((r) => {
      const { connect, sslmode } = connectFor(r.siteName, r);
      return { name: r.siteName, type: r.type, mode: r.mode, protocol: r.protocol, port: r.port, connect, ...(sslmode ? { sslmode } : {}) };
    });
    return c.json({ exposed });
  });

  // ---- delete ----
  app.delete("/v1/sites/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "delete")) return c.json({ error: "owner only" }, 403);
    // Tear down the running workload BEFORE dropping metadata — otherwise the k8s objects
    // orphan in the tenant namespace. Apps: Deployment/Service/Secret/NetworkPolicy/HSO.
    // Databases: the CNPG Cluster (cascades to pods) + ObjectStore/ScheduledBackup/policy.
    if (site.type === "app" && d.kube) {
      // (I5) A stateful app's PVC is real tenant data — refuse a plain delete without an explicit
      // `?force=1` (409), same posture as the non-empty-bucket gate below. `dropVolume` is threaded to
      // deleteApp ONLY once force is confirmed, so the volume itself is left in place (recoverable) on
      // a first, unforced attempt.
      const appCfg = await currentAppConfig(site);
      const force = c.req.query("force") === "1" || c.req.query("force") === "true";
      if (appCfg?.stateful && !force) {
        return c.json({ error: `"${name}" is stateful — it has a volume at ${appCfg.stateful.mount}; pass ?force=1 to delete it and its data` }, 409);
      }
      await d.kube.deleteApp(site.namespace, name, { dropVolume: !!appCfg?.stateful && force });
      // Remove the app's secret material (the <app>-secret Secret + any SM secrets/ExternalSecret).
      // Log (don't swallow) a teardown failure — otherwise SM secrets orphan with no record.
      await d.secrets
        .destroy({ owner: site.owner, app: name, namespace: site.namespace })
        .catch((e) => console.error(`delete ${name}: secrets.destroy failed (possible orphaned secret material): ${(e as Error).message}`));
      // Remove pushed image material too (no-op for containerd; deletes registry images in prod).
      await d.images
        .destroy({ owner: site.owner, app: name, namespace: site.namespace })
        .catch((e) => console.error(`delete ${name}: images.destroy failed (possible orphaned image): ${(e as Error).message}`));
    } else if (site.type === "database" && d.kube) await d.kube.deleteDatabase(site.namespace, name);
    else if (site.type === "cache" && d.kube) {
      // (I2) Tear down the Valkey Deployment/Service/Secret AND its PVC — a cache delete always wipes
      // data (there is no cache backup). No --force gate: a cache is ephemeral by contract.
      await d.kube.deleteCache(site.namespace, name);
    } else if (site.type === "auth" && d.kube) {
      // (K1) Tear down the GoTrue engine + its write-only JWT keys Secret. The USERS live in the bound
      // database (untouched here — deleting the auth resource never drops the user rows). Also destroy
      // the provider `<name>-secret` (app-secret material), same as an app.
      await d.kube.deleteAuth(site.namespace, name);
      await d.secrets
        .destroy({ owner: site.owner, app: name, namespace: site.namespace })
        .catch((e) => console.error(`delete ${name}: secrets.destroy failed (possible orphaned provider secret): ${(e as Error).message}`));
    } else if (site.type === "bucket") {
      // (I1) A non-empty bucket refuses deletion without ?force=1 (409), so its contents can't be
      // wiped by accident. With force (or when empty), destroy() prunes every object under the prefix.
      const ctx = { name, namespace: site.namespace, org: site.orgId ?? "" };
      const usage = await buckets.usage(ctx).catch(() => ({ bytes: 0, objects: 0 }));
      const force = c.req.query("force") === "1" || c.req.query("force") === "true";
      if (usage.objects > 0 && !force) {
        return c.json({ error: `bucket "${name}" holds ${usage.objects} object(s) — pass ?force=1 to delete it and its contents` }, 409);
      }
      await buckets
        .destroy(ctx)
        .catch((e) => console.error(`delete ${name}: bucket destroy failed (possible orphaned objects): ${(e as Error).message}`));
    }
    await d.blob.deletePrefix(`sites/${name}/files/`).catch(() => {}); // bytes; metadata cascades in DB
    await d.meta.deleteSite(name);
    const deleteAction =
      site.type === "bucket" ? "bucket.delete" : site.type === "cache" ? "cache.delete" : site.type === "auth" ? "auth.delete" : "site.delete";
    await audit({ actor: email, action: deleteAction, target: name, targetType: site.type, orgId: site.orgId, detail: { owner: site.owner } });
    return c.json({ deleted: name });
  });

  // ---- list my sites ----
  app.get("/v1/sites", async (c) => {
    const email = c.get("identity").email;
    // Optional ?org=<slug> filter: show only resources in that org (caller must be a member, or admin).
    const orgSlug = c.req.query("org");
    let orgFilterId: string | null = null;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      orgFilterId = org.id;
    }
    const names = await d.meta.listUserSites(email);
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (!s) continue;
      if (orgFilterId && s.orgId !== orgFilterId) continue;
      // (M2) each item carries the caller's resolved capability set for that resource, so list-level
      // actions (and the detail page that opens from a card) gate on the server's truth.
      const actor = await actorFor(c.get("identity"), s);
      out.push({ name: s.name, type: s.type, owner: s.owner, visibility: s.visibility, url: siteUrl(name), current: s.currentVersion, org: await orgOf(s.orgId), capabilities: capabilitiesFor(actor) });
    }
    return c.json({ sites: out });
  });

  // ---- admin: browse ALL sites (keyset-paginated; platform admins only) ----
  app.get("/v1/admin/sites", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    const cursor = c.req.query("cursor") || undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 1000);
    const prefix = c.req.query("prefix") || undefined;
    const owner = c.req.query("owner")?.toLowerCase() || undefined;
    const typeQ = c.req.query("type");
    const type = typeQ === "site" || typeQ === "app" || typeQ === "database" || typeQ === "bucket" || typeQ === "cache" || typeQ === "auth" ? typeQ : undefined;
    // Optional ?org=<slug> filter — scope the browse to one org (an unknown slug → empty page).
    const orgSlug = c.req.query("org");
    let orgId: string | undefined;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ sites: [] });
      orgId = org.id;
    }
    const { names, nextCursor } = await d.meta.listSitesPage({ cursor, limit, prefix, owner, type, orgId });
    // (M2) Every caller here is a platform admin (gated above), so the capability set is the FULL verb
    // set for every row — compute it ONCE rather than resolving an actor per site.
    const adminCaps = capabilitiesFor({ email, platformRole: "admin", siteRole: null, orgRole: null });
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (s)
        out.push({
          name: s.name,
          type: s.type,
          owner: s.owner,
          org: await orgOf(s.orgId),
          visibility: s.visibility,
          current: s.currentVersion,
          url: siteUrl(name),
          collaborators: s.collaborators.length,
          capabilities: adminCaps,
        });
    }
    return c.json({ sites: out, nextCursor });
  });

  // ---- admin: list ALL orgs (platform admins only) — drives the org picker in the console ----
  app.get("/v1/admin/orgs", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    const orgs = await d.orgs.listAllOrgs();
    return c.json({ orgs: orgs.map((o) => ({ slug: o.slug, name: o.name, kind: o.kind, owner: o.createdBy })) });
  });

  // ---- admin: suspend / reactivate a user (platform admins only) ----
  app.post("/v1/admin/users/:email/status", async (c) => {
    const actor = c.get("identity").email;
    if (!(await isPlatformAdmin(actor))) return c.json({ error: "admin only" }, 403);
    const target = c.req.param("email").toLowerCase();
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (body.status !== "active" && body.status !== "suspended") {
      return c.json({ error: "status must be active|suspended" }, 400);
    }
    if (target === actor) return c.json({ error: "cannot change your own status" }, 400); // no self-lockout
    if (body.status === "suspended" && (await d.users.getUser(target))?.role === "admin") {
      return c.json({ error: "cannot suspend another admin" }, 409); // no admin-on-admin disable (segregation of duties)
    }
    const ok = await d.users.setStatus(target, body.status);
    if (!ok) return c.json({ error: "no such user" }, 404);
    await audit({ actor, action: "user.status.set", target, targetType: "user", detail: { status: body.status } });
    return c.json({ email: target, status: body.status });
  });

  // ---- admin: list users (platform role + status; platform admins only) ----
  app.get("/v1/admin/users", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    return c.json({ users: await d.users.listUsers() });
  });

  // ---- admin: grant/revoke the platform-admin role (platform admins only) ----
  // Replaces editing DROP_ADMINS + rebooting. You can't change your OWN role (no self-lockout) —
  // and because of that, demoting others can never remove the last admin (the acting admin remains).
  app.post("/v1/admin/users/:email/role", async (c) => {
    const actor = c.get("identity").email;
    if (!(await isPlatformAdmin(actor))) return c.json({ error: "admin only" }, 403);
    const target = decodeURIComponent(c.req.param("email")).toLowerCase();
    const body = (await c.req.json().catch(() => ({}))) as { role?: string };
    if (body.role !== "admin" && body.role !== "member") return c.json({ error: "role must be admin|member" }, 400);
    if (target === actor) return c.json({ error: "cannot change your own role" }, 400); // no self-lockout
    if (!(await d.users.getUser(target))) return c.json({ error: "no such user" }, 404);
    await d.users.setRole(target, body.role);
    await audit({ actor, action: "user.role.set", target, targetType: "user", detail: { role: body.role } });
    return c.json({ email: target, role: body.role });
  });

  // ---- admin: read the audit trail (keyset-paginated; platform admins only) ----
  app.get("/v1/admin/audit", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    const cursor = c.req.query("cursor") || undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 1000);
    const actorQ = c.req.query("actor")?.toLowerCase() || undefined;
    const target = c.req.query("target") || undefined;
    const action = c.req.query("action") || undefined;
    return c.json(await d.audit.list({ cursor, limit, actor: actorQ, target, action }));
  });

  // ---- admin: per-org quota overrides (item 10; platform admins only) ----
  // GET returns the raw overrides + the EFFECTIVE values (override folded over the platform default),
  // so the admin console can show both. PUT sets one or more override keys (validated, audited).
  app.get("/v1/admin/orgs/:slug/quotas", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    const org = await d.orgs.getOrgBySlug(c.req.param("slug"));
    if (!org) return c.json({ error: "no such org" }, 404);
    const [overrides, maxWorkloads, maxDbStorage, budget] = await Promise.all([
      quotas.list(org.id),
      quotas.resolvedMaxWorkloads(org.id, d.cfg.maxWorkloadsPerOrg),
      quotas.resolvedMaxDbStorage(org.id),
      quotas.resolvedStorageBudgetBytes(org.id),
    ]);
    return c.json({
      org: { slug: org.slug, name: org.name },
      keys: QUOTA_KEYS,
      overrides,
      effective: { max_workloads: maxWorkloads, max_db_storage: maxDbStorage.label, storage_budget_bytes: budget },
    });
  });

  app.put("/v1/admin/orgs/:slug/quotas", async (c) => {
    const email = c.get("identity").email;
    if (!(await isPlatformAdmin(email))) return c.json({ error: "admin only" }, 403);
    const org = await d.orgs.getOrgBySlug(c.req.param("slug"));
    if (!org) return c.json({ error: "no such org" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { quotas?: Record<string, unknown> };
    const entries = body.quotas && typeof body.quotas === "object" ? Object.entries(body.quotas) : [];
    if (entries.length === 0) return c.json({ error: "body.quotas must be a non-empty object of key→value" }, 400);
    for (const [key, value] of entries) {
      const err = validateQuota(key, value);
      if (err) return c.json({ error: err }, 400);
    }
    for (const [key, value] of entries) {
      await quotas.set(org.id, key, String(value), email);
      await audit({ actor: email, action: "quota.set", target: org.slug, targetType: "org", orgId: org.id, detail: { key, value: String(value) } });
    }
    return c.json({ org: org.slug, set: Object.fromEntries(entries.map(([k, v]) => [k, String(v)])) });
  });

  // ---- collaborators ----
  app.post("/v1/sites/:name/collaborators", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "share")) return c.json({ error: "owner only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    const target = body.email.toLowerCase(); // canonical principal — must match the lowercased identity
    const role = body.role === "viewer" ? "viewer" : "editor";
    await ensureUser(target); // FK
    await d.meta.addMember(name, target, role);
    await audit({ actor: email, action: "site.collaborator.add", target: name, targetType: site.type, orgId: site.orgId, detail: { member: target, role } });
    return c.json({ added: target, role });
  });

  app.delete("/v1/sites/:name/collaborators/:email", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const target = c.req.param("email").toLowerCase(); // canonical principal
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "share")) return c.json({ error: "owner only" }, 403);
    await d.meta.removeMember(name, target);
    await audit({ actor: email, action: "site.collaborator.remove", target: name, targetType: site.type, orgId: site.orgId, detail: { member: target } });
    return c.json({ removed: target });
  });

  // ---- transfer ----
  app.post("/v1/sites/:name/transfer", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(c.get("identity"), site), "transfer")) return c.json({ error: "owner only" }, 403);
    // Databases are STATEFUL and the tenant namespace is owner-derived. A metadata-only
    // owner flip would orphan the running CNPG Cluster + PVCs in the old owner's namespace
    // (unrecoverable — unlike an app you can't just "redeploy" without losing data). Block
    // it; moving a DB across owners requires a real backup/restore migration.
    if (site.type === "database") {
      return c.json({ error: "databases cannot be transferred (stateful); back up and recreate under the new owner" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; toOrg?: string };

    // Re-home into a TEAM org (vs transferring to a user, below). Changes the resource's org — and
    // thus its namespace — so an app's workload + secrets are torn down in the old namespace and the
    // owner redeploys into the new org (mirrors the user-transfer path; DBs are already blocked above).
    // The site_member owner is unchanged: the caller stays owner, and the org grants org-wide access.
    if (body.toOrg) {
      const org = await d.orgs.getOrgBySlug(body.toOrg);
      if (!org) return c.json({ error: `no such org: ${body.toOrg}` }, 404);
      const role = await d.orgs.roleOf(org.id, email);
      const platformRole = (await d.users.getUser(email))?.role ?? "member";
      if (!canCreateInOrg(role, platformRole)) return c.json({ error: `not a member of org ${body.toOrg} with create rights` }, 403);
      if (org.id === site.orgId) return c.json({ error: `${name} is already in org ${body.toOrg}` }, 409);
      await d.meta.setSiteOrg(name, org.id);
      let secretsDropped = false;
      if (site.type === "app" && d.kube) {
        await d.kube.deleteApp(site.namespace, name);
        await d.secrets
          .destroy({ owner: site.owner, app: name, namespace: site.namespace })
          .catch((e) => console.error(`transfer ${name} → org ${body.toOrg}: secrets.destroy failed (orphaned material in ${site.namespace}): ${(e as Error).message}`));
        await d.meta.clearSecretKeys(name);
        secretsDropped = true;
      }
      await audit({ actor: email, action: "site.transfer.org", target: name, targetType: site.type, orgId: org.id, detail: { fromOrg: site.orgId, toOrg: org.slug } });
      return c.json({
        name,
        org: org.slug,
        type: site.type,
        secretsDropped,
        ...(site.type === "app" ? { note: `app workload torn down in the old namespace — redeploy into ${org.slug} (drop deploy …) and re-set its secrets` } : {}),
      });
    }

    if (!body.email) return c.json({ error: "email or --org required" }, 400);
    const newOwner = body.email.toLowerCase(); // canonical principal — must match the lowercased identity
    await ensureUser(newOwner); // FK
    const oldOwner = site.owner;
    await d.meta.transferOwner(name, newOwner);
    // Move the resource into the new owner's (personal) org — otherwise the OLD owner keeps
    // org-owner rights over it (the org grants org-wide access). site.namespace below is still the
    // OLD namespace (captured before this move), so teardown targets the right place.
    const newOwnerOrg = await d.orgs.ensurePersonalOrg(newOwner);
    await d.meta.setSiteOrg(name, newOwnerOrg.id);
    // An app's workload lives in the OLD owner's tenant namespace; the namespace is
    // owner-derived, so a transfer must remove it there. The new owner redeploys to
    // provision it in their own namespace (avoids cross-tenant objects + a dangling Secret).
    // SECRETS are owner-namespace/path-derived too: tear them down (else they'd leak in the old
    // namespace AND the registry would advertise keys whose values now live nowhere the new owner
    // can reach). Transfer DROPS secrets — the new owner re-sets them, then redeploys.
    if (site.type === "app" && d.kube) {
      await d.kube.deleteApp(site.namespace, name);
      await d.secrets.destroy({ owner: oldOwner, app: name, namespace: site.namespace }).catch((e) => console.error(`transfer ${name}: secrets.destroy failed (orphaned secret material in ${oldOwner}'s namespace): ${(e as Error).message}`));
      await d.meta.clearSecretKeys(name); // the new owner re-sets secrets under their namespace
    }
    await audit({ actor: email, action: "site.transfer.owner", target: name, targetType: site.type, orgId: newOwnerOrg.id, detail: { fromOwner: oldOwner, toOwner: newOwner } });
    return c.json({ owner: newOwner, secretsDropped: site.type === "app" });
  });

  // ============================ Stacks (B2): declarative multi-resource ============================
  // The reconciler orchestrates EXISTING per-resource operations (claim / db-create / deploy) — it adds
  // no new resource kind. Resources stay ordinary `sites` rows; the stack is grouping + desired state.
  // Content is CLI-provided: an app's image (built + sent as `resolved`) and a site's bytes (published
  // to the created row) come from the client — the server owns EXISTENCE + CONFIG only.

  // The materialized site name for a resource KEY (mapping override wins, else `<stack>-<key>`).
  const siteNameForKey = (spec: StackSpec, mapping: Record<string, string>, key: string): string =>
    mapping[key] ?? resolveResourceName(spec.name, key, spec.resources[key]!);

  // Claim the site row for a resource if it doesn't exist yet (apps/sites/databases share the name
  // namespace). ensureUser must have run first (owner membership FKs to users).
  const claimResource = async (siteName: string, type: "site" | "app" | "database" | "bucket" | "cache" | "auth", org: Org, email: string): Promise<Site> => {
    let site = await d.meta.getSitePlain(siteName);
    if (!site) {
      const claimed = await d.meta.claimSite(siteName, email, type, { id: org.id, namespace: org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(siteName));
    }
    if (!site) throw new Error(`claim failed for ${siteName}`);
    if (site.type !== type) throw new Error(`resource "${siteName}" is a ${site.type}, not a ${type}`);
    return site;
  };

  const ensureTenant = (ns: string) => applyTenantWithExposed(d.kube!, ns);

  // Create/update a database resource. Composes the SAME building blocks as POST /v1/databases/:name
  // (manifests + apply). Intentional duplication: the route's handler is entangled with request/auth
  // plumbing, so the stacks layer re-composes cnpg.ts rather than re-enter the route (per the plan).
  const applyDbResource = async (res: StackResource, siteName: string, ns: string, isCreate: boolean): Promise<void> => {
    const dbCfg = sanitizeDatabaseConfig({ storage: res.storage, hibernation: res.hibernation })!;
    const local = !!d.cfg.s3Endpoint;
    if (!local && !d.cfg.dbBackupRoleArn) throw new Error("database backups not configured: set DROP_DB_BACKUP_ROLE_ARN (IRSA role)");
    await ensureTenant(ns);
    const backupEndpoint = d.cfg.dbBackupEndpoint ?? d.cfg.s3Endpoint;
    const storeEgress =
      local && d.cfg.dbBackupEgressCidr && backupEndpoint
        ? { cidr: d.cfg.dbBackupEgressCidr, port: Number(new URL(backupEndpoint).port) || 443 }
        : undefined;
    const manifests = databaseManifests(dbCfg, {
      name: siteName,
      namespace: ns,
      destinationPath: `s3://${d.cfg.s3Bucket}/databases/${ns}/${siteName}`,
      ...(isCreate ? { appPassword: generateDbPassword() } : {}), // only on first create — never re-rotate
      apiServerCidrs: d.cfg.blockedEgressCidrs,
      ...(local
        ? { s3: { endpointURL: backupEndpoint, accessKeyId: d.cfg.s3KeyId, secretAccessKey: d.cfg.s3Secret }, objectStoreEgress: storeEgress }
        : { iamRoleArn: d.cfg.dbBackupRoleArn }),
    });
    await d.kube!.applyDatabase(ns, siteName, manifests);
    const verId = newVersionId(now());
    await d.meta.putVersion(siteName, { id: verId, publishedBy: "stack", createdAt: now().toISOString(), fileCount: 0, bytes: 0 });
    await d.meta.updateSite(siteName, (s) => ({ ...s, currentVersion: verId }));
  };

  // (I2) Create/update a cache resource. Composes the SAME building blocks as POST /v1/caches/:name.
  const applyCacheResource = async (res: StackResource, siteName: string, ns: string, isCreate: boolean): Promise<void> => {
    const cacheCfg = sanitizeCacheConfig({ memory: res.memory, persistent: res.persistent })!;
    await ensureTenant(ns);
    // Generate the requirepass only on first create; on a re-apply read it back so it isn't rotated.
    const password = isCreate ? generateDbPassword() : (await d.kube!.readCachePassword(ns, siteName)) ?? generateDbPassword();
    await d.kube!.applyCache(ns, siteName, cacheManifests(cacheCfg, { name: siteName, namespace: ns, password }));
    const verId = newVersionId(now());
    await d.meta.putVersion(siteName, { id: verId, publishedBy: "stack", createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: cacheCfg });
    await d.meta.updateSite(siteName, (s) => ({ ...s, currentVersion: verId }));
  };

  // (K1) Create/update an auth resource. Composes the SAME building blocks as POST /v1/auths/:name via
  // provisionAuth. The bound DB is the auth resource's `db:` KEY resolved to its site name (validated by
  // validateStackEdges as a same-stack database). JWT secret generated only on first create.
  const applyAuthResource = async (spec: StackSpec, mapping: Record<string, string>, res: StackResource, siteName: string, ns: string, isCreate: boolean): Promise<void> => {
    const db = siteNameForKey(spec, mapping, res.db!); // validateStackEdges guarantees res.db exists + is a database
    const cfg = sanitizeAuthConfig({ providers: res.providers, redirect_urls: res.redirect_urls, jwt_ttl: res.jwt_ttl, signup: res.signup, site_url: res.site_url, rbac: res.rbac })!;
    await ensureTenant(ns);
    const jwtSecret = isCreate ? generateJwtSecret() : (await d.kube!.readAuthJwtSecret(ns, siteName)) == null ? generateJwtSecret() : undefined;
    await provisionAuth({ name: siteName, namespace: ns, db, cfg, jwtSecret, publishedBy: "stack" });
  };

  // Create/update an app resource from a resolved image. Composes the SAME building blocks as
  // POST /v1/apps/:name (manifests + apply + secret binding). The release phase is intentionally NOT
  // run in the stack path v1 (migrations stay on `drop deploy`); noted as a deliberate deviation.
  const applyAppResource = async (spec: StackSpec, mapping: Record<string, string>, res: StackResource, site: Site, image: string): Promise<void> => {
    // Resolve `uses` edges: each references a resource KEY in this stack → its materialized site name.
    // DB edges wire the manifest (envFrom); bucket edges (I1) inject S3_* creds via the secret path,
    // labelled by the stack RESOURCE KEY so multiple buckets get distinct `<KEY>_`-prefixed env vars.
    // DB edges carry `via` (I3 pooler) through so the manifest's PGHOST override applies in stacks too.
    const uses = (res.uses ?? [])
      .filter((u) => u.database)
      .map((u) => ({ database: siteNameForKey(spec, mapping, u.database!), ...(u.via ? { via: u.via } : {}) }));
    // (I2) cache edges → mapped `{ cache: <site> }` uses so the app declares the dependency + REDIS_URL binds.
    const cacheUses = (res.uses ?? []).filter((u) => u.cache).map((u) => ({ cache: siteNameForKey(spec, mapping, u.cache!) }));
    // (K1) auth edges → mapped `{ auth: <site> }` uses so the app declares the dependency + AUTH_* bind.
    const authUses = (res.uses ?? []).filter((u) => u.auth).map((u) => ({ auth: siteNameForKey(spec, mapping, u.auth!) }));
    const bucketEntries = (res.uses ?? [])
      .filter((u) => u.bucket)
      .map((u) => ({ bucketName: siteNameForKey(spec, mapping, u.bucket!), envLabel: u.bucket! }));
    const cacheEntries = (res.uses ?? [])
      .filter((u) => u.cache)
      .map((u) => ({ cacheName: siteNameForKey(spec, mapping, u.cache!), envLabel: u.cache! }));
    const authEntries = (res.uses ?? [])
      .filter((u) => u.auth)
      .map((u) => ({ authName: siteNameForKey(spec, mapping, u.auth!), envLabel: u.auth! }));
    const allUses = [...uses, ...cacheUses, ...authUses];
    const appCfg: AppConfig = {
      image,
      services: res.services ?? [{ internalPort: 8080, protocol: "http" }],
      resources: res.resources,
      ...(res.env ? { env: res.env } : {}),
      ...(res.scale ? { scale: res.scale } : {}),
      trusted: res.trusted ?? true,
      ...(allUses.length ? { uses: allUses } : {}),
      ...(res.healthcheck ? { healthcheck: res.healthcheck } : {}),
      ...(res.processes ? { processes: res.processes } : {}),
    };
    const ns = site.namespace;
    await ensureTenant(ns);
    await writeBucketBindings(bucketEntries, site, "stack"); // provision + write S3_* secrets before rollout
    await writeCacheBindings(cacheEntries, site, "stack"); // (I2) read back each cache password + write REDIS_URL before rollout
    await writeAuthBindings(authEntries, site, "stack"); // (K1) read back each auth JWT secret + write AUTH_URL/AUTH_JWT_SECRET before rollout
    const sandbox = !appCfg.trusted;
    const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
    const verId = newVersionId(now()); // minted up front so it can stamp the pod-template annotation (H1)
    // (A2b) A stack resource may already be TCP-exposed (via `drop expose`); preserve the tcp-service
    // allowance. Stack-DRIVEN expose (the spec's `expose:` key, parsed+stored today) lands in a later slice.
    const stackExposed = !!(await tcp.get(site.name));
    // (H3) app→app edges: inject `<KEY>_URL` (KEY = the used resource key) for each `{app}` use. Non-
    // secret plain container env resolved here (all stack resources share `ns`; the target's spec scale
    // floor decides direct-svc vs wake-via-edge). NOT added to `appCfg.uses` — it needs no envFrom/secret
    // wiring, only a container env — so appBinding never sees it; the edge itself lives in the stored spec.
    const appUrlEnv = (res.uses ?? [])
      .filter((u) => u.app)
      .map((u) => {
        const targetSite = siteNameForKey(spec, mapping, u.app!);
        return {
          name: appUseEnvName(u.app!),
          value: appUseUrl({ targetName: targetSite, namespace: ns, publicHost: `${targetSite}.${d.cfg.baseDomain}`, minReplicas: spec.resources[u.app!]?.scale?.min ?? 0 }),
        };
      });
    const manifests = appManifests(appCfg, { name: site.name, namespace: ns, host: `${site.name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: verId, tcpExposed: stackExposed, ...(appUrlEnv.length ? { appUrlEnv } : {}) });
    await d.kube!.applyApp(ns, site.name, manifests);
    const secretKeys = (await d.meta.listSecretKeys(site.name)).map((k) => k.key);
    await d.secrets.ensureBinding({ owner: site.owner, app: site.name, namespace: ns }, secretKeys);
    if (site.runtimeState === "stopped") await d.kube!.stopApp(ns, site.name); // a stopped app stays down across up
    // (H1) Store the resolved AppConfig so a stack-deployed app can also be rolled back.
    await d.meta.putVersion(site.name, { id: verId, publishedBy: "stack", createdAt: now().toISOString(), fileCount: 0, bytes: 0, config: appCfg });
    await d.meta.updateSite(site.name, (s) => ({ ...s, currentVersion: verId }));
  };

  // Tear down a resource's workload + metadata. Mirrors DELETE /v1/sites/:name (deliberate
  // duplication — the route is entangled with request plumbing); best-effort on the material stores.
  const tearDownResource = async (site: Site): Promise<void> => {
    if (site.type === "app" && d.kube) {
      await d.kube.deleteApp(site.namespace, site.name);
      await d.secrets.destroy({ owner: site.owner, app: site.name, namespace: site.namespace }).catch((e) => console.error(`stack delete ${site.name}: secrets.destroy failed: ${(e as Error).message}`));
      await d.images.destroy({ owner: site.owner, app: site.name, namespace: site.namespace }).catch((e) => console.error(`stack delete ${site.name}: images.destroy failed: ${(e as Error).message}`));
    } else if (site.type === "database" && d.kube) {
      await d.kube.deleteDatabase(site.namespace, site.name);
    } else if (site.type === "cache" && d.kube) {
      await d.kube.deleteCache(site.namespace, site.name); // (I2) Deployment/Service/Secret + PVC
    } else if (site.type === "auth" && d.kube) {
      await d.kube.deleteAuth(site.namespace, site.name); // (K1) engine + JWT keys Secret (users stay in the bound DB)
      await d.secrets.destroy({ owner: site.owner, app: site.name, namespace: site.namespace }).catch((e) => console.error(`stack delete ${site.name}: secrets.destroy failed: ${(e as Error).message}`));
    }
    await d.blob.deletePrefix(`sites/${site.name}/files/`).catch(() => {});
    await d.meta.deleteSite(site.name);
  };

  // Resolve the target org for a stack `up` (create-capable): explicit ?org=<slug> or the personal org.
  const resolveStackOrg = async (c: any, email: string): Promise<{ org: Org } | { err: Response }> => {
    const orgSlug = c.req.query("org");
    if (!orgSlug) return { org: await d.orgs.ensurePersonalOrg(email) };
    const found = await d.orgs.getOrgBySlug(String(orgSlug));
    if (!found) return { err: c.json({ error: `no such org: ${orgSlug}` }, 404) };
    const role = await d.orgs.roleOf(found.id, email);
    const platformRole = (await d.users.getUser(email))?.role ?? "member";
    if (!canCreateInOrg(role, platformRole)) return { err: c.json({ error: `not a member of org ${orgSlug} with create rights` }, 403) };
    return { org: found };
  };

  // Find a stack by name across the caller's orgs (or a specified ?org). Enforces membership.
  const findStack = async (c: any, email: string, name: string) => {
    const orgSlug = c.req.query("org");
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(String(orgSlug));
      if (!org) return { err: c.json({ error: `no such org: ${orgSlug}` }, 404) };
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return { err: c.json({ error: `not a member of org ${orgSlug}` }, 403) };
      const stack = await stacks.getByName(org.id, name);
      if (!stack) return { err: c.json({ error: `no such stack: ${name}` }, 404) };
      return { stack, org };
    }
    for (const o of await d.orgs.listUserOrgs(email)) {
      const stack = await stacks.getByName(o.id, name);
      if (stack) return { stack, org: o };
    }
    return { err: c.json({ error: `no such stack: ${name}` }, 404) };
  };

  // The per-resource action a caller must hold to reconcile an EXISTING resource of this kind.
  const actionForKind = (kind: StackResourceKind): Action => (kind === "site" ? "publish" : kind === "app" ? "deploy" : "db:create"); // bucket/cache/auth reconcile is create-tier (db:create)

  // The last-deployed image ref for an app resource's site (its current version's stored AppConfig). Used
  // by template publish to capture a stack's DEPLOYED image (a mutable tag) so the template is instantiable
  // without the original source. Returns undefined for an un-deployed app / a version recorded before H1.
  const deployedImageOf = async (siteName: string): Promise<string | undefined> => {
    const site = await d.meta.getSitePlain(siteName);
    if (!site?.currentVersion) return undefined;
    const versions = await d.meta.listVersions(siteName);
    const cur = versions.find((v) => v.id === site.currentVersion);
    const cfg = cur?.config as { image?: string } | undefined;
    return typeof cfg?.image === "string" ? cfg.image : undefined;
  };

  // Core stack reconcile (plan + execute), shared by POST /v1/stacks/:name/up AND template instantiate
  // (D1). Inputs are already parsed + sanitized; returns a { status, body } the route serializes. The only
  // template-specific knobs are `provenance` (stamped on the stack row at CREATE) and the audit action —
  // everything else is byte-for-byte the original up handler, so a plain `up` and an `instantiate` reconcile
  // through EXACTLY the same code path.
  const reconcileStack = async (
    identity: Identity,
    args: {
      name: string;
      org: Org;
      spec: StackSpec;
      resolved?: Record<string, { image?: string }>;
      prune: boolean;
      dryRun: boolean;
      specVersion?: number;
      provenance?: { fromTemplate: string; fromTemplateVersion: string };
      auditAction?: string;
      auditDetail?: Record<string, unknown>;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const email = identity.email;
    const { name, org, spec, prune, dryRun } = args;
    const resolved = args.resolved;

    if (spec.name !== name) return { status: 400, body: { error: `stack name "${spec.name}" does not match target "${name}"` } };
    const edgeErr = validateStackEdges(spec);
    if (edgeErr) return { status: 400, body: { error: edgeErr } };

    const existing = await stacks.getByName(org.id, name);
    const mapping = existing ? await stacks.mapping(existing.id) : {};

    // Each resource materializes as a valid site name — surface an over-long/invalid name as a clean 400.
    for (const [key] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      const e = validateName(sn);
      if (e) return { status: 400, body: { error: `resource "${key}" resolves to an invalid site name "${sn}": ${e}` } };
    }

    // Optimistic concurrency: a stale editor's spec_version is rejected before any work.
    if (existing && args.specVersion != null && args.specVersion !== existing.specVersion) {
      return { status: 409, body: { error: `stack was modified (spec_version ${existing.specVersion}, you sent ${args.specVersion}) — re-fetch and retry` } };
    }

    // Live existence + cross-org conflict check over every candidate site name (spec + removed keys).
    const candidateNames = new Set<string>();
    for (const key of Object.keys(spec.resources)) candidateNames.add(siteNameForKey(spec, mapping, key));
    for (const sn of Object.values(mapping)) candidateNames.add(sn);
    const live: Record<string, LivePresence> = {};
    for (const sn of candidateNames) {
      const s = await d.meta.getSitePlain(sn);
      if (!s) continue;
      if (s.orgId && s.orgId !== org.id) return { status: 409, body: { error: `resource "${sn}" already exists in another organisation` } };
      live[sn] = { type: s.type };
    }

    // Per-resource authz on resources that ALREADY exist (new resources are covered by org create-rights).
    for (const [key, res] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      if (!live[sn]) continue;
      const s = (await d.meta.getSitePlain(sn))!;
      if (!can(await actorFor(identity, s), actionForKind(res.type))) return { status: 403, body: { error: `not permitted to reconcile "${sn}" (${res.type})` } };
    }

    // Plan (pure). A dependency cycle has no apply order → 400.
    let plan: PlanStep[];
    try {
      plan = planStack({ spec, prevSpec: existing?.spec ?? null, mapping, live, prune });
    } catch (e) {
      if (e instanceof StackCycleError) return { status: 400, body: { error: e.message } };
      throw e;
    }

    // Outputs (for site→app env_from substitution, done CLI-side) + content the CLI still owes.
    const outputs: Record<string, { url: string }> = {};
    const needs: { key: string; kind: "app-image" | "site-publish"; siteName: string }[] = [];
    for (const [key, res] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      if (res.type === "app") {
        outputs[key] = { url: siteUrl(sn) };
        const image = resolved?.[key]?.image ?? res.image;
        if (res.dir && !image) needs.push({ key, kind: "app-image", siteName: sn });
      } else if (res.type === "site") {
        outputs[key] = { url: siteUrl(sn) };
        if (res.dir) needs.push({ key, kind: "site-publish", siteName: sn });
      }
    }

    if (dryRun) {
      return { status: 200, body: { stack: name, org: org.slug, specVersion: existing?.specVersion ?? 0, plan, needs, outputs, dryRun: true } };
    }
    // Compute is only required for steps that actually touch the cluster: databases, apps with a known
    // image (an imageless app step just claims the row — the CLI's image push follows), and pruned
    // app/db deletes. A site-only stack must reconcile fine on a static-only instance.
    const touchesCluster = (s: PlanStep): boolean => {
      if (s.kind === "site" || s.action === "noop") return false;
      if (s.action === "delete") return prune;
      if (s.kind === "database") return true;
      return !!(resolved?.[s.key]?.image ?? spec.resources[s.key]?.image);
    };
    if (!d.kube && plan.some(touchesCluster)) {
      return { status: 501, body: { error: "compute is not enabled on this instance (the stack has app/database changes)" } };
    }

    // Per-org workload cap: a stack `up` can create several resources at once — count them up front.
    const createCount = plan.filter((s) => s.action === "create").length;
    if (d.cfg.maxWorkloadsPerOrg > 0 && (await d.meta.countSitesInOrg(org.id)) + createCount > d.cfg.maxWorkloadsPerOrg) {
      return { status: 429, body: { error: `workload cap reached for this org (${d.cfg.maxWorkloadsPerOrg}) — a stack of ${createCount} new resources would exceed it` } };
    }

    const stackId = existing?.id ?? stacks.stackId(org.id, name);
    let outcome: { applied: PlanStep[]; failure: { step: PlanStep; error: string } | null; newVersion: number };
    try {
      outcome = await locks.withLock(`stack:${stackId}`, STACK_LOCK_TTL_MS, async () => {
        const stackRow =
          existing ??
          (await stacks.create({ name, orgId: org.id, spec, createdBy: email, fromTemplate: args.provenance?.fromTemplate ?? null, fromTemplateVersion: args.provenance?.fromTemplateVersion ?? null }));
        const applied: PlanStep[] = [];
        let failure: { step: PlanStep; error: string } | null = null;
        for (const step of plan) {
          try {
            if (step.action === "noop") {
              applied.push(step);
              continue;
            }
            if (step.action === "delete") {
              if (!prune) continue; // flagged only — not executed
              const s = await d.meta.getSitePlain(step.siteName);
              if (s) await tearDownResource(s);
              await stacks.deleteResource(stackRow.id, step.key);
              applied.push(step);
              continue;
            }
            // create / update
            const res = spec.resources[step.key]!;
            const site = await claimResource(step.siteName, res.type, org, email);
            if (res.type === "database") {
              await applyDbResource(res, step.siteName, site.namespace, step.action === "create");
            } else if (res.type === "cache") {
              await applyCacheResource(res, step.siteName, site.namespace, step.action === "create"); // (I2)
            } else if (res.type === "auth") {
              await applyAuthResource(spec, mapping, res, step.siteName, site.namespace, step.action === "create"); // (K1)
            } else if (res.type === "app") {
              const image = resolved?.[step.key]?.image ?? res.image;
              if (image) await applyAppResource(spec, mapping, res, site, image); // else: row claimed, awaits CLI image (in `needs`)
            } else if (res.type === "bucket") {
              await buckets.provision({ name: step.siteName, namespace: site.namespace, org: org.id }); // (I1) idempotent — ensures the prefix/creds exist for binders
            } // site: the row is claimed; bytes come from the CLI publish (in `needs`)
            await stacks.setResource(stackRow.id, step.key, step.siteName);
            applied.push(step);
          } catch (e) {
            failure = { step, error: (e as Error).message };
            break; // halt on first failure; applied steps persist; a retry converges
          }
        }
        // Persist the new desired spec ONLY on full success — a partial run keeps the prior spec so a
        // retry re-plans correctly (an unapplied "update" isn't mistaken for a noop against the new spec).
        let newVersion = existing ? existing.specVersion : 1;
        if (!failure && existing) {
          newVersion = existing.specVersion + 1;
          await stacks.updateSpec(stackRow.id, spec, newVersion);
        }
        return { applied, failure, newVersion };
      });
    } catch (e) {
      if (e instanceof LockHeldError) return { status: 409, body: { error: `a stack up is already in progress for ${name}` } };
      throw e;
    }

    await audit({
      actor: email,
      action: args.auditAction ?? "stack.up",
      target: name,
      targetType: "stack",
      orgId: org.id,
      detail: { applied: outcome.applied.map((s) => ({ action: s.action, key: s.key })), prune, failed: outcome.failure?.step.key ?? null, ...(args.auditDetail ?? {}) },
    });
    if (outcome.failure) {
      // Keyed on the STACK name (not a step) so a later successful `up` resolves it symmetrically.
      await emitEvent({ orgId: org.id, siteName: name, kind: "stack_halted", severity: "error", title: `stack up halted: ${name}`, detail: { stack: name, step: outcome.failure.step.key, error: outcome.failure.error } });
      return {
        status: 500,
        body: { error: `stack up halted at "${outcome.failure.step.key}": ${outcome.failure.error}`, stack: name, applied: outcome.applied, failedStep: outcome.failure.step, plan, needs, outputs },
      };
    }
    await resolveEvent(name, "stack_halted"); // recovery: a clean reconcile closes any open halt incident
    return { status: 200, body: { stack: name, org: org.slug, specVersion: outcome.newVersion, plan, applied: outcome.applied, needs, outputs } };
  };

  // ---- POST /v1/stacks/:name/up : reconcile the desired spec (plan + execute; ?dry_run=1 = plan) ----
  app.post("/v1/stacks/:name/up", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    await ensureUser(email); // provision the user + personal org (org membership FKs to users)
    const orgRes = await resolveStackOrg(c, email);
    if ("err" in orgRes) return orgRes.err;

    let body: { spec?: unknown; resolved?: Record<string, { image?: string }>; prune?: boolean; spec_version?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const spec = sanitizeStackConfig(body.spec);
    if (!spec) return c.json({ error: "invalid stack spec (needs a name and at least one resource)" }, 400);
    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    const r = await reconcileStack(c.get("identity"), {
      name,
      org: orgRes.org,
      spec,
      resolved: body.resolved,
      prune: body.prune === true,
      dryRun,
      specVersion: body.spec_version,
    });
    return c.json(r.body as Record<string, unknown>, r.status as 200);
  });

  // ---- GET /v1/stacks : org-scoped list (optional ?org=<slug>) ----
  app.get("/v1/stacks", async (c) => {
    const email = c.get("identity").email;
    const orgSlug = c.req.query("org");
    let rows;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      if (!(await d.orgs.roleOf(org.id, email)) && !(await isPlatformAdmin(email))) return c.json({ error: `not a member of org ${orgSlug}` }, 403);
      rows = await stacks.listByOrg(org.id);
    } else {
      const userOrgs = await d.orgs.listUserOrgs(email);
      rows = await stacks.listByOrgs(userOrgs.map((o) => o.id));
    }
    const out = [];
    for (const s of rows) {
      out.push({ name: s.name, org: await orgOf(s.orgId), specVersion: s.specVersion, resources: Object.keys(s.spec.resources).length, fromTemplate: s.fromTemplate, updatedAt: s.updatedAt });
    }
    return c.json({ stacks: out });
  });

  // ---- GET /v1/stacks/:name : spec + resources + per-resource live status ----
  app.get("/v1/stacks/:name", async (c) => {
    const email = c.get("identity").email;
    const found = await findStack(c, email, c.req.param("name"));
    if ("err" in found) return found.err;
    const { stack } = found;
    const mapping = await stacks.mapping(stack.id);
    const resources = [];
    for (const [key, res] of Object.entries(stack.spec.resources)) {
      const siteName = mapping[key] ?? resolveResourceName(stack.spec.name, key, res);
      const s = await d.meta.getSitePlain(siteName);
      let status: unknown = null;
      if (d.kube && s) {
        try {
          if (s.type === "app") status = await d.kube.getAppStatus(s.namespace, siteName);
          else if (s.type === "database") status = await d.kube.getDatabaseStatus(s.namespace, siteName);
        } catch {
          /* best-effort — a cluster read failure degrades to null, never a 500 */
        }
      }
      resources.push({ key, type: res.type, siteName, exists: !!s, url: siteUrl(siteName), runtimeState: s?.runtimeState ?? null, status });
    }
    return c.json({ name: stack.name, org: await orgOf(stack.orgId), specVersion: stack.specVersion, fromTemplate: stack.fromTemplate, fromTemplateVersion: stack.fromTemplateVersion, spec: stack.spec, resources });
  });

  // ---- GET /v1/stacks/:name/graph : nodes (live status) + edges (from spec) [+ ?include_plan overlay] ----
  // The C1 canvas backing. Authz is org membership (same gate as GET /v1/stacks/:name via findStack).
  // Live status is read with ONE aggregated kube list per KIND per NAMESPACE (listNamespace*Statuses),
  // never N per-node calls; compute-off (no kube) degrades every node to the no-status normalizeStatus
  // output. Edges come straight from the stored spec. ?include_plan=1 runs planStack(stored spec as both
  // desired AND prev) so out-of-band drift (e.g. a resource deleted underneath) surfaces as a pending step.
  app.get("/v1/stacks/:name/graph", async (c) => {
    const email = c.get("identity").email;
    const found = await findStack(c, email, c.req.param("name"));
    if ("err" in found) return found.err;
    const { stack } = found;
    const spec = stack.spec;
    const mapping = await stacks.mapping(stack.id);

    // Resolve each resource → its site row (namespace + version + runtimeState + existence).
    const nodesRaw: { key: string; res: StackResource; siteName: string; site: Site | null }[] = [];
    const namespaces = new Set<string>();
    for (const [key, res] of Object.entries(spec.resources)) {
      const siteName = mapping[key] ?? resolveResourceName(spec.name, key, res);
      const site = await d.meta.getSitePlain(siteName);
      if (site) namespaces.add(site.namespace);
      nodesRaw.push({ key, res, siteName, site });
    }

    // ONE aggregated list per kind per namespace (not 2N per-node calls). Each list degrades to {} on a
    // cluster-read failure, so a node whose status is missing falls through to normalizeStatus's null path.
    const appStatuses = new Map<string, Record<string, AppStatus>>();
    const dbStatuses = new Map<string, Record<string, DatabaseStatus>>();
    if (d.kube) {
      for (const ns of namespaces) {
        try {
          appStatuses.set(ns, await d.kube.listNamespaceAppStatuses(ns));
        } catch {
          appStatuses.set(ns, {});
        }
        try {
          dbStatuses.set(ns, await d.kube.listNamespaceDatabaseStatuses(ns));
        } catch {
          dbStatuses.set(ns, {});
        }
      }
    }

    const nodes = nodesRaw.map(({ key, res, siteName, site }) => {
      const ns = site?.namespace;
      const appStatus = res.type === "app" && ns ? (appStatuses.get(ns)?.[siteName] ?? null) : null;
      const dbStatus = res.type === "database" && ns ? (dbStatuses.get(ns)?.[siteName] ?? null) : null;
      const status = normalizeStatus({ type: res.type, runtimeState: site?.runtimeState ?? null, appStatus, dbStatus });
      return { key, siteName, type: res.type, url: siteUrl(siteName), currentVersion: site?.currentVersion ?? null, exists: !!site, status };
    });

    // Edges straight from the stored spec (provider → consumer: db → app via `uses`, app → site via
    // `env_from` — a clean left-to-right flow for the layered layout). Labels say what flows on the wire.
    const edges: { from: string; to: string; kind: "uses" | "env_from"; label: string }[] = [];
    for (const [key, res] of Object.entries(spec.resources)) {
      if (res.type === "app")
        for (const u of res.uses ?? []) {
          const targetKey = u.database ?? u.bucket ?? u.cache ?? u.app; // (H3) app→app is a `uses` edge too
          if (!targetKey) continue;
          const target = spec.resources[targetKey];
          if (!target) continue;
          const tSite = mapping[targetKey] ?? resolveResourceName(spec.name, targetKey, target);
          const label = u.database ? `PG* via ${tSite}-app` : u.bucket ? `S3_* via ${tSite}` : u.cache ? `REDIS_URL via ${tSite}` : `injects ${appUseEnvName(targetKey)}`;
          edges.push({ from: targetKey, to: key, kind: "uses", label });
        }
      if (res.type === "site")
        for (const e of res.env_from ?? []) {
          if (!spec.resources[e.resource]) continue;
          edges.push({ from: e.resource, to: key, kind: "env_from", label: "URL at publish" });
        }
    }

    const out: Record<string, unknown> = { name: stack.name, org: await orgOf(stack.orgId), specVersion: stack.specVersion, nodes, edges };

    // Pending-changes overlay: planStack with the stored spec as BOTH desired and prev → unchanged
    // resources are noop, but anything absent from live state (deleted out-of-band) is create-pending.
    // noop steps are dropped; only actionable steps ride along for the console to badge.
    if (c.req.query("include_plan") === "1" || c.req.query("include_plan") === "true") {
      const live: Record<string, LivePresence> = {};
      for (const { siteName, site } of nodesRaw) if (site) live[siteName] = { type: site.type };
      try {
        out.plan = planStack({ spec, prevSpec: spec, mapping, live }).filter((s) => s.action !== "noop");
      } catch {
        out.plan = []; // a cycle in the stored spec must never fail the read
      }
    }

    return c.json(out);
  });

  // ---- DELETE /v1/stacks/:name?cascade=1 : delete the stack; cascade tears down resources, else orphans ----
  app.delete("/v1/stacks/:name", async (c) => {
    const email = c.get("identity").email;
    const found = await findStack(c, email, c.req.param("name"));
    if ("err" in found) return found.err;
    const { stack, org } = found;
    // Deleting a stack (and, with cascade, its resources) is an owner/admin action, not a member one.
    const role = await d.orgs.roleOf(org.id, email);
    if (!(await isPlatformAdmin(email)) && role !== "owner" && role !== "admin") return c.json({ error: "owner/admin only" }, 403);
    const cascade = c.req.query("cascade") === "1" || c.req.query("cascade") === "true";
    const resources = [];
    for (const { resourceKey, siteName } of await stacks.resources(stack.id)) {
      const s = await d.meta.getSitePlain(siteName);
      if (cascade && s) {
        await tearDownResource(s);
        resources.push({ key: resourceKey, siteName, action: "deleted" });
      } else {
        resources.push({ key: resourceKey, siteName, action: s ? "orphaned" : "gone" });
      }
    }
    await stacks.delete(stack.id); // cascades stack_resources
    await audit({ actor: email, action: "stack.delete", target: stack.name, targetType: "stack", orgId: org.id, detail: { cascade, resources: resources.map((r) => r.siteName) } });
    return c.json({ deleted: stack.name, cascade, resources });
  });

  // ---- Template upstream diff (D2): resolve a template-derived stack's pinned + latest versions into
  // CONCRETE specs (substituting ${stack}/${var.…} + lifting secrets so they compare like the stored
  // stack spec), then run the pure three-way diff. Because the instantiate-time variable values are not
  // persisted (secrets never are), a variable-driven field is substituted with the version's DEFAULT — so
  // an instantiate-time override reads as LOCAL drift (which it accurately is: a divergence from the
  // template default). Returns the resolved pinned + latest concrete specs so the console builds a union
  // canvas without re-resolving.
  const resolveTemplateForStack = async (
    stack: StackRow,
    targetVersion?: string,
  ): Promise<{ err?: { status: number; body: Record<string, unknown> }; pinnedSpec?: StackSpec; latestSpec?: StackSpec; latestVersion?: string; targetVersion?: string }> => {
    if (!stack.fromTemplate || !stack.fromTemplateVersion) {
      return { err: { status: 404, body: { upToDate: true, templateDerived: false, error: "stack is not template-derived (it has no from_template provenance)" } } };
    }
    const tplId = templates.templateId(stack.fromTemplate);
    const tpl = await templates.getBySlug(stack.fromTemplate);
    const pinnedV = tpl ? await templates.getVersion(tplId, stack.fromTemplateVersion) : null;
    const latestV = tpl ? await templates.latestVersion(tplId) : null;
    const wanted = targetVersion ?? latestV?.version;
    const targetV = tpl && wanted ? await templates.getVersion(tplId, wanted) : null;
    if (!tpl || !pinnedV || !latestV || !targetV) {
      return {
        err: {
          status: 404,
          body: { upToDate: true, templateDerived: true, latestVersion: latestV?.version ?? null, error: `template "${stack.fromTemplate}"@${wanted ?? "?"} (or its pinned version ${stack.fromTemplateVersion}) is no longer available to diff against` },
        },
      };
    }
    return {
      pinnedSpec: substituteTemplate(pinnedV.spec, pinnedV.variables, {}, stack.name).spec,
      latestSpec: substituteTemplate(targetV.spec, targetV.variables, {}, stack.name).spec,
      latestVersion: latestV.version,
      targetVersion: targetV.version,
    };
  };

  // ---- GET /v1/stacks/:name/outdated : three-way diff of pinned → latest vs pinned → current ----
  // Authz: stack read (org membership, via findStack). 404 (templateDerived:false) when the stack is not
  // template-derived — a clear "not template-derived" response, not an error the console must special-case.
  app.get("/v1/stacks/:name/outdated", async (c) => {
    const email = c.get("identity").email;
    const found = await findStack(c, email, c.req.param("name"));
    if ("err" in found) return found.err;
    const { stack } = found;
    const r = await resolveTemplateForStack(stack);
    if (r.err) return c.json(r.err.body, r.err.status as 404);
    const diff = diffStack(r.pinnedSpec!, r.latestSpec!, stack.spec);
    const upToDate = stack.fromTemplateVersion === r.latestVersion || !diff.upstreamChanged;
    return c.json({
      upToDate,
      templateDerived: true,
      template: stack.fromTemplate,
      fromVersion: stack.fromTemplateVersion,
      latestVersion: r.latestVersion,
      diff,
      // the resolved concrete specs (console builds a union canvas + the CLI can render values)
      current: stack.spec,
      latest: r.latestSpec,
    });
  });

  // ---- POST /v1/stacks/:name/upgrade {to?, resolutions?} : merge non-conflicting upstream changes,
  // require a per-key resolution for conflicts (409 if any is missing), feed the merged spec to the
  // STANDARD reconcile (?dry_run=1 → plan only), then bump from_template_version. Audited stack.upgrade.
  app.post("/v1/stacks/:name/upgrade", async (c) => {
    const email = c.get("identity").email;
    await ensureUser(email);
    const found = await findStack(c, email, c.req.param("name"));
    if ("err" in found) return found.err;
    const { stack, org } = found;

    let body: { to?: unknown; resolutions?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* an upgrade with no body is fine (take-latest, no conflicts) */
    }
    const to = typeof body.to === "string" && body.to ? body.to : undefined;
    const r = await resolveTemplateForStack(stack, to);
    if (r.err) return c.json(r.err.body, r.err.status as 404);

    // Parse resolutions { key: "take-upstream" | "keep-local" } (ignore junk values).
    const resolutions: Record<string, Resolution> = {};
    if (body.resolutions && typeof body.resolutions === "object" && !Array.isArray(body.resolutions)) {
      for (const [k, v] of Object.entries(body.resolutions as Record<string, unknown>)) {
        if (v === "take-upstream" || v === "keep-local") resolutions[k] = v;
      }
    }

    const diff = diffStack(r.pinnedSpec!, r.latestSpec!, stack.spec);
    const merge = mergeUpgrade(diff, r.latestSpec!, stack.spec, resolutions);
    if (merge.unresolved.length) {
      return c.json(
        { error: `unresolved conflict(s): ${merge.unresolved.join(", ")} — resolve each with "take-upstream" or "keep-local"`, conflicts: merge.unresolved, diff },
        409,
      );
    }

    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    const prune = c.req.query("prune") === "1" || c.req.query("prune") === "true"; // actually tear down upstream-removed resources
    const rec = await reconcileStack(c.get("identity"), {
      name: stack.name,
      org,
      spec: merge.spec,
      prune,
      dryRun,
      specVersion: stack.specVersion,
      auditAction: "stack.upgrade",
      auditDetail: { template: stack.fromTemplate, from: stack.fromTemplateVersion, to: r.targetVersion, autoApplied: merge.autoApplied, resolved: merge.resolved },
    });
    // Re-pin provenance to the target ONLY on a successful execute (not a dry-run, not a failed reconcile).
    if (!dryRun && rec.status === 200) await stacks.setProvenanceVersion(stack.id, r.targetVersion!);
    const respBody = { ...rec.body, template: stack.fromTemplate, fromVersion: stack.fromTemplateVersion, toVersion: r.targetVersion, autoApplied: merge.autoApplied, resolved: merge.resolved };
    return c.json(respBody as Record<string, unknown>, rec.status as 200);
  });

  // ============================ Templates (D1): the golden-path registry ============================
  // A template is a published, sanitized stack spec + variable declarations. Publishing is org-scoped and
  // runs the strip pass (fail-closed on credential-looking values). Instantiating resolves + substitutes
  // and runs the SAME reconcile as a stack `up`, recording provenance + returning the secrets the CLI owes.

  // ---- POST /v1/templates : publish (from a spec OR an existing stack; strip-pass FAIL-CLOSED) ----
  app.post("/v1/templates", async (c) => {
    const email = c.get("identity").email;
    await ensureUser(email);
    let body: { slug?: unknown; name?: unknown; description?: unknown; visibility?: unknown; spec?: unknown; from_stack?: unknown; variables?: unknown; readme?: unknown; allow?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const slug = typeof body.slug === "string" ? body.slug : "";
    const slugErr = validateTemplateSlug(slug);
    if (slugErr) return c.json({ error: slugErr }, 400);

    // Org (create-capable): ?org or personal. Publishing is org-scoped.
    const orgRes = await resolveStackOrg(c, email);
    if ("err" in orgRes) return orgRes.err;
    const org = orgRes.org;

    // A slug is instance-wide unique — if it already exists it must belong to THIS org.
    const existingTpl = await templates.getBySlug(slug);
    if (existingTpl && existingTpl.orgId !== org.id) return c.json({ error: `template slug "${slug}" is already taken by another organisation` }, 409);

    const visibility: TemplateVisibility = body.visibility === "public" ? "public" : "org";
    const variables = sanitizeVariables(body.variables);
    if (typeof variables === "string") return c.json({ error: variables }, 400); // a validation error message
    const allow = Array.isArray(body.allow) ? (body.allow as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const readme = typeof body.readme === "string" ? body.readme.slice(0, 64 * 1024) : null;
    const name = typeof body.name === "string" && body.name.length ? body.name.slice(0, 200) : slug;
    const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null;

    // Build the source spec: a supplied spec, or an export of an existing stack (apps' DEPLOYED images
    // filled in so the template is instantiable without source; each resource's registered secret keys
    // collected for the strip pass).
    let sourceSpec: StackSpec;
    const secretKeyNames: Record<string, string[]> = {};
    if (typeof body.from_stack === "string" && body.from_stack) {
      const found = await findStack(c, email, body.from_stack);
      if ("err" in found) return found.err;
      const { stack } = found;
      const mapping = await stacks.mapping(stack.id);
      const filled = JSON.parse(JSON.stringify(stack.spec)) as StackSpec;
      for (const [key, res] of Object.entries(filled.resources)) {
        const siteName = mapping[key] ?? resolveResourceName(stack.spec.name, key, res);
        secretKeyNames[key] = (await d.meta.listSecretKeys(siteName)).map((k) => k.key);
        if (res.type === "app" && !res.image) {
          const img = await deployedImageOf(siteName);
          if (img) {
            res.image = img; // pin the deployed (mutable-tag) image
            delete res.dir; // template instantiates from the image, not the original build context
          }
        }
      }
      sourceSpec = filled;
    } else {
      // A directly-supplied template spec MAY carry `${var.…}` / `${stack}` placeholders in TYPED fields
      // (e.g. a database `storage: "${var.db_storage}"`). The full sanitizer would clobber those (a
      // placeholder isn't a valid k8s quantity → reset to the default), so we use it only as a STRUCTURE
      // GATE (a valid skeleton must exist), then keep the raw, placeholder-bearing fields for the resource
      // keys it accepted (junk keys are dropped). The concrete spec is fully sanitized at instantiate,
      // AFTER substitution — so no un-sanitized value ever reaches the cluster.
      const skeleton = sanitizeStackConfig(body.spec);
      if (!skeleton || !body.spec || typeof body.spec !== "object") return c.json({ error: "invalid template spec (needs a name and at least one resource), or set from_stack" }, 400);
      const raw = body.spec as StackSpec;
      const kept: Record<string, StackResource> = {};
      for (const key of Object.keys(skeleton.resources)) if (raw.resources?.[key]) kept[key] = raw.resources[key]!;
      sourceSpec = { name: skeleton.name, resources: kept };
    }

    // Strip pass (pure). FAIL CLOSED while credential-looking values remain (unless --allow'd).
    const stripped = stripStackSpec({ spec: sourceSpec, stackName: sourceSpec.name, secretKeyNames, allow });
    if (stripped.flags.length) {
      return c.json(
        {
          error: `refusing to publish: ${stripped.flags.length} credential-looking value(s) still in the spec — variable-ize them as \${var.…} or pass --allow <key> after confirming they are not secrets`,
          flags: stripped.flags,
        },
        400,
      );
    }

    const { template, version } = await templates.publish({ slug, orgId: org.id, name, description, visibility, spec: stripped.spec, variables, readme, createdBy: email });
    await audit({
      actor: email,
      action: "template.publish",
      target: slug,
      targetType: "template",
      orgId: org.id,
      detail: { version: version.version, visibility, fromStack: typeof body.from_stack === "string" ? body.from_stack : null, allow, removed: stripped.removed.map((r) => `${r.resourceKey}.${r.envKey}`) },
    });
    return c.json({ slug, name: template.name, visibility, version: version.version, resources: Object.keys(stripped.spec.resources).length, notes: stripped.notes, removed: stripped.removed });
  });

  // ---- GET /v1/templates : visibility-aware catalog list ----
  app.get("/v1/templates", async (c) => {
    const email = c.get("identity").email;
    const memberOrgIds = (await d.orgs.listUserOrgs(email)).map((o) => o.id);
    const items = await templates.listVisible(memberOrgIds);
    const out = [];
    for (const t of items) out.push({ slug: t.slug, name: t.name, description: t.description, visibility: t.visibility, org: await orgOf(t.orgId), latestVersion: t.latestVersion, resources: t.resources, createdAt: t.createdAt });
    return c.json({ templates: out });
  });

  // ---- GET /v1/templates/:slug (+?version=) : readme + variables + spec ----
  app.get("/v1/templates/:slug", async (c) => {
    const email = c.get("identity").email;
    const slug = c.req.param("slug");
    const version = c.req.query("version") || undefined;
    const resolved = await templates.resolve(slug, version);
    if (!resolved) return c.json({ error: `no such template: ${slug}${version ? `@${version}` : ""}` }, 404);
    const memberOrgIds = (await d.orgs.listUserOrgs(email)).map((o) => o.id);
    if (!templates.canView(resolved.template, memberOrgIds)) return c.json({ error: `no such template: ${slug}` }, 404); // org template → 404 for outsiders
    const all = await templates.versions(resolved.template.id);
    return c.json({
      slug,
      name: resolved.template.name,
      description: resolved.template.description,
      visibility: resolved.template.visibility,
      org: await orgOf(resolved.template.orgId),
      version: resolved.version.version,
      versions: all.map((v) => v.version),
      variables: resolved.version.variables,
      readme: resolved.version.readme,
      spec: resolved.version.spec,
    });
  });

  // ---- POST /v1/templates/:slug/instantiate : resolve+substitute → same up path → provenance + secrets ----
  app.post("/v1/templates/:slug/instantiate", async (c) => {
    const email = c.get("identity").email;
    const slug = c.req.param("slug");
    await ensureUser(email);

    let body: { name?: unknown; org?: unknown; vars?: unknown; version?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : "";
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: `stack name: ${nameErr}` }, 400);

    // Org (create-capable): body.org / ?org, else the caller's personal org.
    const orgSlug = (typeof body.org === "string" && body.org) || c.req.query("org");
    let org: Org;
    if (!orgSlug) {
      org = await d.orgs.ensurePersonalOrg(email);
    } else {
      const found = await d.orgs.getOrgBySlug(String(orgSlug));
      if (!found) return c.json({ error: `no such org: ${orgSlug}` }, 404);
      const role = await d.orgs.roleOf(found.id, email);
      const platformRole = (await d.users.getUser(email))?.role ?? "member";
      if (!canCreateInOrg(role, platformRole)) return c.json({ error: `not a member of org ${orgSlug} with create rights` }, 403);
      org = found;
    }

    // Resolve the template (visibility-gated) + version.
    const version = typeof body.version === "string" ? body.version : undefined;
    const resolvedTpl = await templates.resolve(slug, version);
    if (!resolvedTpl) return c.json({ error: `no such template: ${slug}${version ? `@${version}` : ""}` }, 404);
    const memberOrgIds = (await d.orgs.listUserOrgs(email)).map((o) => o.id);
    if (!templates.canView(resolvedTpl.template, memberOrgIds)) return c.json({ error: `no such template: ${slug}` }, 404);

    // Substitute variables → concrete spec + the secretsToSet plan (secrets never land in the spec).
    const values: Record<string, string> = {};
    if (body.vars && typeof body.vars === "object" && !Array.isArray(body.vars)) {
      for (const [k, v] of Object.entries(body.vars as Record<string, unknown>)) if (typeof v === "string") values[k] = v;
    }
    const sub = substituteTemplate(resolvedTpl.version.spec, resolvedTpl.version.variables, values, name);
    if (sub.missing.length) return c.json({ error: `missing required variable(s): ${sub.missing.join(", ")}`, missing: sub.missing }, 400);
    if (sub.errors.length) return c.json({ error: sub.errors.join("; "), errors: sub.errors }, 400);

    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    // Resolve each lifted secret to its materialized app site name (the CLI just setSecret(app,key,value)).
    const secretsToSet = sub.secretsToSet.map((s) => ({ app: siteNameForKey(sub.spec, {}, s.resourceKey), resourceKey: s.resourceKey, key: s.envKey, value: s.value }));

    const r = await reconcileStack(c.get("identity"), {
      name,
      org,
      spec: sub.spec,
      prune: false,
      dryRun,
      provenance: { fromTemplate: slug, fromTemplateVersion: resolvedTpl.version.version },
      auditAction: "stack.instantiate",
      auditDetail: { template: slug, version: resolvedTpl.version.version, secretKeys: secretsToSet.map((s) => ({ app: s.app, key: s.key })) },
    });
    // Merge the up response with the secrets the CLI still owes. Only key NAMES were audited — the values
    // ride the response (the caller supplied them; this is not a stored-secret read).
    const respBody = { ...r.body, template: slug, version: resolvedTpl.version.version, secretsToSet };
    return c.json(respBody as Record<string, unknown>, r.status as 200);
  });

  return app;
}

/** Parse+clamp `?expire_days` for a preview publish (E1): 1-30, default 7. Never throws or 400s — a
 *  missing/garbage value just falls back to the default rather than failing an otherwise-good
 *  publish over a cosmetic query param. */
function clampExpireDays(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 7;
  return Math.min(30, Math.max(1, Math.trunc(n)));
}

/** Delete file/version records beyond keepVersions (never the current one). */
async function pruneVersions(d: Deps, name: string): Promise<void> {
  try {
    const site = await d.meta.getSitePlain(name);
    if (!site) return;
    const versions = await d.meta.listVersions(name); // newest first
    for (let i = d.cfg.keepVersions; i < versions.length; i++) {
      const v = versions[i]!;
      if (v.id === site.currentVersion) continue;
      await d.blob.deletePrefix(d.meta.filesPrefix(name, v.id)).catch(() => {});
      await d.meta.deleteVersion(name, v.id).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}
