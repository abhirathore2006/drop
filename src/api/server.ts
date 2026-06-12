import { Hono } from "hono";
import { Readable } from "node:stream";
import * as streamConsumers from "node:stream/consumers";
import { parseSiteConfig, type SiteConfig } from "../site-config.ts";
import type { Config } from "../config.ts";
import type { BlobStore } from "../blob/types.ts";
import type { Verifier } from "../auth/types.ts";
import { authMiddleware, type AuthEnv } from "../auth/middleware.ts";
import { MetaStore } from "../metastore/store.ts";
import { validateName } from "../names.ts";
import { extractTarGz } from "../archive.ts";
import { newVersionId } from "../version-id.ts";
import { canAdmin, canWrite } from "./authz.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { dashboardHtml } from "./dashboard.ts";

export interface Deps {
  cfg: Config;
  meta: MetaStore;
  blob: BlobStore;
  verifier: Verifier;
  now?: () => Date;
}

export function createApp(d: Deps): Hono<AuthEnv> {
  const now = d.now ?? (() => new Date());
  const siteUrl = (name: string) => `https://${name}.${d.cfg.baseDomain}`;
  const app = new Hono<AuthEnv>();

  app.get("/healthz", (c) => c.text("ok"));

  // Public server-mediated login routes (/auth/*) — clients only need DROP_API.
  registerAuthRoutes(app, d.cfg, d.blob);

  // Dashboard (public page; its JS calls /v1/* with the session cookie).
  app.get("/", (c) => c.html(dashboardHtml(d.cfg.baseDomain)));

  app.use("/v1/*", authMiddleware(d.verifier));

  app.get("/v1/me", (c) => c.json({ email: c.get("identity").email }));

  // ---- publish ----
  app.post("/v1/sites/:name/versions", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const nameErr = validateName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    // resolve or claim
    let site = await d.meta.getSitePlain(name);
    if (!site) {
      site = (await d.meta.claimSite(name, email)) ?? (await d.meta.getSitePlain(name));
    }
    if (!site) return c.json({ error: "claim failed" }, 500);
    if (!canWrite(site, email)) return c.json({ error: `site is owned by ${site.owner}` }, 403);

    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    const verId = newVersionId(now());
    const prefix = d.meta.filesPrefix(name, verId);
    const nodeStream = Readable.fromWeb(c.req.raw.body as any);

    let result: { files: number; bytes: number };
    const captured: { raw?: Buffer } = {}; // object wrapper so the closure write survives CFA
    try {
      result = await extractTarGz(
        nodeStream,
        async (rel, body, size, ct) => {
          // _drop.json is config, not a served asset — capture it, don't store it
          // (it may contain basic-auth credentials).
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
    // Guard: the bundle's declared name must match the target being published to.
    // (Ownership of `name` was already enforced above via canWrite/claim.)
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
    // commit point: CAS-flip the live pointer (+ denormalize config for the edge)
    await d.meta.updateSite(name, (s) => ({ ...s, currentVersion: verId, config }));

    void pruneVersions(d, name);
    return c.json({ url: siteUrl(name), version: verId, files: result.files, bytes: result.bytes });
  });

  // ---- rollback ----
  app.post("/v1/sites/:name/rollback", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!canWrite(site, email)) return c.json({ error: "not permitted" }, 403);

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
    if (!canWrite(site, email)) return c.json({ error: "not permitted" }, 403);
    const versions = await d.meta.listVersions(name);
    return c.json({
      name: site.name,
      owner: site.owner,
      collaborators: site.collaborators,
      current: site.currentVersion,
      url: siteUrl(name),
      versions,
    });
  });

  // ---- delete ----
  app.delete("/v1/sites/:name", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!canAdmin(site, email)) return c.json({ error: "owner only" }, 403);
    await d.meta.deleteSite(name);
    return c.json({ deleted: name });
  });

  // ---- list my sites ----
  app.get("/v1/sites", async (c) => {
    const email = c.get("identity").email;
    const names = await d.meta.listSiteNames();
    const out: any[] = [];
    for (const name of names) {
      const s = await d.meta.getSitePlain(name);
      if (s && (s.owner === email || s.collaborators.includes(email))) {
        out.push({ name: s.name, owner: s.owner, url: siteUrl(name), current: s.currentVersion });
      }
    }
    return c.json({ sites: out });
  });

  // ---- collaborators ----
  app.post("/v1/sites/:name/collaborators", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!canAdmin(site, email)) return c.json({ error: "owner only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    const add = body.email;
    await d.meta.updateSite(name, (s) =>
      s.collaborators.includes(add) ? s : { ...s, collaborators: [...s.collaborators, add] },
    );
    return c.json({ added: add });
  });

  app.delete("/v1/sites/:name/collaborators/:email", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const target = c.req.param("email");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!canAdmin(site, email)) return c.json({ error: "owner only" }, 403);
    await d.meta.updateSite(name, (s) => ({
      ...s,
      collaborators: s.collaborators.filter((x) => x !== target),
    }));
    return c.json({ removed: target });
  });

  // ---- transfer ----
  app.post("/v1/sites/:name/transfer", async (c) => {
    const email = c.get("identity").email;
    const name = c.req.param("name");
    const site = await d.meta.getSitePlain(name);
    if (!site) return c.json({ error: "no such site" }, 404);
    if (!canAdmin(site, email)) return c.json({ error: "owner only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    if (!body.email) return c.json({ error: "email required" }, 400);
    const newOwner = body.email;
    await d.meta.updateSite(name, (s) => ({
      ...s,
      owner: newOwner,
      collaborators: [...new Set([...s.collaborators.filter((x) => x !== newOwner), s.owner])],
    }));
    return c.json({ owner: newOwner });
  });

  return app;
}

/** Delete file/version objects beyond keepVersions (never the current one). */
async function pruneVersions(d: Deps, name: string): Promise<void> {
  try {
    const site = await d.meta.getSitePlain(name);
    if (!site) return;
    const versions = await d.meta.listVersions(name); // newest first
    for (let i = d.cfg.keepVersions; i < versions.length; i++) {
      const v = versions[i]!;
      if (v.id === site.currentVersion) continue;
      await d.blob.deletePrefix(d.meta.filesPrefix(name, v.id)).catch(() => {});
      await d.blob.deletePrefix(d.meta.versionKey(name, v.id)).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}
