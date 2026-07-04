import { test, expect } from "bun:test";
import { planStack, StackCycleError, type LivePresence } from "./plan.ts";
import type { StackSpec } from "../stack-config.ts";

// A three-resource stack: db ← api (uses) ← web (env_from). Topo order must be db, api, web.
const shop: StackSpec = {
  name: "shop",
  resources: {
    web: { type: "site", dir: "./web", env_from: [{ resource: "api", output: "url", as: "API" }] },
    api: { type: "app", image: "api:1", uses: [{ database: "db" }] },
    db: { type: "database", storage: "1Gi" },
  },
};

const live = (...names: [string, LivePresence["type"]][]): Record<string, LivePresence> =>
  Object.fromEntries(names.map(([n, t]) => [n, { type: t }]));

test("first up (nothing live): all creates, ordered db → app → site (topo, dependencies first)", () => {
  const steps = planStack({ spec: shop, prevSpec: null, mapping: {}, live: {} });
  expect(steps.map((s) => [s.action, s.key, s.siteName])).toEqual([
    ["create", "db", "shop-db"],
    ["create", "api", "shop-api"],
    ["create", "web", "shop-web"],
  ]);
  expect(steps.every((s) => s.kind)).toBeTruthy();
});

test("all live + unchanged vs prevSpec → all noop, still topo-ordered", () => {
  const steps = planStack({
    spec: shop,
    prevSpec: shop,
    mapping: { db: "shop-db", api: "shop-api", web: "shop-web" },
    live: live(["shop-db", "database"], ["shop-api", "app"], ["shop-web", "site"]),
  });
  expect(steps.map((s) => [s.action, s.key])).toEqual([
    ["noop", "db"],
    ["noop", "api"],
    ["noop", "web"],
  ]);
});

test("a changed resource is an update; a still-unchanged one stays noop", () => {
  const next: StackSpec = {
    ...shop,
    resources: { ...shop.resources, api: { type: "app", image: "api:2", uses: [{ database: "db" }] } }, // image bumped
  };
  const steps = planStack({
    spec: next,
    prevSpec: shop,
    mapping: { db: "shop-db", api: "shop-api", web: "shop-web" },
    live: live(["shop-db", "database"], ["shop-api", "app"], ["shop-web", "site"]),
  });
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s.action]));
  expect(byKey).toEqual({ db: "noop", api: "update", web: "noop" });
});

test("a live resource with no prevSpec entry is adopted as an update, not a noop", () => {
  const steps = planStack({
    spec: { name: "shop", resources: { db: { type: "database", storage: "1Gi" } } },
    prevSpec: null,
    mapping: { db: "shop-db" },
    live: live(["shop-db", "database"]),
  });
  expect(steps).toEqual([{ action: "update", key: "db", kind: "database", siteName: "shop-db", reason: "adopting existing resource" }]);
});

test("removed key → delete, flagged when prune is off (reason says so), reverse-ordered (dependents first)", () => {
  // prev had db+api+web; new spec drops api AND web → both deleted, web (dependent) before api.
  const next: StackSpec = { name: "shop", resources: { db: { type: "database", storage: "1Gi" } } };
  const steps = planStack({
    spec: next,
    prevSpec: shop,
    mapping: { db: "shop-db", api: "shop-api", web: "shop-web" },
    live: live(["shop-db", "database"], ["shop-api", "app"], ["shop-web", "site"]),
    prune: false,
  });
  expect(steps.map((s) => [s.action, s.key])).toEqual([
    ["noop", "db"],
    ["delete", "web"], // dependent first
    ["delete", "api"],
  ]);
  expect(steps.find((s) => s.key === "web")!.reason).toContain("flagged-delete");
});

test("prune flips the delete reason to pruning", () => {
  const next: StackSpec = { name: "shop", resources: { db: { type: "database", storage: "1Gi" } } };
  const steps = planStack({
    spec: next,
    prevSpec: shop,
    mapping: { db: "shop-db", api: "shop-api", web: "shop-web" },
    live: live(["shop-db", "database"], ["shop-api", "app"], ["shop-web", "site"]),
    prune: true,
  });
  const del = steps.find((s) => s.key === "api")!;
  expect(del.action).toBe("delete");
  expect(del.reason).toContain("pruning");
});

test("a key present only in the mapping (not prevSpec) is still deleted", () => {
  const steps = planStack({
    spec: { name: "shop", resources: { db: { type: "database" } } },
    prevSpec: null,
    mapping: { db: "shop-db", orphan: "shop-orphan" },
    live: live(["shop-db", "database"], ["shop-orphan", "app"]),
  });
  expect(steps.map((s) => [s.action, s.key, s.siteName])).toEqual([
    ["update", "db", "shop-db"], // live + no prev → adopt
    ["delete", "orphan", "shop-orphan"],
  ]);
});

test("mapping site name wins over the default <stack>-<key> for an already-materialized resource", () => {
  const steps = planStack({
    spec: { name: "shop", resources: { db: { type: "database" } } },
    prevSpec: null,
    mapping: { db: "legacy-db-name" },
    live: live(["legacy-db-name", "database"]),
  });
  expect(steps[0]!.siteName).toBe("legacy-db-name");
});

test("a dependency cycle is rejected with StackCycleError", () => {
  // Two apps that each 'uses' the other (contrived — apps don't normally use apps, but the planner is
  // type-agnostic about edges): db1 uses db2 and db2 uses db1 via the app edge.
  const cyclic: StackSpec = {
    name: "loop",
    resources: {
      a: { type: "app", image: "x:1", uses: [{ database: "b" }] },
      b: { type: "app", image: "x:1", uses: [{ database: "a" }] },
    },
  };
  expect(() => planStack({ spec: cyclic, prevSpec: null, mapping: {}, live: {} })).toThrow(StackCycleError);
});

test("H3: app→app `uses` is a dependency edge — target ordered before consumer", () => {
  // web uses api (service discovery). api must be created BEFORE web so web's API_URL resolves.
  const spec: StackSpec = {
    name: "svc",
    resources: {
      web: { type: "app", image: "web:1", uses: [{ app: "api" }] },
      api: { type: "app", image: "api:1" },
    },
  };
  const steps = planStack({ spec, prevSpec: null, mapping: {}, live: {} });
  expect(steps.map((s) => [s.action, s.key])).toEqual([
    ["create", "api"],
    ["create", "web"],
  ]);
});

test("H3: a mutual app↔app reference is rejected as a cycle", () => {
  // a uses b AND b uses a via the app edge — no valid apply order, so the <KEY>_URL injection can't be
  // ordered. Rejected as a StackCycleError (documented v1 limitation).
  const cyclic: StackSpec = {
    name: "loop",
    resources: {
      a: { type: "app", image: "x:1", uses: [{ app: "b" }] },
      b: { type: "app", image: "x:1", uses: [{ app: "a" }] },
    },
  };
  expect(() => planStack({ spec: cyclic, prevSpec: null, mapping: {}, live: {} })).toThrow(StackCycleError);
});
