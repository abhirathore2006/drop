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
