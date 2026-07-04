import type { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Config } from "../config.ts";
import { isGoogleIssuer } from "../config.ts";
import type { Db } from "../db/db.ts";
import type { UserStore } from "../users/store.ts";
import type { AuditStore } from "../audit/store.ts";
import { type AuthEnv, SESSION_COOKIE } from "../auth/middleware.ts";
import { mapClaims } from "../auth/oidc.ts";
import { verifyBreakGlass } from "../auth/break-glass.ts";
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

/**
 * Server-mediated SSO login (J2) is available whenever the OIDC client + session secret are
 * configured — including in dev-auth mode (DROP_DEV_AUTH=1), where dev `sub:email` tokens also
 * keep working. Login is independent of the dev flag. `oidcClientId`/`oidcClientSecret` fall back
 * to the legacy DROP_GOOGLE_* vars in config, so existing Google deployments stay configured.
 */
export function loginConfigured(cfg: Pick<Config, "oidcClientId" | "oidcClientSecret" | "sessionSecret">): boolean {
  return !!cfg.oidcClientId && !!cfg.oidcClientSecret && !!cfg.sessionSecret;
}

const SSO_NOT_CONFIGURED = "SSO login not configured — set DROP_OIDC_ISSUER, DROP_OIDC_CLIENT_ID, DROP_OIDC_CLIENT_SECRET, DROP_SESSION_SECRET";

const page = (msg: string) =>
  `<!doctype html><meta charset=utf-8><title>Drop</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${msg}</h2></body>`;

/**
 * Server-mediated OIDC login (J2). The API is the OAuth client: it owns the provider
 * credentials, discovers the issuer (`/.well-known/openid-configuration`), runs the code
 * exchange, maps + gates the claims, upserts the user, and issues a Drop session token.
 * The issuer is generic — Google is just the default (`DROP_OIDC_ISSUER`). Pending login
 * state lives in `auth_handles`.
 *
 *   POST /auth/start   → { authUrl, handle, pollToken }
 *   GET  /auth/callback (IdP redirect; exchanges code, stores session token)
 *   POST /auth/poll {handle, pollToken} → { token } | { status }
 *   GET  /v1/auth/meta  → { displayName, breakGlass } (public; drives the console login label)
 *   GET/POST /auth/break-glass (only when DROP_BREAK_GLASS_ADMIN is set)
 */
export function registerAuthRoutes(app: Hono<AuthEnv>, cfg: Config, db: Db, users: UserStore, audit?: AuditStore) {
  let configPromise: ReturnType<typeof oidc.discovery> | null = null;
  // Issuer-generic discovery (same openid-client mechanism as before, just parameterized on the
  // configured issuer). Memoized: one discovery per process — the metadata is stable for the run.
  const getOAuth = () => (configPromise ??= oidc.discovery(new URL(cfg.oidcIssuer), cfg.oidcClientId!, cfg.oidcClientSecret));
  const configured = () => loginConfigured(cfg);

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
      scope: cfg.oidcScopes,
      state: handle,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    await saveHandle({ id: handle, pollToken, codeVerifier, status: "pending", mode, token: null, error: null });
    return { url: url.href, handle, pollToken };
  }

  app.post("/auth/start", async (c) => {
    if (!configured()) return c.json({ error: SSO_NOT_CONFIGURED }, 400);
    const { url, handle, pollToken } = await startFlow("cli");
    return c.json({ authUrl: url, handle, pollToken });
  });

  // Browser login for the dashboard: redirect to the IdP; the callback sets a cookie.
  app.get("/login", async (c) => {
    if (!configured()) return c.text(SSO_NOT_CONFIGURED, 400);
    const { url } = await startFlow("browser");
    return c.redirect(url);
  });

  // Public login metadata — drives the console's sign-in label + the break-glass affordance.
  // Registered BEFORE the /v1/* auth middleware (see server.ts) so it stays reachable when signed out.
  app.get("/v1/auth/meta", (c) => c.json({ displayName: cfg.oidcDisplayName, breakGlass: !!cfg.breakGlassAdmin }));

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
      const mapped = mapClaims(claims, {
        emailClaim: cfg.oidcEmailClaim,
        nameClaim: cfg.oidcNameClaim,
        allowedDomains: cfg.oidcAllowedDomains,
        allowedEmails: cfg.allowedEmails,
        isGoogle: isGoogleIssuer(cfg.oidcIssuer),
        groupsClaim: cfg.oidcGroupsClaim,
        requiredGroup: cfg.oidcRequiredGroup,
      });
      if (!mapped.ok) {
        await saveHandle({ ...h, status: "denied", error: mapped.error });
        return c.html(page(`Your account isn't allowed to use Drop — ${mapped.error}.`), 403);
      }
      const { email, name } = mapped;
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

  // (J2) Break-glass admin — the ONE local email/password login, for emergency access when the OIDC
  // provider is down. Registered ONLY when DROP_BREAK_GLASS_ADMIN is set. It mints a NORMAL session
  // (same cookie as SSO). There is deliberately NO signup and NO password-reset flow (email/password
  // accounts are otherwise out of Drop — consistent with the K-mail/SMTP deferral). Every use is audited.
  if (cfg.breakGlassAdmin && cfg.sessionSecret) {
    const bgPage = (msg: string, isError = false) =>
      `<!doctype html><meta charset=utf-8><title>Drop — break-glass</title><body style="font-family:system-ui;max-width:22rem;margin:5rem auto;padding:0 1rem">` +
      `<h2>Break-glass sign in</h2>` +
      (isError ? `<p style="color:#b00">${msg}</p>` : `<p style="color:#666">${msg}</p>`) +
      `<form method=post action=/auth/break-glass style="display:flex;flex-direction:column;gap:.6rem">` +
      `<input name=email type=email placeholder=email required autofocus style="padding:.5rem">` +
      `<input name=password type=password placeholder=password required style="padding:.5rem">` +
      `<button style="padding:.5rem">Sign in</button></form></body>`;

    app.get("/auth/break-glass", (c) => c.html(bgPage("Emergency access. Use only when SSO is unavailable.")));

    app.post("/auth/break-glass", async (c) => {
      const ct = c.req.header("content-type") ?? "";
      const body: Record<string, unknown> = ct.includes("application/json")
        ? await c.req.json().catch(() => ({}))
        : ((await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>);
      const email = String(body.email ?? "");
      const password = String(body.password ?? "");
      const ok = verifyBreakGlass(cfg.breakGlassAdmin, email, password);
      if (!ok) return c.html(bgPage("Invalid email or password.", true), 401);
      await users.upsertOnLogin(ok, null);
      const token = await signSession(cfg.sessionSecret, { sub: ok, email: ok });
      // Audit the emergency login (best-effort — a failed audit write must never block it).
      await audit?.record({ actor: ok, action: "auth.break_glass", target: ok, targetType: "user" }).catch(() => {});
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, path: "/", sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
      return c.redirect("/");
    });
  }
}
