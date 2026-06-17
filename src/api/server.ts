import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Readable } from "node:stream";
import * as streamConsumers from "node:stream/consumers";
import { hashPassword, parseSiteConfig, type SiteConfig } from "../site-config.ts";
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
import { registerAuthRoutes } from "./auth-routes.ts";
import { dashboardHtml } from "./dashboard.ts";

export interface Deps {
  cfg: Config;
  meta: MetaStore;
  blob: BlobStore;
  db: Db;
  users: UserStore;
  verifier: Verifier;
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
  app.use(
    "/docs/*",
    serveStatic({
      root: d.cfg.docsDir,
      rewriteRequestPath: (p) => p.replace(/^\/docs/, "") || "/",
    }),
  );

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
    const actor = await actorFor(email, site);
    if (!can(actor, "publish")) return c.json({ error: `site is owned by ${site.owner}` }, 403);

    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    const verId = newVersionId(now());
    const prefix = d.meta.filesPrefix(name, verId);
    const nodeStream = Readable.fromWeb(c.req.raw.body as Parameters<typeof Readable.fromWeb>[0]);

    let result: { files: number; bytes: number };
    const captured: { raw?: Buffer } = {}; // object wrapper so the closure write survives CFA
    try {
      result = await extractTarGz(
        nodeStream,
        async (rel, body, size, ct) => {
          // _drop.json is config, not a served asset (it may carry credentials).
          if (rel === "_drop.json") {
            captured.raw = await streamConsumers.buffer(body);
            return;
          }
          await d.blob.put(prefix + rel, body, size, ct);
        },
        { maxFiles: d.cfg.maxFiles, maxBytes: d.cfg.maxUploadBytes },
      );
    } catch (e) {
      await d.blob.deletePrefix(prefix).catch(() => {});
      return c.json({ error: `bad upload: ${(e as Error).message}` }, 400);
    }

    let config: SiteConfig | undefined;
    if (captured.raw) {
      try {
        config = parseSiteConfig(captured.raw.toString("utf8"));
      } catch (e) {
        await d.blob.deletePrefix(prefix).catch(() => {});
        return c.json({ error: `invalid _drop.json: ${(e as Error).message}` }, 400);
      }
    }
    if (config?.name && config.name !== name) {
      await d.blob.deletePrefix(prefix).catch(() => {});
      return c.json({ error: `_drop.json name "${config.name}" does not match target site "${name}"` }, 400);
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
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    await ensureUser(body.email); // FK
    await d.meta.transferOwner(name, body.email);
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
