# Spike: make local CNPG database backups reach Floci (local "EKS" → local "S3")

**Date:** 2026-06-22 · **Branch:** `spike/local-cnpg-backups` · **Status:** proven; minimal fix implemented

## Question

In Phase C, the live verification noted: *"Backup to S3 — manifest verified; local Floci
unreachable in-cluster (accepted) — prod = real S3/443 + IRSA."* Two questions:

1. Why was that "acceptable"?
2. What can be done so the local stack (k3s standing in for EKS) backs up to Floci (the
   local S3 emulator) too — closing the local-mirrors-prod gap?

## Why it was marked "accepted" (and why that was only half-right)

The local cluster is the `.run/cluster-up.sh` workaround: **k3s in one podman container +
Floci in a separate host-side podman container** published on `localhost:4566`. (The
canonical `make compute-up` uses Floci's own EKS, which needs a real Docker daemon — podman
is incompatible, colima is blocked by the corp Zscaler CA — so we run k3s directly.)

Phase C set the CNPG `ObjectStore.endpointURL` to the API's `s3Endpoint`
(`http://localhost:4566`). That is the **API process's host-side view**. Inside a CNPG pod,
`localhost` is the pod itself, so backups had no reachable store. On top of that, the
per-DB egress policy only allowed 443/6443 + DNS + intra-ns + cnpg-system — not `:4566`.

The *core* database features (provision, connect, cross-tenant isolation, hibernation,
delete) don't touch the backup path, so they verified fully. Only backup/restore was
deferred — hence "accepted". **But the gap is closeable**, and for true local-mirrors-prod
it should be closed.

## Investigation (evidence)

Both containers are on the **same podman bridge** `podman` (10.88.0.0/16):

| container | bridge IP |
|---|---|
| `k3s` (node) | 10.88.0.2 |
| `drop-floci` | 10.88.0.3 |

A pod *inside* k3s reaches Floci fine (SNAT via the node), verified from a probe pod:

```
pod → http://10.88.0.3:4566/_floci/health           → 200
pod → http://host.containers.internal:4566/_floci/.. → 200   (podman injects this name)
```

So **reachability was never the problem** — the wrong `endpointURL` + the missing egress
rule were.

## Proof: a real backup lands in Floci

A CNPG `Cluster` with `endpointURL: http://10.88.0.3:4566` and a per-DB egress rule
allowing `:4566 → 10.88.0.0/16`:

- `ContinuousArchiving=True (ContinuousArchivingSuccess)`; plugin log:
  `barman-cloud-wal-archive --endpoint-url http://10.88.0.3:4566 … → Archived WAL file`.
- An on-demand `Backup` (`method: plugin`) → `phase=completed`.
- Floci now holds the objects:
  ```
  s3://drop/spike/spike-pg/spike-pg/base/20260622T082410/data.tar.gz   (4.2 MB)
  s3://drop/spike/spike-pg/spike-pg/base/20260622T082410/backup.info
  s3://drop/spike/spike-pg/spike-pg/wals/0000000100000000/0000…01.gz   (continuous WAL)
  ```
- End-to-end via the **API** (`drop db:create bkdb`): the emitted ObjectStore used
  `endpointURL=http://10.88.0.3:4566`, the netpol carried `:4566 → 10.88.0.0/16`, and WAL
  archived to `s3://drop/databases/<ns>/bkdb/…`.

## The fix (implemented on this branch, config-driven; prod unaffected)

CNPG runs *in-cluster*, so its object-store endpoint is distinct from the API's host-side
`s3Endpoint`. Two new config knobs (both local-only; unset in prod → real S3 on 443 + IRSA,
already covered by the tenant 443 egress):

| env | meaning | local value |
|---|---|---|
| `DROP_DB_BACKUP_S3_ENDPOINT` | in-cluster S3 endpoint for CNPG (≠ the API's host view) | `http://<floci-bridge-ip>:4566` |
| `DROP_DB_BACKUP_S3_EGRESS_CIDR` | CIDR the DB pod may egress to for the store on its non-443 port | `10.88.0.0/16` |

- `src/config.ts` — parse both.
- `src/api/server.ts` — the DB endpoint uses `dbBackupEndpoint ?? s3Endpoint` for the
  ObjectStore, and passes `objectStoreEgress {cidr, port}` (port parsed from the endpoint).
- `src/kube/cnpg.ts` — `databaseManifests` emits a scoped extra egress rule
  (`{ipBlock: cidr}` on the store port) when `objectStoreEgress` is set — never `0.0.0.0/0`.

## Productionizing the local default (recommendations, not yet wired)

The proven endpoint used Floci's **dynamic** bridge IP (`10.88.0.3`), which can change on a
Floci restart. For a stable local default, pick one:

1. **Discover at bring-up** (simplest): in `cluster-up.sh` / `compute-up.sh`,
   `DROP_DB_BACKUP_S3_ENDPOINT=http://$(podman inspect drop-floci -f '{{…IPAddress}}'):4566`.
   `DROP_DB_BACKUP_S3_EGRESS_CIDR=10.88.0.0/16` is stable (the bridge CIDR).
2. **`host.containers.internal:4566`** — stable name, resolved + reachable from pods
   (verified). Confirm its resolved IP falls inside the egress CIDR before relying on it.
3. **In-cluster MinIO/Floci Service** (most prod-like): run the backup store as an in-cluster
   `Service`; the endpoint becomes `http://<svc>.<ns>:4566` and egress is a `namespaceSelector`
   (no IPs at all). Heaviest, but no host-networking coupling.

Recommended: **(1)** for the existing podman stack (one line in the bring-up), **(3)** if we
later want the local stack fully decoupled from the host.

## Restore

Not exercised in this spike. CNPG restore is `bootstrap.recovery` referencing the same
ObjectStore (plus `externalClusters` with a `serverName`). With backups now landing in Floci,
a local restore drill is a straightforward follow-up.
