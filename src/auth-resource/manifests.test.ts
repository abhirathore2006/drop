import { test, expect } from "bun:test";
import { authManifests, authExternalUrl } from "./manifests.ts";
import { GoTrueEngine, GOTRUE_IMAGE } from "./gotrue.ts";
import { FakeEngine } from "./engine.ts";
import { sanitizeAuthConfig } from "../auth-config.ts";
import { generateJwtSecret, mintAdminToken, verifyHs256, signHs256 } from "./jwt.ts";

const engine = new GoTrueEngine();
const cfg = sanitizeAuthConfig({ redirect_urls: ["https://myapp.example.com/cb"], jwt_ttl: "1h", signup: "open" })!;
const ctx = { name: "myauth", namespace: "org-acme", host: "auth--myauth.drop.example.com", db: "authdb", jwtSecret: "s3cr3t-signing-key" };

function containerOf(m: ReturnType<typeof authManifests>): any {
  return (m.deployment as any).spec.template.spec.containers[0];
}
function envMap(container: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of container.env) if (typeof e.value === "string") out[e.name] = e.value;
  return out;
}

test("engine image is pinned to a concrete v2 tag (never :latest / moving :v2)", () => {
  expect(GOTRUE_IMAGE).toBe("docker.io/supabase/gotrue:v2.170.0");
  expect(GOTRUE_IMAGE).not.toContain(":latest");
  expect(engine.image).toBe(GOTRUE_IMAGE);
  expect(engine.jwtAlg).toBe("HS256");
});

test("Deployment is pinned 1/1 (HTTPScaledObject min:1/max:1) — auth can't cold-start", () => {
  const m = authManifests(cfg, engine, ctx);
  expect((m.httpScaledObject as any).spec.replicas).toEqual({ min: 1, max: 1 });
  expect((m.httpScaledObject as any).spec.hosts).toEqual(["auth--myauth.drop.example.com"]);
  expect((m.deployment as any).spec.strategy).toEqual({ type: "Recreate" });
});

test("Service exposes the engine port (9999) and the HSO routes at it", () => {
  const m = authManifests(cfg, engine, ctx);
  expect((m.service as any).spec.ports).toEqual([{ name: "http", port: 9999, targetPort: 9999 }]);
  expect((m.httpScaledObject as any).spec.scaleTargetRef.port).toBe(9999);
});

test("DATABASE_URL is composed via k8s $(VAR) interpolation from valueFrom DB creds (defined EARLIER)", () => {
  const m = authManifests(cfg, engine, ctx);
  const c = containerOf(m);
  const names = c.env.map((e: any) => e.name);
  // DB_USER + DB_PASSWORD are secretKeyRef entries that appear BEFORE the URL that references them.
  const iUser = names.indexOf("DB_USER");
  const iPass = names.indexOf("DB_PASSWORD");
  const iUrl = names.indexOf("GOTRUE_DB_DATABASE_URL");
  expect(iUser).toBeGreaterThanOrEqual(0);
  expect(iPass).toBeGreaterThanOrEqual(0);
  expect(iUrl).toBeGreaterThan(iUser);
  expect(iUrl).toBeGreaterThan(iPass);
  const dbUser = c.env[iUser];
  const dbPass = c.env[iPass];
  expect(dbUser.valueFrom.secretKeyRef).toEqual({ name: "authdb-app", key: "username" });
  expect(dbPass.valueFrom.secretKeyRef).toEqual({ name: "authdb-app", key: "password" });
  const url = c.env[iUrl].value as string;
  expect(url).toBe("postgres://$(DB_USER):$(DB_PASSWORD)@authdb-rw:5432/app?sslmode=verify-full&sslrootcert=/var/run/drop/db-ca/authdb/ca.crt");
});

test("CA is mounted read-only from the bound db's <db>-ca Secret (B1 reuse)", () => {
  const m = authManifests(cfg, engine, ctx);
  const c = containerOf(m);
  const vol = (m.deployment as any).spec.template.spec.volumes[0];
  expect(vol.secret.secretName).toBe("authdb-ca");
  expect(c.volumeMounts[0]).toEqual({ name: "db-ca-authdb", mountPath: "/var/run/drop/db-ca/authdb", readOnly: true });
});

test("JWT secret is wired via valueFrom (never a plaintext env value); config env is present", () => {
  const m = authManifests(cfg, engine, ctx);
  const c = containerOf(m);
  const jwt = c.env.find((e: any) => e.name === "GOTRUE_JWT_SECRET");
  expect(jwt.valueFrom.secretKeyRef).toEqual({ name: "myauth-auth-keys", key: "jwt-secret" });
  expect(jwt.value).toBeUndefined(); // NEVER a plaintext value
  const env = envMap(c);
  expect(env.GOTRUE_DB_DRIVER).toBe("postgres");
  expect(env.API_EXTERNAL_URL).toBe("https://auth--myauth.drop.example.com");
  expect(env.GOTRUE_SITE_URL).toBe("https://myapp.example.com/cb");
  expect(env.GOTRUE_URI_ALLOW_LIST).toBe("https://myapp.example.com/cb");
  expect(env.GOTRUE_MAILER_AUTOCONFIRM).toBe("true"); // email verification OFF (no SMTP v1)
  expect(env.GOTRUE_DISABLE_SIGNUP).toBe("false"); // signup open
  expect(env.GOTRUE_JWT_ADMIN_ROLES).toBe("service_role");
});

test("provider client id → non-secret env; provider SECRET comes from the write-only <name>-secret envFrom (never plaintext)", () => {
  const withProviders = sanitizeAuthConfig({ providers: { google: { client_id: "g-123" } }, redirect_urls: [] })!;
  const m = authManifests(withProviders, engine, ctx);
  const c = containerOf(m);
  const env = envMap(c);
  expect(env.GOTRUE_EXTERNAL_GOOGLE_ENABLED).toBe("true");
  expect(env.GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID).toBe("g-123");
  expect(env.GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI).toBe("https://auth--myauth.drop.example.com/callback");
  // the SECRET is NOT anywhere in plaintext env — it arrives via the optional write-only Secret envFrom.
  const flat = JSON.stringify(c.env);
  expect(flat).not.toContain("GOTRUE_EXTERNAL_GOOGLE_SECRET");
  expect(c.envFrom).toEqual([{ secretRef: { name: "myauth-secret", optional: true } }]);
});

test("keys Secret emitted ONLY when jwtSecret present (create/rotate); absent on a plain re-apply", () => {
  const withKey = authManifests(cfg, engine, ctx);
  expect((withKey.keysSecret as any).metadata.name).toBe("myauth-auth-keys");
  expect((withKey.keysSecret as any).stringData).toEqual({ "jwt-secret": "s3cr3t-signing-key" });
  const reapply = authManifests(cfg, engine, { ...ctx, jwtSecret: undefined });
  expect(reapply.keysSecret).toBeUndefined();
});

test("the plaintext JWT secret NEVER appears in the Deployment (only in the keys Secret + a secretKeyRef)", () => {
  const m = authManifests(cfg, engine, ctx);
  expect(JSON.stringify(m.deployment)).not.toContain("s3cr3t-signing-key");
  // it lives ONLY in the keysSecret stringData.
  expect(JSON.stringify(m.keysSecret)).toContain("s3cr3t-signing-key");
});

test("interceptor NetworkPolicy allows keda → the engine pod on its port", () => {
  const m = authManifests(cfg, engine, ctx);
  const np = m.ingressPolicy as any;
  expect(np.metadata.name).toBe("myauth-allow-interceptor");
  expect(np.spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 9999 }]);
  expect(np.spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("keda");
});

test("authExternalUrl builds the auth-- host", () => {
  expect(authExternalUrl("myauth", "drop.example.com")).toBe("https://auth--myauth.drop.example.com");
});

test("FakeEngine + GoTrueEngine agree on the admin-route surface", () => {
  const fake = new FakeEngine();
  for (const [op, arg] of [["listUsers", undefined], ["createUser", undefined], ["deleteUser", "u1"], ["updateUser", "u1"]] as const) {
    expect(fake.adminPath(op, arg).method).toBe(engine.adminPath(op, arg).method);
    expect(fake.adminPath(op, arg).path).toBe(engine.adminPath(op, arg).path.replace("/admin/users", "/admin/users"));
  }
  expect(engine.adminPath("deleteUser", "u1")).toEqual({ method: "DELETE", path: "/admin/users/u1" });
});

// ---- HS256 JWT primitives (the shipped alg) + isolation ----

test("mintAdminToken is a verifiable service-role HS256 token", () => {
  const secret = generateJwtSecret();
  const tok = mintAdminToken(secret, { ttlS: 60 });
  const claims = verifyHs256(secret, tok)!;
  expect(claims.role).toBe("service_role");
  expect(typeof claims.exp).toBe("number");
});

test("ISOLATION: a token signed by resource A's secret FAILS resource B's secret", () => {
  const a = generateJwtSecret();
  const b = generateJwtSecret();
  const tok = signHs256(a, { sub: "user-1" }, { ttlS: 3600 });
  expect(verifyHs256(a, tok)).not.toBeNull(); // valid under A
  expect(verifyHs256(b, tok)).toBeNull(); // rejected under B — resources are cryptographically isolated
});

test("an expired token fails verification", () => {
  const s = generateJwtSecret();
  const tok = signHs256(s, {}, { ttlS: 10, nowS: 1000 });
  expect(verifyHs256(s, tok, 2000)).toBeNull(); // now past exp
});
