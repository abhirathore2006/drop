import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore } from "../orgs/store.ts";
import { MetaStore } from "../metastore/store.ts";
import { TcpEndpointStore } from "./store.ts";
import { MetastoreRouteSource } from "./meta-source.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@x.com", null);
  const meta = new MetaStore(db);
  const orgs = new OrgStore(db);
  const o = await orgs.ensurePersonalOrg("alice@x.com");
  const claim = (name: string, type: "app" | "database") => meta.claimSite(name, "alice@x.com", type, { id: o.id, namespace: o.namespace });
  return { db, tcp: new TcpEndpointStore(db), claim, ns: o.namespace };
}

test("resolveSni maps an exposed app to its Service host:80", async () => {
  const { db, tcp, claim, ns } = await fix();
  await claim("web", "app");
  await tcp.exposeSni("web", "tcp", "alice@x.com");
  const src = new MetastoreRouteSource(db, { baseDomain: "drop.example.com" });
  expect(await src.resolveSni("web.drop.example.com")).toEqual({ host: `web.${ns}.svc.cluster.local`, port: 80, workload: "web" });
  // case-insensitive on the SNI hostname
  expect(await src.resolveSni("WEB.Drop.Example.Com")).toMatchObject({ workload: "web" });
  await db.destroy();
});

test("resolveSni maps an exposed database to its -rw Service host:5432", async () => {
  const { db, tcp, claim, ns } = await fix();
  await claim("pg", "database");
  await tcp.exposeSni("pg", "postgres", "alice@x.com");
  const src = new MetastoreRouteSource(db, { baseDomain: "drop.example.com" });
  expect(await src.resolveSni("pg.drop.example.com")).toEqual({ host: `pg-rw.${ns}.svc.cluster.local`, port: 5432, workload: "pg" });
  await db.destroy();
});

test("resolvePort maps an allocated port to its target; unallocated → null", async () => {
  const { db, tcp, claim, ns } = await fix();
  await claim("cache", "app");
  await tcp.exposePort("cache", "redis", "alice@x.com", 7000, 7099);
  const src = new MetastoreRouteSource(db, { baseDomain: "drop.example.com" });
  expect(await src.resolvePort(7000)).toEqual({ host: `cache.${ns}.svc.cluster.local`, port: 80, workload: "cache" });
  expect(await src.resolvePort(7050)).toBeNull();
  await db.destroy();
});

test("unexposed / foreign-domain names resolve to null", async () => {
  const { db, tcp, claim } = await fix();
  await claim("web", "app"); // claimed but NOT exposed
  const src = new MetastoreRouteSource(db, { baseDomain: "drop.example.com" });
  expect(await src.resolveSni("web.drop.example.com")).toBeNull(); // no expose row
  expect(await src.resolveSni("web.evil.com")).toBeNull(); // wrong base domain → no routing key
  expect(await src.resolveSni("a.b.drop.example.com")).toBeNull(); // not a single leftmost label
  // A port-mode workload has no SNI route, and an sni-mode one has no port route.
  await tcp.exposePort("web", "tcp", "alice@x.com", 7000, 7099);
  expect(await src.resolveSni("web.drop.example.com")).toBeNull();
  await db.destroy();
});

test("the TTL cache honors an injectable clock (a stale route survives until the TTL lapses)", async () => {
  const { db, tcp, claim } = await fix();
  await claim("pg", "database");
  await tcp.exposeSni("pg", "postgres", "alice@x.com");
  let t = 0;
  const src = new MetastoreRouteSource(db, { baseDomain: "drop.example.com", ttlMs: 5000, now: () => t });
  expect(await src.resolveSni("pg.drop.example.com")).toMatchObject({ workload: "pg" }); // populates cache at t=0
  await tcp.unexpose("pg"); // DB row gone, but the cache entry hasn't expired yet
  t = 4999;
  expect(await src.resolveSni("pg.drop.example.com")).toMatchObject({ workload: "pg" }); // still the cached hit
  t = 5000;
  expect(await src.resolveSni("pg.drop.example.com")).toBeNull(); // TTL lapsed → re-reads DB → gone
  await db.destroy();
});
