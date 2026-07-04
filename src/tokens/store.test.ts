import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { ServiceTokenStore, TOKEN_PREFIX } from "./store.ts";
import { parseScope, validateScopes, scopeAllows } from "../authz/permissions.ts";

// ---- scope grammar (pure) ----------------------------------------------------------------------

test("parseScope: bare verb, verb:name, verb:*, and the colon-bearing db:create verb", () => {
  expect(parseScope("deploy")).toEqual({ verb: "deploy", resource: "*" });
  expect(parseScope("deploy:*")).toEqual({ verb: "deploy", resource: "*" });
  expect(parseScope("deploy:myapp")).toEqual({ verb: "deploy", resource: "myapp" });
  // db:create contains a colon — must NOT be mis-split into verb "db" + resource "create"
  expect(parseScope("db:create")).toEqual({ verb: "db:create", resource: "*" });
  expect(parseScope("db:create:mydb")).toEqual({ verb: "db:create", resource: "mydb" });
  expect(parseScope("db:create:*")).toEqual({ verb: "db:create", resource: "*" });
});

test("parseScope: unknown verbs and malformed scopes → null", () => {
  expect(parseScope("nope")).toBeNull();
  expect(parseScope("db")).toBeNull(); // "db" is not a verb; only "db:create" is
  expect(parseScope("deploy:")).toBeNull(); // empty resource
  expect(parseScope("")).toBeNull();
});

test("validateScopes: rejects empty lists, non-strings, and unknown verbs", () => {
  expect(validateScopes(["deploy:myapp", "publish:*", "db:create"])).toBeNull();
  expect(validateScopes([])).toMatch(/at least one scope/);
  expect(validateScopes("deploy")).toMatch(/at least one scope/); // not an array
  expect(validateScopes([123])).toMatch(/must be a string/);
  expect(validateScopes(["deploy:myapp", "frobnicate"])).toMatch(/invalid scope "frobnicate"/);
});

test("scopeAllows: exact resource, wildcard, verb mismatch, unknown verb", () => {
  const s = ["deploy:myapp", "publish:*", "db:create"];
  expect(scopeAllows(s, "deploy", "myapp")).toBe(true); // exact
  expect(scopeAllows(s, "deploy", "other")).toBe(false); // scoped to myapp only
  expect(scopeAllows(s, "publish", "anything")).toBe(true); // publish:* wildcard
  expect(scopeAllows(s, "db:create", "mydb")).toBe(true); // bare verb → all resources
  expect(scopeAllows(s, "delete", "myapp")).toBe(false); // verb not granted
  expect(scopeAllows(["read"], "read", "x")).toBe(true);
  expect(scopeAllows(["read"], "logs", "x")).toBe(false);
});

// ---- store (PGlite + injectable clock) ---------------------------------------------------------

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  return { db, orgId: org.id };
}

test("create returns a drop_st_ secret once; verify resolves org + scopes; only the hash is stored", async () => {
  const { db, orgId } = await fix();
  const store = new ServiceTokenStore(db);
  const { token, row } = await store.create(orgId, "ci", ["deploy:myapp"], null, "alice@x.com");
  expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
  expect(row.name).toBe("ci");
  expect(row.scopes).toEqual(["deploy:myapp"]);
  expect(row.revokedAt).toBeNull();
  // the plaintext secret is NEVER persisted — only its sha256 hash
  const raw = await db.selectFrom("service_tokens").select(["token_hash"]).where("id", "=", row.id).executeTakeFirst();
  expect(raw!.token_hash).not.toContain(token);
  expect(raw!.token_hash).toHaveLength(64);

  const v = await store.verify(token);
  expect(v).toEqual({ orgId, tokenId: row.id, name: "ci", scopes: ["deploy:myapp"] });
  // a non-service / unknown token → null (lets the auth chain try the next verifier)
  expect(await store.verify("garbage")).toBeNull();
  expect(await store.verify(TOKEN_PREFIX + "deadbeef")).toBeNull();
  await db.destroy();
});

test("expiry: verify returns null once expires_at passes (injectable clock)", async () => {
  const { db, orgId } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new ServiceTokenStore(db, () => t);
  const { token } = await store.create(orgId, "ci", ["deploy:*"], new Date("2026-01-02T00:00:00Z"), "alice@x.com");
  expect(await store.verify(token)).not.toBeNull(); // before expiry
  t = new Date("2026-01-03T00:00:00Z"); // now past expiry
  expect(await store.verify(token)).toBeNull();
  await db.destroy();
});

test("revoke is a soft mark: verify → null, the row survives, second revoke is a no-op", async () => {
  const { db, orgId } = await fix();
  const store = new ServiceTokenStore(db);
  const { token, row } = await store.create(orgId, "ci", ["deploy:*"], null, "alice@x.com");
  expect(await store.verify(token)).not.toBeNull();
  expect(await store.revoke(row.id)).toBe(true);
  expect(await store.verify(token)).toBeNull(); // revoked → 401 upstream
  const still = await store.get(row.id);
  expect(still).not.toBeNull(); // row kept for audit value
  expect(still!.revokedAt).not.toBeNull();
  expect(await store.revoke(row.id)).toBe(false); // idempotent
  expect(await store.revoke("st_nope")).toBe(false); // unknown
  await db.destroy();
});

test("last_used_at is bumped throttled (~1/min)", async () => {
  const { db, orgId } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new ServiceTokenStore(db, () => t);
  const { token, row } = await store.create(orgId, "ci", ["deploy:*"], null, "alice@x.com");
  expect((await store.get(row.id))!.lastUsedAt).toBeNull();

  await store.verify(token); // first use → sets last_used_at = t0
  const first = (await store.get(row.id))!.lastUsedAt;
  expect(first).not.toBeNull();

  t = new Date("2026-01-01T00:00:30Z"); // +30s: within the throttle window → NO bump
  await store.verify(token);
  expect((await store.get(row.id))!.lastUsedAt).toBe(first);

  t = new Date("2026-01-01T00:01:05Z"); // +65s: past the window → bumped
  await store.verify(token);
  expect((await store.get(row.id))!.lastUsedAt).not.toBe(first);
  await db.destroy();
});

test("list is newest-first, org-scoped, and never leaks a hash", async () => {
  const { db, orgId } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new ServiceTokenStore(db, () => t);
  await store.create(orgId, "one", ["read"], null, "alice@x.com");
  t = new Date("2026-01-01T00:00:05Z");
  await store.create(orgId, "two", ["deploy:*"], null, "alice@x.com");
  const list = await store.list(orgId);
  expect(list.map((tk) => tk.name)).toEqual(["two", "one"]); // created_at desc
  expect(Object.keys(list[0]!)).not.toContain("token_hash");
  await db.destroy();
});
