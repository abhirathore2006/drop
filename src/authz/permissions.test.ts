import { test, expect } from "bun:test";
import { can, capabilitiesFor, parseScope, scopeAllows, ACTIONS, type Action, type Actor } from "./permissions.ts";

const ALL: Action[] = ["read", "publish", "rollback", "configure", "share", "transfer", "delete"];
const owner: Actor = { email: "o@x.com", platformRole: "member", siteRole: "owner", orgRole: null };
const editor: Actor = { email: "e@x.com", platformRole: "member", siteRole: "editor", orgRole: null };
const viewer: Actor = { email: "v@x.com", platformRole: "member", siteRole: "viewer", orgRole: null };
const stranger: Actor = { email: "s@x.com", platformRole: "member", siteRole: null, orgRole: null };
const admin: Actor = { email: "a@x.com", platformRole: "admin", siteRole: null, orgRole: null };

test("owner can do everything", () => {
  for (const a of ALL) expect(can(owner, a)).toBe(true);
});

test("editor can publish/rollback/read only", () => {
  expect(can(editor, "publish")).toBe(true);
  expect(can(editor, "rollback")).toBe(true);
  expect(can(editor, "read")).toBe(true);
  for (const a of ["configure", "share", "transfer", "delete"] as const) expect(can(editor, a)).toBe(false);
});

test("expose is the deploy/ship tier: owner + editor + org member yes, viewer no (A2b)", () => {
  expect(can(owner, "expose")).toBe(true);
  expect(can(editor, "expose")).toBe(true); // editors ship — expose is deploy-adjacent
  expect(can(viewer, "expose")).toBe(false);
  expect(can(stranger, "expose")).toBe(false);
  const orgMember: Actor = { email: "m@x.com", platformRole: "member", siteRole: null, orgRole: "member" };
  expect(can(orgMember, "expose")).toBe(true);
  const orgViewer: Actor = { email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" };
  expect(can(orgViewer, "expose")).toBe(false);
});

test("connect is the deploy/ship tier: owner + editor + org member yes, viewer no (A3 db:proxy)", () => {
  expect(can(owner, "connect")).toBe(true);
  expect(can(editor, "connect")).toBe(true); // opening a psql tunnel is a routine dev action
  expect(can(viewer, "connect")).toBe(false); // a metadata-only viewer must NOT open a raw SQL session
  expect(can(stranger, "connect")).toBe(false);
  const orgMember: Actor = { email: "m@x.com", platformRole: "member", siteRole: null, orgRole: "member" };
  expect(can(orgMember, "connect")).toBe(true);
  const orgViewer: Actor = { email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" };
  expect(can(orgViewer, "connect")).toBe(false);
});

test("exec is the deploy/ship tier, ABOVE viewer: owner + editor + org member yes, viewer no (J3)", () => {
  expect(can(owner, "exec")).toBe(true);
  expect(can(editor, "exec")).toBe(true); // an editor opens a debug shell — a routine dev action
  expect(can(viewer, "exec")).toBe(false); // STRICTER than logs: a shell env-dumps write-only secrets
  expect(can(stranger, "exec")).toBe(false);
  const orgMember: Actor = { email: "m@x.com", platformRole: "member", siteRole: null, orgRole: "member" };
  expect(can(orgMember, "exec")).toBe(true);
  const orgViewer: Actor = { email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" };
  expect(can(orgViewer, "exec")).toBe(false);
});

test("exec is a first-class token scope (exec:<app> parses + grants like other verbs) (J3)", () => {
  expect(parseScope("exec:myapp")).toEqual({ verb: "exec", resource: "myapp" });
  expect(parseScope("exec")).toEqual({ verb: "exec", resource: "*" });
  expect(scopeAllows(["exec:myapp"], "exec", "myapp")).toBe(true);
  expect(scopeAllows(["exec:myapp"], "exec", "other")).toBe(false); // scoped to myapp only
  expect(scopeAllows(["exec"], "exec", "anyapp")).toBe(true); // bare verb → all apps
  expect(scopeAllows(["logs:myapp"], "exec", "myapp")).toBe(false); // logs doesn't imply exec
  // a token actor with exec:myapp can exec myapp only, fenced to its org
  const tok: Actor = { email: "token:ci@acme", platformRole: "member", siteRole: null, orgRole: null, token: { scopes: ["exec:myapp"], orgId: "org1", resourceName: "myapp", resourceOrgId: "org1" } };
  expect(can(tok, "exec")).toBe(true);
});

test("query is the deploy/ship tier, ABOVE viewer: owner + editor + org member yes, viewer no (I4 SQL console)", () => {
  expect(can(owner, "query")).toBe(true);
  expect(can(editor, "query")).toBe(true); // an editor runs a read-only query — a routine dev action
  expect(can(viewer, "query")).toBe(false); // STRICTER than read: a query returns ALL row data, not metadata
  expect(can(stranger, "query")).toBe(false);
  const orgMember: Actor = { email: "m@x.com", platformRole: "member", siteRole: null, orgRole: "member" };
  expect(can(orgMember, "query")).toBe(true);
  const orgViewer: Actor = { email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" };
  expect(can(orgViewer, "query")).toBe(false);
});

test("query is a first-class token scope (query:<db> parses + grants like other verbs) (I4)", () => {
  expect(parseScope("query:billing")).toEqual({ verb: "query", resource: "billing" });
  expect(parseScope("query")).toEqual({ verb: "query", resource: "*" });
  expect(scopeAllows(["query:billing"], "query", "billing")).toBe(true);
  expect(scopeAllows(["query:billing"], "query", "other")).toBe(false); // scoped to billing only
  expect(scopeAllows(["query"], "query", "anydb")).toBe(true); // bare verb → all databases
  expect(scopeAllows(["read:billing"], "query", "billing")).toBe(false); // read doesn't imply query
  const tok: Actor = { email: "token:ci@acme", platformRole: "member", siteRole: null, orgRole: null, token: { scopes: ["query:billing"], orgId: "org1", resourceName: "billing", resourceOrgId: "org1" } };
  expect(can(tok, "query")).toBe(true);
});

test("capabilitiesFor: query is present for owner/editor, absent for viewer (I4 console gating)", () => {
  expect(capabilitiesFor(owner)).toContain("query");
  expect(capabilitiesFor(editor)).toContain("query");
  expect(capabilitiesFor(viewer)).not.toContain("query");
  const orgViewer: Actor = { email: "ov@x.com", platformRole: "member", siteRole: null, orgRole: "viewer" };
  expect(capabilitiesFor(orgViewer)).not.toContain("query");
});

test("viewer can only read", () => {
  expect(can(viewer, "read")).toBe(true);
  for (const a of ["publish", "rollback", "configure", "share", "transfer", "delete"] as const)
    expect(can(viewer, a)).toBe(false);
});

test("non-member can do nothing", () => {
  for (const a of ALL) expect(can(stranger, a)).toBe(false);
});

test("platform admin can do everything regardless of site role", () => {
  for (const a of ALL) expect(can(admin, a)).toBe(true);
});

// ---- capabilitiesFor (M2): the resolved verb set the console gates on -------------------------

test("capabilitiesFor: owner + admin get the FULL verb set; it stays in ACTIONS order", () => {
  expect(capabilitiesFor(owner)).toEqual([...ACTIONS]); // site owner can do everything
  expect(capabilitiesFor(admin)).toEqual([...ACTIONS]); // platform admin too
});

test("capabilitiesFor: editor is the ship tier (no configure/share/transfer/delete)", () => {
  expect(capabilitiesFor(editor)).toEqual(["read", "logs", "publish", "deploy", "db:create", "connect", "exec", "query", "rollback", "expose"]);
});

test("capabilitiesFor: viewer is read-only; a non-member gets nothing", () => {
  expect(capabilitiesFor(viewer)).toEqual(["read"]);
  expect(capabilitiesFor(stranger)).toEqual([]);
});

test("capabilitiesFor: exactly matches can() over every action (never drifts)", () => {
  for (const a of [owner, editor, viewer, stranger, admin]) {
    const caps = capabilitiesFor(a);
    for (const verb of ACTIONS) expect(caps.includes(verb)).toBe(can(a, verb));
  }
});

test("capabilitiesFor: a service token gets its SCOPE-filtered set, fenced to its own org", () => {
  const scoped: Actor = {
    email: "token:ci@acme",
    platformRole: "member",
    siteRole: null,
    orgRole: null,
    token: { scopes: ["deploy:myapp", "logs"], orgId: "org1", resourceName: "myapp", resourceOrgId: "org1" },
  };
  // ACTIONS order → logs before deploy; nothing else the scopes don't grant.
  expect(capabilitiesFor(scoped)).toEqual(["logs", "deploy"]);
  // a bare `deploy:otherapp` scope grants nothing on `myapp`
  const narrow: Actor = { ...scoped, token: { ...scoped.token!, scopes: ["deploy:otherapp"] } };
  expect(capabilitiesFor(narrow)).toEqual([]);
  // cross-org (resource's org ≠ token's org) → empty, whatever the scopes say
  const crossOrg: Actor = { ...scoped, token: { ...scoped.token!, scopes: ["deploy:*", "read:*"], resourceOrgId: "org2" } };
  expect(capabilitiesFor(crossOrg)).toEqual([]);
});

test("org role grants org-wide; unions with per-resource grant (broader wins)", () => {
  const orgMember: Actor = { email: "m@x.com", platformRole: "member", siteRole: null, orgRole: "member" };
  expect(can(orgMember, "deploy")).toBe(true); // org member can ship anything in the org
  expect(can(orgMember, "configure")).toBe(true); // …including secrets
  expect(can(orgMember, "delete")).toBe(false); // but not delete/transfer (owner/admin)
  const orgOwner: Actor = { email: "oo@x.com", platformRole: "member", siteRole: null, orgRole: "owner" };
  for (const a of ALL) expect(can(orgOwner, a)).toBe(true);
  // a per-resource editor who is only an org viewer still gets the UNION (editor's publish)
  const both: Actor = { email: "b@x.com", platformRole: "member", siteRole: "editor", orgRole: "viewer" };
  expect(can(both, "publish")).toBe(true);
});
