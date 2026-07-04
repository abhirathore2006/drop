// @drop/auth — the app-side SDK for a Drop managed auth resource (GoTrue engine, K2).
//
// Two halves, both framework-agnostic and dependency-free:
//   • Client (browser or server): thin fetch wrappers over GoTrue's REST surface — signUp / signIn /
//     signOut / getUser / refresh. `createAuthClient()` reads `AUTH_URL` (the value Drop injects when
//     you bind the resource with `uses: [{ auth: <name> }]`) by default.
//   • Server: `verifyRequest()` verifies an incoming JWT locally — HS256 with the shared secret Drop
//     injects (`AUTH_JWT_SECRET`, plus `AUTH_JWT_SECRET_PREVIOUS` during a key-rotation grace window).
//     It returns `{ user, roles, permissions, claims }`; `roles`/`permissions` come from the app-RBAC
//     claims hook (K2) when the resource has `rbac: true`, else empty arrays.
//
// WHY HS256 (not JWKS): OSS GoTrue signs and verifies with a single shared secret and serves no JWKS
// endpoint (that is a Supabase-platform feature). So verification is symmetric — the app holds the
// same secret the engine signs with, injected via Drop's write-only secret path. See docs/auth.html.
//
// `verifyRequest` is async and Node-only: it lazy-imports `node:crypto` INSIDE the call so this module
// stays import-clean for browser bundles (a client component that only uses `createAuthClient` never
// pulls `node:crypto` into its graph).

/** An authenticated end user, from the verified token's `sub`/`email` claims. */
export interface AuthUser {
  id: string;
  email?: string;
}

/** The result of verifying a request's bearer token. `roles`/`permissions` are stamped by the app-RBAC
 *  claims hook (empty when RBAC is off or the user has no roles). `claims` is the full decoded payload. */
export interface VerifiedRequest {
  user: AuthUser;
  roles: string[];
  permissions: string[];
  claims: Record<string, unknown>;
}

/** GoTrue's token response (password + refresh grants). Extra fields are passed through untyped. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  refresh_token: string;
  user?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A minimal fetch shape so the SDK needs no DOM lib and accepts an injected fetch (tests, custom agents). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Anything `verifyRequest` can pull a bearer token from: a raw token string, a Fetch `Request`, a
 *  `Headers`, a Node `req` (`{ headers: {...} }`), or a plain headers object. */
export type TokenSource =
  | string
  | { headers?: unknown; get?: (name: string) => string | null }
  | Record<string, unknown>;

/** A verification failure (no token, bad signature, expired, malformed, …). `code` is machine-readable. */
export class AuthError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** A non-2xx response from a GoTrue REST call. `detail` is the parsed error body when available. */
export class AuthApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The browser/server client — thin wrappers over the engine's REST API. */
export interface AuthClient {
  /** The resolved engine base URL (trailing slash stripped). */
  readonly url: string;
  /** Email/password sign-up (`POST /signup`). Returns the created user (and session if auto-confirmed). */
  signUp(email: string, password: string): Promise<Record<string, unknown>>;
  /** Email/password sign-in (`POST /token?grant_type=password`). Returns access + refresh tokens. */
  signIn(email: string, password: string): Promise<TokenResponse>;
  /** Revoke the session (`POST /logout`, bearer the access token). */
  signOut(accessToken: string): Promise<void>;
  /** Fetch the current user (`GET /user`, bearer the access token). */
  getUser(accessToken: string): Promise<Record<string, unknown>>;
  /** Exchange a refresh token for a new session (`POST /token?grant_type=refresh_token`). */
  refresh(refreshToken: string): Promise<TokenResponse>;
}

/** Read an env var without assuming a Node `process` exists (browser-safe). */
function env(name: string): string | undefined {
  return typeof process !== "undefined" && process?.env ? process.env[name] : undefined;
}

/** Create a client bound to an auth resource's REST API. `url` defaults to `AUTH_URL`; `fetch` defaults
 *  to the global (pass one for tests or non-standard runtimes). */
export function createAuthClient(opts: { url?: string; fetch?: FetchLike } = {}): AuthClient {
  const url = (opts.url ?? env("AUTH_URL") ?? "").replace(/\/+$/, "");
  if (!url) throw new AuthError("no auth URL — pass { url } or set AUTH_URL (Drop injects it when you bind the resource)", "no_url");
  const doFetch = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined);
  if (!doFetch) throw new AuthError("no fetch available in this runtime — pass { fetch }", "no_fetch");

  async function call(path: string, o: { method?: string; body?: unknown; token?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.token) headers["authorization"] = `Bearer ${o.token}`;
    const res = await doFetch!(`${url}${path}`, {
      method: o.method ?? "POST",
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (!res.ok) {
      let detail: unknown;
      try {
        detail = await res.json();
      } catch {
        try {
          detail = await res.text();
        } catch {
          detail = undefined;
        }
      }
      throw new AuthApiError(`auth request to ${path} failed (${res.status})`, res.status, detail);
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  return {
    url,
    signUp: (email, password) => call("/signup", { body: { email, password } }) as Promise<Record<string, unknown>>,
    signIn: (email, password) => call("/token?grant_type=password", { body: { email, password } }) as Promise<TokenResponse>,
    signOut: async (accessToken) => {
      await call("/logout", { token: accessToken });
    },
    getUser: (accessToken) => call("/user", { method: "GET", token: accessToken }) as Promise<Record<string, unknown>>,
    refresh: (refreshToken) => call("/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } }) as Promise<TokenResponse>,
  };
}

/** Strip an optional `Bearer ` prefix (case-insensitive) and surrounding whitespace. */
function stripBearer(raw: string): string {
  return raw.replace(/^\s*Bearer\s+/i, "").trim();
}

/** Pull a bearer token out of the many request/header shapes `verifyRequest` accepts. Returns null when
 *  no token is present. */
function extractToken(req: TokenSource | null | undefined): string | null {
  if (req == null) return null;
  if (typeof req === "string") return stripBearer(req) || null;

  const anyReq = req as { headers?: unknown; get?: (name: string) => string | null };
  // A Headers-like object passed directly (has its own `.get`).
  if (typeof anyReq.get === "function" && anyReq.headers === undefined) {
    const raw = anyReq.get("authorization") ?? anyReq.get("Authorization");
    return raw ? stripBearer(raw) || null : null;
  }
  const headers: unknown = anyReq.headers ?? req;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const h = headers as { get: (name: string) => string | null };
    const raw = h.get("authorization") ?? h.get("Authorization");
    return raw ? stripBearer(raw) || null : null;
  }
  if (headers && typeof headers === "object") {
    const h = headers as Record<string, unknown>;
    const raw = h["authorization"] ?? h["Authorization"];
    const val = Array.isArray(raw) ? raw[0] : raw;
    return typeof val === "string" ? stripBearer(val) || null : null;
  }
  return null;
}

/** Only string entries of an array claim, else []. */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Verify an incoming request's bearer token and return the authenticated user + RBAC claims.
 *
 * HS256, constant-time, with an exp/nbf check. Accepts either the current or the previous signing secret
 * (the key-rotation grace window). `secret`/`previousSecret` default to `AUTH_JWT_SECRET` /
 * `AUTH_JWT_SECRET_PREVIOUS`. Throws `AuthError` on any failure (no token, bad signature, expired, nbf,
 * malformed). Async + Node-only (lazy-imports `node:crypto`).
 */
export async function verifyRequest(
  req: TokenSource | null | undefined,
  opts: { secret?: string; previousSecret?: string; now?: number } = {},
): Promise<VerifiedRequest> {
  const token = extractToken(req);
  if (!token) throw new AuthError("no bearer token on the request", "no_token");

  const secret = opts.secret ?? env("AUTH_JWT_SECRET");
  const previousSecret = opts.previousSecret ?? env("AUTH_JWT_SECRET_PREVIOUS");
  if (!secret && !previousSecret) {
    throw new AuthError("no verification secret — set AUTH_JWT_SECRET (Drop injects it) or pass { secret }", "no_secret");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed token (expected three JWT segments)", "malformed");
  const [h, p, sig] = parts as [string, string, string];
  const signingInput = `${h}.${p}`;

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const matches = (s: string | undefined): boolean => {
    if (!s) return false;
    const expected = createHmac("sha256", s).update(signingInput).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!matches(secret) && !matches(previousSecret)) throw new AuthError("token signature does not verify", "bad_signature");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AuthError("token claims are not valid JSON", "malformed");
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw new AuthError("token has expired", "expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new AuthError("token is not valid yet (nbf)", "not_yet_valid");

  return {
    user: {
      id: typeof payload.sub === "string" ? payload.sub : String(payload.sub ?? ""),
      email: typeof payload.email === "string" ? payload.email : undefined,
    },
    roles: strArray(payload.roles),
    permissions: strArray(payload.permissions),
    claims: payload,
  };
}
