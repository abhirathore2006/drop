import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { TunnelTicketStore, TICKET_PREFIX } from "./tunnel-tickets.ts";
import { can, scopeAllows, parseScope, type Actor } from "../authz/permissions.ts";

// ---- the `connect` verb (A3) -------------------------------------------------------------------
// connect authorizes opening a db:proxy tunnel — deliberately ABOVE viewer, at the deploy/ship tier.

test("connect: owner + editor + org member/admin/owner yes; viewer + stranger no", () => {
  const owner: Actor = { email: "o@x.com", platformRole: "member", siteRole: "owner", orgRole: null };
  const editor: Actor = { email: "e@x.com", platformRole: "member", siteRole: "editor", orgRole: null };
  const viewer: Actor = { email: "v@x.com", platformRole: "member", siteRole: "viewer", orgRole: null };
  const stranger: Actor = { email: "s@x.com", platformRole: "member", siteRole: null, orgRole: null };
  expect(can(owner, "connect")).toBe(true);
  expect(can(editor, "connect")).toBe(true); // opening a psql session is a routine dev action
  expect(can(viewer, "connect")).toBe(false); // a metadata-only viewer must NOT open a raw SQL session
  expect(can(stranger, "connect")).toBe(false);
  for (const role of ["owner", "admin", "member"] as const) {
    expect(can({ email: "m@x.com", platformRole: "member", siteRole: null, orgRole: role }, "connect")).toBe(true);
  }
  expect(can({ email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" }, "connect")).toBe(false);
});

test("connect is a first-class token scope (connect:<db> parses + grants like other verbs)", () => {
  expect(parseScope("connect:mydb")).toEqual({ verb: "connect", resource: "mydb" });
  expect(parseScope("connect")).toEqual({ verb: "connect", resource: "*" });
  expect(scopeAllows(["connect:mydb"], "connect", "mydb")).toBe(true);
  expect(scopeAllows(["connect:mydb"], "connect", "otherdb")).toBe(false); // scoped to mydb only
  expect(scopeAllows(["connect"], "connect", "anydb")).toBe(true); // bare verb → all databases
  expect(scopeAllows(["read:mydb"], "connect", "mydb")).toBe(false); // read doesn't imply connect
});

// ---- store (PGlite + injectable clock) ---------------------------------------------------------

async function fix() {
  const db = await makeTestDb();
  await new UserStore(db).upsertOnLogin("alice@x.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@x.com");
  const meta = new MetaStore(db);
  // Two databases so the wrong-db case is real.
  await meta.claimSite("mydb", "alice@x.com", "database", { id: org.id, namespace: org.namespace });
  await meta.claimSite("otherdb", "alice@x.com", "database", { id: org.id, namespace: org.namespace });
  return { db };
}

test("issue returns a drop_tt_ secret once; only its sha256 hash is stored", async () => {
  const { db } = await fix();
  const store = new TunnelTicketStore(db);
  const { ticket, expiresAt } = await store.issue("mydb", "alice@x.com");
  expect(ticket.startsWith(TICKET_PREFIX)).toBe(true);
  expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  const raw = await db.selectFrom("tunnel_tickets").select(["token_hash", "email", "site_name"]).executeTakeFirstOrThrow();
  expect(raw.token_hash).not.toContain(ticket);
  expect(raw.token_hash).toHaveLength(64);
  expect(raw.email).toBe("alice@x.com");
  expect(raw.site_name).toBe("mydb");
  await db.destroy();
});

test("redeem is single-use: the first redemption wins, a replay returns null", async () => {
  const { db } = await fix();
  const store = new TunnelTicketStore(db);
  const { ticket } = await store.issue("mydb", "alice@x.com");
  expect(await store.redeem(ticket, "mydb")).toEqual({ email: "alice@x.com", siteName: "mydb" });
  expect(await store.redeem(ticket, "mydb")).toBeNull(); // spent — replay-proof
  await db.destroy();
});

test("redeem is bound to the database: a ticket for mydb cannot open otherdb (and stays unspent)", async () => {
  const { db } = await fix();
  const store = new TunnelTicketStore(db);
  const { ticket } = await store.issue("mydb", "alice@x.com");
  expect(await store.redeem(ticket, "otherdb")).toBeNull(); // wrong db → no match
  expect(await store.redeem(ticket, "mydb")).not.toBeNull(); // the mydb ticket still works
  await db.destroy();
});

test("issue stamps a 60s TTL from the injectable clock; a redeem just inside the window succeeds", async () => {
  const { db } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new TunnelTicketStore(db, () => t, 60_000);
  const { ticket, expiresAt } = await store.issue("mydb", "alice@x.com");
  expect(new Date(expiresAt).toISOString()).toBe("2026-01-01T00:01:00.000Z");
  t = new Date("2026-01-01T00:00:59Z"); // 1s before expiry → still valid
  expect(await store.redeem(ticket, "mydb")).not.toBeNull();
  await db.destroy();
});

test("expiry: redeem past the TTL returns null", async () => {
  const { db } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new TunnelTicketStore(db, () => t, 60_000);
  const { ticket } = await store.issue("mydb", "alice@x.com");
  t = new Date("2026-01-01T00:02:00Z"); // 2 min later — past the 60s TTL
  expect(await store.redeem(ticket, "mydb")).toBeNull();
  await db.destroy();
});

test("unknown / non-ticket secrets → null (never throws)", async () => {
  const { db } = await fix();
  const store = new TunnelTicketStore(db);
  expect(await store.redeem("garbage", "mydb")).toBeNull();
  expect(await store.redeem(TICKET_PREFIX + "deadbeef", "mydb")).toBeNull();
  await db.destroy();
});

test("deleteExpired reaps spent + expired rows, keeps live ones", async () => {
  const { db } = await fix();
  let t = new Date("2026-01-01T00:00:00Z");
  const store = new TunnelTicketStore(db, () => t, 60_000);
  const spent = await store.issue("mydb", "alice@x.com");
  await store.redeem(spent.ticket, "mydb"); // → used
  await store.issue("otherdb", "alice@x.com"); // will expire
  t = new Date("2026-01-01T00:05:00Z");
  const live = await store.issue("mydb", "alice@x.com"); // fresh at t+5m
  const removed = await store.deleteExpired(); // now() = t; removes the used one + the expired one
  expect(removed).toBe(2);
  expect(await store.redeem(live.ticket, "mydb")).not.toBeNull(); // the live one survived
  await db.destroy();
});
