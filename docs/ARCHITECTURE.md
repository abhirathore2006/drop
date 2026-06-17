# Drop — Architecture

Drop is a self-hosted static-site publisher. Two stateless Hono services share a
**Postgres** metadata store and an **S3** (or S3-compatible) byte store:

- **api** — the control plane: auth, publishing, rollback, sharing, visibility,
  admin, and the dashboard. Owns schema migrations.
- **edge** — the data plane: serves published bytes by hostname, applies per-site
  config and visibility. Read-only against Postgres.

File **bytes** live in S3 (`sites/<name>/files/<verId>/…`). Everything else —
sites, members, versions, users, auth handles — lives in Postgres.

Ports: api `8473`, edge `8474`, Postgres `5432`, S3/Floci `4566` (local), portless
`443` (local, optional).

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
        pg[("Postgres<br/>users · sites · site_members<br/>versions · auth_handles")]
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
    note over A: capture _drop.json (config, not served)
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

    users {
        text email PK
        text name
        text role "admin | member"
        text status "active | suspended"
        timestamptz last_login_at
    }
    sites {
        text name PK
        text current_version "nullable"
        text visibility "public | private | password"
        text password_hash "nullable"
        jsonb config "current _drop.json"
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

`make start` runs api/edge as Node processes against Floci (S3) and Postgres in
podman. `make portless` (optional) fronts them with trusted HTTPS on `:443`.

```mermaid
flowchart LR
    b["Browser / CLI"]

    subgraph pl["portless (optional) :443<br/>local CA · ~/.portless/ca.pem"]
        direction TB
        r{{"host router<br/>--wildcard"}}
    end

    subgraph host["host (Node processes)"]
        api["api :8473"]
        edge["edge :8474"]
    end

    subgraph podman["podman containers"]
        floci[("Floci S3 :4566<br/>vol: drop-floci-data")]
        pg[("Postgres :5432<br/>vol: drop-pg-data")]
    end

    b -->|"https://api.drop.localhost"| r
    b -->|"https://&lt;name&gt;.drop.localhost"| r
    r -->|"alias api.drop"| api
    r -->|"alias drop + wildcard"| edge

    api --> floci
    api --> pg
    edge --> floci
    edge --> pg
```

Without portless, reach the edge at `http://<name>.drop.localhost:8474` and the api
at `http://localhost:8473`. With portless you get production-shaped URLs
(`https://…`, no ports); the edge reads `x-forwarded-host` so the site name
survives the proxy.

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
