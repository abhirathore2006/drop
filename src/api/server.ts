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
import type { Verifier } from "../auth/types.ts";
import { authMiddleware, type AuthEnv } from "../auth/middleware.ts";
import { MetaStore } from "../metastore/store.ts";
import type { Site, Visibility } from "../metastore/types.ts";
import { UserStore } from "../users/store.ts";
import { can, canCreateInOrg, canManageOrg, type Action, type Actor } from "../authz/permissions.ts";
import { OrgStore, validateOrgSlug, type Org } from "../orgs/store.ts";
import { validateName } from "../names.ts";
import { extractTarGz } from "../archive.ts";
import { newVersionId } from "../version-id.ts";
import { sanitizeAppConfig, assertHttpOnly, assertProcesses } from "../app-config.ts";
import { sanitizeDatabaseConfig, generateDbPassword, validateDbPassword, validateDbStorage } from "../db-config.ts";
import { appManifests, releaseJobManifest, tenantManifests } from "../kube/manifests.ts";
import { databaseManifests } from "../kube/cnpg.ts";
import { PasswordSyncError, type KubeClient } from "../kube/types.ts";
import { LockStore, LockHeldError } from "../metastore/lock.ts";
import type { SecretStore } from "../secrets/types.ts";
import type { ImageStore } from "../images/types.ts";
import { fingerprint, validateSecretKey } from "../secrets/secrets.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { consoleShell, consoleAsset } from "./dashboard.ts";
import type { AuditStore, AuditEntry } from "../audit/store.ts";

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
  locks?: LockStore; // lease-based advisory locks (serialize deploy/release per app); defaults over `db`
  now?: () => Date;
}

// Serialize a deploy's release-Job + rollout per app so two deploys can't interleave migrations. TTL
// bounds a crashed holder; it must exceed the longest release timeout (15m cap) plus rollout slack.
const DEPLOY_LOCK_TTL_MS = 20 * 60 * 1000;

export function createApp(d: Deps): Hono<AuthEnv> {
  const now = d.now ?? (() => new Date());
  const locks = d.locks ?? new LockStore(d.db); // serialize deploy/release per app

  const siteUrl = (name: string) => `https://${name}.${d.cfg.baseDomain}`;
  const app = new Hono<AuthEnv>();
  // In-flight DB password rotations, keyed by name. Serializes per database so two concurrent
  // rotations can't stomp the shared Job/Secret and diverge the role from the creds Secret.
  // Process-local: covers the double-submit / two-admin case on a single API instance (the common
  // one); a multi-replica deployment would want a distributed lock — noted in Future.md.
  const rotatingPasswords = new Set<string>();

  app.get("/healthz", (c) => c.text("ok"));

  // Public server-mediated login routes (/auth/*) — clients only need DROP_API.
  registerAuthRoutes(app, d.cfg, d.db, d.users);

  // Dashboard (public page; its JS calls /v1/* with the session cookie).
  // The console SPA shell. Served at the root AND at its client-side routes so deep links and
  // browser refresh load the same shell (the React app reads location and renders the route).
  const shell = () => consoleShell(d.cfg);
  app.get("/", shell);
  app.get("/admin", shell);
  app.get("/app/:name", shell);
  app.get("/database/:name", shell);
  app.get("/site/:name", shell);

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

  // First touch provisions the user AND their personal org (idempotent), so resources always have an
  // org to belong to and single-user flows keep working with no explicit org.
  const ensureUser = async (email: string) => {
    await d.users.upsertOnLogin(email, null);
    await d.orgs.ensurePersonalOrg(email);
  };

  async function actorFor(email: string, site: Site | null): Promise<Actor> {
    const u = await d.users.getUser(email);
    const siteRole = site ? (site.members.find((m) => m.email === email)?.role ?? null) : null;
    const orgRole = await d.orgs.roleOf(site?.orgId ?? null, email); // org-wide role on the resource's org
    return { email, platformRole: u?.role ?? "member", siteRole, orgRole };
  }

  // Resolve the target org for a CREATE (explicit ?org=<slug> or the caller's personal org) +
  // authorize it. Uses ONLY the query param — never reads the body (publish streams a tarball).
  const resolveCreateOrg = async (c: any, email: string): Promise<{ org: Org } | { err: Response }> => {
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
    // Per-org workload cap (DROP_MAX_WORKLOADS_PER_ORG; 0 = unlimited). Only the CREATE path passes
    // through here — re-deploys of an existing workload don't claim a new name, so they're never capped.
    const cap = d.cfg.maxWorkloadsPerOrg;
    if (cap > 0 && (await d.meta.countSitesInOrg(org.id)) >= cap) {
      return { err: c.json({ error: `workload cap reached for this org (${cap}) — delete one or ask an admin to raise the limit` }, 429) };
    }
    return { org };
  };
  const isPlatformAdmin = async (email: string) => (await d.users.getUser(email))?.role === "admin";
  // Append an audit event WITHOUT ever failing the action it records: a broken audit write must
  // not 500 a delete/transfer/etc. Awaited (not fire-and-forget) so the trail is ordered + the
  // record is durable before we respond — the only swallowed outcome is the write itself failing.
  const audit = (e: AuditEntry) => d.audit.record(e).catch((err) => console.error(`audit ${e.action} (${e.target ?? "-"}):`, (err as Error).message));
  // Resolve a resource's owning org to a display shape ({slug,name,kind}) for the console/CLI, or null.
  const orgOf = async (orgId: string | null) => {
    if (!orgId) return null;
    const o = await d.orgs.getOrg(orgId);
    return o ? { slug: o.slug, name: o.name, kind: o.kind } : null;
  };

  app.get("/v1/me", async (c) => {
    const email = c.get("identity").email;
    await ensureUser(email); // ensure the personal org exists on first console/CLI touch
    return c.json({ email, admin: await isPlatformAdmin(email) });
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
    return c.json({
      org: { slug: r.org.slug, name: r.org.name, kind: r.org.kind },
      workloads,
      cap: d.cfg.maxWorkloadsPerOrg, // 0 = unlimited
      quota, // { hard, used } | null
    });
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

  // ---- publish ----
  app.post("/v1/sites/:name/versions", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

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
    const actor = await actorFor(email, site);
    if (!can(actor, "publish")) return c.json({ error: `site is owned by ${site.owner}` }, 403);

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
    try {
      assertHttpOnly(appCfg); // v1: one HTTP service (443-only)
      assertProcesses(appCfg); // at most one web process
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (appCfg.name && appCfg.name !== name) {
      return c.json({ error: `app name "${appCfg.name}" does not match target "${name}"` }, 400);
    }

    // resolve or claim — apps share the one name namespace with sites
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
    const actor = await actorFor(email, site);
    if (!can(actor, "deploy")) return c.json({ error: `app is owned by ${site.owner}` }, 403);

    // Resolve declared DB bindings (app.uses): each must be an existing database in the SAME org.
    // The CNPG `<db>-app`/`<db>-ca` Secrets the binding wires are namespace-scoped, so a cross-org
    // database is both unauthorized and unreachable — reject with a named 400 before touching kube.
    for (const u of appCfg.uses ?? []) {
      const dbSite = await d.meta.getSitePlain(u.database);
      if (!dbSite || dbSite.type !== "database") {
        return c.json({ error: `app uses database "${u.database}", which does not exist` }, 400);
      }
      if (dbSite.orgId !== site.orgId) {
        return c.json({ error: `database "${u.database}" belongs to a different organisation and cannot be bound` }, 400);
      }
    }

    const verId = newVersionId(now());
    const ns = site.namespace; // per-owner tenant namespace (isolation)
    const kube = d.kube;
    const theSite = site;
    await kube.applyTenant(ns, tenantManifests(ns, { blockedEgressCidrs: d.cfg.blockedEgressCidrs })); // namespace + NetworkPolicy + quota + LimitRange
    const sandbox = !appCfg.trusted;
    const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
    const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret });
    // A stopped deploy (--no-start / already-stopped) rolls out nothing yet, so it also SKIPS the
    // release phase — the point of --no-start is to configure secrets first, and the release command
    // (which needs those secrets/the DB) would otherwise fail against an unconfigured app.
    const willStop = theSite.runtimeState === "stopped" || c.req.query("start") === "false";

    // Serialize the release + rollout per app so two concurrent deploys can't interleave migrations.
    // A held lock → 409 (another deploy is mid-flight). Everything cluster-mutating lives inside.
    let result: { halt: true; reason: string; logs: string } | { halt: false; stopped: boolean };
    try {
      result = await locks.withLock(`deploy:${name}`, DEPLOY_LOCK_TTL_MS, async () => {
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

        await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0 });
        await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId }));
        return { halt: false as const, stopped };
      });
    } catch (e) {
      if (e instanceof LockHeldError) return c.json({ error: `a deploy is already in progress for ${name}` }, 409);
      throw e;
    }
    if (result.halt) {
      await audit({ actor: email, action: "app.release.failed", target: name, targetType: "app", orgId: theSite.orgId, detail: { reason: result.reason, version: verId } });
      // The old version keeps serving; return the release logs so the failure is diagnosable inline.
      return c.json({ error: `release command failed (${result.reason}) — the previous version keeps serving`, releaseLogs: (result.logs ?? "").slice(-4000) }, 422);
    }
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
    const actor = await actorFor(email, site);
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
    if (!can(await actorFor(email, site), "configure")) return { err: c.json({ error: "owner only" }, 403) };
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

  // ---- app lifecycle: restart / stop (true-offline) / start (editor+; operational) ----
  const lifecycle = (action: "restart" | "stop" | "start") => async (c: any) => {
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such app" }, 404);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    if (!can(await actorFor(email, site), "deploy")) return c.json({ error: "not permitted" }, 403);
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
    // Enforce the per-database storage cap on the control plane (rejects raw API/MCP callers with a
    // clear error; the CLI already rejects up front). sanitize would otherwise silently clamp it.
    const storageErr = validateDbStorage(body);
    if (storageErr) return c.json({ error: storageErr }, 400);
    const dbCfg = sanitizeDatabaseConfig(body);
    if (!dbCfg) return c.json({ error: "invalid database config" }, 400);
    if (dbCfg.name && dbCfg.name !== name) {
      return c.json({ error: `database name "${dbCfg.name}" does not match target "${name}"` }, 400);
    }

    // resolve or claim — databases share the one name namespace with sites/apps
    let site = await d.meta.getSitePlain(name);
    const isCreate = !site; // first claim → generate the app password; a re-apply must NOT rotate it
    if (!site) {
      await ensureUser(email);
      const orgRes = await resolveCreateOrg(c, email);
      if ("err" in orgRes) return orgRes.err;
      const claimed = await d.meta.claimSite(name, email, "database", { id: orgRes.org.id, namespace: orgRes.org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "database") return c.json({ error: `name "${name}" is a ${site.type}, not a database` }, 409);
    const actor = await actorFor(email, site);
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
    await d.kube.applyTenant(ns, tenantManifests(ns, { blockedEgressCidrs: d.cfg.blockedEgressCidrs }));
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

    await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0 });
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
    if (!can(await actorFor(email, site), "configure")) return c.json({ error: "owner only" }, 403);

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
      if (!can(await actorFor(email, appSite), "configure")) return c.json({ error: `not permitted to set secrets on ${appName}` }, 403);
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

  // ---- managed-database backups + hibernation (Future.md #3; restore deferred to db:migrate) ----
  // Resolve a database workload + authorize the caller for `action` (compute must be enabled).
  const resolveDb = async (c: any, action: Action): Promise<{ site: Site; email: string } | { err: Response }> => {
    if (!d.kube) return { err: c.json({ error: "compute is not enabled on this instance" }, 501) };
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return { err: c.json({ error: "no such database" }, 404) };
    if (site.type !== "database") return { err: c.json({ error: `name "${name}" is a ${site.type}, not a database` }, 409) };
    if (!can(await actorFor(email, site), action)) return { err: c.json({ error: "not permitted" }, 403) };
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

  // ---- rollback ----
  app.post("/v1/sites/:name/rollback", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "rollback")) return c.json({ error: "not permitted" }, 403);
    // Rollback restores a previous published-version pointer — meaningful only for static sites.
    // Apps/databases have no version bytes to flip; "rolling back" would desync metadata from the
    // running workload. Re-deploy (apps) or restore-from-backup (DBs) is the equivalent.
    if (site.type !== "site") return c.json({ error: `rollback is for static sites; re-deploy a ${site.type} instead` }, 409);

    const body = (await c.req.json().catch(() => ({}))) as { to?: string };
    let target = body.to ?? "";
    const versions = await d.meta.listVersions(name);
    if (!target) {
      target = versions.find((v) => v.id !== site.currentVersion)?.id ?? "";
      if (!target) return c.json({ error: "no previous version" }, 400);
    } else if (!versions.some((v) => v.id === target)) {
      return c.json({ error: "unknown version" }, 400);
    }
    const targetConfig = versions.find((v) => v.id === target)?.config;
    await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: target, config: targetConfig }));
    return c.json({ url: siteUrl(name), version: target });
  });

  // ---- get site ----
  app.get("/v1/sites/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "read")) return c.json({ error: "not permitted" }, 403);
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
      out.database = dbInfo;
    }
    return c.json(out);
  });

  // ---- recent workload logs (crash diagnostics; apps + databases) ----
  app.get("/v1/sites/:name/logs", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    // logs (not read): a viewer is metadata-only — pod logs can leak env-injected secrets.
    if (!can(await actorFor(email, site), "logs")) return c.json({ error: "not permitted" }, 403);
    if (!d.kube || site.type === "site") return c.json({ logs: "" }); // static sites have no pods
    const tail = Math.min(Number(c.req.query("tail") ?? "100") || 100, 1000);
    // ?release=1 resolves the LATEST release Job's pod instead of the app pods (drop logs --release).
    const wantRelease = c.req.query("release") === "1" || c.req.query("release") === "true";
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
    if (!can(await actorFor(email, site), "read")) return c.json({ error: "not permitted" }, 403);
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
    if (!can(await actorFor(email, site), "configure")) return c.json({ error: "owner only" }, 403);
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

  // ---- delete ----
  app.delete("/v1/sites/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "delete")) return c.json({ error: "owner only" }, 403);
    // Tear down the running workload BEFORE dropping metadata — otherwise the k8s objects
    // orphan in the tenant namespace. Apps: Deployment/Service/Secret/NetworkPolicy/HSO.
    // Databases: the CNPG Cluster (cascades to pods) + ObjectStore/ScheduledBackup/policy.
    if (site.type === "app" && d.kube) {
      await d.kube.deleteApp(site.namespace, name);
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
    await d.blob.deletePrefix(`sites/${name}/files/`).catch(() => {}); // bytes; metadata cascades in DB
    await d.meta.deleteSite(name);
    await audit({ actor: email, action: "site.delete", target: name, targetType: site.type, orgId: site.orgId, detail: { owner: site.owner } });
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
      out.push({ name: s.name, type: s.type, owner: s.owner, visibility: s.visibility, url: siteUrl(name), current: s.currentVersion, org: await orgOf(s.orgId) });
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
    const type = typeQ === "site" || typeQ === "app" || typeQ === "database" ? typeQ : undefined;
    // Optional ?org=<slug> filter — scope the browse to one org (an unknown slug → empty page).
    const orgSlug = c.req.query("org");
    let orgId: string | undefined;
    if (orgSlug) {
      const org = await d.orgs.getOrgBySlug(orgSlug);
      if (!org) return c.json({ sites: [] });
      orgId = org.id;
    }
    const { names, nextCursor } = await d.meta.listSitesPage({ cursor, limit, prefix, owner, type, orgId });
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

  // ---- collaborators ----
  app.post("/v1/sites/:name/collaborators", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "share")) return c.json({ error: "owner only" }, 403);
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
    if (!can(await actorFor(email, site), "share")) return c.json({ error: "owner only" }, 403);
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
    if (!can(await actorFor(email, site), "transfer")) return c.json({ error: "owner only" }, 403);
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

  return app;
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
