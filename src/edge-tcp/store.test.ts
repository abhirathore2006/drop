import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { TcpEndpointStore, PortPoolExhaustedError } from "./store.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  return { db, meta, orgs, tcp: new TcpEndpointStore(db) };
}

async function claim(t: { meta: MetaStore; orgs: OrgStore }, name: string, type: "app" | "database") {
  const o = await t.orgs.ensurePersonalOrg("alice@x.com");
  await t.meta.claimSite(name, "alice@x.com", type, { id: o.id, namespace: o.namespace });
  return o.namespace;
}

test("exposeSni upserts a null-port row and resolves with type + namespace", async () => {
  const { db, meta, orgs, tcp } = await fix();
  const ns = await claim({ meta, orgs }, "pg", "database");
  const ep = await tcp.exposeSni("pg", "postgres", "alice@x.com");
  expect(ep).toMatchObject({ siteName: "pg", port: null, mode: "sni", protocol: "postgres" });
  const r = await tcp.resolveSni("pg");
  expect(r).toMatchObject({ mode: "sni", type: "database", namespace: ns });
  expect(await tcp.resolvePort(7000)).toBeNull(); // no port-mode row
  await db.destroy();
});

test("exposePort allocates the lowest free port and resolves it", async () => {
  const { db, meta, orgs, tcp } = await fix();
  await claim({ meta, orgs }, "a", "app");
  await claim({ meta, orgs }, "b", "app");
  const a = await tcp.exposePort("a", "tcp", "alice@x.com", 7000, 7099);
  expect(a.port).toBe(7000);
  const b = await tcp.exposePort("b", "redis", "alice@x.com", 7000, 7099);
  expect(b.port).toBe(7001); // lowest FREE
  const r = await tcp.resolvePort(7001);
  expect(r).toMatchObject({ siteName: "b", mode: "port", protocol: "redis", type: "app" });
  await db.destroy();
});

test("a freed port is reused (lowest-free fills the gap)", async () => {
  const { db, meta, orgs, tcp } = await fix();
  for (const n of ["a", "b", "c"]) await claim({ meta, orgs }, n, "app");
  expect((await tcp.exposePort("a", "tcp", "alice@x.com", 7000, 7099)).port).toBe(7000);
  expect((await tcp.exposePort("b", "tcp", "alice@x.com", 7000, 7099)).port).toBe(7001);
  await tcp.unexpose("a"); // frees 7000
  expect((await tcp.exposePort("c", "tcp", "alice@x.com", 7000, 7099)).port).toBe(7000);
  await db.destroy();
});

test("port allocation is unique across a full pool, then exhausts with 409-signal error", async () => {
  const { db, meta, orgs, tcp } = await fix();
  for (const n of ["a", "b", "c"]) await claim({ meta, orgs }, n, "app");
  const p1 = (await tcp.exposePort("a", "tcp", "alice@x.com", 7000, 7001)).port;
  const p2 = (await tcp.exposePort("b", "tcp", "alice@x.com", 7000, 7001)).port;
  expect(new Set([p1, p2])).toEqual(new Set([7000, 7001])); // both distinct ports in the 2-wide pool
  await expect(tcp.exposePort("c", "tcp", "alice@x.com", 7000, 7001)).rejects.toBeInstanceOf(PortPoolExhaustedError);
  await db.destroy();
});

test("re-expose switches mode and frees the old port; sni consumes none", async () => {
  const { db, meta, orgs, tcp } = await fix();
  await claim({ meta, orgs }, "a", "app");
  await claim({ meta, orgs }, "b", "app");
  await tcp.exposePort("a", "tcp", "alice@x.com", 7000, 7099); // a → 7000
  await tcp.exposeSni("a", "postgres", "alice@x.com"); // a switches to sni, freeing 7000
  expect((await tcp.get("a"))!.port).toBeNull();
  expect((await tcp.exposePort("b", "tcp", "alice@x.com", 7000, 7099)).port).toBe(7000); // 7000 reusable
  await db.destroy();
});

test("listForNamespace returns every exposed workload in a namespace", async () => {
  const { db, meta, orgs, tcp } = await fix();
  const ns = await claim({ meta, orgs }, "pg", "database");
  await claim({ meta, orgs }, "app1", "app");
  await tcp.exposeSni("pg", "postgres", "alice@x.com");
  await tcp.exposePort("app1", "tcp", "alice@x.com", 7000, 7099);
  const list = await tcp.listForNamespace(ns);
  expect(list.map((e) => e.siteName).sort()).toEqual(["app1", "pg"]);
  expect(list.find((e) => e.siteName === "pg")).toMatchObject({ mode: "sni", type: "database" });
  expect(await tcp.listForNamespace("drop-t-nobody-00000000")).toEqual([]);
  await db.destroy();
});

test("unexpose is idempotent and clears resolution", async () => {
  const { db, meta, orgs, tcp } = await fix();
  await claim({ meta, orgs }, "pg", "database");
  await tcp.exposeSni("pg", "postgres", "alice@x.com");
  await tcp.unexpose("pg");
  await tcp.unexpose("pg"); // no-op
  expect(await tcp.get("pg")).toBeNull();
  expect(await tcp.resolveSni("pg")).toBeNull();
  await db.destroy();
});
