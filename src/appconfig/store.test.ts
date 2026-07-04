import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { AppConfigStore, ConfigValidationError, validateConfigKey, looksLikeSecret, MAX_VALUE_BYTES } from "./store.ts";

// app_configs.app FKs sites.name, so a store fixture needs an app row to hang config off.
async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  const meta = new MetaStore(db);
  await meta.claimSite("myapp", "alice@x.com", "app", { id: org.id, namespace: org.namespace });
  return { db, store: new AppConfigStore(db) };
}

test("validateConfigKey: env-var-ish names only", () => {
  expect(validateConfigKey("FEATURE_X")).toBeNull();
  expect(validateConfigKey("feature.newUi")).toBeNull();
  expect(validateConfigKey("_hidden")).toBeNull();
  expect(validateConfigKey("a".repeat(128))).toBeNull();
  expect(validateConfigKey("1BAD")).not.toBeNull(); // leading digit
  expect(validateConfigKey("has space")).not.toBeNull();
  expect(validateConfigKey("a".repeat(129))).not.toBeNull(); // too long
  expect(validateConfigKey("no-dash")).not.toBeNull();
  expect(validateConfigKey(42)).not.toBeNull();
});

test("looksLikeSecret: refuses secret-y KEYS and high-entropy VALUES; passes ordinary config", () => {
  // secret-y key names
  expect(looksLikeSecret("API_KEY", "42")).not.toBeNull();
  expect(looksLikeSecret("DB_PASSWORD", "x")).not.toBeNull();
  expect(looksLikeSecret("STRIPE_SECRET", "x")).not.toBeNull();
  expect(looksLikeSecret("AUTH_TOKEN", "x")).not.toBeNull();
  // high-entropy value (a real credential) even under a benign key name
  expect(looksLikeSecret("BLOB", "9aF3kQ2mZ7pL1xR8vT4wYbN6cD0eG5hJ7tWq")).not.toBeNull();
  // ordinary, non-secret config passes — incl. prose (whitespace), URLs, slugs, and short values
  expect(looksLikeSecret("FEATURE_NEW_UI", "true")).toBeNull();
  expect(looksLikeSecret("MAX_UPLOAD_MB", "25")).toBeNull();
  expect(looksLikeSecret("THEME", "dark")).toBeNull();
  expect(looksLikeSecret("WELCOME_MESSAGE", "Hello and welcome to our app")).toBeNull();
  expect(looksLikeSecret("API_BASE_URL", "https://api.example.com/v2/webhook")).toBeNull(); // URLs are config, not secrets
  expect(looksLikeSecret("REGION", "us-east-1-prod")).toBeNull();
  expect(looksLikeSecret("RELEASE", "550e8400-e29b-41d4-a716-446655440000")).toBeNull(); // a UUID is not a credential
});

test("set/get: stores non-secret values; version is an ETag that bumps on every mutation", async () => {
  const { db, store } = await fix();
  expect(await store.get("myapp")).toEqual({ map: {}, version: 0 });

  const s1 = await store.set("myapp", "FEATURE_X", "on", "Alice@X.com");
  expect(s1.map).toEqual({ FEATURE_X: "on" });
  expect(s1.version).toBe(1);

  const s2 = await store.set("myapp", "THEME", "dark", "alice@x.com");
  expect(s2.map).toEqual({ FEATURE_X: "on", THEME: "dark" });
  expect(s2.version).toBe(2); // bumped

  // updatedBy is lowercased (parity with the other stores)
  const list = await store.list("myapp");
  expect(list.find((e) => e.key === "FEATURE_X")!.updatedBy).toBe("alice@x.com");
  await db.destroy();
});

test("set: a no-op set (identical value) does NOT churn the ETag", async () => {
  const { db, store } = await fix();
  const s1 = await store.set("myapp", "K", "v", "alice@x.com");
  expect(s1.version).toBe(1);
  const s2 = await store.set("myapp", "K", "v", "alice@x.com"); // same value
  expect(s2.version).toBe(1); // unchanged — the SDK poll won't see a spurious change
  const s3 = await store.set("myapp", "K", "v2", "alice@x.com"); // new value
  expect(s3.version).toBe(2);
  await db.destroy();
});

test("rm: bumps the ETag and keeps it monotonic when a NON-highest row is removed", async () => {
  const { db, store } = await fix();
  await store.set("myapp", "A", "1", "alice@x.com"); // v1
  await store.set("myapp", "B", "2", "alice@x.com"); // v2 (MAX)
  const before = await store.get("myapp");
  expect(before.version).toBe(2);

  // Remove A (the NON-highest row). A naive MAX(version) would stay 2 → a false 304. The store re-stamps
  // the surviving highest row so the app version advances.
  const afterRm = await store.rm("myapp", "A");
  expect(afterRm.map).toEqual({ B: "2" });
  expect(afterRm.version).toBe(3); // advanced past 2 → the poll sees a change

  // A no-op rm (missing key) does NOT bump.
  const noop = await store.rm("myapp", "NOPE");
  expect(noop.version).toBe(3);
  await db.destroy();
});

test("rm: removing the last key resets the app version to 0 (empty)", async () => {
  const { db, store } = await fix();
  await store.set("myapp", "ONLY", "x", "alice@x.com");
  const empty = await store.rm("myapp", "ONLY");
  expect(empty).toEqual({ map: {}, version: 0 });
  // re-adding starts a fresh count; any prior non-zero ETag differs → no false 304
  const re = await store.set("myapp", "ONLY", "y", "alice@x.com");
  expect(re.version).toBe(1);
  await db.destroy();
});

test("set: refuses credential-looking values with a friendly message (the D1 heuristic)", async () => {
  const { db, store } = await fix();
  await expect(store.set("myapp", "API_KEY", "whatever", "alice@x.com")).rejects.toMatchObject({ reason: "looks_secret" });
  await expect(store.set("myapp", "BLOB", "9aF3kQ2mZ7pL1xR8vT4wYbN6cD0eG5hJ7tWq", "alice@x.com")).rejects.toBeInstanceOf(ConfigValidationError);
  // the message steers the user to the secret path
  await expect(store.set("myapp", "DB_PASSWORD", "hunter2", "alice@x.com")).rejects.toThrow(/drop secrets set/);
  // nothing was written
  expect(await store.get("myapp")).toEqual({ map: {}, version: 0 });
  await db.destroy();
});

test("set: enforces the value size cap + key shape", async () => {
  const { db, store } = await fix();
  await expect(store.set("myapp", "BIG", "x".repeat(MAX_VALUE_BYTES + 1), "alice@x.com")).rejects.toMatchObject({ reason: "too_large" });
  await expect(store.set("myapp", "1BAD", "x", "alice@x.com")).rejects.toMatchObject({ reason: "bad_key" });
  // exactly at the cap is fine
  const ok = await store.set("myapp", "ATCAP", "x".repeat(MAX_VALUE_BYTES), "alice@x.com");
  expect(ok.version).toBe(1);
  await db.destroy();
});
