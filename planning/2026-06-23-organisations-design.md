# Organisations — feasibility analysis + design

**Status:** proposed (Task 3 of the org epic) · **Date:** 2026-06-23 · branch `feat/organisations-plan`

**Question (from the goal):** can we let users create **organisations**, where permissions run at the
**org level**, and an org is a **logical grouping** of resources (apps, databases, sites)?

**Verdict: yes, and cleanly** — because the one hard part (per-owner tenant namespaces holding live
workloads) maps to orgs *without moving any running workload*, if every user gets a **personal org
whose namespace equals their existing one**. Teams are then just shared orgs with their own namespace.

---

## 1. Where we are today

- `users(email PK, role admin|member, status)` — platform identity.
- `sites(name PK, type site|app|database, …)` — the workload row (one global name namespace).
- `site_members(site_name, email, role owner|editor|viewer)` — **per-resource** membership; exactly
  one `owner` per site (partial unique index).
- `app_secret_keys`, `versions`, … hang off `sites.name`.
- **Authz:** `can(actor, action)` (`src/authz/permissions.ts`) — platform admin is all-powerful;
  otherwise the actor's **per-site** role decides. Non-members get nothing.
- **Isolation:** the Kubernetes tenant namespace is **owner-derived**: `drop-t-<slug(ownerEmail)>-<hash>`
  (`src/api/tenant.ts`). All of an owner's apps/DBs live there, fenced by NetworkPolicy/quota.

The limitation: ownership + sharing are **per resource**. There's no "team" that owns a set of
resources, and granting a colleague access means adding them to each site one by one.

## 2. Target model

- An **organisation** owns resources and has **members with org-level roles**. A user belongs to ≥1
  org and can create more. Every resource belongs to exactly one org.
- **Permissions run at the org level:** an org member's role applies to **every** resource in the org.
- **Per-resource grants stay** (today's `site_members`) as an *additive, finer* layer — so we can
  migrate existing collaborators without over-granting, and teams can still share a single resource
  with someone who isn't a full org member.
- **Isolation moves to per-org:** the tenant namespace is **org-derived** (`drop-t-<orgSlug>-<hash>`).

### The personal-org bridge (why this is migration-safe)

Every user gets a **personal org** on first login, with **`slug` chosen so its namespace equals the
user's current owner-derived namespace**. Then:
- Existing resources are owned by the user → assign them to that user's personal org. Their workloads
  are **already in that namespace**, so nothing moves.
- Single-user flows are unchanged (you're always acting in your personal org by default).
- A **team org** is a new org with its own (new) namespace; resources created in it land there.

Moving a resource **between orgs** is the same problem as cross-owner transfer today (namespace is
derived) → **re-deploy** for apps, **blocked** for stateful databases. Consistent with the existing
transfer rules; documented, not silently broken.

---

## 3. Data model (proposed)

```
organisations
  id           text PK            -- ulid/slug-id
  slug         text UNIQUE        -- DNS-safe; drives the namespace (personal org slug = user handle)
  name         text
  kind         text               -- 'personal' | 'team'
  created_by   text  FK→users.email
  created_at   timestamptz

org_members
  org_id       text FK→organisations.id ON DELETE CASCADE
  email        text FK→users.email
  role         text               -- 'owner' | 'admin' | 'member' | 'viewer'
  created_at   timestamptz
  PK (org_id, email)              -- partial unique index: one 'owner' per org

sites
  + org_id     text FK→organisations.id   -- the resource's org (NOT NULL after backfill)
```

`site_members` is **kept** (per-resource grants), now interpreted as an override layer on top of org
membership. (A later cleanup can rename it `resource_grants`; not required for v1.)

### Org roles

| role | scope |
|---|---|
| `owner` | manage the org (rename, delete, members incl. other owners), + everything `admin` can |
| `admin` | manage members (below owner) + create/delete/configure **all** resources in the org |
| `member` | create + deploy/manage resources, set secrets, lifecycle (the day-to-day role) |
| `viewer` | read-only across the org |

Mapped to the existing `Action`s in `permissions.ts` (read/logs/publish/deploy/db:create/rollback/
configure/share/transfer/delete) so the action vocabulary doesn't change — only *who* resolves to them.

---

## 4. Authz changes

`can(actor, action)` becomes: **platform admin** ⇒ allow; else the union of
1. the actor's **org role** in the resource's `org_id` (org-wide), and
2. any **per-resource grant** in `site_members` (resource-specific).

`Actor` gains the resolved `orgRole` (looked up from `org_members` by the resource's `org_id`).
`src/authz/permissions.ts` stays the single authority; the `MAP` gains an org-role→actions table
alongside the existing site-role one. Everything else (`actorFor`, the endpoints) is unchanged in
shape — they just pass the org context.

---

## 5. Naming & isolation

- **Names stay global** (one `sites.name` namespace) — simplest, no per-org name collisions to design
  around; a name belongs to one org. (Per-org name scoping is a possible future, not now.)
- **Namespace = `drop-t-<orgSlug>-<hash>`.** `tenant.ts` changes from email-derived to org-slug-derived.
  Personal-org slug is the existing handle, so existing namespaces are unchanged.
- ResourceQuota/LimitRange/NetworkPolicy become **per-org** (they already are per-namespace) — an org's
  resources share a quota, which is the natural "team budget".

---

## 6. Surface (API / CLI / console)

- **API:** `POST /v1/orgs` (create), `GET /v1/orgs` (mine), `GET /v1/orgs/:slug`, `POST
  /v1/orgs/:slug/members` + `DELETE …/members/:email` (owner/admin), `POST /v1/orgs/:slug/transfer`.
  Resource-create endpoints gain an optional `org` (default: the caller's personal org). Detail/list
  responses include `org`.
- **CLI:** `drop org create <slug> [name]`, `drop org ls`, `drop org members <slug>`, `drop org add
  <slug> <email> [role]`; `--org <slug>` on `deploy`/`db:create`/`publish` (default personal).
- **Console:** an **org switcher** in the header; the workload list is scoped to the active org;
  "members" page per org; the create flow targets the active org.
- **MCP:** `org_create` / `org_list` / `org_add_member`, and an `org` arg on deploy/db tools.

---

## 7. Migration plan (backfill, online-safe)

1. Add `organisations` + `org_members`; add nullable `sites.org_id`.
2. Backfill: for each distinct site **owner**, create a personal org (`slug` = the namespace slug they
   already have, `kind=personal`), add them as org `owner`; set every owned site's `org_id` to it.
   Make `org_id` NOT NULL after backfill.
3. Existing `site_members` collaborators are **left as per-resource grants** (no over-grant into the
   personal org). New teams use org membership.
4. Personal-org namespace == existing namespace ⇒ **zero running-workload moves**.
5. `ensureUser`/first-login creates a personal org if absent (idempotent).

---

## 8. Risks & open questions

- **Over-grant on migration** — resolved by keeping `site_members` as a per-resource layer rather than
  folding collaborators into the personal org.
- **Cross-org resource moves** — re-deploy (apps) / blocked (DBs), same as transfer today. Confirm
  that's acceptable for v1 (recommended).
- **Personal vs team default** — creating a resource with no `--org` uses the personal org. Confirm.
- **One-owner-per-org** vs multiple owners — recommend ≥1 owner, allow multiple admins. Confirm.
- **Quota** — per-org shared quota is new behavior for teams; fine for v1 (document it).
- **Billing/SSO/domain-claim** — explicitly **out of scope** here; orgs are the substrate they'd build on.

## 9. Phased rollout (for the implementation plan, Task 4)

1. Schema + `organisations`/`org_members` + `sites.org_id` + backfill migration; `OrgStore`.
2. `tenant.ts` org-slug-derived namespace (personal slug == today) + the personal-org bridge in login.
3. `permissions.ts`: org-role resolution in `can()`; `actorFor` loads the org role; keep per-resource grants.
4. API: `/v1/orgs*` + `org` on create endpoints + `org` in read models.
5. Surfaces: CLI `org *` + `--org`, console org switcher, MCP tools.
6. Docs + examples.

**Recommendation:** feasible and worth doing; the personal-org bridge makes it backward-compatible
with no workload migration. Proceed to an implementation plan (Task 4) if this design is sound.
