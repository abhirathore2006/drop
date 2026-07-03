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
import { sanitizeAppConfig, assertHttpOnly, assertProcesses, type AppConfig } from "../app-config.ts";
import { sanitizeDatabaseConfig, generateDbPassword, validateDbPassword, validateDbStorage } from "../db-config.ts";
import { sanitizeStackConfig, validateStackEdges, resolveResourceName, type StackSpec, type StackResource } from "../stack-config.ts";
import { planStack, StackCycleError, type LivePresence, type PlanStep } from "../stacks/plan.ts";
import { StackStore } from "../stacks/store.ts";
import { appManifests, releaseJobManifest, tenantManifests } from "../kube/manifests.ts";
import { databaseManifests } from "../kube/cnpg.ts";
import { PasswordSyncError, type KubeClient } from "../kube/types.ts";
import { LockStore, LockHeldError } from "../metastore/lock.ts";
import type { SecretStore } from "../secrets/types.ts";
import type { ImageStore } from "../images/types.ts";
import { fingerprint, validateSecretKey } from "../secrets/secrets.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { consoleShell, consoleAsset } from "./dashboard.ts";
import { normalizeStatus } from "./status.ts";
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
  stacks?: StackStore; // stack metadata + resource mapping (B2); defaults over `db`
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
    // versionId (H1): stamps `drop.dev/version` on the pod template so THIS deploy always rolls
    // pods, even when the image tag is unchanged from the previous version.
    const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: verId });
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
  // Static sites flip the version pointer (bytes for every version already exist in blob storage).
  // Apps (H1) re-apply the target version's STORED config as a fresh manifest set — see below.
  // Databases have no analogous stored-config/version-bytes path; "rolling back" would desync
  // metadata from the running CNPG cluster — restore-from-backup is the equivalent there.
  app.post("/v1/sites/:name/rollback", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "rollback")) return c.json({ error: "not permitted" }, 403);
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
    try {
      await locks.withLock(`deploy:${name}`, DEPLOY_LOCK_TTL_MS, async () => {
        const sandbox = !appCfg.trusted;
        const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
        // Same context construction as deploy (sandbox/imagePullSecret/host); versionId stamps the
        // pod-template annotation so a rollback to a version with the SAME image tag as what's
        // currently running still rolls the pods.
        const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: target });
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
    // Normalized status contract (M0): ONE server-side mapping from the raw signals to the
    // console/CLI enum — the client trusts this field and only falls back to mirroring it
    // when talking to an older API (console/src/lib/status.ts).
    out.status = normalizeStatus({
      type: site.type,
      runtimeState: site.runtimeState,
      appStatus: ((out.app as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["appStatus"],
      dbStatus: ((out.database as Record<string, unknown> | undefined)?.status ?? null) as Parameters<typeof normalizeStatus>[0]["dbStatus"],
    });
    return c.json(out);
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
    if (!can(await actorFor(email, site), "logs")) return c.json({ error: "not permitted" }, 403);
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
  const claimResource = async (siteName: string, type: "site" | "app" | "database", org: Org, email: string): Promise<Site> => {
    let site = await d.meta.getSitePlain(siteName);
    if (!site) {
      const claimed = await d.meta.claimSite(siteName, email, type, { id: org.id, namespace: org.namespace });
      site = claimed ?? (await d.meta.getSitePlain(siteName));
    }
    if (!site) throw new Error(`claim failed for ${siteName}`);
    if (site.type !== type) throw new Error(`resource "${siteName}" is a ${site.type}, not a ${type}`);
    return site;
  };

  const ensureTenant = (ns: string) => d.kube!.applyTenant(ns, tenantManifests(ns, { blockedEgressCidrs: d.cfg.blockedEgressCidrs }));

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

  // Create/update an app resource from a resolved image. Composes the SAME building blocks as
  // POST /v1/apps/:name (manifests + apply + secret binding). The release phase is intentionally NOT
  // run in the stack path v1 (migrations stay on `drop deploy`); noted as a deliberate deviation.
  const applyAppResource = async (spec: StackSpec, mapping: Record<string, string>, res: StackResource, site: Site, image: string): Promise<void> => {
    // Resolve `uses` edges: each references a resource KEY in this stack → its materialized DB name.
    const uses = (res.uses ?? []).map((u) => ({ database: siteNameForKey(spec, mapping, u.database) }));
    const appCfg: AppConfig = {
      image,
      services: res.services ?? [{ internalPort: 8080, protocol: "http" }],
      resources: res.resources,
      ...(res.env ? { env: res.env } : {}),
      ...(res.scale ? { scale: res.scale } : {}),
      trusted: res.trusted ?? true,
      ...(uses.length ? { uses } : {}),
      ...(res.healthcheck ? { healthcheck: res.healthcheck } : {}),
      ...(res.processes ? { processes: res.processes } : {}),
    };
    const ns = site.namespace;
    await ensureTenant(ns);
    const sandbox = !appCfg.trusted;
    const imagePullSecret = d.cfg.imageBackend === "registry" ? d.cfg.imageRegistryPullSecret : undefined;
    const verId = newVersionId(now()); // minted up front so it can stamp the pod-template annotation (H1)
    const manifests = appManifests(appCfg, { name: site.name, namespace: ns, host: `${site.name}.${d.cfg.baseDomain}`, sandbox, imagePullSecret, versionId: verId });
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
  const actionForKind = (kind: "site" | "app" | "database"): Action => (kind === "site" ? "publish" : kind === "app" ? "deploy" : "db:create");

  // ---- POST /v1/stacks/:name/up : reconcile the desired spec (plan + execute; ?dry_run=1 = plan) ----
  app.post("/v1/stacks/:name/up", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    await ensureUser(email); // provision the user + personal org (org membership FKs to users)
    const orgRes = await resolveStackOrg(c, email);
    if ("err" in orgRes) return orgRes.err;
    const org = orgRes.org;

    let body: { spec?: unknown; resolved?: Record<string, { image?: string }>; prune?: boolean; spec_version?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const spec = sanitizeStackConfig(body.spec);
    if (!spec) return c.json({ error: "invalid stack spec (needs a name and at least one resource)" }, 400);
    if (spec.name !== name) return c.json({ error: `stack name "${spec.name}" does not match target "${name}"` }, 400);
    const edgeErr = validateStackEdges(spec);
    if (edgeErr) return c.json({ error: edgeErr }, 400);

    const prune = body.prune === true;
    const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
    const existing = await stacks.getByName(org.id, name);
    const mapping = existing ? await stacks.mapping(existing.id) : {};

    // Each resource materializes as a valid site name — surface an over-long/invalid name as a clean 400
    // rather than a cryptic cluster error later.
    for (const [key] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      const e = validateName(sn);
      if (e) return c.json({ error: `resource "${key}" resolves to an invalid site name "${sn}": ${e}` }, 400);
    }

    // Optimistic concurrency: a stale editor's spec_version is rejected before any work.
    if (existing && body.spec_version != null && body.spec_version !== existing.specVersion) {
      return c.json({ error: `stack was modified (spec_version ${existing.specVersion}, you sent ${body.spec_version}) — re-fetch and retry` }, 409);
    }

    // Live existence + cross-org conflict check over every candidate site name (spec + removed keys).
    const candidateNames = new Set<string>();
    for (const key of Object.keys(spec.resources)) candidateNames.add(siteNameForKey(spec, mapping, key));
    for (const sn of Object.values(mapping)) candidateNames.add(sn);
    const live: Record<string, LivePresence> = {};
    for (const sn of candidateNames) {
      const s = await d.meta.getSitePlain(sn);
      if (!s) continue;
      if (s.orgId && s.orgId !== org.id) return c.json({ error: `resource "${sn}" already exists in another organisation` }, 409);
      live[sn] = { type: s.type };
    }

    // Per-resource authz on resources that ALREADY exist (new resources are covered by org create-rights).
    for (const [key, res] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      if (!live[sn]) continue;
      const s = (await d.meta.getSitePlain(sn))!;
      if (!can(await actorFor(email, s), actionForKind(res.type))) return c.json({ error: `not permitted to reconcile "${sn}" (${res.type})` }, 403);
    }

    // Plan (pure). A dependency cycle has no apply order → 400.
    let plan: PlanStep[];
    try {
      plan = planStack({ spec, prevSpec: existing?.spec ?? null, mapping, live, prune });
    } catch (e) {
      if (e instanceof StackCycleError) return c.json({ error: e.message }, 400);
      throw e;
    }

    // Outputs (for site→app env_from substitution, done CLI-side) + content the CLI still owes.
    const outputs: Record<string, { url: string }> = {};
    const needs: { key: string; kind: "app-image" | "site-publish"; siteName: string }[] = [];
    for (const [key, res] of Object.entries(spec.resources)) {
      const sn = siteNameForKey(spec, mapping, key);
      if (res.type === "app") {
        outputs[key] = { url: siteUrl(sn) };
        const image = body.resolved?.[key]?.image ?? res.image;
        if (res.dir && !image) needs.push({ key, kind: "app-image", siteName: sn });
      } else if (res.type === "site") {
        outputs[key] = { url: siteUrl(sn) };
        if (res.dir) needs.push({ key, kind: "site-publish", siteName: sn });
      }
    }

    if (dryRun) {
      return c.json({ stack: name, org: org.slug, specVersion: existing?.specVersion ?? 0, plan, needs, outputs, dryRun: true });
    }
    if (!d.kube) return c.json({ error: "compute is not enabled on this instance" }, 501);

    // Per-org workload cap: a stack `up` can create several resources at once — count them up front.
    const createCount = plan.filter((s) => s.action === "create").length;
    if (d.cfg.maxWorkloadsPerOrg > 0 && (await d.meta.countSitesInOrg(org.id)) + createCount > d.cfg.maxWorkloadsPerOrg) {
      return c.json({ error: `workload cap reached for this org (${d.cfg.maxWorkloadsPerOrg}) — a stack of ${createCount} new resources would exceed it` }, 429);
    }

    const stackId = existing?.id ?? stacks.stackId(org.id, name);
    let outcome: { applied: PlanStep[]; failure: { step: PlanStep; error: string } | null; newVersion: number };
    try {
      outcome = await locks.withLock(`stack:${stackId}`, STACK_LOCK_TTL_MS, async () => {
        const stackRow = existing ?? (await stacks.create({ name, orgId: org.id, spec, createdBy: email }));
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
            } else if (res.type === "app") {
              const image = body.resolved?.[step.key]?.image ?? res.image;
              if (image) await applyAppResource(spec, mapping, res, site, image); // else: row claimed, awaits CLI image (in `needs`)
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
      if (e instanceof LockHeldError) return c.json({ error: `a stack up is already in progress for ${name}` }, 409);
      throw e;
    }

    await audit({
      actor: email,
      action: "stack.up",
      target: name,
      targetType: "stack",
      orgId: org.id,
      detail: { applied: outcome.applied.map((s) => ({ action: s.action, key: s.key })), prune, failed: outcome.failure?.step.key ?? null },
    });
    if (outcome.failure) {
      return c.json(
        { error: `stack up halted at "${outcome.failure.step.key}": ${outcome.failure.error}`, stack: name, applied: outcome.applied, failedStep: outcome.failure.step, plan, needs, outputs },
        500,
      );
    }
    return c.json({ stack: name, org: org.slug, specVersion: outcome.newVersion, plan, applied: outcome.applied, needs, outputs });
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
