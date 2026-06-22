import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Readable } from "node:stream";
import * as streamConsumers from "node:stream/consumers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPassword, parseDropYaml, CONFIG_FILE_YAML, type SiteConfig } from "../site-config.ts";
import { installScript } from "./install.ts";
import type { Config } from "../config.ts";
import type { BlobStore } from "../blob/types.ts";
import type { Db } from "../db/db.ts";
import type { Verifier } from "../auth/types.ts";
import { authMiddleware, type AuthEnv } from "../auth/middleware.ts";
import { MetaStore } from "../metastore/store.ts";
import type { Site, Visibility } from "../metastore/types.ts";
import { UserStore } from "../users/store.ts";
import { can, type Action, type Actor } from "../authz/permissions.ts";
import { validateName } from "../names.ts";
import { extractTarGz } from "../archive.ts";
import { newVersionId } from "../version-id.ts";
import { sanitizeAppConfig, assertHttpOnly } from "../app-config.ts";
import { sanitizeDatabaseConfig } from "../db-config.ts";
import { appManifests, tenantManifests } from "../kube/manifests.ts";
import { databaseManifests } from "../kube/cnpg.ts";
import { tenantNamespace } from "./tenant.ts";
import type { KubeClient } from "../kube/types.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { dashboardHtml } from "./dashboard.ts";

export interface Deps {
  cfg: Config;
  meta: MetaStore;
  blob: BlobStore;
  db: Db;
  users: UserStore;
  verifier: Verifier;
  kube?: KubeClient; // optional: when absent, /v1/apps returns 501 (static-only instance)
  now?: () => Date;
}

export function createApp(d: Deps): Hono<AuthEnv> {
  const now = d.now ?? (() => new Date());
  const siteUrl = (name: string) => `https://${name}.${d.cfg.baseDomain}`;
  const app = new Hono<AuthEnv>();

  app.get("/healthz", (c) => c.text("ok"));

  // Public server-mediated login routes (/auth/*) — clients only need DROP_API.
  registerAuthRoutes(app, d.cfg, d.db, d.users);

  // Dashboard (public page; its JS calls /v1/* with the session cookie).
  app.get("/", (c) => c.html(dashboardHtml(d.cfg.baseDomain)));

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

  app.use("/v1/*", authMiddleware(d.verifier));

  const ensureUser = (email: string) => d.users.upsertOnLogin(email, null);

  async function actorFor(email: string, site: Site | null): Promise<Actor> {
    const u = await d.users.getUser(email);
    const siteRole = site ? (site.members.find((m) => m.email === email)?.role ?? null) : null;
    return { email, platformRole: u?.role ?? "member", siteRole };
  }
  const isPlatformAdmin = async (email: string) => (await d.users.getUser(email))?.role === "admin";

  app.get("/v1/me", async (c) => {
    const email = c.get("identity").email;
    return c.json({ email, admin: await isPlatformAdmin(email) });
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
      const claimed = await d.meta.claimSite(name, email);
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
      const claimed = await d.meta.claimSite(name, email, "app");
      site = claimed ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (site.type !== "app") return c.json({ error: `name "${name}" is a ${site.type}, not an app` }, 409);
    const actor = await actorFor(email, site);
    if (!can(actor, "deploy")) return c.json({ error: `app is owned by ${site.owner}` }, 403);

    const verId = newVersionId(now());
    const ns = tenantNamespace(site.owner); // per-owner tenant namespace (isolation)
    await d.kube.applyTenant(ns, tenantManifests(ns, { blockedEgressCidrs: d.cfg.blockedEgressCidrs })); // namespace + NetworkPolicy + quota + LimitRange
    const manifests = appManifests(appCfg, { name, namespace: ns, host: `${name}.${d.cfg.baseDomain}`, sandbox: !appCfg.trusted });
    await d.kube.applyApp(ns, name, manifests);

    await d.meta.putVersion(name, { id: verId, publishedBy: email, createdAt: now().toISOString(), fileCount: 0, bytes: 0 });
    await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId }));
    return c.json({ url: siteUrl(name), name, version: verId, image: appCfg.image });
  });

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
    const dbCfg = sanitizeDatabaseConfig(body);
    if (!dbCfg) return c.json({ error: "invalid database config" }, 400);
    if (dbCfg.name && dbCfg.name !== name) {
      return c.json({ error: `database name "${dbCfg.name}" does not match target "${name}"` }, 400);
    }

    // resolve or claim — databases share the one name namespace with sites/apps
    let site = await d.meta.getSitePlain(name);
    if (!site) {
      await ensureUser(email);
      const claimed = await d.meta.claimSite(name, email, "database");
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
    const ns = tenantNamespace(site.owner);
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
      credentialsSecret: `${name}-app`,
    });
  });

  // ---- rollback ----
  app.post("/v1/sites/:name/rollback", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "rollback")) return c.json({ error: "not permitted" }, 403);

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
    return c.json({
      name: site.name,
      owner: site.owner,
      collaborators: site.collaborators,
      members: site.members,
      visibility: site.visibility,
      current: site.currentVersion,
      url: siteUrl(name),
      versions,
    });
  });

  // ---- set visibility (owner/admin) ----
  app.post("/v1/sites/:name/visibility", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "configure")) return c.json({ error: "owner only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { visibility?: string; password?: string };
    const vis = body.visibility as Visibility;
    if (vis !== "public" && vis !== "private" && vis !== "password") {
      return c.json({ error: "visibility must be public|private|password" }, 400);
    }
    if (vis === "password" && !body.password) return c.json({ error: "password required for password visibility" }, 400);
    const hash = vis === "password" ? hashPassword(body.password!) : null;
    await d.meta.setVisibility(name, vis, hash);
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
    if (site.type === "app" && d.kube) await d.kube.deleteApp(tenantNamespace(site.owner), name);
    else if (site.type === "database" && d.kube) await d.kube.deleteDatabase(tenantNamespace(site.owner), name);
    await d.blob.deletePrefix(`sites/${name}/files/`).catch(() => {}); // bytes; metadata cascades in DB
    await d.meta.deleteSite(name);
    return c.json({ deleted: name });
  });

  // ---- list my sites ----
  app.get("/v1/sites", async (c) => {
    const email = c.get("identity").email;
    const names = await d.meta.listUserSites(email);
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (s) out.push({ name: s.name, owner: s.owner, visibility: s.visibility, url: siteUrl(name), current: s.currentVersion });
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
    const { names, nextCursor } = await d.meta.listSitesPage({ cursor, limit, prefix });
    const out: unknown[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (s)
        out.push({
          name: s.name,
          owner: s.owner,
          visibility: s.visibility,
          current: s.currentVersion,
          url: siteUrl(name),
          collaborators: s.collaborators.length,
        });
    }
    return c.json({ sites: out, nextCursor });
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
    const role = body.role === "viewer" ? "viewer" : "editor";
    await ensureUser(body.email); // FK
    await d.meta.addMember(name, body.email, role);
    return c.json({ added: body.email, role });
  });

  app.delete("/v1/sites/:name/collaborators/:email", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const target = c.req.param("email");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!can(await actorFor(email, site), "share")) return c.json({ error: "owner only" }, 403);
    await d.meta.removeMember(name, target);
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
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    await ensureUser(body.email); // FK
    const oldOwner = site.owner;
    await d.meta.transferOwner(name, body.email);
    // An app's workload lives in the OLD owner's tenant namespace; the namespace is
    // owner-derived, so a transfer must remove it there. The new owner redeploys to
    // provision it in their own namespace (avoids cross-tenant objects + a dangling Secret).
    if (site.type === "app" && d.kube) await d.kube.deleteApp(tenantNamespace(oldOwner), name);
    return c.json({ owner: body.email });
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
