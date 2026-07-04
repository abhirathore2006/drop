import { test, expect } from "bun:test";
import { loadConfig, deriveDisplayName, isGoogleIssuer } from "./config.ts";

const BASE = { DROP_S3_BUCKET: "drop-sites", DROP_DATABASE_URL: "postgres://x/y" };

test("loadConfig reads env and applies defaults", () => {
  const c = loadConfig(BASE);
  expect(c.s3Bucket).toBe("drop-sites");
  expect(c.databaseUrl).toBe("postgres://x/y");
  expect(c.httpPort).toBe(8080);
  expect(c.baseDomain).toBe("drop.example.com");
  expect(c.keepVersions).toBe(10);
  expect(c.allowedDomains).toEqual([]);
  expect(c.devAuth).toBe(false);
  expect(c.blockedEgressCidrs).toEqual(["10.0.0.0/8"]); // local k3s default
});

test("loadConfig parses config-driven blocked egress CIDRs (prod EKS)", () => {
  const c = loadConfig({ ...BASE, DROP_BLOCKED_EGRESS_CIDRS: "172.16.0.0/12, 100.64.0.0/10 ,10.100.0.0/16" });
  expect(c.blockedEgressCidrs).toEqual(["172.16.0.0/12", "100.64.0.0/10", "10.100.0.0/16"]);
});

test("loadConfig parses allowed domains and dev auth", () => {
  const c = loadConfig({
    ...BASE,
    DROP_ALLOWED_DOMAINS: "example.com, example.org",
    DROP_DEV_AUTH: "1",
  });
  expect(c.allowedDomains).toEqual(["example.com", "example.org"]);
  expect(c.devAuth).toBe(true);
});

test("loadConfig throws when bucket missing", () => {
  expect(() => loadConfig({ DROP_DATABASE_URL: "postgres://x/y" })).toThrow();
});

test("loadConfig throws when database url missing", () => {
  expect(() => loadConfig({ DROP_S3_BUCKET: "b" })).toThrow();
});

// --- (J2) generic OIDC config -----------------------------------------------------------------

test("OIDC defaults: Google is the default issuer with sensible claim/scope defaults", () => {
  const c = loadConfig(BASE);
  expect(c.oidcIssuer).toBe("https://accounts.google.com");
  expect(c.oidcScopes).toBe("openid email profile");
  expect(c.oidcEmailClaim).toBe("email");
  expect(c.oidcNameClaim).toBe("name");
  expect(c.oidcDisplayName).toBe("Google"); // derived from the issuer host
  expect(c.oidcGroupsClaim).toBeUndefined();
  expect(c.oidcRequiredGroup).toBeUndefined();
  expect(c.breakGlassAdmin).toBeUndefined();
});

test("OIDC client id/secret fall back to the legacy DROP_GOOGLE_* vars (zero-migration)", () => {
  const c = loadConfig({ ...BASE, DROP_GOOGLE_CLIENT_ID: "gid", DROP_GOOGLE_CLIENT_SECRET: "gsec" });
  expect(c.oidcClientId).toBe("gid");
  expect(c.oidcClientSecret).toBe("gsec");
});

test("OIDC vars WIN over the legacy Google vars when both are set", () => {
  const c = loadConfig({
    ...BASE,
    DROP_GOOGLE_CLIENT_ID: "gid",
    DROP_GOOGLE_CLIENT_SECRET: "gsec",
    DROP_OIDC_CLIENT_ID: "oid",
    DROP_OIDC_CLIENT_SECRET: "osec",
  });
  expect(c.oidcClientId).toBe("oid");
  expect(c.oidcClientSecret).toBe("osec");
});

test("oidcAllowedDomains falls back to DROP_ALLOWED_DOMAINS, and DROP_OIDC_ALLOWED_DOMAINS overrides it", () => {
  expect(loadConfig({ ...BASE, DROP_ALLOWED_DOMAINS: "legacy.com" }).oidcAllowedDomains).toEqual(["legacy.com"]);
  expect(loadConfig({ ...BASE, DROP_ALLOWED_DOMAINS: "legacy.com", DROP_OIDC_ALLOWED_DOMAINS: "new.com, two.com" }).oidcAllowedDomains).toEqual(["new.com", "two.com"]);
  // explicit empty OIDC domains clears the gate even when the legacy var is set (OIDC wins)
  expect(loadConfig({ ...BASE, DROP_ALLOWED_DOMAINS: "legacy.com", DROP_OIDC_ALLOWED_DOMAINS: "" }).oidcAllowedDomains).toEqual([]);
});

test("OIDC generic provider config is read (Keycloak-style)", () => {
  const c = loadConfig({
    ...BASE,
    DROP_OIDC_ISSUER: "http://localhost:8580/realms/drop",
    DROP_OIDC_SCOPES: "openid email profile groups",
    DROP_OIDC_EMAIL_CLAIM: "email",
    DROP_OIDC_NAME_CLAIM: "preferred_username",
    DROP_OIDC_GROUPS_CLAIM: "groups",
    DROP_OIDC_REQUIRED_GROUP: "drop-users",
    DROP_OIDC_DISPLAY_NAME: "Keycloak",
    DROP_BREAK_GLASS_ADMIN: "admin@example.com:aa:bb",
  });
  expect(c.oidcIssuer).toBe("http://localhost:8580/realms/drop");
  expect(c.oidcScopes).toBe("openid email profile groups");
  expect(c.oidcNameClaim).toBe("preferred_username");
  expect(c.oidcGroupsClaim).toBe("groups");
  expect(c.oidcRequiredGroup).toBe("drop-users");
  expect(c.oidcDisplayName).toBe("Keycloak");
  expect(c.breakGlassAdmin).toBe("admin@example.com:aa:bb");
});

test("isGoogleIssuer only trusts accounts.google.com", () => {
  expect(isGoogleIssuer("https://accounts.google.com")).toBe(true);
  expect(isGoogleIssuer("https://dev-1.okta.com")).toBe(false);
  expect(isGoogleIssuer("http://localhost:8580/realms/drop")).toBe(false);
});

test("deriveDisplayName derives a friendly provider name from the issuer host", () => {
  expect(deriveDisplayName("https://accounts.google.com")).toBe("Google");
  expect(deriveDisplayName("https://dev-1.okta.com")).toBe("Okta");
  expect(deriveDisplayName("https://login.microsoftonline.com/common/v2.0")).toBe("Microsoftonline");
});
