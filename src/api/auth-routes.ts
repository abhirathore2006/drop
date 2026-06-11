import type { Hono } from "hono";
import * as oidc from "openid-client";
import type { Config } from "../config.ts";
import type { BlobStore } from "../blob/types.ts";
import { readText } from "../blob/types.ts";
import type { AuthEnv } from "../auth/middleware.ts";
import { checkDomain } from "../auth/oidc.ts";
import { signSession } from "../auth/session-token.ts";

interface Handle {
  pollToken: string;
  codeVerifier: string;
  status: "pending" | "done" | "denied";
  token?: string;
  error?: string;
}

const page = (msg: string) =>
  `<!doctype html><meta charset=utf-8><title>Drop</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${msg}</h2></body>`;

/**
 * Server-mediated Google login. The API is the OAuth client: it owns the Google
 * credentials, runs the code exchange, verifies the domain, and issues a Drop
 * session token. Clients only ever talk to the Drop API (just need DROP_API).
 *
 *   POST /auth/start   → { authUrl, handle, pollToken }
 *   GET  /auth/callback (Google redirect; exchanges code, stores session token)
 *   POST /auth/poll {handle, pollToken} → { token } | { status }
 */
export function registerAuthRoutes(app: Hono<AuthEnv>, cfg: Config, blob: BlobStore) {
  let configPromise: ReturnType<typeof oidc.discovery> | null = null;
  const getOAuth = () =>
    (configPromise ??= oidc.discovery(new URL("https://accounts.google.com"), cfg.googleClientId!, cfg.googleClientSecret));
  const key = (id: string) => `auth/${id}.json`;
  const save = (id: string, h: Handle) =>
    blob.put(key(id), Buffer.from(JSON.stringify(h)), 0, "application/json");
  const configured = () => !cfg.devAuth && !!cfg.googleClientId && !!cfg.sessionSecret;

  app.post("/auth/start", async (c) => {
    if (!configured()) {
      return c.json({ error: "server-mediated login is not configured (dev-auth mode or missing Google config)" }, 400);
    }
    const conf = await getOAuth();
    const handle = oidc.randomState();
    const pollToken = oidc.randomState();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const url = oidc.buildAuthorizationUrl(conf, {
      redirect_uri: `${cfg.publicUrl}/auth/callback`,
      scope: "openid email",
      state: handle,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    await save(handle, { pollToken, codeVerifier, status: "pending" });
    return c.json({ authUrl: url.href, handle, pollToken });
  });

  app.get("/auth/callback", async (c) => {
    const handle = c.req.query("state");
    if (!handle) return c.html(page("Missing state."), 400);
    const obj = await blob.get(key(handle));
    if (!obj) return c.html(page("Login session expired — start again."), 400);
    const h = JSON.parse(await readText(obj)) as Handle;
    try {
      const conf = await getOAuth();
      const currentUrl = new URL(c.req.url, cfg.publicUrl);
      const tokens = await oidc.authorizationCodeGrant(conf, currentUrl, {
        pkceCodeVerifier: h.codeVerifier,
        expectedState: handle,
      });
      const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      const email = typeof claims.email === "string" ? claims.email : "";
      const verified = claims.email_verified === true;
      const hd = typeof claims.hd === "string" ? claims.hd : undefined;
      if (!email || !verified || !checkDomain(email, hd, cfg.allowedDomains)) {
        await save(handle, { ...h, status: "denied", error: "account not allowed" });
        return c.html(page("Your account isn't allowed to use Drop."), 403);
      }
      const token = await signSession(cfg.sessionSecret, { sub: email, email });
      await save(handle, { ...h, status: "done", token });
      return c.html(page("✓ Logged in to Drop. You can close this tab."));
    } catch (e) {
      await save(handle, { ...h, status: "denied", error: (e as Error).message });
      return c.html(page("Login failed — start again."), 400);
    }
  });

  app.post("/auth/poll", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { handle?: string; pollToken?: string };
    if (!body.handle || !body.pollToken) return c.json({ error: "handle and pollToken required" }, 400);
    const obj = await blob.get(key(body.handle));
    if (!obj) return c.json({ status: "expired" });
    const h = JSON.parse(await readText(obj)) as Handle;
    if (h.pollToken !== body.pollToken) return c.json({ error: "bad pollToken" }, 403);
    if (h.status === "done") {
      await blob.deletePrefix(key(body.handle));
      return c.json({ token: h.token });
    }
    if (h.status === "denied") {
      await blob.deletePrefix(key(body.handle));
      return c.json({ status: "denied", error: h.error ?? "denied" });
    }
    return c.json({ status: "pending" });
  });
}
