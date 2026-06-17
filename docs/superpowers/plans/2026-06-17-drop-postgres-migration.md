# Drop Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all Drop metadata from S3 objects to Postgres (via Kysely), add a canonical `users` table with platform + per-site roles and a code-defined permission map, and add a `public/private/password` site-visibility axis (public + password enforced now; private fail-closed 403 until edge-auth).

**Architecture:** `MetaStore` stays the single metadata seam but is reimplemented over Kysely/`pg`; `BlobStore` (S3) keeps only file bytes. Atomic claim becomes `INSERT … ON CONFLICT`, CAS becomes `SELECT … FOR UPDATE` transactions. Migrations run on API boot under a `pg_advisory_lock`. Tests run against in-process PGlite (real SQL, no Docker).

**Tech Stack:** TypeScript on Node v24, Hono, Kysely + `pg`, `@electric-sql/pglite` (+ `kysely-pglite`) for tests, esbuild, `bun test`.

Spec: `docs/superpowers/specs/2026-06-17-drop-postgres-migration-design.md`.

---

## File Structure

**Create:**
- `src/db/schema.ts` — Kysely `Database` interface + per-table row types.
- `src/db/db.ts` — `makeDb(url)`: `pg.Pool` + Kysely instance; `Db` type alias.
- `src/db/migrations.ts` — inline Kysely migration provider (`0001_init`).
- `src/db/migrate.ts` — `runMigrations(db)` with `pg_advisory_lock`.
- `src/db/testdb.ts` — `makeTestDb()`: migrated PGlite-backed Kysely (test-only).
- `src/users/store.ts` — `UserStore` (upsert/get/setRole/list/seedAdmins).
- `src/users/store.test.ts`
- `src/authz/permissions.ts` — `can()` + role→permission map.
- `src/authz/permissions.test.ts`

**Modify:**
- `src/config.ts` — add `databaseUrl`.
- `src/metastore/types.ts` — add `visibility`, `Member`/role types; keep `Site`/`VersionMeta`.
- `src/metastore/store.ts` — reimplement over Kysely.
- `src/metastore/store.test.ts` — rebuild on `makeTestDb()`.
- `src/api/authz.ts` — re-export/replace with `permissions.ts` (delete old helpers).
- `src/api/server.ts` — `can()` authz, visibility endpoints, SQL admin browse, user upsert, drop marker calls.
- `src/api/server.test.ts` — construct app with `makeTestDb()` + `UserStore`.
- `src/api/auth-routes.ts` — handles via DB; user upsert on login.
- `src/edge/server.ts` — read `{version,config,visibility,passwordHash}`; enforce public/password; private→403.
- `src/edge/server.test.ts` — visibility cases.
- `src/blob/types.ts`, `src/blob/fake.ts`, `src/blob/s3.ts` — remove `listPage`/`delete`/`list`; keep `put`/`get`/`deletePrefix`/`ensureBucket`.
- `bin/api.ts`, `bin/edge.ts` — pool/Kysely; api migrates+seeds; both `new MetaStore(db)` + `S3Blob`.
- `package.json` — deps.
- `Makefile` — `drop-postgres` container + `DROP_DATABASE_URL`.
- `infra/helm/drop/...` — `DROP_DATABASE_URL` secret on api+edge.
- `README.md` — storage/roles/visibility section.

---

## Phase 0 — Dependencies & DB layer

### Task 1: Add dependencies + config

**Files:** Modify `package.json`, `src/config.ts`, `src/config.test.ts` (if present).

- [ ] **Step 1:** Install deps.
```bash
cd /path/to/drop
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm install kysely pg
npm install -D @types/pg @electric-sql/pglite kysely-pglite
```
- [ ] **Step 2:** Add `databaseUrl` to `Config` and `loadConfig` in `src/config.ts`.
```ts
// in interface Config:
  databaseUrl: string; // postgres connection string (required)
// in loadConfig return, after s3 fields:
  databaseUrl: env.DROP_DATABASE_URL ?? "",
```
Add a guard near the bucket guard:
```ts
  const databaseUrl = env.DROP_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DROP_DATABASE_URL is required");
```
and reference `databaseUrl` in the return object.
- [ ] **Step 3:** Run typecheck.
```bash
bunx tsc --noEmit
```
Expected: PASS.
- [ ] **Step 4:** Commit.
```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat(db): add kysely/pg deps and DROP_DATABASE_URL config"
```

### Task 2: DB schema types

**Files:** Create `src/db/schema.ts`.

- [ ] **Step 1:** Write the Kysely table interfaces.
```ts
import type { ColumnType, Generated } from "kysely";
import type { SiteConfig } from "../site-config.ts";

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  email: string;
  name: string | null;
  role: ColumnType<"admin" | "member", "admin" | "member" | undefined, "admin" | "member">;
  status: ColumnType<"active" | "suspended", "active" | "suspended" | undefined, "active" | "suspended">;
  created_at: Generated<Ts>;
  last_login_at: Ts | null;
}

export interface SitesTable {
  name: string;
  current_version: string | null;
  visibility: ColumnType<"public" | "private" | "password", "public" | "private" | "password" | undefined, "public" | "private" | "password">;
  password_hash: string | null;
  config: ColumnType<SiteConfig | null, string | null, string | null>; // jsonb
  created_at: Generated<Ts>;
  updated_at: Ts;
}

export type SiteRole = "owner" | "editor" | "viewer";

export interface SiteMembersTable {
  site_name: string;
  email: string;
  role: SiteRole;
  created_at: Generated<Ts>;
}

export interface VersionsTable {
  site_name: string;
  id: string;
  published_by: string;
  created_at: Ts;
  file_count: number;
  bytes: ColumnType<number, number | bigint, number | bigint>;
  config: ColumnType<SiteConfig | null, string | null, string | null>;
}

export interface AuthHandlesTable {
  id: string;
  poll_token: string;
  code_verifier: string;
  status: ColumnType<"pending" | "done", "pending" | "done" | undefined, "pending" | "done">;
  mode: "cli" | "browser";
  token: string | null;
  created_at: Generated<Ts>;
}

export interface Database {
  users: UsersTable;
  sites: SitesTable;
  site_members: SiteMembersTable;
  versions: VersionsTable;
  auth_handles: AuthHandlesTable;
}
```
- [ ] **Step 2:** Typecheck. `bunx tsc --noEmit` → PASS (jsonb config typed as string in/out; we `JSON.stringify`/`JSON.parse` at the store boundary).
- [ ] **Step 3:** Commit.
```bash
git add src/db/schema.ts
git commit -m "feat(db): kysely schema types"
```

### Task 3: Initial migration

**Files:** Create `src/db/migrations.ts`.

- [ ] **Step 1:** Write the migration provider with `0001_init`.
```ts
import { type Kysely, type Migration, type MigrationProvider, sql } from "kysely";

const m0001_init: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable("users")
      .addColumn("email", "text", (c) => c.primaryKey())
      .addColumn("name", "text")
      .addColumn("role", "text", (c) => c.notNull().defaultTo("member"))
      .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("last_login_at", "timestamptz")
      .execute();

    await db.schema.createTable("sites")
      .addColumn("name", "text", (c) => c.primaryKey())
      .addColumn("current_version", "text")
      .addColumn("visibility", "text", (c) => c.notNull().defaultTo("public"))
      .addColumn("password_hash", "text")
      .addColumn("config", "jsonb")
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema.createTable("site_members")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("email", "text", (c) => c.notNull().references("users.email"))
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint("site_members_pk", ["site_name", "email"])
      .execute();
    await sql`create unique index one_owner_per_site on site_members(site_name) where role = 'owner'`.execute(db);
    await db.schema.createIndex("site_members_email_idx").on("site_members").column("email").execute();

    await db.schema.createTable("versions")
      .addColumn("site_name", "text", (c) => c.notNull().references("sites.name").onDelete("cascade"))
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("published_by", "text", (c) => c.notNull())
      .addColumn("created_at", "timestamptz", (c) => c.notNull())
      .addColumn("file_count", "integer", (c) => c.notNull())
      .addColumn("bytes", "bigint", (c) => c.notNull())
      .addColumn("config", "jsonb")
      .addPrimaryKeyConstraint("versions_pk", ["site_name", "id"])
      .execute();

    await db.schema.createTable("auth_handles")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("poll_token", "text", (c) => c.notNull())
      .addColumn("code_verifier", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("token", "text")
      .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
  },
  async down() { /* forward-only */ },
};

export class InlineMigrations implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "0001_init": m0001_init };
  }
}
```
- [ ] **Step 2:** Typecheck → PASS.
- [ ] **Step 3:** Commit.
```bash
git add src/db/migrations.ts
git commit -m "feat(db): initial schema migration"
```

### Task 4: DB factory + migration runner

**Files:** Create `src/db/db.ts`, `src/db/migrate.ts`.

- [ ] **Step 1:** `src/db/db.ts`.
```ts
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

export function makeDb(url: string): { db: Db; pool: pg.Pool } {
  // bigint as number (our byte counts fit in JS safe-int range)
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)) as any);
  const pool = new pg.Pool({ connectionString: url });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
```
- [ ] **Step 2:** `src/db/migrate.ts`.
```ts
import { Migrator, sql } from "kysely";
import type { Db } from "./db.ts";
import { InlineMigrations } from "./migrations.ts";

const LOCK_KEY = 4_829_173; // arbitrary, stable advisory-lock id for Drop migrations

/** Run all migrations to latest under an advisory lock (multi-replica safe). */
export async function runMigrations(db: Db): Promise<void> {
  await sql`select pg_advisory_lock(${LOCK_KEY})`.execute(db);
  try {
    const migrator = new Migrator({ db, provider: new InlineMigrations() });
    const { error, results } = await migrator.migrateToLatest();
    for (const r of results ?? []) {
      if (r.status === "Error") throw new Error(`migration failed: ${r.migrationName}`);
    }
    if (error) throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.execute(db);
  }
}
```
- [ ] **Step 3:** Typecheck → PASS.
- [ ] **Step 4:** Commit.
```bash
git add src/db/db.ts src/db/migrate.ts
git commit -m "feat(db): pool/kysely factory + advisory-locked migration runner"
```

### Task 5: PGlite test harness

**Files:** Create `src/db/testdb.ts`.

- [ ] **Step 1:** Write `makeTestDb()` (uses `kysely-pglite`; runs real migrations).
```ts
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type { Database } from "./schema.ts";
import type { Db } from "./db.ts";
import { Migrator } from "kysely";
import { InlineMigrations } from "./migrations.ts";

/** Fresh in-process Postgres (PGlite) with all migrations applied. Test-only. */
export async function makeTestDb(): Promise<Db> {
  const { dialect } = await new KyselyPGlite().then((x) => x); // in-memory by default
  const db = new Kysely<Database>({ dialect });
  const migrator = new Migrator({ db, provider: new InlineMigrations() });
  const { results } = await migrator.migrateToLatest();
  for (const r of results ?? []) if (r.status === "Error") throw new Error(`migration failed: ${r.migrationName}`);
  return db;
}
```
> Note: verify `kysely-pglite` constructor shape during impl; if its API differs, adapt to `const { dialect } = new KyselyPGlite()` / `await KyselyPGlite.create()`. The contract `makeTestDb(): Promise<Db>` must hold regardless.
- [ ] **Step 2:** Smoke test it. Create a temporary `src/db/testdb.smoke.test.ts`:
```ts
import { test, expect } from "bun:test";
import { makeTestDb } from "./testdb.ts";

test("makeTestDb applies migrations", async () => {
  const db = await makeTestDb();
  const rows = await db.selectFrom("sites").selectAll().execute();
  expect(rows).toEqual([]);
  await db.destroy();
});
```
- [ ] **Step 3:** Run it.
```bash
bun test src/db/testdb.smoke.test.ts
```
Expected: PASS (table exists, empty).
- [ ] **Step 4:** Delete the smoke test, commit harness.
```bash
rm src/db/testdb.smoke.test.ts
git add src/db/testdb.ts
git commit -m "test(db): pglite-backed test db harness"
```

---

## Phase 1 — Stores & permissions over Kysely

### Task 6: UserStore

**Files:** Create `src/users/store.ts`, `src/users/store.test.ts`.

- [ ] **Step 1:** Write failing tests.
```ts
import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "./store.ts";

test("upsertOnLogin creates then updates last_login", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  const a = await u.upsertOnLogin("a@x.com", "Ayla");
  expect(a.role).toBe("member");
  expect(a.name).toBe("Ayla");
  const b = await u.upsertOnLogin("a@x.com", "Ayla R");
  expect(b.name).toBe("Ayla R"); // updated, still one row
  expect((await u.listUsers()).length).toBe(1);
  await db.destroy();
});

test("seedAdmins promotes listed emails to admin (idempotent)", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  await u.seedAdmins(["boss@x.com"]);
  await u.seedAdmins(["boss@x.com"]); // idempotent
  expect((await u.getUser("boss@x.com"))!.role).toBe("admin");
  await u.upsertOnLogin("boss@x.com", "Boss"); // login must NOT demote
  expect((await u.getUser("boss@x.com"))!.role).toBe("admin");
  await db.destroy();
});

test("setRole changes platform role", async () => {
  const db = await makeTestDb();
  const u = new UserStore(db);
  await u.upsertOnLogin("a@x.com", null);
  await u.setRole("a@x.com", "admin");
  expect((await u.getUser("a@x.com"))!.role).toBe("admin");
  await db.destroy();
});
```
- [ ] **Step 2:** Run → FAIL (no `UserStore`).
```bash
bun test src/users/store.test.ts
```
- [ ] **Step 3:** Implement `src/users/store.ts`.
```ts
import { sql } from "kysely";
import type { Db } from "../db/db.ts";

export interface User {
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "suspended";
}

const SELECT = ["email", "name", "role", "status"] as const;

export class UserStore {
  constructor(private db: Db) {}

  /** Create-or-update on login. Never downgrades role; refreshes name + last_login_at. */
  async upsertOnLogin(email: string, name: string | null): Promise<User> {
    const row = await this.db
      .insertInto("users")
      .values({ email, name, last_login_at: sql`now()` })
      .onConflict((oc) =>
        oc.column("email").doUpdateSet({
          name: (eb) => eb.fn.coalesce("excluded.name" as any, "users.name" as any),
          last_login_at: sql`now()`,
        }),
      )
      .returning(SELECT)
      .executeTakeFirstOrThrow();
    return row as User;
  }

  async getUser(email: string): Promise<User | null> {
    const r = await this.db.selectFrom("users").select(SELECT).where("email", "=", email).executeTakeFirst();
    return (r as User) ?? null;
  }

  async setRole(email: string, role: "admin" | "member"): Promise<void> {
    await this.db.updateTable("users").set({ role }).where("email", "=", email).execute();
  }

  /** Ensure each email exists with role=admin (bootstrap; idempotent; never demotes others). */
  async seedAdmins(emails: string[]): Promise<void> {
    for (const email of emails) {
      await this.db
        .insertInto("users")
        .values({ email, name: null, role: "admin" })
        .onConflict((oc) => oc.column("email").doUpdateSet({ role: "admin" }))
        .execute();
    }
  }

  async listUsers(): Promise<User[]> {
    return (await this.db.selectFrom("users").select(SELECT).orderBy("email").execute()) as User[];
  }
}
```
> If the `coalesce(excluded.name, users.name)` raw-column form fights the types during impl, use `sql<string | null>\`coalesce(excluded.name, users.name)\``. Behaviour: a login with a non-null name updates it; null leaves the stored name.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.
```bash
git add src/users/store.ts src/users/store.test.ts
git commit -m "feat(users): UserStore over kysely (upsert/seed/setRole/list)"
```

### Task 7: Permission map

**Files:** Create `src/authz/permissions.ts`, `src/authz/permissions.test.ts`.

- [ ] **Step 1:** Failing tests.
```ts
import { test, expect } from "bun:test";
import { can, type Actor } from "./permissions.ts";

const owner: Actor = { email: "o@x.com", platformRole: "member", siteRole: "owner" };
const editor: Actor = { email: "e@x.com", platformRole: "member", siteRole: "editor" };
const viewer: Actor = { email: "v@x.com", platformRole: "member", siteRole: "viewer" };
const stranger: Actor = { email: "s@x.com", platformRole: "member", siteRole: null };
const admin: Actor = { email: "a@x.com", platformRole: "admin", siteRole: null };

test("owner can do everything", () => {
  for (const a of ["read", "publish", "rollback", "configure", "share", "transfer", "delete"] as const)
    expect(can(owner, a)).toBe(true);
});
test("editor can publish/rollback/read but not share/delete/configure", () => {
  expect(can(editor, "publish")).toBe(true);
  expect(can(editor, "rollback")).toBe(true);
  expect(can(editor, "read")).toBe(true);
  expect(can(editor, "share")).toBe(false);
  expect(can(editor, "delete")).toBe(false);
  expect(can(editor, "configure")).toBe(false);
});
test("viewer can only read", () => {
  expect(can(viewer, "read")).toBe(true);
  expect(can(viewer, "publish")).toBe(false);
});
test("stranger can do nothing", () => {
  expect(can(stranger, "read")).toBe(false);
});
test("platform admin can do everything regardless of site role", () => {
  for (const a of ["read", "publish", "rollback", "configure", "share", "transfer", "delete"] as const)
    expect(can(admin, a)).toBe(true);
});
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/authz/permissions.ts`.
```ts
import type { SiteRole } from "../db/schema.ts";

export type Action = "read" | "publish" | "rollback" | "configure" | "share" | "transfer" | "delete";

export interface Actor {
  email: string;
  platformRole: "admin" | "member";
  siteRole: SiteRole | null; // null = not a member
}

const MAP: Record<SiteRole, Action[]> = {
  owner: ["read", "publish", "rollback", "configure", "share", "transfer", "delete"],
  editor: ["read", "publish", "rollback"],
  viewer: ["read"],
};

/** Single authority check. Platform admins are all-powerful on every site. */
export function can(actor: Actor, action: Action): boolean {
  if (actor.platformRole === "admin") return true;
  if (!actor.siteRole) return false;
  return MAP[actor.siteRole].includes(action);
}
```
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.
```bash
git add src/authz/permissions.ts src/authz/permissions.test.ts
git commit -m "feat(authz): code-defined role→permission map + can()"
```

### Task 8: MetaStore over Kysely

**Files:** Modify `src/metastore/types.ts`, rewrite `src/metastore/store.ts`, rewrite `src/metastore/store.test.ts`.

- [ ] **Step 1:** Update `src/metastore/types.ts` — add visibility + member shape; keep `Site`/`VersionMeta`/`SiteNotFoundError`.
```ts
import type { SiteConfig } from "../site-config.ts";
import type { SiteRole } from "../db/schema.ts";

export type Visibility = "public" | "private" | "password";

export interface Member { email: string; role: SiteRole; }

export interface Site {
  name: string;
  owner: string;               // email of the role='owner' member
  collaborators: string[];     // editor + viewer emails (back-compat shape)
  members: Member[];           // full membership (owner+editor+viewer)
  currentVersion: string | null;
  visibility: Visibility;
  config?: SiteConfig;
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  id: string;
  publishedBy: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
  config?: SiteConfig;
}

/** Lean record for the edge hot path (no member list). */
export interface SitePointer {
  currentVersion: string | null;
  visibility: Visibility;
  passwordHash: string | null;
  config?: SiteConfig;
}

export class SiteNotFoundError extends Error {
  constructor(name: string) { super(`site not found: ${name}`); this.name = "SiteNotFoundError"; }
}
```
- [ ] **Step 2:** Write failing tests `src/metastore/store.test.ts` (rebuild on `makeTestDb`; users must exist before membership due to FK).
```ts
import { test, expect } from "bun:test";
import { makeTestDb } from "../db/testdb.ts";
import { UserStore } from "../users/store.ts";
import { MetaStore } from "./store.ts";
import { SiteNotFoundError } from "./types.ts";

async function fix() {
  const db = await makeTestDb();
  const users = new UserStore(db);
  for (const e of ["alice@x.com", "bob@x.com", "carol@x.com"]) await users.upsertOnLogin(e, null);
  return { db, meta: new MetaStore(db) };
}

test("claim is first-writer-wins and sets owner membership", async () => {
  const { db, meta } = await fix();
  const a = await meta.claimSite("app", "alice@x.com");
  expect(a?.owner).toBe("alice@x.com");
  expect(a?.currentVersion).toBeNull();
  expect(a?.visibility).toBe("public");
  expect(await meta.claimSite("app", "bob@x.com")).toBeNull();
  expect((await meta.getSitePlain("app"))!.owner).toBe("alice@x.com");
  await db.destroy();
});

test("updateSite flips pointer + denormalizes config", async () => {
  const { db, meta } = await fix();
  await meta.claimSite("app", "alice@x.com");
  const up = await meta.updateSite("app", (s) => ({ ...s, currentVersion: "v_1", config: { name: "app" } }));
  expect(up.currentVersion).toBe("v_1");
  expect((await meta.getPointer("app"))!.currentVersion).toBe("v_1");
  await db.destroy();
});

test("updateSite throws on missing site", async () => {
  const { db, meta } = await fix();
  await expect(meta.updateSite("ghost", (s) => s)).rejects.toBeInstanceOf(SiteNotFoundError);
  await db.destroy();
});

test("versions listed newest-first", async () => {
  const { db, meta } = await fix();
  await meta.claimSite("app", "alice@x.com");
  await meta.putVersion("app", { id: "v_001", publishedBy: "alice@x.com", createdAt: "2026-01-01T00:00:00Z", fileCount: 1, bytes: 1 });
  await meta.putVersion("app", { id: "v_002", publishedBy: "alice@x.com", createdAt: "2026-01-02T00:00:00Z", fileCount: 1, bytes: 1 });
  expect((await meta.listVersions("app")).map((v) => v.id)).toEqual(["v_002", "v_001"]);
  await db.destroy();
});

test("members: add/remove/transfer + listUserSites", async () => {
  const { db, meta } = await fix();
  await meta.claimSite("app", "alice@x.com");
  await meta.addMember("app", "bob@x.com", "editor");
  expect((await meta.getSitePlain("app"))!.collaborators).toEqual(["bob@x.com"]);
  expect((await meta.listUserSites("bob@x.com")).sort()).toEqual(["app"]);
  await meta.transferOwner("app", "carol@x.com");
  const s = (await meta.getSitePlain("app"))!;
  expect(s.owner).toBe("carol@x.com");
  expect(s.collaborators.includes("alice@x.com")).toBe(true); // old owner kept as collaborator
  await meta.removeMember("app", "bob@x.com");
  expect((await meta.listUserSites("bob@x.com"))).toEqual([]);
  await db.destroy();
});

test("setVisibility / password + getPointer", async () => {
  const { db, meta } = await fix();
  await meta.claimSite("app", "alice@x.com");
  await meta.setVisibility("app", "password", "sha256:abc");
  const p = (await meta.getPointer("app"))!;
  expect(p.visibility).toBe("password");
  expect(p.passwordHash).toBe("sha256:abc");
  await db.destroy();
});

test("listSitesPage keyset paginates + prefix", async () => {
  const { db, meta } = await fix();
  for (const n of ["s1", "s2", "s3"]) await meta.claimSite(n, "alice@x.com");
  const p1 = await meta.listSitesPage({ limit: 2 });
  expect(p1.names).toEqual(["s1", "s2"]);
  const p2 = await meta.listSitesPage({ limit: 2, cursor: p1.nextCursor });
  expect(p2.names).toEqual(["s3"]);
  expect(p2.nextCursor).toBeUndefined();
  expect((await meta.listSitesPage({ prefix: "s1" })).names).toEqual(["s1"]);
  await db.destroy();
});

test("deleteSite cascades members + versions", async () => {
  const { db, meta } = await fix();
  await meta.claimSite("app", "alice@x.com");
  await meta.addMember("app", "bob@x.com", "viewer");
  await meta.deleteSite("app");
  expect(await meta.getSitePlain("app")).toBeNull();
  expect(await meta.listUserSites("bob@x.com")).toEqual([]);
  await db.destroy();
});
```
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Rewrite `src/metastore/store.ts`.
```ts
import { sql } from "kysely";
import type { Db } from "../db/db.ts";
import type { SiteConfig } from "../site-config.ts";
import { type Member, type Site, type SitePointer, type Visibility, type VersionMeta, SiteNotFoundError } from "./types.ts";

const iso = (v: any): string => (v instanceof Date ? v.toISOString() : String(v));
const parseCfg = (v: any): SiteConfig | undefined => (v == null ? undefined : typeof v === "string" ? JSON.parse(v) : v);
const encCfg = (c?: SiteConfig): string | null => (c ? JSON.stringify(c) : null);

export class MetaStore {
  constructor(private db: Db) {}

  /** S3 byte-path bridge (unchanged). */
  filesPrefix(name: string, id: string) { return `sites/${name}/files/${id}/`; }

  private async members(name: string): Promise<Member[]> {
    const rows = await this.db.selectFrom("site_members").select(["email", "role"]).where("site_name", "=", name).execute();
    return rows.map((r) => ({ email: r.email, role: r.role }));
  }

  private toSite(row: any, members: Member[]): Site {
    const owner = members.find((m) => m.role === "owner")?.email ?? "";
    return {
      name: row.name,
      owner,
      members,
      collaborators: members.filter((m) => m.role !== "owner").map((m) => m.email),
      currentVersion: row.current_version,
      visibility: row.visibility as Visibility,
      config: parseCfg(row.config),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  /** Atomic claim: insert site + owner membership in one tx. Null if name taken. */
  async claimSite(name: string, owner: string): Promise<Site | null> {
    return await this.db.transaction().execute(async (tx) => {
      const site = await tx.insertInto("sites").values({ name, updated_at: sql`now()` })
        .onConflict((oc) => oc.column("name").doNothing()).returningAll().executeTakeFirst();
      if (!site) return null; // taken
      await tx.insertInto("site_members").values({ site_name: name, email: owner, role: "owner" }).execute();
      return this.toSite(site, [{ email: owner, role: "owner" }]);
    });
  }

  async getSitePlain(name: string): Promise<Site | null> {
    const row = await this.db.selectFrom("sites").selectAll().where("name", "=", name).executeTakeFirst();
    if (!row) return null;
    return this.toSite(row, await this.members(name));
  }

  /** Lean edge read: pointer + visibility + password + config. */
  async getPointer(name: string): Promise<SitePointer | null> {
    const row = await this.db.selectFrom("sites")
      .select(["current_version", "visibility", "password_hash", "config"])
      .where("name", "=", name).executeTakeFirst();
    if (!row) return null;
    return {
      currentVersion: row.current_version,
      visibility: row.visibility as Visibility,
      passwordHash: row.password_hash,
      config: parseCfg(row.config),
    };
  }

  /** Read-modify-write under a row lock (replaces etag CAS). */
  async updateSite(name: string, mutate: (s: Site) => Site): Promise<Site> {
    return await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom("sites").selectAll().where("name", "=", name)
        .forUpdate().executeTakeFirst();
      if (!row) throw new SiteNotFoundError(name);
      const members = (await tx.selectFrom("site_members").select(["email", "role"]).where("site_name", "=", name).execute())
        .map((r) => ({ email: r.email, role: r.role }));
      const next = mutate(this.toSite(row, members));
      const updated = await tx.updateTable("sites").set({
        current_version: next.currentVersion,
        visibility: next.visibility,
        config: encCfg(next.config),
        updated_at: sql`now()`,
      }).where("name", "=", name).returningAll().executeTakeFirstOrThrow();
      return this.toSite(updated, members);
    });
  }

  async setVisibility(name: string, visibility: Visibility, passwordHash: string | null): Promise<void> {
    const res = await this.db.updateTable("sites")
      .set({ visibility, password_hash: passwordHash, updated_at: sql`now()` })
      .where("name", "=", name).executeTakeFirst();
    if (!res.numUpdatedRows) throw new SiteNotFoundError(name);
  }

  async addMember(name: string, email: string, role: "editor" | "viewer"): Promise<void> {
    await this.db.insertInto("site_members").values({ site_name: name, email, role })
      .onConflict((oc) => oc.columns(["site_name", "email"]).doUpdateSet({ role })).execute();
  }

  async removeMember(name: string, email: string): Promise<void> {
    await this.db.deleteFrom("site_members").where("site_name", "=", name).where("email", "=", email)
      .where("role", "!=", "owner").execute();
  }

  /** Demote current owner → editor (collaborator), promote newOwner → owner. */
  async transferOwner(name: string, newOwner: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom("site_members").select(["email"]).where("site_name", "=", name).where("role", "=", "owner").forUpdate().executeTakeFirst();
      if (cur && cur.email !== newOwner) {
        await tx.updateTable("site_members").set({ role: "editor" }).where("site_name", "=", name).where("email", "=", cur.email).execute();
      }
      await tx.insertInto("site_members").values({ site_name: name, email: newOwner, role: "owner" })
        .onConflict((oc) => oc.columns(["site_name", "email"]).doUpdateSet({ role: "owner" })).execute();
    });
  }

  async deleteSite(name: string): Promise<void> {
    await this.db.deleteFrom("sites").where("name", "=", name).execute(); // cascades members+versions
  }

  /** Names of sites a user owns or collaborates on. */
  async listUserSites(email: string): Promise<string[]> {
    const rows = await this.db.selectFrom("site_members").select("site_name").where("email", "=", email).orderBy("site_name").execute();
    return rows.map((r) => r.site_name);
  }

  /** Keyset page over all sites (admin), optional name prefix. */
  async listSitesPage(opts: { cursor?: string; limit?: number; prefix?: string } = {}): Promise<{ names: string[]; nextCursor?: string }> {
    const limit = opts.limit ?? 100;
    let q = this.db.selectFrom("sites").select("name").orderBy("name").limit(limit + 1);
    if (opts.cursor) q = q.where("name", ">", opts.cursor);
    if (opts.prefix) q = q.where("name", "like", opts.prefix.replace(/[%_]/g, "\\$&") + "%");
    const rows = await q.execute();
    const names = rows.slice(0, limit).map((r) => r.name);
    const nextCursor = rows.length > limit ? names[names.length - 1] : undefined;
    return { names, nextCursor };
  }

  async putVersion(name: string, v: VersionMeta): Promise<void> {
    await this.db.insertInto("versions").values({
      site_name: name, id: v.id, published_by: v.publishedBy, created_at: v.createdAt,
      file_count: v.fileCount, bytes: v.bytes, config: encCfg(v.config),
    }).onConflict((oc) => oc.columns(["site_name", "id"]).doNothing()).execute();
  }

  async listVersions(name: string): Promise<VersionMeta[]> {
    const rows = await this.db.selectFrom("versions").selectAll().where("site_name", "=", name).orderBy("id", "desc").execute();
    return rows.map((r) => ({
      id: r.id, publishedBy: r.published_by, createdAt: iso(r.created_at),
      fileCount: r.file_count, bytes: Number(r.bytes), config: parseCfg(r.config),
    }));
  }
}
```
- [ ] **Step 5:** Run → PASS.
```bash
bun test src/metastore/store.test.ts
```
- [ ] **Step 6:** Commit.
```bash
git add src/metastore/types.ts src/metastore/store.ts src/metastore/store.test.ts
git commit -m "feat(metastore): reimplement over kysely (claim/CAS/members/visibility/keyset)"
```

---

## Phase 2 — Wire API, auth, edge, bins

### Task 9: Auth handles + user upsert in auth-routes

**Files:** Modify `src/api/auth-routes.ts` (+ its test if present).

- [ ] **Step 1:** Replace the blob-backed `save`/`key`/load of handles with DB calls. Change `registerAuthRoutes(app, cfg, blob)` signature to `registerAuthRoutes(app, cfg, db, users)`. Handle persistence:
```ts
// save pending handle
await db.insertInto("auth_handles").values({
  id: handle, poll_token: pollToken, code_verifier: codeVerifier, status: "pending", mode,
}).execute();
// load in callback
const h = await db.selectFrom("auth_handles").selectAll().where("id", "=", state).executeTakeFirst();
// after exchanging code + verifying identity:
await users.upsertOnLogin(identity.email, identity.name ?? null);
await db.updateTable("auth_handles").set({ status: "done", token }).where("id", "=", state).execute();
// poll consumes + deletes
const row = await db.selectFrom("auth_handles").selectAll().where("id", "=", handle).where("poll_token", "=", pollToken).executeTakeFirst();
if (row?.status === "done") { await db.deleteFrom("auth_handles").where("id", "=", handle).execute(); return c.json({ token: row.token }); }
```
> Preserve existing route shapes (`/auth/start|callback|poll`, `/login`, `/logout`) and cookie behaviour exactly; only swap the storage backend and add the user upsert. Check `identity` has `name` available from the OIDC profile; if not, pass `null`.
- [ ] **Step 2:** Typecheck → PASS.
- [ ] **Step 3:** Commit.
```bash
git add src/api/auth-routes.ts
git commit -m "feat(auth): persist OAuth handles in postgres + upsert users on login"
```

### Task 10: API server — authz via can(), visibility endpoints, SQL admin, drop markers

**Files:** Modify `src/api/server.ts`, delete `src/api/authz.ts`, rewrite `src/api/server.test.ts`. Update `Deps`.

- [ ] **Step 1:** Change `Deps` to carry `db`, `users`, and keep `meta`, `blob`, `cfg`, `verifier`. Build an `Actor` per request:
```ts
import { can, type Action, type Actor } from "../authz/permissions.ts";
// helper inside createApp:
async function actorFor(email: string, site: Site | null): Promise<Actor> {
  const u = await d.users.getUser(email);
  const siteRole = site ? (site.members.find((m) => m.email === email)?.role ?? null) : null;
  return { email, platformRole: u?.role ?? "member", siteRole };
}
function require(c: any, actor: Actor, action: Action) {
  if (!can(actor, action)) return c.json({ error: "not permitted" }, 403);
  return null;
}
```
- [ ] **Step 2:** Update each route:
  - `/v1/me` → `{ email, admin: (await d.users.getUser(email))?.role === "admin" }`.
  - publish: resolve/claim; `actorFor`; `can(actor,"publish")`; on `_drop.json` basicAuth set `setVisibility(name,"password",hash)` and strip basicAuth from served config; remove `addUserSite`.
  - rollback: `can(actor,"rollback")`.
  - get site: `can(actor,"read")`; include `visibility` in response.
  - delete: `can(actor,"delete")`; remove marker cleanup (cascade handles it).
  - collaborators add: `can(actor,"share")` → `meta.addMember(name,email,role)` (default `editor`; accept optional `role`). The target email must exist as a user — upsert a placeholder: `await d.users.upsertOnLogin(email, null)` before `addMember` (FK).
  - collaborators delete: `can(actor,"share")` → `meta.removeMember`.
  - transfer: `can(actor,"transfer")` → `meta.transferOwner`; ensure new owner user row exists first.
  - NEW `POST /v1/sites/:name/visibility` `{visibility, password?}` → `can(actor,"configure")`; hash password (reuse site-config sha256 helper) when `visibility==="password"`; else null.
  - `/v1/sites` (my ls) → `meta.listUserSites(email)` then hydrate.
  - `/v1/admin/sites` → platform-admin check via `getUser(email).role==="admin"`; `meta.listSitesPage`.
- [ ] **Step 3:** Rewrite `src/api/server.test.ts` to build deps from `makeTestDb()` + `UserStore` + `FakeBlob`, pre-seed users via `upsertOnLogin`, and keep all existing assertions (publish/claim/403/rollback/collab/admin/me) plus: visibility set→get, password set reflects in pointer. Use the existing `pub`/`call`/`tgz` helpers.
- [ ] **Step 4:** Run → PASS. `bun test src/api/server.test.ts`
- [ ] **Step 5:** Commit.
```bash
git rm src/api/authz.ts
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): can()-based authz, visibility endpoint, SQL admin, drop marker index"
```

### Task 11: Edge — visibility enforcement

**Files:** Modify `src/edge/server.ts`, `src/edge/server.test.ts`.

- [ ] **Step 1:** Failing tests: public serves; password without creds → 401, with creds → 200; private → 403.
```ts
// build edge app with meta over makeTestDb + a published version in FakeBlob
// (claim, putVersion, blob.put files, updateSite pointer) then:
// public: GET / → 200
// setVisibility("s","password","sha256:<hex of 'pw'>"): GET / → 401; with Authorization Basic → 200
// setVisibility("s","private",null): GET / → 403
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In the edge handler, replace `meta.getSitePlain` with `meta.getPointer`; cache `{version,config,visibility,passwordHash}`. Before serving:
```ts
if (ptr.visibility === "private") return c.text("private site (viewer auth coming soon)", 403);
if (ptr.visibility === "password") {
  const hash = ptr.passwordHash ?? configBasicAuthHash(ptr.config);
  if (!basicAuthOk(c.req.header("authorization"), hash)) {
    return new Response("auth required", { status: 401, headers: { "www-authenticate": 'Basic realm="drop"' } });
  }
}
```
> Reuse `basicAuthOk` from `src/site-config.ts` (adapt to take the header + hash). Keep existing CORS/redirects/cleanUrls/SPA-fallback ordering; visibility check goes first (after pointer load).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.
```bash
git add src/edge/server.ts src/edge/server.test.ts
git commit -m "feat(edge): enforce public/password visibility, fail-closed 403 for private"
```

### Task 12: Bin wiring

**Files:** Modify `bin/api.ts`, `bin/edge.ts`.

- [ ] **Step 1:** `bin/api.ts`: build `{db,pool}=makeDb(cfg.databaseUrl)`, `await runMigrations(db)`, `const users=new UserStore(db)`, `await users.seedAdmins(cfg.admins)`, `await blob.ensureBucket()`, `const meta=new MetaStore(db)`, pass `{cfg,meta,blob,db,users,verifier}` to `createApp`. Register auth routes with `(app,cfg,db,users)`.
- [ ] **Step 2:** `bin/edge.ts`: build `{db}=makeDb(cfg.databaseUrl)` (NO migrations), `const meta=new MetaStore(db)`, keep `S3Blob`. 
- [ ] **Step 3:** Build all bundles.
```bash
node build.mjs
```
Expected: 4 bundles built, no errors.
- [ ] **Step 4:** Commit.
```bash
git add bin/api.ts bin/edge.ts
git commit -m "feat(bin): wire postgres into api (migrate+seed) and edge (read-only)"
```

---

## Phase 3 — Cleanup, infra, verification

### Task 13: Shrink BlobStore

**Files:** Modify `src/blob/types.ts`, `src/blob/fake.ts`, `src/blob/s3.ts` (+ blob tests).

- [ ] **Step 1:** Remove `listPage`, `delete`, `list`, and the `ListPage`/`ListPageOptions`/`ListResult` types from the interface and both impls. Keep `put`, `get`, `deletePrefix`, `ensureBucket`. Remove now-unused S3 imports (`DeleteObjectCommand`; keep `ListObjectsV2Command` + `DeleteObjectsCommand` for `deletePrefix`).
- [ ] **Step 2:** Grep for stragglers: `grep -rn 'listPage\|\.list(\|blob.delete' src/ bin/ | grep -v deletePrefix` → expect no app-code hits.
- [ ] **Step 3:** Typecheck + full test. `bunx tsc --noEmit && bun test`
- [ ] **Step 4:** Commit.
```bash
git add src/blob/
git commit -m "refactor(blob): drop metadata list/delete; bytes-only store"
```

### Task 14: Local dev — Postgres in podman + Makefile

**Files:** Modify `Makefile`.

- [ ] **Step 1:** Add a `drop-postgres` container (port 5432, named volume `drop-pg-data`, `POSTGRES_USER=drop POSTGRES_PASSWORD=drop POSTGRES_DB=drop`), start it in `start`/`setup`, add to `status`, `stop`, and wipe its volume in `reset`. Add `DROP_DATABASE_URL=postgres://drop:drop@localhost:5432/drop` to the `ENV` line. Wait-loop on `pg_isready` before starting api.
- [ ] **Step 2:** Bring it up clean.
```bash
make reset && make start && make status
```
Expected: postgres/floci/api/edge all up.
- [ ] **Step 3:** Commit.
```bash
git add Makefile
git commit -m "build(local): postgres container + DROP_DATABASE_URL in make targets"
```

### Task 15: Helm

**Files:** Modify `infra/helm/drop/values.yaml`, `templates/secret.yaml`, `templates/api-deployment.yaml`, `templates/edge-deployment.yaml`, `README.md`.

- [ ] **Step 1:** Add `databaseUrl` to values (secret), wire `DROP_DATABASE_URL` env (from secret) into both api and edge deployments. Document external-managed-PG expectation; api runs migrations on boot (advisory lock covers multi-replica).
- [ ] **Step 2:** Validate.
```bash
helm lint infra/helm/drop && helm template t infra/helm/drop >/dev/null && echo ok
```
- [ ] **Step 3:** Commit.
```bash
git add infra/helm/drop README.md
git commit -m "build(infra): DROP_DATABASE_URL secret for api+edge"
```

### Task 16: Docs

**Files:** Modify `README.md`.

- [ ] **Step 1:** Replace the "all state is S3 objects" section with the Postgres model (tables, roles, visibility, `DROP_DATABASE_URL`, `DROP_ADMINS` as boot seed). Note bytes still in S3.
- [ ] **Step 2:** Commit.
```bash
git add README.md
git commit -m "docs: postgres metadata model, roles, visibility"
```

### Task 17: Full live verification

- [ ] **Step 1:** Clean slate + bring up.
```bash
make reset && make start
```
- [ ] **Step 2:** Mint a session for `admin@example.com` (seeded admin) as before; confirm `/v1/me` → `admin:true`.
- [ ] **Step 3:** Re-publish fixtures from `examples/` (multipage, report, viteapp). Confirm edge serves each (200), `/v1/sites` lists them, `/v1/admin/sites` paginates.
- [ ] **Step 4:** Visibility: set a site to `password` (via `/v1/sites/:name/visibility`), confirm edge 401 then 200 with basic-auth; set `private`, confirm edge 403.
- [ ] **Step 5:** Roles: add a collaborator as `editor`, confirm they can publish but not delete (403); `viewer` can read-mgmt only.
- [ ] **Step 6:** Reporting sanity: `psql postgres://drop:drop@localhost:5432/drop -c "select owner_role.email, count(*) from site_members owner_role where role='owner' group by 1"` returns expected counts.
- [ ] **Step 7:** Final full suite + typecheck + build.
```bash
bunx tsc --noEmit && bun test && node build.mjs
```
Expected: tsc clean, all tests pass, 4 bundles built.
- [ ] **Step 8:** Commit any verification fixups; summarize results.

---

## Self-Review

- **Spec coverage:** users table (T6), auth_handles in DB (T9), site_members + owner-in-members + partial unique index (T3/T8), roles+permission map (T7), visibility public/password enforced + private 403 (T10/T11), Kysely+pg + boot migrations w/ advisory lock (T4/T12), PGlite tests (T5), marker index removed + BlobStore shrunk (T8/T13), keyset admin pagination (T8/T10), DROP_ADMINS→seed (T6/T12), local podman PG (T14), Helm secret (T15), fresh start / no importer (T17 re-publish). All covered.
- **Placeholder scan:** code shown for every code step; two impl-note caveats (kysely-pglite constructor in T5, coalesce form in T6) flagged with concrete fallbacks — acceptable, not blocking.
- **Type consistency:** `Db`, `Site`(+`members`/`visibility`), `SitePointer`, `Actor`/`can`/`Action`, `MetaStore` method names (`claimSite`/`updateSite`/`getPointer`/`addMember`/`removeMember`/`transferOwner`/`setVisibility`/`listUserSites`/`listSitesPage`/`putVersion`/`listVersions`) are consistent across tasks. `Deps` gains `db`+`users` (T10/T12 aligned).
