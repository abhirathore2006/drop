import { test, expect } from "bun:test";
import { AuditStore } from "./store.ts";
import { makeTestDb } from "../db/testdb.ts";

test("record + list newest-first with detail round-trip", async () => {
  const db = await makeTestDb();
  const audit = new AuditStore(db);
  await audit.record({ actor: "Alice@Example.com", action: "site.delete", target: "blog", targetType: "site" });
  await audit.record({ actor: "alice@example.com", action: "user.role.set", target: "bob@example.com", targetType: "user", detail: { role: "admin" } });
  const { entries } = await audit.list();
  expect(entries.length).toBe(2);
  expect(entries[0]!.action).toBe("user.role.set"); // newest first
  expect(entries[0]!.actor).toBe("alice@example.com"); // lowercased
  expect(entries[0]!.detail).toEqual({ role: "admin" });
  expect(entries[1]!.action).toBe("site.delete");
  await db.destroy();
});

test("filters by actor / target / action", async () => {
  const db = await makeTestDb();
  const audit = new AuditStore(db);
  await audit.record({ actor: "alice@example.com", action: "site.delete", target: "blog" });
  await audit.record({ actor: "bob@example.com", action: "site.delete", target: "shop" });
  await audit.record({ actor: "alice@example.com", action: "db.password.rotate", target: "db1" });
  expect((await audit.list({ actor: "alice@example.com" })).entries.length).toBe(2);
  expect((await audit.list({ target: "shop" })).entries.length).toBe(1);
  expect((await audit.list({ action: "site.delete" })).entries.length).toBe(2);
  await db.destroy();
});

test("keyset pagination via nextCursor", async () => {
  const db = await makeTestDb();
  const audit = new AuditStore(db);
  for (let i = 0; i < 5; i++) await audit.record({ actor: "a@x.com", action: "x", target: `t${i}` });
  const p1 = await audit.list({ limit: 2 });
  expect(p1.entries.length).toBe(2);
  expect(p1.nextCursor).toBeDefined();
  const p2 = await audit.list({ limit: 2, cursor: p1.nextCursor });
  expect(p2.entries.length).toBe(2);
  // pages are disjoint + monotonically older
  expect(Number(p2.entries[0]!.id)).toBeLessThan(Number(p1.entries[1]!.id));
  await db.destroy();
});
