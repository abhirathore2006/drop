# Future work

Deferred enhancements with enough design to pick up later. Ordered by leverage.

## 1. First-class database binding (highest leverage)

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

Backups are provisioned (CNPG + Barman Cloud Plugin) but there's no surface to list backups,
verify last-success, trigger an on-demand backup, or restore. Likewise hibernation is only
scheduled (CronJob) — no on-demand hibernate/wake control. Both need new API routes + console UI.

## 4. Usage / quota metering + per-tenant caps

ResourceQuota/LimitRange are set per tenant but never read back, and `claimSite` has no cap, so a
tenant can claim unlimited names. Add per-tenant usage reporting (quota consumption, workload
counts) and a name/workload cap.

## 5. Audit log

No audit trail for mutating/admin actions (delete/transfer/suspend reach any tenant via the
platform-admin `can()` override). Add an append-only audit table + writes on mutating routes,
surfaced in the admin console.

## 6. Runtime user/role management

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
