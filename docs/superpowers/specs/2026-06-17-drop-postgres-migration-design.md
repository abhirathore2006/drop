# Drop: Metadata → Postgres migration + Roles & Visibility

**Date:** 2026-06-17
**Status:** Approved (design)
**Supersedes (partially):** the "no database, S3-only" storage decision in
`2026-06-09-drop-static-publishing-design.md`. File bytes still live in S3; all
*metadata* moves to Postgres.

## Why

The original design kept all state as S3 objects (conditional writes for atomic
claim/CAS, a per-user marker index for `ls`). That works, but it makes
*reporting and control* hard — there are no secondary indexes, no joins, no ad-hoc
queries. Moving metadata to Postgres gives:

- SQL reporting over sites, owners, versions, bytes, publish activity.
- A real identity inventory (`users`) and DB-managed roles.
- A first-class site **visibility** model (public / private / password).
- A clean foundation for the planned "more features" phase.

The served file **bytes** stay in S3 — Postgres is not a blob store, and the edge
streams assets. Only metadata migrates.

## Decisions (locked)

1. **Boundary:** ALL metadata → Postgres (sites, members, versions, users, auth
   handles, visibility). File bytes (`sites/<name>/files/<verId>/…`) stay in S3.
2. **Tooling:** Kysely (typed query builder) over `pg`. Not an ORM — SQL stays
   transparent for reporting. Migrations are Kysely TS migration files run
   programmatically on API boot.
3. **Existing data:** Fresh start. Nothing is deployed; local sites are wiped and
   re-published from `examples/`. No importer.
4. **RBAC:** Roles + **code-defined** permissions (single module). No DB
   permission matrix.
5. **Identity:** Add a canonical `users` table. `auth_handles` stays a separate,
   ephemeral table (OAuth-flow state, not identity).
6. **Visibility:** New `sites.visibility` axis. `public` (default) and `password`
   enforced now; `private` modeled + settable now, edge enforcement is the next
   feature (interim = fail-closed 403).

## Architecture

`MetaStore` is already the single abstraction over all metadata, used by the API
(writes) and edge (reads). The migration **reimplements `MetaStore` over Kysely**
and keeps `BlobStore` (S3) for bytes. API/edge call sites (`d.meta.*`) keep their
shapes, so churn is contained.

```
                 ┌─────────────┐         ┌──────────────┐
   API (writes)──┤  MetaStore  ├──Kysely─┤  Postgres    │  metadata
   Edge (reads)──┤  (over pg)  │         └──────────────┘
                 └──────┬──────┘
                        │ filesPrefix(name,ver)        bytes
                 ┌──────┴──────┐         ┌──────────────┐
                 │  BlobStore  ├──S3 SDK─┤  S3 / Floci  │
                 └─────────────┘         └──────────────┘
```

### Modules

- `src/db/db.ts` — Kysely + `pg` Pool factory; `Database` schema interface.
- `src/db/schema.ts` — Kysely table interfaces (`users`, `sites`, `site_members`,
  `versions`, `auth_handles`).
- `src/db/migrations/0001_init.ts` — initial schema (further files for later
  changes).
- `src/db/migrate.ts` — `runMigrations(db)`: acquire `pg_advisory_lock`, run
  Kysely `Migrator.migrateToLatest()`, release. Kysely's Migrator also locks its
  own `kysely_migration_lock` table; the advisory lock is belt-and-suspenders for
  the multi-replica/HPA rollout.
- `src/db/pglite.ts` — PGlite-backed Kysely for the test suite (in-process WASM
  Postgres, no Docker; runs the real migrations + real SQL).
- `src/metastore/store.ts` — reimplemented over Kysely. `filesPrefix()` stays a
  pure helper (the bridge to S3 byte paths). Marker-index methods are removed.
- `src/users/store.ts` — `UserStore`: `upsertOnLogin`, `getUser`, `setRole`,
  `listUsers`, `seedAdmins`.
- `src/authz/permissions.ts` — `can(actor, action, site)` + role→permission map.
  Replaces `canAdmin`/`canWrite`/`isAdmin`.

## Schema

```sql
users
  email          text primary key
  name           text
  role           text not null default 'member'   -- 'admin' | 'member'
  status         text not null default 'active'    -- 'active' | 'suspended'
  created_at     timestamptz not null default now()
  last_login_at  timestamptz

sites
  name            text primary key
  current_version text                              -- null = claimed, nothing published
  visibility      text not null default 'public'    -- 'public' | 'private' | 'password'
  password_hash   text                              -- set when visibility='password'
  config          jsonb                             -- current version's _drop.json (edge-denormalized)
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()

site_members
  site_name   text not null references sites(name) on delete cascade
  email       text not null references users(email)
  role        text not null                          -- 'owner' | 'editor' | 'viewer'
  created_at  timestamptz not null default now()
  primary key (site_name, email)
  -- exactly one owner per site:
  -- create unique index one_owner on site_members(site_name) where role = 'owner'

versions
  site_name    text not null references sites(name) on delete cascade
  id           text not null
  published_by text not null
  created_at   timestamptz not null
  file_count   int not null
  bytes        bigint not null
  config       jsonb
  primary key (site_name, id)

auth_handles
  id            text primary key                     -- OAuth state
  poll_token    text not null
  code_verifier text not null
  status        text not null default 'pending'      -- 'pending' | 'done'
  mode          text not null                         -- 'cli' | 'browser'
  token         text                                  -- minted session token after callback
  created_at    timestamptz not null default now()
```

**Owner modeling:** `site_members` holds *every* relationship including the owner
(`role='owner'`), enforced unique by a partial index. There is no `owner` column on
`sites`. The `Site` object reconstructs `owner` + `collaborators[]` on read. This
keeps one uniform access table for reporting and the private-site allowlist.

## Concurrency (replaces S3 conditional writes)

- **Claim (first-writer-wins):** `INSERT INTO sites … ON CONFLICT (name) DO
  NOTHING RETURNING *` inside a transaction that also inserts the owner
  `site_members` row. No row returned ⇒ name taken. Replaces `If-None-Match`.
- **Read-modify-write (pointer flip, member edits):** a transaction with
  `SELECT … FOR UPDATE`. Replaces the `If-Match` etag CAS retry loop entirely.

## Roles & permissions

- **Platform role** (`users.role`): `admin` may see/manage all sites and manage
  users; `member` is a normal user.
- **Per-site role** (`site_members.role`): `owner` / `editor` / `viewer`.
- **Permission map** (code, one module):
  | action     | owner | editor | viewer | platform admin |
  |------------|:-----:|:------:|:------:|:--------------:|
  | read-mgmt  |  ✓    |  ✓     |  ✓     |  ✓             |
  | publish    |  ✓    |  ✓     |        |  ✓             |
  | rollback   |  ✓    |  ✓     |        |  ✓             |
  | configure¹ |  ✓    |        |        |  ✓             |
  | share      |  ✓    |        |        |  ✓             |
  | transfer   |  ✓    |        |        |  ✓             |
  | delete     |  ✓    |        |        |  ✓             |

  ¹ configure = set visibility / password.
- `can(actor, action, site)` resolves the actor's platform role + their
  `site_members` role and consults the map.
- **`DROP_ADMINS` → bootstrap seed:** on API boot, those emails are upserted with
  `role='admin'` (so the existing admin keeps working with no manual SQL).
  Thereafter admins are DB-managed.

## Visibility & edge enforcement

`sites.visibility` is the source of truth at serve time.

- **public** (default): served openly — today's behavior.
- **password**: edge requires HTTP basic-auth against `sites.password_hash`.
  Publishing a `_drop.json` with `basicAuth` *sets* `visibility='password'` +
  `password_hash`; the API/dashboard can also set it directly. Enforced **now**.
- **private**: only allowed users (= `site_members`, any role) ∪ platform admins
  may view. Edge enforcement (authenticate viewer, then membership check) is the
  **next feature**. **Interim: the edge returns `403` for private sites** —
  fail closed; never serve a private site openly. Owners can still
  manage/publish; only the served page is gated until edge-auth ships.

The edge keeps its in-memory pointer cache (10s TTL); it now caches
`{version, config, visibility, passwordHash}` from the `sites` row. Point lookups
hit Postgres instead of S3 and are faster; cache bounds DB load.

## Config

- New: `DROP_DATABASE_URL` (required) — e.g.
  `postgres://drop:drop@localhost:5432/drop`.
- `DROP_ADMINS` — kept, semantics change to boot-time admin seed.
- All S3 config retained (bytes).

## Removed / simplified

- Per-user marker index (`users/<email>/<name>` objects;
  `addUserSite`/`removeUserSite`/`listUserSites` markers) → replaced by a single
  SQL query (`site_members` join). The marker index only existed because S3 lacks
  secondary indexes.
- `BlobStore.listPage` / `delete` / `list` → removed. `deletePrefix` stays (prune
  version bytes). BlobStore shrinks to `put` / `get` / `deletePrefix` /
  `ensureBucket`.
- Admin browse: cursor-over-S3-LIST → keyset SQL
  (`WHERE name > $cursor ORDER BY name LIMIT $n`, prefix via `LIKE $p || '%'`).
  Identical `{sites, nextCursor}` API shape; dashboard untouched.
- `updateSite` CAS retry loop → transactional row locking.

## Boot sequence

**API:** connect pool → `pg_advisory_lock` → `migrateToLatest()` → unlock →
`seedAdmins(DROP_ADMINS)` → ensure S3 bucket → serve.
**Edge:** connect pool (read-only; **does not migrate**) → serve.

## Testing

- Automated suite uses **PGlite** via a Kysely dialect: `bun test` stays
  self-contained (no Docker) but exercises the real migrations + real SQL.
- Runtime/prod uses node-postgres (`pg`).
- Live verification runs against real Postgres in podman.
- New tests: claim/transfer transactions, CAS via row locks, `users` upsert +
  admin seed, permission map (`can`), visibility set + edge public/password
  enforcement + private→403, admin keyset pagination + prefix search, "list my
  sites" via members query.

## Local dev & infra

- **podman/Makefile:** add a `drop-postgres` container (named volume) alongside
  Floci. `make setup` pulls it; `make start` runs PG + Floci + api + edge;
  `make reset` wipes both volumes.
- **Helm (`infra/`):** chart takes `DROP_DATABASE_URL` as a secret pointing at an
  **external managed Postgres** (RDS/CloudSQL/company DB) — no bundled DB
  (backups/HA are infra's responsibility). Both api and edge get the URL; only
  api runs migrations.

## New dependencies

`kysely`, `pg`, `@types/pg`; dev: `@electric-sql/pglite` + a PGlite Kysely
dialect.

## Out of scope (the "more features" phase)

- Private-site edge authentication (viewer login redirect + membership check).
- DB-driven permission matrix (only if runtime-configurable perms are needed).
- Richer reporting endpoints/dashboards beyond the existing admin browse.
