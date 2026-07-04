import { test, expect } from "bun:test";
import { sanitizeAuthConfig, parseAuthConfig, jwtTtlSeconds, PROVIDER_SECRET_ENV } from "./auth-config.ts";

test("sanitizeAuthConfig defaults: open signup, 1h ttl, no providers/redirects", () => {
  expect(sanitizeAuthConfig({})).toEqual({ redirect_urls: [], jwt_ttl: "1h", signup: "open" });
  expect(sanitizeAuthConfig(null)).toEqual({ redirect_urls: [], jwt_ttl: "1h", signup: "open" });
  expect(sanitizeAuthConfig("nonsense")).toBeUndefined(); // clearly-invalid scalar
});

test("signup: only 'closed' flips from the default 'open'", () => {
  expect(sanitizeAuthConfig({ signup: "closed" })!.signup).toBe("closed");
  expect(sanitizeAuthConfig({ signup: "open" })!.signup).toBe("open");
  expect(sanitizeAuthConfig({ signup: "garbage" })!.signup).toBe("open"); // junk → default
});

test("jwt_ttl: valid durations kept, junk → default 1h", () => {
  expect(sanitizeAuthConfig({ jwt_ttl: "30m" })!.jwt_ttl).toBe("30m");
  expect(sanitizeAuthConfig({ jwt_ttl: "3600" })!.jwt_ttl).toBe("3600");
  expect(sanitizeAuthConfig({ jwt_ttl: "banana" })!.jwt_ttl).toBe("1h"); // junk → default
  // round-trip: the sanitized `jwtTtl` alias is also accepted
  expect(sanitizeAuthConfig({ jwtTtl: "2h" })!.jwt_ttl).toBe("2h");
});

test("jwtTtlSeconds parses + clamps to [60s, 24h]", () => {
  expect(jwtTtlSeconds("1h")).toBe(3600);
  expect(jwtTtlSeconds("30m")).toBe(1800);
  expect(jwtTtlSeconds("3600")).toBe(3600);
  expect(jwtTtlSeconds("1s")).toBe(60); // clamped up to the floor
  expect(jwtTtlSeconds("100h")).toBe(24 * 3600); // clamped to the ceiling
});

test("redirect_urls: only absolute http(s), de-duped, junk (relative / javascript:) dropped", () => {
  const c = sanitizeAuthConfig({
    redirect_urls: ["https://app.example.com/cb", "http://localhost:3000/x", "javascript:alert(1)", "/relative", "https://app.example.com/cb"],
  })!;
  expect(c.redirect_urls).toEqual(["https://app.example.com/cb", "http://localhost:3000/x"]);
});

test("providers: google/github non-secret client_id kept; secret NEVER accepted here; oidc needs issuer", () => {
  const c = sanitizeAuthConfig({
    providers: {
      google: { client_id: "g-123", secret: "SHOULD-BE-IGNORED" },
      github: { client_id: "gh-456" },
      oidc: { client_id: "o-789", issuer: "https://idp.example.com" },
      bogus: { client_id: "x" }, // unknown provider kind → ignored
    },
  })!;
  expect(c.providers).toEqual({
    google: { client_id: "g-123" }, // note: NO `secret` — the sanitizer never carries provider secrets
    github: { client_id: "gh-456" },
    oidc: { client_id: "o-789", issuer: "https://idp.example.com" },
  });
});

test("providers: a provider with no client_id is dropped; oidc with no issuer is dropped", () => {
  const c = sanitizeAuthConfig({ providers: { google: { foo: "bar" }, oidc: { client_id: "o-1" } } })!;
  expect(c.providers).toBeUndefined(); // both invalid → no providers block at all
});

test("reserved K-mail smtp/email keys are ACCEPTED + STORED (ignored by the engine, additive for K-mail)", () => {
  const c = sanitizeAuthConfig({ smtp: { host: "smtp.example.com", port: "587", junk: 5 }, email: { from: "no-reply@x.com" } })!;
  expect(c.smtp).toEqual({ host: "smtp.example.com", port: "587" }); // non-string junk dropped, strings preserved
  expect(c.email).toEqual({ from: "no-reply@x.com" });
});

test("rbac: only boolean true is stored; false/absent/junk → omitted (K2)", () => {
  expect(sanitizeAuthConfig({ rbac: true })!.rbac).toBe(true);
  expect(sanitizeAuthConfig({ rbac: false })!.rbac).toBeUndefined();
  expect(sanitizeAuthConfig({ rbac: "true" })!.rbac).toBeUndefined(); // string junk → not enabled
  expect(sanitizeAuthConfig({})!.rbac).toBeUndefined();
  // round-trip: a config with rbac:true re-sanitizes identically
  expect(sanitizeAuthConfig(sanitizeAuthConfig({ rbac: true }))).toEqual(sanitizeAuthConfig({ rbac: true }));
});

test("round-trip: re-sanitizing an AuthConfig yields the same AuthConfig", () => {
  const once = sanitizeAuthConfig({
    providers: { google: { client_id: "g" }, oidc: { client_id: "o", issuer: "https://i.example.com" } },
    redirect_urls: ["https://a.example.com/cb"],
    jwt_ttl: "45m",
    signup: "closed",
    site_url: "https://a.example.com",
    smtp: { host: "h" },
  });
  expect(sanitizeAuthConfig(once)).toEqual(once);
});

test("parseAuthConfig reads the auth: section; absent → undefined", () => {
  expect(parseAuthConfig("site:\n  redirects: []\n")).toBeUndefined();
  const c = parseAuthConfig("auth:\n  signup: closed\n  jwt_ttl: 15m\n");
  expect(c).toEqual({ redirect_urls: [], jwt_ttl: "15m", signup: "closed" });
});

test("provider secret env-key names are documented + stable", () => {
  expect(PROVIDER_SECRET_ENV.google).toBe("GOTRUE_EXTERNAL_GOOGLE_SECRET");
  expect(PROVIDER_SECRET_ENV.github).toBe("GOTRUE_EXTERNAL_GITHUB_SECRET");
  expect(PROVIDER_SECRET_ENV.oidc).toBe("GOTRUE_EXTERNAL_KEYCLOAK_SECRET");
});
