import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "./store.ts";

test("upsertOnLogin creates then updates, single row", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  const a = await u.upsertOnLogin("a@x.com", "Ayla");
  expect(a.role).toBe("member");
  expect(a.name).toBe("Ayla");
  const b = await u.upsertOnLogin("a@x.com", "Ayla R");
  expect(b.name).toBe("Ayla R");
  // a null name on a later login must not wipe the stored name
  const c = await u.upsertOnLogin("a@x.com", null);
  expect(c.name).toBe("Ayla R");
  expect((await u.listUsers()).length).toBe(1);
  await db.destroy();
});

test("seedAdmins promotes listed emails to admin, idempotent, login does not demote", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  await u.seedAdmins(["boss@x.com"]);
  await u.seedAdmins(["boss@x.com"]);
  expect((await u.getUser("boss@x.com"))!.role).toBe("admin");
  await u.upsertOnLogin("boss@x.com", "Boss");
  expect((await u.getUser("boss@x.com"))!.role).toBe("admin");
  await db.destroy();
});

test("setRole changes the platform role", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  await u.upsertOnLogin("a@x.com", null);
  await u.setRole("a@x.com", "admin");
  expect((await u.getUser("a@x.com"))!.role).toBe("admin");
  await db.destroy();
});

test("email is canonicalized to lowercase across the store (suspension lookups must match login)", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  // login with a mixed-case IdP email — must be stored lowercase…
  await u.upsertOnLogin("Bob@Example.com", "Bob");
  expect((await u.getUser("bob@example.com"))?.email).toBe("bob@example.com");
  expect((await u.getUser("BOB@EXAMPLE.COM"))?.email).toBe("bob@example.com"); // lookup is case-insensitive too
  // …so a status change keyed on any casing matches the single row (the kill-switch works).
  expect(await u.setStatus("BOB@EXAMPLE.COM", "suspended")).toBe(true);
  expect((await u.getUser("bob@example.com"))?.status).toBe("suspended");
  // and a re-login with different casing doesn't create a second row
  await u.upsertOnLogin("BOB@example.COM", null);
  expect((await u.listUsers()).filter((x) => x.email.includes("bob"))).toHaveLength(1);
  await db.destroy();
});

test("getUser returns null for unknown", async () => {
  const db = await makeTestDb();
  expect(await new UserStore(db).getUser("nobody@x.com")).toBeNull();
  await db.destroy();
});
