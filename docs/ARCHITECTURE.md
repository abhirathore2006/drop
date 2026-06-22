# Drop — Architecture

Drop is a self-hosted **static-site publisher** *and* an opt-in **compute platform** (container
apps + managed Postgres + secrets). Two stateless Hono services share a **Postgres** metadata
store and an **S3** byte store; the compute plane adds a **Kubernetes** cluster:

- **api** — the control plane: auth, publishing/deploy, rollback, sharing, visibility, admin, the
  dashboard, and — when compute is enabled — apps, databases, secrets, and lifecycle. Owns schema
  migrations; the only writer to Postgres and the cluster.
- **edge** — the data plane: serves published **site** bytes by hostname, and **dispatches `app`
  hostnames** to the in-cluster KEDA HTTP interceptor (scale-from-zero). Read-only against Postgres.

Static **site** bytes live in S3 (`sites/<name>/files/<verId>/…`); site/app/database **metadata**
lives in Postgres; **apps**, **databases**, and **secrets** are Kubernetes objects in per-tenant
namespaces. Compute is **opt-in** — enabled only when the api has `DROP_KUBECONFIG`; otherwise
`/v1/apps` & `/v1/databases` return `501` and Drop is static-only.

Ports: api `8473`, edge `8474`, Postgres `5432`, S3/Floci `4566` (local), nginx `443` (local
HTTPS, optional), k3s `6443` (local compute).

---

## 1. System overview

```mermaid
flowchart TB
    subgraph clients["Clients"]
        cli["drop CLI<br/>(npx git-URL)"]
        mcp["MCP server<br/>(AI clients)"]
        dash["Dashboard<br/>(browser)"]
        viewer["Site viewers<br/>(browser)"]
    end

    subgraph drop["Drop services (stateless Hono)"]
        api["api · control plane<br/>:8473<br/>auth · publish · rollback<br/>share · visibility · admin · dashboard"]
        edge["edge · data plane<br/>:8474<br/>host routing · visibility gate<br/>SPA fallback · disk cache"]
    end

    subgraph stores["State"]
        pg[("Postgres<br/>users · sites (site/app/db) · site_members<br/>versions · app_secret_keys · auth_handles")]
        s3[("S3 / Floci<br/>sites/&lt;name&gt;/files/&lt;verId&gt;/…")]
    end

    google["Google OAuth<br/>(API is the client)"]

    cli -->|"POST /v1/* (Bearer)"| api
    mcp -->|"POST /v1/* (Bearer)"| api
    dash -->|"/v1/* (cookie)"| api
    viewer -->|"GET https://&lt;name&gt;.drop.…"| edge

    api -->|"login / token mint"| google
    api -->|"metadata R/W<br/>(claim, CAS, members)"| pg
    api -->|"write file bytes<br/>prune old versions"| s3
    api -.->|"migrate on boot<br/>(pg_advisory_lock)"| pg

    edge -->|"pointer + visibility<br/>(10s mem cache)"| pg
    edge -->|"read bytes<br/>(disk cache → S3)"| s3
```

The api and edge are the only moving parts; both are horizontally scalable because
all shared state is in Postgres + S3. The edge never writes and never migrates.

---

## 2. Publish flow

`drop publish ./dist myapp` → a tarball streamed to the api, which writes bytes to
S3 and flips the live pointer in Postgres.

```mermaid
sequenceDiagram
    autonumber
    participant C as CLI / MCP
    participant A as api
    participant PG as Postgres
    participant S3 as S3

    C->>A: POST /v1/sites/myapp/versions (tar.gz, Bearer)
    A->>A: verify token → identity (SessionVerifier)
    A->>PG: getSite(myapp)
    alt site does not exist
        A->>PG: upsert user (FK prerequisite for owner membership)
        A->>PG: claimSite — INSERT … ON CONFLICT DO NOTHING + owner member [tx]
    end
    A->>A: can(actor, "publish")?  (else 403)
    loop each file in tarball
        A->>S3: put sites/myapp/files/<verId>/<path>
    end
    note over A: capture drop.yaml (config, not served)
    A->>PG: putVersion(<verId>, fileCount, bytes, config)
    A->>PG: updateSite → current_version, config,<br/>visibility=password if basicAuth [SELECT … FOR UPDATE tx]
    A-->>C: { url, version, files, bytes }
    A--)A: prune (best-effort): for each version beyond keepVersions,<br/>skip the live one, else delete its S3 prefix + its PG row
```

Atomicity: the name claim is `INSERT … ON CONFLICT DO NOTHING` (first writer wins);
the pointer flip is a row-locked transaction (replaces the old S3 ETag CAS).

---

## 3. Serve flow

A browser requests `https://<name>.drop.example.com/path`; the edge resolves the
site, enforces visibility, and streams bytes.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant E as edge
    participant PG as Postgres
    participant S3 as S3

    B->>E: GET /path  (Host / X-Forwarded-Host = <name>.drop.…)
    E->>E: siteFromHost(x-forwarded-host ?? host) → name
    alt pointer cache miss (>10s)
        E->>PG: getPointer(name) → {version, config, visibility, passwordHash}
    end
    alt no current version
        E-->>B: 404
    else visibility = private
        E-->>B: 403 (fail closed — viewer auth is a later feature)
    end
    opt config.basicAuth present OR visibility = password
        E->>E: basic-auth vs config.basicAuth users / passwordHash
        opt missing/bad credentials
            E-->>B: 401 WWW-Authenticate
        end
    end
    E->>E: CORS preflight · redirects · exact / cleanUrls / SPA fallback / 404
    alt disk cache hit
        E-->>B: 200 bytes (from disk / OS page cache)
    else
        E->>S3: get sites/name/files/<version>/<key>
        E--)E: write-through to disk cache
        E-->>B: 200 bytes
    end
```

The long-lived in-memory cache holds only the small per-site pointer (10s TTL) —
asset **bytes** are never *retained* in memory. They're served from the node-local
disk cache (OS page cache keeps hot files at RAM speed) or fetched per-request from
S3; each object body is buffered briefly to serve the response and then freed, so
memory use is bounded by concurrency, not by site count.

---

## 4. Data model

```mermaid
erDiagram
    users ||--o{ site_members : "is"
    sites ||--o{ site_members : "has"
    sites ||--o{ versions : "has"
    sites ||--o{ app_secret_keys : "has"

    users {
        text email PK
        text name
        text role "admin | member"
        text status "active | suspended"
        timestamptz last_login_at
    }
    sites {
        text name PK
        text type "site | app | database"
        text current_version "nullable"
        text visibility "public | private | password"
        text password_hash "nullable"
        text runtime_state "running | stopped (apps)"
        jsonb config "current drop.yaml"
    }
    app_secret_keys {
        text app PK "FK → sites.name (cascade); PK is (app, key)"
        text key PK "env-var name — NAMES only, never values"
        text fingerprint
        text updated_by
        timestamptz updated_at
    }
    site_members {
        text site_name PK "FK → sites; PK is (site_name, email)"
        text email PK "FK → users"
        text role "owner | editor | viewer"
    }
    versions {
        text site_name PK "FK → sites; PK is (site_name, id)"
        text id PK "sortable verId"
        text published_by
        timestamptz created_at
        int file_count
        bigint bytes
        jsonb config
    }
    auth_handles {
        text id PK "OAuth state"
        text poll_token
        text code_verifier
        text status "pending | done | denied"
        text mode "cli | browser"
        text token "nullable"
    }
```

Exactly one `owner` per site is enforced by a partial unique index
(`unique(site_name) where role='owner'`). Deleting a site cascades to its members
and versions. Authorization is two-axis: platform role (`users.role`) + per-site
role (`site_members.role`), resolved by `can(actor, action)` in
`src/authz/permissions.ts`. Visibility is an independent axis (who may *view* the
served pages) from roles (who may *manage* the site).

---

## 5. Local development topology

Two local options. **`make start`** runs api/edge as Node processes against Floci (S3)
and Postgres in podman — fast iteration over plain `http://…:<port>`. The
**`docker compose`** stack runs everything in containers behind **nginx** for trusted
HTTPS on `:443` — mirroring the prod ingress.

```mermaid
flowchart LR
    b["Browser / CLI"]

    subgraph nx["nginx :443 (compose)<br/>TLS · host routing"]
        direction TB
        r{{"api.* → api<br/>*.drop.localhost → edge"}}
    end

    subgraph svc["containers (compose) / processes (make start)"]
        api["api :8473"]
        edge["edge :8474"]
        floci[("Floci S3 :4566")]
        pg[("Postgres :5432")]
    end

    b -->|"https://api.drop.localhost"| r
    b -->|"https://&lt;name&gt;.drop.localhost"| r
    r -->|"X-Forwarded-Host"| api
    r -->|"X-Forwarded-Host"| edge

    api --> floci
    api --> pg
    edge --> floci
    edge --> pg
```

With `make start`, reach the edge at `http://<name>.drop.localhost:8474` and the api at
`http://localhost:8473`. With the compose stack you get `https://api.drop.localhost/`
and `https://<name>.drop.localhost/` on `:443`; nginx sets `X-Forwarded-Host`, which
the edge reads so the site name survives the proxy.

---

## 6. Production topology (Kubernetes)

Helm (`infra/helm/drop`) deploys api + edge behind one ingress. Postgres is an
**external managed** database (RDS / CloudSQL); S3 is the real bucket via IRSA.

```mermaid
flowchart TB
    dns["DNS<br/>api.drop.example.com<br/>*.drop.example.com"]
    lb["Load balancer + TLS<br/>(ALB + ACM wildcard)"]

    subgraph k8s["Kubernetes"]
        ing["Ingress"]
        apiD["api Deployment<br/>(replicas, HPA)<br/>migrates on boot"]
        edgeD["edge Deployment<br/>(replicas, HPA)<br/>emptyDir disk cache"]
    end

    s3[("S3 bucket<br/>(IRSA, no keys)")]
    rds[("Managed Postgres<br/>(RDS / CloudSQL)")]

    dns --> lb --> ing
    ing -->|"host api.*"| apiD
    ing -->|"host *.*"| edgeD
    apiD --> s3
    apiD --> rds
    edgeD --> s3
    edgeD --> rds
```

Migrations run on api-pod boot under a `pg_advisory_lock`, so a multi-replica
rollout is safe — one pod migrates, the rest wait then serve. The edge connects
read-only and never migrates. `DROP_DATABASE_URL` is injected from a Secret into
both deployments.

---

## 7. Compute plane (apps · databases · secrets)

Opt-in (enabled by `DROP_KUBECONFIG`). The **api** is the only cluster writer; it talks to the
Kubernetes API over plain `node:https` with **server-side apply** (no `@kubernetes/client-node`),
behind a `KubeClient` port (`FakeKube` in tests). Everything a tenant owns lives in a **per-tenant
namespace** `drop-t-<slug(email)>-<hash>`, locked down by:

- **NetworkPolicy** — default-deny; egress allowlist excludes the cluster pod/service CIDRs
  (`DROP_BLOCKED_EGRESS_CIDRS`) so tenants can't reach each other or the platform DB.
- **ResourceQuota** + **LimitRange** (no unbounded pods), **PodSecurity** (baseline) labels, and
  the **gVisor** RuntimeClass for untrusted images in prod.

```mermaid
flowchart TB
    subgraph cp["api (control plane)"]
        K["KubeClient (https + SSA)"]
        SS["SecretStore port<br/>kube | aws"]
    end
    subgraph ns["tenant namespace drop-t-…"]
        dep["app Deployment<br/>+ Service + HTTPScaledObject"]
        sec["&lt;app&gt;-secret Secret<br/>(envFrom)"]
        cl["CNPG Cluster<br/>+ ObjectStore + ScheduledBackup"]
    end
    keda["KEDA HTTP add-on<br/>interceptor (scale-from-zero)"]
    eso["External Secrets Operator"]
    asm[("AWS Secrets Manager<br/>/ Floci")]
    s3[("S3 / Floci<br/>(WAL + backups)")]

    K --> dep & cl
    SS -->|kube| sec
    SS -->|aws| asm --> eso --> sec
    edge["edge"] -->|"&lt;app&gt; host"| keda --> dep
    dep -->|envFrom| sec
    cl --> s3
```

**Apps.** `drop deploy` → `appManifests` translates `drop.yaml` `app:` into a Deployment +
Service + **HTTPScaledObject** (KEDA HTTP add-on) + ingress NetworkPolicy. No `replicas` on the
Deployment — KEDA owns the count (0..max). The edge proxies `<name>.drop.example.com` to the KEDA
**interceptor** via `node:http` (preserving the Host header), which wakes a scaled-to-zero pod on
the first request. Lifecycle: **restart** bumps a pod-template annotation; **stop** pauses the
ScaledObject (`paused-replicas: 0`) *and* scales to 0 (true offline — won't wake on traffic);
**start** un-pauses. `runtime_state` in Postgres makes a stop survive redeploys.

**Databases.** `drop db:create` → a **CloudNativePG** `Cluster` (Postgres 18, single instance),
with backups via the **Barman Cloud Plugin** (`ObjectStore` + `ScheduledBackup`, method `plugin`)
to S3 (local Floci, prod IRSA). The app user/db are bootstrapped from a platform-owned
`<db>-app` Secret. `drop db:password` rotates the role password with a one-shot, idempotent
in-namespace `ALTER ROLE` Job (a role changes its own password — no superuser), then syncs the
Secret. Apps connect in-namespace to `<db>-rw`.

**Secrets.** Write-only per-app secrets behind a `SecretStore` **port**, backend chosen at deploy
time. **`kube`**: the api merge-patches the `<app>-secret` Secret per key (set never prunes
siblings). **`aws`**: the api writes one **AWS Secrets Manager** secret per key at
`drop/<ns>/<app>/<KEY>` and reconciles an **ExternalSecret** (explicit per-key `remoteRef`s); the
**External Secrets Operator** syncs it into `<app>-secret`. Either way the Deployment `envFrom`s
`<app>-secret` (listed after `<app>-env`, so a secret wins on a key collision; `optional` so an
absent Secret never blocks startup). The metastore holds only key **names** + a fingerprint; a
value is never returned, logged, or persisted outside the secret manager and the pod env.

**Local = prod shape.** Locally the cluster is **k3s-in-podman** with KEDA, CNPG, and ESO
installed by `make compute-up`; the `aws` secrets backend and CNPG backups run against **Floci**'s
S3 + Secrets-Manager emulation, so the local stack exercises the same code paths as EKS.
