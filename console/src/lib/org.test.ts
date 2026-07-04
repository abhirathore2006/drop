import { describe, expect, test } from "bun:test";
import type { OrgSummary } from "./api-extra.ts";
import { ALL_ORGS, currentOrg, filterByOrg } from "./org.ts";

const orgs: OrgSummary[] = [
  { slug: "me", name: "me@example.com", kind: "personal", role: "owner" },
  { slug: "acme", name: "Acme", kind: "team", role: "admin" },
];

describe("currentOrg", () => {
  test("absent ?org resolves to the personal org (the default)", () => {
    expect(currentOrg(orgs, null)?.slug).toBe("me");
  });
  test("a slug resolves to that org", () => {
    expect(currentOrg(orgs, "acme")?.slug).toBe("acme");
  });
  test("the ALL sentinel means unfiltered (null)", () => {
    expect(currentOrg(orgs, ALL_ORGS)).toBeNull();
  });
  test("a stale/unknown slug falls back to the personal default", () => {
    expect(currentOrg(orgs, "ghost")?.slug).toBe("me");
  });
  test("before the org list loads, the view is unfiltered (null)", () => {
    expect(currentOrg(undefined, "acme")).toBeNull();
    expect(currentOrg([], null)).toBeNull();
  });
});

type Item = { name: string; org: { slug: string; kind: string } | null };
const items: Item[] = [
  { name: "a", org: { slug: "acme", kind: "team" } },
  { name: "b", org: { slug: "me", kind: "personal" } },
  { name: "c", org: null }, // no org of its own → belongs to the personal context
];

describe("filterByOrg", () => {
  test("a null org is unfiltered (all items)", () => {
    expect(filterByOrg(items, null)).toHaveLength(3);
  });
  test("a team org yields only its own items", () => {
    expect(filterByOrg(items, orgs[1]!).map((i) => i.name)).toEqual(["a"]);
  });
  test("the personal org yields its items plus org-less ones", () => {
    expect(filterByOrg(items, orgs[0]!).map((i) => i.name)).toEqual(["b", "c"]);
  });
});
