import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { S3Blob } from "../src/blob/s3.ts";
import { makeDb } from "../src/db/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { MetaStore } from "../src/metastore/store.ts";
import { LockStore } from "../src/metastore/lock.ts";
import { StackStore } from "../src/stacks/store.ts";
import { UserStore } from "../src/users/store.ts";
import { OrgStore } from "../src/orgs/store.ts";
import { AuditStore } from "../src/audit/store.ts";
import { ServiceTokenStore } from "../src/tokens/store.ts";
import { TunnelTicketStore } from "../src/tokens/tunnel-tickets.ts";
import { PreviewStore } from "../src/previews/store.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import { UptimePoller } from "../src/metrics/uptime.ts";
import { EventStore } from "../src/events/store.ts";
import { diffCrashLoops, type AppStatusSnapshot } from "../src/events/crashloop.ts";
import { createDbTunnelHandler, writeHttpError } from "../src/api/db-tunnel.ts";
import { createExecHandler } from "../src/api/exec-bridge.ts";
import { DevHeaderVerifier, ChainVerifier } from "../src/auth/oidc.ts";
import { SessionVerifier } from "../src/auth/session-token.ts";
import { TokenVerifier } from "../src/auth/token-verifier.ts";
import { createApp } from "../src/api/server.ts";
import { KubeApiClient } from "../src/kube/client.ts";
import { makeSecretStore } from "../src/secrets/factory.ts";
import { makeImageStore } from "../src/images/factory.ts";
import { makeBucketStore } from "../src/buckets/factory.ts";
import { QuotaStore } from "../src/quotas/store.ts";
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
  if (cfg.oidcClientId && cfg.oidcClientSecret && cfg.sessionSecret) {
    console.log(`SSO login also enabled in dev mode (issuer ${cfg.oidcIssuer}) — OAuth callback: ${cfg.publicUrl}/auth/callback`);
  }
} else {
  // Server-mediated login (J2): the API owns the OIDC client and issues its own session tokens,
  // which it verifies here. Clients only need DROP_API. The issuer is generic (DROP_OIDC_ISSUER);
  // Google is just the default, and DROP_OIDC_CLIENT_ID/SECRET fall back to the legacy DROP_GOOGLE_* vars.
  if (!cfg.oidcClientId || !cfg.oidcClientSecret) {
    throw new Error("SSO login not configured — set DROP_OIDC_CLIENT_ID and DROP_OIDC_CLIENT_SECRET (legacy DROP_GOOGLE_CLIENT_ID/SECRET still work), or set DROP_DEV_AUTH=1");
  }
  if (!cfg.sessionSecret) throw new Error("DROP_SESSION_SECRET is required (signs Drop session tokens)");
  if (cfg.oidcAllowedDomains.length === 0 && !cfg.oidcRequiredGroup) {
    console.warn(`WARNING: DROP_OIDC_ALLOWED_DOMAINS is empty — ANY account from ${cfg.oidcIssuer} can authenticate (set a domain or DROP_OIDC_REQUIRED_GROUP).`);
  }
  console.log(`SSO issuer: ${cfg.oidcIssuer} · OAuth callback: ${cfg.publicUrl}/auth/callback (register this redirect URI in the provider)`);
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
const locks = new LockStore(db);
const stacks = new StackStore(db);
const bucket = makeBucketStore(cfg); // (I1) tenant object storage (floci-prefix locally)
const quotas = new QuotaStore(db); // (item 10) per-org quota overrides
const tokens = new ServiceTokenStore(db); // (J1) service accounts / scoped CI tokens
const previews = new PreviewStore(db); // (E1) preview registry
const tickets = new TunnelTicketStore(db, undefined, cfg.tunnelTicketTtlMs); // (A3) db:proxy tunnel tickets — ONE instance shared by issuance (createApp) + redemption (the upgrade handler below)
const metrics = new MetricsStore(db); // (G2/G2b) edge traffic + uptime rollups — read by the API routes/Prometheus, written by the poller + swept below
const events = new EventStore(db); // (G3) alerting/notifications feed + org webhook delivery — emitted from the API routes AND the sweeps below (crash-loop, preview-expiring); ONE instance shared so all emits hit the same webhook path
// Accept `Authorization: Bearer drop_st_…` alongside human logins. TokenVerifier goes FIRST in the
// chain; it returns null for any non-service token so session/Google verification still runs after it.
verifier = new ChainVerifier([new TokenVerifier(tokens, orgs), verifier]);
const app = createApp({ cfg, meta, blob, db, users, verifier, kube, secrets, images, orgs, audit, locks, stacks, bucket, quotas, tokens, previews, tickets, metrics, events });
const server = serve({ fetch: app.fetch, port: cfg.httpPort }, () => {
  console.log(`drop-api listening on :${cfg.httpPort}`);
});

// WebSocket upgrade dispatcher — a ROUTE TABLE over the two upgrade surfaces the API serves. Attaching
// ANY 'upgrade' listener is also what makes the HTTP server surface upgrades instead of dropping them,
// so the dispatcher REJECTS (404) every path that isn't a known WS endpoint — nothing else on the API
// gains a WS surface.
//
//   • (A3) db:proxy — `/v1/databases/:name/tunnel`: redeem a single-use tunnel ticket, splice the
//     WebSocket to the DB Service in-cluster. Dial posture (honest): DROP_TUNNEL_DIRECT=1 (the normal
//     in-cluster prod deployment) dials `<db>-rw.<ns>.svc:5432` directly; locally the API runs OUTSIDE
//     the cluster with no route, so resolveTarget returns null and the tunnel 501s. CNPG serves TLS at
//     the DB layer, so a TLS client still gets an end-to-end encrypted session; the local hop is loopback.
//   • (J3) drop exec — `/v1/apps/:name/exec`: redeem a single-use EXEC ticket, open the kube exec
//     stream (v4.channel.k8s.io) into the app's first ready pod, and bridge stdin/stdout/stderr/resize.
const auditBestEffort = (e: any) => audit.record(e).catch((err) => console.error(`audit ${e.action}:`, (err as Error).message));
const tunnelHandler = createDbTunnelHandler({
  meta,
  tickets,
  resolveTarget: (site) => (cfg.tunnelDirect ? { host: `${site.name}-rw.${site.namespace}.svc`, port: 5432 } : null),
  audit: auditBestEffort,
  idleTimeoutMs: cfg.tunnelIdleTimeoutMs,
  maxTunnelsPerUser: cfg.maxTunnelsPerUser,
});
const execHandler = createExecHandler({
  meta,
  tickets,
  kube,
  audit: auditBestEffort,
  idleTimeoutMs: cfg.execIdleTimeoutMs,
  maxExecPerUser: cfg.maxExecPerUser,
});
const upgradeRoutes: { re: RegExp; handler: (req: any, socket: any, head: Buffer) => void }[] = [
  { re: /^\/v1\/databases\/[^/]+\/tunnel$/, handler: tunnelHandler },
  { re: /^\/v1\/apps\/[^/]+\/exec$/, handler: execHandler },
];
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const url = (req.url ?? "/") as string;
  const qIdx = url.indexOf("?");
  const path = qIdx === -1 ? url : url.slice(0, qIdx);
  const route = upgradeRoutes.find((r) => r.re.test(path));
  if (!route) return writeHttpError(socket, 404, "not a websocket endpoint");
  route.handler(req, socket, head);
});

// (E1) Expiry sweep — the API's first housekeeping loop (none existed before previews). Deletes
// previews whose expires_at has passed. Bytes are VERSION bytes, already covered by the existing
// publish-time pruneVersions/GC (src/api/server.ts) — this loop only drops the now-stale previews
// POINTER row, nothing else. No audit event: a sweep is a system action, not a user one (consistent
// with pruneVersions, which is likewise unaudited). Errors are logged, never thrown — a transient DB
// hiccup on one tick must not crash the process; the next tick just tries again.
setInterval(() => {
  // (E1/E2) Two-phase for app previews (E2): LIST the expired rows → tear down each app preview's
  // parallel `<name>-p-<label>` manifest set (+ its --with-db CNPG clone) idempotently — the SAME code
  // path as app delete — → then DELETE the rows. Reading before deleting keeps a crash mid-sweep from
  // orphaning a preview workload: the row survives, so the next tick re-tears-down and re-deletes. Both
  // calls share one `sweepNow` so the delete removes EXACTLY the set we tore down (min 1d expiry means no
  // row can newly qualify in the millisecond gap). App-preview BYTES are the shared image (GC'd with the
  // parent) — only the manifests + optional db cost anything; a SITE preview is still just a pointer row.
  const sweepNow = new Date();
  previews
    .listExpired(sweepNow)
    .then(async (expired) => {
      let appN = 0;
      for (const p of expired) {
        const parent = await meta.getSitePlain(p.siteName).catch(() => null); // parent still exists (FK cascade would have removed the row otherwise)
        // (G3) Warn BEFORE reaping a preview that was actively in use — an expiring preview that saw edge
        // traffic in the last hour is worth an `info` heads-up (its host is `<site>--<label>`). Best-effort,
        // dedup'd to one open notice per (org, site). Chosen over the "emit unconditionally for previews >1h"
        // fallback: the traffic cross-check is a cheap LIMIT-1 probe, so we can afford the accurate signal.
        if (parent?.orgId) {
          const host = `${p.siteName}--${p.label}`;
          const used = await meta.hadTrafficSince(host, new Date(sweepNow.getTime() - 60 * 60 * 1000)).catch(() => false);
          if (used) void events.emit({ orgId: parent.orgId, siteName: p.siteName, kind: "preview_expiring", severity: "info", title: `preview expiring with traffic: ${host}`, detail: { label: p.label, host, kind: p.kind } }).catch((e) => console.error("preview_expiring emit:", (e as Error).message));
        }
        if (p.kind !== "app" || !kube) continue; // site previews are pointer-only; app previews need kube to tear down
        const ns = parent?.namespace;
        if (!ns) continue;
        appN++;
        const previewName = `${p.siteName}-p-${p.label}`;
        await kube.deleteApp(ns, previewName).catch((e) => console.error(`preview sweep: deleteApp ${previewName}:`, (e as Error).message));
        if (p.hasDb) await kube.deleteDatabase(ns, `${previewName}-db`).catch((e) => console.error(`preview sweep: deleteDatabase ${previewName}-db:`, (e as Error).message));
      }
      const removed = await previews.deleteExpired(sweepNow);
      if (removed.length) console.log(`preview sweep: removed ${removed.length} expired preview(s)${appN ? ` (${appN} app)` : ""}`);
    })
    .catch((e) => console.error("preview sweep failed:", (e as Error).message));
  // (A3) Reap spent/expired tunnel tickets on the same tick — they're tiny + 60s-lived, but unredeemed
  // ones would otherwise accumulate. Same posture as the preview sweep: best-effort, unaudited, never throws.
  tickets.deleteExpired(new Date()).catch((e) => console.error("tunnel-ticket sweep failed:", (e as Error).message));
  // (G2/G2b/G3) Retention sweep — drop traffic_minutes + uptime_checks + events older than the retention
  // window (default 30d). Same best-effort posture; a range delete over the `minute`/`created_at` index,
  // not a table scan. Events are cheap and valuable for a post-mortem, so they ride the same 30d window;
  // an actively-flapping incident keeps a fresh created_at (dedup bumps it) so only truly-stale rows go.
  const cutoff = new Date(Date.now() - cfg.metricsRetentionDays * 24 * 60 * 60 * 1000);
  metrics
    .sweepTraffic(cutoff)
    .then((n) => n > 0 && console.log(`traffic sweep: removed ${n} row(s) older than ${cfg.metricsRetentionDays}d`))
    .catch((e) => console.error("traffic sweep failed:", (e as Error).message));
  metrics.sweepUptime(cutoff).catch((e) => console.error("uptime sweep failed:", (e as Error).message));
  events.sweep(cutoff).catch((e) => console.error("events sweep failed:", (e as Error).message));
  // (G3) Crash-loop detection — the formalization the plan assigned jointly to G2/G3. RIGHT HERE, as the
  // old G3 marker promised: per active namespace read live app statuses (restart counts + reason), diff
  // the restart counts against the PREVIOUS sweep (bounded state — `crashPrev` is rebuilt from each
  // sweep, so it can't grow unbounded), and emit `crashloop` (error) on a new crash-loop / `resolve` on
  // recovery. Skipped entirely when compute is off (no kube). Best-effort; a cluster read error on one
  // namespace logs + is skipped, never crashing the loop.
  if (kube) void detectCrashLoops(kube).catch((e) => console.error("crash-loop sweep failed:", (e as Error).message));
}, cfg.previewSweepIntervalMs).unref();

// (G3) Previous-sweep restart counts, keyed by app name. Rebuilt each sweep from the CURRENT snapshot
// (diffCrashLoops returns the next map), so it stays bounded to apps seen this tick.
let crashPrev = new Map<string, number>();
async function detectCrashLoops(k: KubeClient): Promise<void> {
  const apps = await meta.listAppsForCrashScan(); // running apps + their namespace/org
  if (apps.length === 0) {
    crashPrev = new Map();
    return;
  }
  // One namespace-wide status read per DISTINCT namespace (bounded), then match the apps we own.
  const byNs = new Map<string, { name: string; orgId: string }[]>();
  for (const a of apps) {
    const list = byNs.get(a.namespace) ?? [];
    list.push({ name: a.name, orgId: a.orgId });
    byNs.set(a.namespace, list);
  }
  const snapshots: AppStatusSnapshot[] = [];
  for (const [ns, list] of byNs) {
    const statuses = await k.listNamespaceAppStatuses(ns).catch((e) => {
      console.error(`crash-loop: listNamespaceAppStatuses ${ns}:`, (e as Error).message);
      return {} as Record<string, { replicas: number; ready: number; restarts: number; reason: string }>;
    });
    for (const { name, orgId } of list) {
      const s = statuses[name];
      if (!s) continue; // no live Deployment (e.g. a cron/schedule app has none) — nothing to diff
      snapshots.push({ name, orgId, restarts: s.restarts, ready: s.ready, replicas: s.replicas, reason: s.reason });
    }
  }
  const { emit, resolve, next } = diffCrashLoops(crashPrev, snapshots);
  crashPrev = next;
  for (const s of emit) {
    await events
      .emit({ orgId: s.orgId, siteName: s.name, kind: "crashloop", severity: "error", title: `crash-loop: ${s.name}`, detail: { restarts: s.restarts, reason: s.reason, ready: s.ready, replicas: s.replicas } })
      .catch((e) => console.error(`crashloop emit ${s.name}:`, (e as Error).message));
  }
  for (const s of resolve) {
    await events.resolve(s.name, "crashloop").catch((e) => console.error(`crashloop resolve ${s.name}:`, (e as Error).message));
  }
}

// (G2b) Synthetic uptime poller — probes each qualifying workload on its own interval (default 60s)
// and records the outcome into `uptime_checks`. HTTP probes (sites/apps) go through the EDGE
// (DROP_EDGE_INTERNAL_URL, Host-routed); database probes TCP-connect the CNPG rw Service, but only when
// the API is in-cluster (DROP_TUNNEL_DIRECT — the same reachability signal db:proxy uses). Best-effort:
// a sweep error logs and the next tick retries; never throws.
if (!cfg.edgeInternalUrl) {
  console.warn("uptime poller: DROP_EDGE_INTERNAL_URL is unset — HTTP uptime probes (sites/apps) are DISABLED (database TCP probes still run when DROP_TUNNEL_DIRECT=1). Set it to the internal edge origin (e.g. http://drop-edge.drop-system.svc) to enable them.");
}
const uptime = new UptimePoller({
  meta,
  metrics,
  baseDomain: cfg.baseDomain,
  edgeInternalUrl: cfg.edgeInternalUrl,
  probeDatabases: cfg.tunnelDirect,
});
setInterval(() => {
  uptime.sweep().catch((e) => console.error("uptime poll failed:", (e as Error).message));
}, cfg.uptimeIntervalMs).unref();
