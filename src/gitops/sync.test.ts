// (B3) syncLinkedStack — the ONE per-stack sync body the poller and the manual sync/apply routes share
// — plus the poll tick. Real PGlite-backed StackLinkStore/StackStore (matching the repo's store-test
// posture); the reconcile + emit/resolve + fetch transport are recorded fakes, so no network and no
// cluster. The reconcile-under-lock property itself is covered by the route tests (which run the REAL
// reconcileStack); here `reconcile` is the seam.
import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { StackStore, type StackRow } from "../stacks/store.ts";
import { UserStore } from "../users/store.ts";
import { OrgStore, type Org } from "../orgs/store.ts";
import type { EmitInput } from "../events/store.ts";
import { contentSha } from "./fetch.ts";
import { StackLinkStore } from "./store.ts";
import { gitopsPollTick } from "./poller.ts";
import { syncLinkedStack, type GitopsReconcileArgs, type GitopsSyncDeps } from "./sync.ts";

const YAML_V1 = "stack:\n  name: shop\n  resources:\n    db:\n      type: database\n";
const YAML_V2 = "stack:\n  name: shop\n  resources:\n    db:\n      type: database\n      storage: 2Gi\n";
const YAML_DIR = "stack:\n  name: shop\n  resources:\n    web:\n      type: site\n      dir: ./web\n";

interface Harness {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  org: Org;
  stack: StackRow;
  links: StackLinkStore;
  deps: GitopsSyncDeps;
  reconciles: { email: string; args: GitopsReconcileArgs }[];
  emits: EmitInput[];
  resolves: { site: string; kind: string }[];
  setFile: (body: string, status?: number) => void;
}

async function setup(opts: { dryRunOnly?: boolean; reconcileStatus?: number; reconcileError?: string } = {}): Promise<Harness> {
  const db = await makeTestDb();
  const users = new UserStore(db);
  await users.upsertOnLogin("alice@example.com", null);
  const orgs = new OrgStore(db);
  const org = await orgs.ensurePersonalOrg("alice@example.com");
  const stacks = new StackStore(db);
  const stack = await stacks.create({ name: "shop", orgId: org.id, spec: { name: "shop", resources: { db: { type: "database" } } }, createdBy: "alice@example.com" });
  const links = new StackLinkStore(db);
  await links.link({ stackId: stack.id, repo: "https://github.com/acme/shop", branch: "main", path: "drop.yaml", token: "tok", dryRunOnly: opts.dryRunOnly ?? false, createdBy: "alice@example.com" });

  let file = { body: YAML_V1, status: 200 };
  const reconciles: Harness["reconciles"] = [];
  const emits: EmitInput[] = [];
  const resolves: Harness["resolves"] = [];
  const deps: GitopsSyncDeps = {
    links,
    getOrg: async (id) => (id === org.id ? org : null),
    reconcile: async (email, args) => {
      reconciles.push({ email, args });
      return opts.reconcileStatus && opts.reconcileStatus !== 200
        ? { status: opts.reconcileStatus, body: { error: opts.reconcileError ?? "reconcile blew up" } }
        : { status: 200, body: { stack: args.name, specVersion: 2 } };
    },
    emit: (e) => void emits.push(e),
    resolve: (site, kind) => void resolves.push({ site, kind }),
    fetchImpl: async () => new Response(file.body, { status: file.status }),
    now: () => new Date("2026-07-05T10:00:00Z"),
  };
  return { db, org, stack, links, deps, reconciles, emits, resolves, setFile: (body, status = 200) => (file = { body, status }) };
}

test("B3 sync: a changed sha reconciles (default env, prune off, stack.sync audit action) and records synced state", async () => {
  const h = await setup();
  const r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.outcome).toBe("synced");
  expect(r.sha).toBe(contentSha(YAML_V1));
  expect(r.specVersion).toBe(2);

  // reconciled as the LINK CREATOR, on the default env, prune off, audited as stack.sync
  expect(h.reconciles).toHaveLength(1);
  expect(h.reconciles[0]!.email).toBe("alice@example.com");
  const args = h.reconciles[0]!.args;
  expect(args.name).toBe("shop");
  expect(args.org.id).toBe(h.org.id);
  expect(args.spec.resources.db!.type).toBe("database");
  expect(args.prune).toBe(false);
  expect(args.dryRun).toBe(false);
  expect(args.env).toBe("");
  expect(args.auditAction).toBe("stack.sync");
  expect(args.auditDetail.gitops).toBe(true);
  expect(args.auditDetail.sha).toBe(r.sha);

  const link = (await h.links.get(h.stack.id))!;
  expect(link.lastSha).toBe(r.sha!);
  expect(link.lastStatus).toBe("synced");
  expect(link.lastError).toBeNull();
  expect(link.lastSyncedAt).toBe("2026-07-05T10:00:00.000Z");
  expect(link.pendingSha).toBeNull();

  // gitops_synced emitted + any open gitops_failed resolved
  expect(h.emits.map((e) => e.kind)).toEqual(["gitops_synced"]);
  expect(h.emits[0]!.severity).toBe("info");
  expect(h.resolves).toEqual([{ site: "shop", kind: "gitops_failed" }]);
});

test("B3 sync: an unchanged sha is a pure no-op (no reconcile, no state write, no event)", async () => {
  const h = await setup();
  await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  const before = (await h.links.get(h.stack.id))!;
  const r = await syncLinkedStack(h.deps, h.stack, before); // same content again
  expect(r.outcome).toBe("unchanged");
  expect(r.sha).toBe(before.lastSha!);
  expect(h.reconciles).toHaveLength(1); // still just the first run
  expect(h.emits).toHaveLength(1);
  expect(await h.links.get(h.stack.id)).toEqual(before);

  // …and a NEW sha triggers again
  h.setFile(YAML_V2);
  const r2 = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r2.outcome).toBe("synced");
  expect(h.reconciles).toHaveLength(2);
  expect((await h.links.get(h.stack.id))!.lastSha).toBe(contentSha(YAML_V2));
});

test("B3 sync: fetch failure → failed state + gitops_failed event; last_sha untouched so the next tick retries", async () => {
  const h = await setup();
  h.setFile("gone", 500);
  const r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.outcome).toBe("failed");
  expect(r.error).toMatch(/fetch returned 500/);
  const link = (await h.links.get(h.stack.id))!;
  expect(link.lastStatus).toBe("failed");
  expect(link.lastError).toMatch(/fetch returned 500/);
  expect(link.lastSha).toBeNull(); // never applied anything
  expect(h.emits.map((e) => e.kind)).toEqual(["gitops_failed"]);
  expect(h.emits[0]!.severity).toBe("error");
  expect(h.emits[0]!.detail!.repo).toBe("https://github.com/acme/shop");
  expect(h.reconciles).toHaveLength(0);
});

test("B3 sync: reconcile failure (e.g. a held stack lock's 409) → failed state carries the server's error", async () => {
  const h = await setup({ reconcileStatus: 409, reconcileError: "a stack up is already in progress for shop" });
  const r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.outcome).toBe("failed");
  expect(r.error).toBe("a stack up is already in progress for shop");
  expect((await h.links.get(h.stack.id))!.lastError).toBe("a stack up is already in progress for shop");
  expect((await h.links.get(h.stack.id))!.lastSha).toBeNull(); // not applied → retried next tick
  expect(h.emits.map((e) => e.kind)).toEqual(["gitops_failed"]);
});

test("B3 sync: an invalid / wrong-name / dir:-bearing spec is refused with a clear last_error (spec-only v1)", async () => {
  const h = await setup();

  h.setFile("just: junk\n");
  let r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.outcome).toBe("failed");
  expect(r.error).toMatch(/no valid stack: section/);

  h.setFile("stack:\n  name: other\n  resources:\n    db:\n      type: database\n");
  r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.error).toMatch(/"other" does not match the linked stack "shop"/);

  h.setFile(YAML_DIR);
  r = await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!);
  expect(r.outcome).toBe("failed");
  expect(r.error).toMatch(/spec-only GitOps v1: resource\(s\) web use dir:/);
  expect((await h.links.get(h.stack.id))!.lastError).toMatch(/dir:/);
  expect(h.reconciles).toHaveLength(0); // never reached the reconcile
});

test("B3 sync: dry-run-only parks a change as pending_review (NOT applied); re-poll of the same sha is quiet; apply executes it", async () => {
  const h = await setup({ dryRunOnly: true });
  const link0 = (await h.links.get(h.stack.id))!;
  const r = await syncLinkedStack(h.deps, h.stack, link0);
  expect(r.outcome).toBe("pending_review");
  expect(r.sha).toBe(contentSha(YAML_V1));
  expect(h.reconciles).toHaveLength(0); // the whole point: no auto-apply

  let link = (await h.links.get(h.stack.id))!;
  expect(link.lastStatus).toBe("pending_review");
  expect(link.pendingSha).toBe(r.sha!);
  expect(link.lastSha).toBeNull();

  // re-polling the SAME pending sha stays parked (idempotent)
  const r2 = await syncLinkedStack(h.deps, h.stack, link);
  expect(r2.outcome).toBe("pending_review");
  expect(h.reconciles).toHaveLength(0);

  // the human-confirmed apply runs the reconcile and clears the pending state
  link = (await h.links.get(h.stack.id))!;
  const applied = await syncLinkedStack(h.deps, h.stack, link, { mode: "apply", expectSha: link.pendingSha! });
  expect(applied.outcome).toBe("synced");
  expect(h.reconciles).toHaveLength(1);
  expect(h.reconciles[0]!.args.auditDetail.reviewed).toBe(true);
  link = (await h.links.get(h.stack.id))!;
  expect(link.lastSha).toBe(contentSha(YAML_V1));
  expect(link.lastStatus).toBe("synced");
  expect(link.pendingSha).toBeNull();
});

test("B3 sync: apply refuses content that moved since review — re-parks under the NEW sha, never applies unreviewed bytes", async () => {
  const h = await setup({ dryRunOnly: true });
  await syncLinkedStack(h.deps, h.stack, (await h.links.get(h.stack.id))!); // parks YAML_V1
  const reviewed = (await h.links.get(h.stack.id))!;
  h.setFile(YAML_V2); // the file moves after the human reviewed V1
  const r = await syncLinkedStack(h.deps, h.stack, reviewed, { mode: "apply", expectSha: reviewed.pendingSha! });
  expect(r.outcome).toBe("pending_review");
  expect(r.changedSinceReview).toBe(true);
  expect(r.sha).toBe(contentSha(YAML_V2));
  expect(h.reconciles).toHaveLength(0);
  const link = (await h.links.get(h.stack.id))!;
  expect(link.pendingSha).toBe(contentSha(YAML_V2)); // fresh review target
  expect(link.lastStatus).toBe("pending_review");
});

// ---- the poll tick ------------------------------------------------------------------------------------

test("B3 poller: a tick sweeps every link, skips a lapsed stack, and one failure never stops the sweep", async () => {
  const h = await setup();
  // a second linked stack whose row is then deleted (the tick must skip it, not throw)
  const stacks = new StackStore(h.db);
  const users = new UserStore(h.db);
  await users.upsertOnLogin("bob@example.com", null);
  const orgs = new OrgStore(h.db);
  const bobOrg = await orgs.ensurePersonalOrg("bob@example.com");
  const ghost = await stacks.create({ name: "ghost", orgId: bobOrg.id, spec: { name: "ghost", resources: { db: { type: "database" } } }, createdBy: "bob@example.com" });
  await h.links.link({ stackId: ghost.id, repo: "https://github.com/acme/ghost", branch: "main", path: "drop.yaml", token: null, dryRunOnly: false, createdBy: "bob@example.com" });

  const ran: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  await gitopsPollTick({
    links: h.links,
    stacks: { getById: (id) => (id === h.stack.id ? Promise.resolve(h.stack) : Promise.resolve(null)) }, // ghost's row "lapsed"
    run: async (stack) => {
      ran.push(stack.name);
      return { outcome: "synced", sha: "a".repeat(64) };
    },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  });
  expect(ran).toEqual(["shop"]); // ghost skipped, no throw
  expect(logs.some((l) => l.includes("synced stack shop"))).toBe(true);

  // a run() that THROWS is caught + logged; the sweep completes
  await gitopsPollTick({
    links: h.links,
    stacks: { getById: () => Promise.resolve(h.stack) },
    run: async () => {
      throw new Error("db hiccup");
    },
    error: (m) => errors.push(m),
  });
  expect(errors.some((e) => e.includes("db hiccup"))).toBe(true);

  // a failed OUTCOME is surfaced through error() too
  await gitopsPollTick({
    links: h.links,
    stacks: { getById: () => Promise.resolve(h.stack) },
    run: async () => ({ outcome: "failed", error: "fetch returned 500" }),
    error: (m) => errors.push(m),
  });
  expect(errors.some((e) => e.includes("fetch returned 500"))).toBe(true);
});
