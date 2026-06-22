# Admin/Operator Console — Phase D plan

Drop now runs three workload types (static sites, container apps, managed Postgres) under
a multi-tenant control plane, but the only UI (`src/api/dashboard.ts`, inline vanilla JS) is
a static-sites-only per-user panel. This phase builds a proper operator console.

Delivered in two sub-phases on `feat/compute-platform`, each: implement (TDD) → review×2 →
commit → live-verify on the k3s stack.

## D1 — Backend read-model + ops routes (frontend-agnostic)

The dashboard can't even tell sites from apps from DBs today: the read endpoints omit
`type`. D1 fixes the read-model and adds the ops reads the console needs.

1. **`type` on every read.** `GET /v1/sites` (list), `GET /v1/sites/:name`, and
   `GET /v1/admin/sites` include `SitesTable.type`.
2. **Per-type detail on `GET /v1/sites/:name`.**
   - site: unchanged (versions, collaborators, visibility…).
   - app: `image` + `scale` (from the applied manifests via `KubeClient.getApp`) + **live
     status** — replicas / ready, from a new `KubeClient.getAppStatus(ns,name)` reading the
     Deployment `.status`.
   - database: connection reference (host / port / database / credentialsSecret — **never the
     password**) + **live status** — CNPG `.status.phase` + ready/instances, from a new
     `KubeClient.getDatabaseStatus(ns,name)`.
   - All cluster reads are best-effort: if compute is off or the object is gone, omit the
     live block (never 500 the detail call).
3. **Admin filters.** `GET /v1/admin/sites` gains `?owner=` and `?type=` (keyset pagination
   preserved) for offboarding / type-scoped browsing.
4. **Tenant suspension (activate the dead hook).** `authMiddleware` rejects a verified
   identity whose `users.status` is `suspended` (403). New admin route
   `POST /v1/admin/users/:email/status {status}` (admin-only) to suspend/reactivate, backed
   by a `UserStore.setStatus`. `users.status` already exists in the schema.

KubeClient additions (`types.ts`, `fake.ts`, `client.ts`): `getAppStatus`, `getDatabaseStatus`
(both return `null` when absent). FakeKube returns canned, test-settable values.

## D2 — React/TS SPA

- **Stack/build:** Vite + React + TypeScript → static assets in `dist-ui/`. The API serves
  them at `/` like it serves `/cli`. React stays OUT of the `api`/`edge` esbuild runtime
  bundles (served statically only). Shared TS types from `src/` where practical.
- **Auth:** unchanged — server-mediated Google OAuth + the `drop_session` cookie; the SPA is
  a `/v1/*` client. 401 → login screen linking the existing `/auth` flow.
- **Views:** Workloads (mine; Sites / Apps / Databases, type-branched) · per-type detail
  drawer (site: versions/rollback/visibility/collaborators/transfer/delete; app:
  image/scale/live health + delete; database: connection ref + status + delete) · Admin (if
  `me.admin`): all tenants, filter by owner/type, drill-in with live health, suspend/reactivate.
- **Out of v1 scope (no backend hooks yet):** audit-log UI, backup list/restore UI,
  usage/quota metering, on-demand DB hibernate/wake.

## Verification

Unit/integration green (`bun test`), `tsc` clean, esbuild bundles still free of React +
`@kubernetes/client-node`. Live: load the console against the running k3s stack — apps + DBs
render with live status, admin lists all tenants by type, suspend blocks a user.
