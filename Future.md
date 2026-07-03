# Future work

Deferred enhancements with enough design to pick up later. Ordered by leverage.

## 1. First-class database binding (highest leverage)

> **Status (2026-07-04):** SHIPPED (slice B1). `app.uses: [{ database: <name> }]` → the deploy
> resolves the database (must be in the caller's org, else a `400`) and wires the app's pod:
> `envFrom` the CNPG `<db>-app` Secret (PG* incl. password — never copied into the app's own
> secret), a read-only `<db>-ca` CA mount at `/var/run/drop/db-ca/<db>/ca.crt`, and
> `PGSSLMODE=verify-full` + `PGSSLROOTCERT`. Landed in `app-config.ts` (`uses` sanitizer),
> `kube/manifests.ts` (envFrom + CA volume/mount + TLS env), `api/server.ts` (resolve + same-org
> authz), docs in `configuration.html`.

**Problem.** Today, wiring an app to a managed database is manual and fragile:
- The operator/user must read the CNPG `<db>-app` Secret, build a connection string, and pass
  it as app `env` (`PGHOST`/`PGPASSWORD`/…). This **copies the DB password into the app's own
  `*-env` Secret** — a second copy of a credential the platform already manages.
- It's a footgun in practice: CNPG serves a **self-signed (operator-CA) TLS** cert, so clients
  must trust that CA or disable verification; and a connection-string env var can collide with a
  driver's own env precedence (we hit exactly this — Bun.SQL silently preferring a stale
  `DATABASE_URL`). See the todo-app post-mortem.

**Proposal.** Let an app *declare* a database dependency and have the platform bind it:

```yaml
# drop.yaml
app:
  image: ecr/todo:1
  uses:
    - database: tododb        # a database the same owner created
```

At deploy, the API:
1. Verifies the caller owns (or is a member of) `tododb`.
2. Wires the app's Deployment to the CNPG-managed Secret directly —
   `envFrom: [{ secretRef: { name: tododb-app } }]` — so `PGHOST`/`PGUSER`/`PGPASSWORD`/
   `PGDATABASE` come straight from CNPG. **No password is copied into the app's `*-env` Secret**,
   and credential rotation just works (the pod re-reads on restart).
3. Mounts the **CNPG cluster CA** (the `<db>-ca` Secret) and sets `PGSSLROOTCERT` +
   `PGSSLMODE=verify-full`, so the app verifies TLS properly instead of `rejectUnauthorized:false`.
4. Adds nothing to egress — app↔DB is already intra-namespace (Phase A allows it).

**Why now-ish.** It removes a whole class of connection bugs, stops duplicating secrets, and is
the natural counterpart to `db:create`. Touch points: `app-config.ts` (`uses`), `kube/manifests.ts`
(extra `envFrom` + CA volume), `api/server.ts` deploy (resolve the referenced DB + authz), and a
docs page "connecting an app to a Drop database".

**Interim guidance until this lands:** pass individual `PG*` env vars (not a `DATABASE_URL`), and
either trust the CNPG CA or use the driver's "encrypt without verify" option.

## 2. `db:proxy` — external psql access (deferred from Phase C)

A platform-mediated, authorized TCP tunnel so a developer can `psql` a managed DB from their
laptop — **not** raw `kubectl port-forward` (which bypasses authz). Needs a short-lived, scoped
tunnel the API issues. The in-cluster app↔DB path needs no proxy, so this is for human/CLI access
only. Security-sensitive (TCP-over-authenticated-channel); its own slice.

## 3. Backup list / restore UI + on-demand DB hibernate/wake

> **Status (2026-06-26):** SHIPPED except restore. Added `GET/POST /v1/databases/:name/backups`
> (list + last-success + on-demand trigger via the Barman Cloud Plugin), `POST .../hibernate` and
> `.../wake` (declarative `cnpg.io/hibernation`), surfaced in the console DB page + `drop db
> backups|backup|hibernate|wake` + MCP. **Remaining: restore** — deferred to item 9 (`db migrate`),
> which is designed around CNPG `bootstrap.recovery` from a Barman backup.

Backups are provisioned (CNPG + Barman Cloud Plugin) but there's no surface to list backups,
verify last-success, trigger an on-demand backup, or restore. Likewise hibernation is only
scheduled (CronJob) — no on-demand hibernate/wake control. Both need new API routes + console UI.

## 4. Usage / quota metering + per-tenant caps

> **Status (2026-06-26):** SHIPPED. `GET /v1/orgs/:slug/usage` reports workload counts + the cap +
> live ResourceQuota consumption (`KubeClient.getTenantUsage`); a per-org workload cap
> (`DROP_MAX_WORKLOADS_PER_ORG`, 0 = unlimited) is enforced at claim time (429). Surfaced on the
> console "my workloads" page + `drop org usage` + MCP `org_usage`.

ResourceQuota/LimitRange are set per tenant but never read back, and `claimSite` has no cap, so a
tenant can claim unlimited names. Add per-tenant usage reporting (quota consumption, workload
counts) and a name/workload cap.

## 5. Audit log

> **Status (2026-06-26):** SHIPPED. Migration 0005 + `audit_log` (bigserial id = keyset cursor),
> `AuditStore.record/list`; writes wired on delete/visibility/collaborators/transfer/db-password/
> user-status/user-role/org create+members (best-effort — a failed audit write never fails the
> action; the password is never logged). `GET /v1/admin/audit` (filters + paging) + an admin-console
> "audit" tab + `drop admin audit` + MCP `admin_audit`. (Routine publish/deploy stay in the
> `versions` table, not duplicated here.)

No audit trail for mutating/admin actions (delete/transfer/suspend reach any tenant via the
platform-admin `can()` override). Add an append-only audit table + writes on mutating routes,
surfaced in the admin console.

## 6. Runtime user/role management

> **Status (2026-06-26):** SHIPPED. `GET /v1/admin/users` + `POST /v1/admin/users/:email/role`
> (admin only; can't change your own role → no self-lockout, so demoting others can't remove the
> last admin). Admin-console "users" tab (role toggle + suspend/reactivate) + `drop admin
> users|set-role|suspend|reactivate` + MCP `admin_list_users`/`admin_set_role`.

`UserStore.setRole`/`listUsers` exist but aren't wired to routes; granting/revoking admin requires
editing `DROP_ADMINS` and rebooting. Add admin routes + console UI (suspension already shipped).

## 7. DB password rotation: distributed lock + configurable operand image

The `POST /v1/databases/:name/password` rotation (`db:password`) serializes concurrent rotations
with a **process-local** `Set` (`rotatingPasswords` in `api/server.ts`) — correct for the common
double-submit / two-admin case on a single API instance, but a **multi-replica** deployment could
still run two rotations against the same DB concurrently. Replace with a distributed lock (a
metastore row lock / advisory lock keyed on the DB name) when the API runs >1 replica.

Also, the rotation Job reuses the live Cluster's `.status.image`; when that's unset it falls back to
a hardcoded `DEFAULT_OPERAND_IMAGE` (`kube/cnpg.ts`) — an internet `ghcr.io` tag that won't pull in
an air-gapped / mirror-only registry. Make the fallback config-overridable (and mirror it) for prod.
In practice `.status.image` is set whenever the DB is connectable (the only time rotation can
succeed), so this is a defensive edge, not a routine path.

## 8. CLI/MCP-driven image build + push (local == prod), target: in-cluster builds

> **Status (2026-06-23):** Step 2 shipped on `feat/image-registry` — an `ImageStore` port
> (`containerd` local / `registry` prod backends, like `SecretStore`), `PUT /v1/apps/:name/image`,
> and `drop push` / `drop deploy --build` (build locally → stream a `docker save` tarball through
> Drop → cluster). The manual `ctr import` is now optional. **Remaining:** verify the prod registry
> (ECR) backend against a real/emulated registry + wire tenant-ECR/pull-creds in Terraform, and
> Step 3 (in-cluster Kaniko/BuildKit builds — the no-local-Docker end-state). An MCP `app_push`
> tool can mirror the CLI once a build context is settled.
>
> **Review follow-ups (deferred, low-risk):** (a) a reused image tag won't roll the pods (the
> `--build` path mints a fresh tag each build, so this only bites a manually-pinned reused tag —
> a deploy-time pod-template annotation would make same-tag redeploys roll); (b) containerd image
> GC — every `--build` adds a tagged `drop.local/<app>:*` layer the node never reclaims, so prune
> old tags per app (matters on the 8Gi local VM); (c) `drop push` claims an app name without
> provisioning tenant manifests/quota (deploy does that later) — the upload size cap bounds disk
> abuse, but a per-tenant name/workload cap (item 4) is the real backstop.

**Problem.** Drop is bring-your-own-image: `drop deploy` only forwards the `app.image` string from
`drop.yaml` into the Deployment's `container.image` verbatim — no build, no push, no
`imagePullPolicy`, **no `imagePullSecrets`** (`kube/manifests.ts:126`). Consequences:
- **Local** is a manual hack that *bypasses Drop entirely*: `podman build -t docker.io/library/<n>:<t>`
  then `podman save | podman exec k3s ctr … images import` to shove the image straight into k3s's
  containerd, *then* `drop deploy` (`examples/DATABASE_APPS.md:104-120`). The non-`:latest` tag is
  what makes k8s use the imported image (default `IfNotPresent`) instead of pulling.
- **Prod (EKS)** has no tenant image path at all. Terraform provisions ECR only for the *platform's*
  own api/edge images (`infra/terraform/foundation/main.tf:14-27`); there is **no tenant registry,
  no pull-credential wiring**. A private-registry tenant image would `ImagePullBackOff`. The docs
  admit it: *"in a real cluster you'd `docker push` to a registry instead"* (`DATABASE_APPS.md:60`).

So the two environments use *different, manual* image delivery, and neither goes through Drop —
the opposite of a Heroku/Fly PaaS.

**Proposal.** One CLI/MCP-driven flow that puts the image in a registry the cluster pulls from,
**identical locally and in prod**. Build it in increments toward an in-cluster builder:

- **Step 1 — registry + CLI build/push (smallest parity win).** Stand up a registry in both
  environments: a `registry:2` container at `localhost:5000` locally (k3s configured to pull from
  it), an **ECR repo per tenant/app** in prod (Drop provisions it at app-create + injects
  `imagePullSecrets`, or uses node IRSA). `drop deploy` (or a new `drop build`/`drop push`) builds
  the app's Dockerfile with the local Docker/podman, tags it `<registry>/<tenant>/<app>:<version>`,
  pushes, and deploys referencing that ref. **Kills the `ctr import` hack; local == prod.** Needs a
  local container builder (already required today).
- **Step 2 — push the built image *through* Drop (no client registry creds).** CLI `docker save`s
  the built image and **streams the tarball to a Drop API endpoint**, reusing the static-site
  `publish` tarball-upload pattern (`/v1/sites/:name/versions` → an analogous `/v1/apps/:name/image`).
  Drop loads it into the registry/containerd server-side. Developers never handle registry auth.
- **Step 3 — in-cluster builds (TARGET end-state, full Heroku).** CLI uploads only the build
  *context* (source tarball); Drop builds the image **in-cluster with Kaniko/BuildKit** (no local
  Docker), pushes to the registry, streams build logs back to the CLI, and deploys. This is the
  north-star: `git push`-style `drop deploy ./app` with zero local container tooling. Largest new
  surface — a builder workload, build-log streaming, per-build resource limits + layer cache.

**Why / touch points.** Closes the single biggest "is this really a PaaS?" gap. Touches
`app-config.ts` (drop the implicit-tag assumption; maybe a `build:` block), `kube/manifests.ts`
(explicit `imagePullPolicy` + `imagePullSecrets`), `api/server.ts` (image-upload/build routes +
per-tenant registry provisioning), `cli/commands.ts` + `cli/client.ts` + `mcp/server.ts` (a
`build`/`push` surface), `infra/terraform` (tenant ECR + pull IAM/IRSA) and `infra/local`
(`registry:2` + k3s registry config). Steps 1→3 ship independently; each removes manual work.

## 9. `db migrate` — move a managed database across orgs/owners (data-safe)

**Problem.** `drop transfer` re-homes a **site** (metadata) and an **app** (tear down + redeploy —
stateless), but **blocks databases**. A DB's CNPG `Cluster` + PVCs are namespace-scoped, and a
resource's namespace is org/owner-derived, so a metadata-only org/owner flip would orphan the data in
the old namespace (or point the new namespace at an empty DB). The handler refuses with *"databases
cannot be transferred (stateful); back up and recreate"*. Today the only way to move a DB to another
org is manual: `drop db create <new> --org <slug>` → `pg_dump`/restore (or restore the Barman backup)
→ repoint the app's `PGHOST` + `PGPASSWORD` → delete the old.

**Proposal.** `drop db migrate <db> --org <slug>` (and/or `--to <email>`) orchestrates that as ONE
data-safe flow instead of a pointer flip:

1. Provision a fresh CNPG `Cluster` in the target org's namespace.
2. Restore from the DB's latest **Barman backup** (CNPG `bootstrap.recovery` from the ObjectStore;
   point-in-time capable) — never a live volume move.
3. Verify (row counts / a checksum) before any cutover.
4. Optionally **cut over**: rotate the app's `PGHOST` + `PGPASSWORD` secret to the new DB and
   redeploy (pairs naturally with first-class DB binding, item 1).
5. Drop the **old** `Cluster` only after the operator confirms — explicit + reversible; the source is
   never deleted implicitly.

**Why / touch points.** Completes the org model: an app *and* its database can both live in a team
org, and both can move. Touches `api/server.ts` (a migrate route driving create→restore→verify→
cutover→cleanup), `kube/cnpg.ts` (bootstrap-from-backup into a new namespace), `cli/commands.ts`
(`db migrate`), and builds directly on the existing Barman backups (item 3's backup/restore surface
is the foundation). Heavier than a flag — sequence after item 1 so the app re-point is declarative.

## 10. Storage quotas: per-app + per-tenant, admin-adjustable

> **Interim shipped:** a **hard per-database storage cap of `1Gi`** (`MAX_DB_STORAGE` in
> `db-config.ts`), enforced at the control plane — `POST /v1/databases/:name` returns `400` when the
> requested `storage` exceeds it, and the CLI/MCP reject up front (`parseDatabaseConfig` throws). The
> default DB PVC is now `1Gi`. This is a flat, non-configurable stopgap; the item below is the real system.

**Problem.** Storage is barely governed (see the code today): the tenant `ResourceQuota`
(`kube/manifests.ts` `QUOTA`) caps only `cpu`/`memory`/`count-pods`/`count-services` — there is **no
`requests.storage` and no `count/persistentvolumeclaims`** limit — and container apps have **no
ephemeral-storage limit** at all (the `LimitRange` sets only cpu/memory). The interim cap above is a
single hard-coded ceiling with no per-tenant budget and no way to raise it for a team that needs more.

**Proposal.** A real quota system with two levels and an admin override:

1. **Per-app** — an ephemeral-storage `default`/`max` in the tenant `LimitRange` (so an app's writable
   layer/`/tmp` can't fill the node), and keep the per-database PVC-size ceiling but make it a
   configurable limit rather than the hard-coded `1Gi`.
2. **Per-tenant (org)** — add `requests.storage` + `count/persistentvolumeclaims` to the tenant
   `ResourceQuota` so an org has a **total** storage budget across all its databases, not just a
   per-DB cap. Report consumption alongside the existing usage metering (item 4 —
   `GET /v1/orgs/:slug/usage` already returns the live `ResourceQuota` hard/used).
3. **Admin-adjustable** — persist per-org quota overrides (a metastore table, default = platform
   default) and an admin route + console control to raise/lower an org's cpu/memory/storage/workload
   limits; `applyTenant` reads the override when emitting the `ResourceQuota`/`LimitRange`. Pairs with
   the per-org workload cap (`DROP_MAX_WORKLOADS_PER_ORG`, item 4), which should become a per-org
   override too rather than a single global env var.

**Why / touch points.** Storage is the one resource a tenant can exhaust with no ceiling today.
Touches `kube/manifests.ts` (`QUOTA` + `LimitRange` gain storage dims, sourced from an override),
`api/server.ts` (admin quota routes + `applyTenant` call sites), `db-config.ts` (configurable cap),
a new metastore table for per-org overrides, and the console (an admin quota editor). Note the local
k3s `local-path` provisioner does **not** enforce PVC size — quotas bind in prod (real CSI/EBS); test
accordingly.
