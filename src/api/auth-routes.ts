import type { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import type { UserStore } from "../users/store.ts";
import { type AuthEnv, SESSION_COOKIE } from "../auth/middleware.ts";
import { checkDomain } from "../auth/oidc.ts";
import { signSession } from "../auth/session-token.ts";

interface Handle {
  id: string;
  pollToken: string;
  codeVerifier: string;
  status: "pending" | "done" | "denied";
  mode: "cli" | "browser";
  token: string | null;
  error: string | null;
}

const page = (msg: string) =>
  `<!doctype html><meta charset=utf-8><title>Drop</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${msg}</h2></body>`;

/**
 * Server-mediated Google login. The API is the OAuth client: it owns the Google
 * credentials, runs the code exchange, verifies the domain, upserts the user,
 * and issues a Drop session token. Pending login state lives in `auth_handles`.
 *
 *   POST /auth/start   → { authUrl, handle, pollToken }
 *   GET  /auth/callback (Google redirect; exchanges code, stores session token)
 *   POST /auth/poll {handle, pollToken} → { token } | { status }
 */
export function registerAuthRoutes(app: Hono<AuthEnv>, cfg: Config, db: Db, users: UserStore) {
  let configPromise: ReturnType<typeof oidc.discovery> | null = null;
  const getOAuth = () =>
    (configPromise ??= oidc.discovery(new URL("https://accounts.google.com"), cfg.googleClientId!, cfg.googleClientSecret));
  const configured = () => !cfg.devAuth && !!cfg.googleClientId && !!cfg.sessionSecret;

  const saveHandle = (h: Handle) =>
    db
      .insertInto("auth_handles")
      .values({
        id: h.id,
        poll_token: h.pollToken,
        code_verifier: h.codeVerifier,
        status: h.status,
        mode: h.mode,
        token: h.token,
        error: h.error,
      })
      .onConflict((oc) => oc.column("id").doUpdateSet({ status: h.status, token: h.token, error: h.error }))
      .execute();

  const loadHandle = async (id: string): Promise<Handle | null> => {
    const r = await db.selectFrom("auth_handles").selectAll().where("id", "=", id).executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id,
      pollToken: r.poll_token,
      codeVerifier: r.code_verifier,
      status: r.status,
      mode: r.mode,
      token: r.token,
      error: r.error,
    };
  };
  const delHandle = (id: string) => db.deleteFrom("auth_handles").where("id", "=", id).execute();

  async function startFlow(mode: "cli" | "browser"): Promise<{ url: string; handle: string; pollToken: string }> {
    const conf = await getOAuth();
    const handle = oidc.randomState();
    const pollToken = mode === "cli" ? oidc.randomState() : "";
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const url = oidc.buildAuthorizationUrl(conf, {
      redirect_uri: `${cfg.publicUrl}/auth/callback`,
      scope: "openid email profile",
      state: handle,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    await saveHandle({ id: handle, pollToken, codeVerifier, status: "pending", mode, token: null, error: null });
    return { url: url.href, handle, pollToken };
  }

  app.post("/auth/start", async (c) => {
    if (!configured()) {
      return c.json({ error: "server-mediated login is not configured (dev-auth mode or missing Google config)" }, 400);
    }
    const { url, handle, pollToken } = await startFlow("cli");
    return c.json({ authUrl: url, handle, pollToken });
  });

  // Browser login for the dashboard: redirect to Google; the callback sets a cookie.
  app.get("/login", async (c) => {
    if (!configured()) return c.text("login is not configured (dev-auth mode or missing Google config)", 400);
    const { url } = await startFlow("browser");
    return c.redirect(url);
  });

  app.get("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  app.get("/auth/callback", async (c) => {
    const handleId = c.req.query("state");
    if (!handleId) return c.html(page("Missing state."), 400);
    const h = await loadHandle(handleId);
    if (!h) return c.html(page("Login session expired — start again."), 400);
    try {
      const conf = await getOAuth();
      const currentUrl = new URL(c.req.url, cfg.publicUrl);
      const tokens = await oidc.authorizationCodeGrant(conf, currentUrl, {
        pkceCodeVerifier: h.codeVerifier,
        expectedState: handleId,
      });
      const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      const email = typeof claims.email === "string" ? claims.email : "";
      const name = typeof claims.name === "string" ? claims.name : null;
      const verified = claims.email_verified === true;
      const hd = typeof claims.hd === "string" ? claims.hd : undefined;
      const emailAllowed = cfg.allowedEmails.length === 0 || cfg.allowedEmails.includes(email.toLowerCase());
      if (!email || !verified || !checkDomain(email, hd, cfg.allowedDomains) || !emailAllowed) {
        await saveHandle({ ...h, status: "denied", error: "account not allowed" });
        return c.html(page("Your account isn't allowed to use Drop."), 403);
      }
      await users.upsertOnLogin(email, name);
      const token = await signSession(cfg.sessionSecret, { sub: email, email });
      if (h.mode === "browser") {
        await delHandle(handleId);
        setCookie(c, SESSION_COOKIE, token, { httpOnly: true, path: "/", sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
        return c.redirect("/");
      }
      await saveHandle({ ...h, status: "done", token });
      return c.html(page("✓ Logged in to Drop. You can close this tab."));
    } catch (e) {
      await saveHandle({ ...h, status: "denied", error: (e as Error).message });
      return c.html(page("Login failed — start again."), 400);
    }
  });

  app.post("/auth/poll", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { handle?: string; pollToken?: string };
    if (!body.handle || !body.pollToken) return c.json({ error: "handle and pollToken required" }, 400);
    const h = await loadHandle(body.handle);
    if (!h) return c.json({ status: "expired" });
    if (h.pollToken !== body.pollToken) return c.json({ error: "bad pollToken" }, 403);
    if (h.status === "done") {
      await delHandle(body.handle);
      return c.json({ token: h.token });
    }
    if (h.status === "denied") {
      await delHandle(body.handle);
      return c.json({ status: "denied", error: h.error ?? "denied" });
    }
    return c.json({ status: "pending" });
  });
}
