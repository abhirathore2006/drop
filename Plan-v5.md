# Drop enhancement plan v5 — complete scope

Supersedes v1–v4. Everything is in scope: stacks, canvas (view **and** edit),
templates (including upstream diffing), previews (static **and** apps), WebSockets, the
L7→L4 load-balancer evolution with port-based TCP access, repo detection, AI intent,
edge metrics, alerting, the supporting items, tenant object
storage (buckets), managed Valkey, Postgres depth (pgvector, pooler, SQL console),
constrained volumes, uptime checks, log retention, `drop exec`, service accounts / CI
tokens, generic OIDC platform login, GitOps mode, environments, **managed auth as
a resource** (Supabase/GoTrue-style per-app end-user auth — deliberately *not* shared
platform auth), **plus** — new in v4 — the app-development loop (release phase, health
checks, worker processes with queue scaling, database branching for previews,
`drop dev`, runtime config/flags, platform OpenAPI + typed client) and a
**production-grade console overhaul** (Workstream M). Buildpacks and the LLM gateway
are excluded by decision (tracked in deferred). Email/SMTP-dependent flows remain a
named future task.
Written in `Future.md` style
(problem → analysis → design → touch points) and cross-referenced against the existing
`Future.md` items so nothing is duplicated — several items here *absorb* or *build on*
items already tracked there (noted inline).

**Verified current state (from source, July 2026):**
- Metastore: `sites` with `type` discriminator (`site|app|database`), `org_id`,
  `runtime_state`; `versions` with per-version `config` jsonb; orgs; audit log
  (`src/db/schema.ts`).
- `drop.yaml`: `site:` (`src/site-config.ts`) + `app:` (`src/app-config.ts`); unknown
  top-level keys ignored ("for now"). **`services[].protocol: "tcp"` is already modeled**
  and rejected only by `assertHttpOnly` — the schema anticipated L4.
- Edge: fetch-style reverse proxy to the KEDA HTTP interceptor; `upgrade` stripped as
  hop-by-hop (`src/edge/server.ts:57`) — no WS path *in the edge* (local nginx already
  forwards `Upgrade` correctly; the block is internal).
- Prod LB: ONE **internal ALB**, L7, single `HTTPS:443` listener, ACM wildcard cert,
  host routing api/edge (`infra/terraform/eks/main.tf:8-10,362`). Local nginx mirrors it.
- Rollback: sites only (409 for apps, `src/api/server.ts:803`). Logs: one-shot tail,
  no streaming (`src/kube/client.ts:279`).
- Console — React in name only: ONE 1,019-line `src/ui/app.tsx`; 3-route regex
  router; CSS is a ~95-line **template string injected at runtime from `main.tsx`**
  (dark-only, hardcoded hex — no light mode); server-generated HTML shell
  (`src/api/dashboard.ts`) with **no CSP/security headers**; **IIFE bundle** (ESM
  move required before any code-splitting), one unversioned `/ui/app.js`; native
  `confirm()`/`prompt()` for destructive actions; no dev server/HMR; **client-side
  permission re-implementation** (`isOwner`/`canDeploy` in `WorkloadPage`); status
  via client-side regex over reason strings; **no way to publish from the console**.
- `Future.md`: items 1 (DB binding — designed, unshipped), 2 (`db:proxy` tunnel —
  deferred), 3/4/5/6 largely shipped, 7 (distributed rotation lock), 8 (image builds —
  step 2 shipped, step 3 in-cluster builds pending), 9 (`db migrate`), 10 (storage quotas).

**Workstreams and dependency graph:**

```
A. Network plane (WS → L4/TCP → db:proxy)          [independent start]
B. Stack core (Future.md item 1 → spec → drop up)  [independent start]
C. Canvas (read-only → editing)                    [needs B]
D. Templates (registry → upstream diff)            [needs B]
E. Previews (static → apps) + Environments         [static independent; apps need quotas (FM item 4/10); envs need B+D]
F. Agent & intent (detect → stack MCP → AI intent) [needs B; AI intent best after D]
G. Observability (logs -f → metrics → uptime → alerts → log retention) [independent; canvas consumes it]
H. Supporting (app rollback, cron, app→app edges)  [rollback/cron independent; edges need B]
I. Data & storage (buckets → Valkey → PG depth → volumes) [buckets independent; all bind via B]
J. Platform identity & access (service accounts/CI tokens → generic OIDC → drop exec) [independent]
K. Managed auth resource (GoTrue engine, app RBAC, SDK) [needs B (stack edges), I1 helpful (secrets pattern), SMTP flows deferred]
L. App dev loop (release/healthcheck/processes → DB branching → drop dev → flags → OpenAPI) [L1 core independent; queue workers need I2; branching needs E2+FM9 machinery; dev needs A3]
M. Console: proper React app (re-platform+foundation → drop-zone publish → IA → permissions/governance → streaming → data/SSE → quality bar) [M0 before C1; rest tracks feature delivery]
```

| Order | Slice | Workstream | Size |
| --- | --- | --- | --- |
| 1 | A1 WebSockets through the edge | A | S–M |
| 2 | B1 DB binding (Future.md item 1, as designed) | B | M |
| 3 | L1 drop.yaml evolution: `healthcheck` + `release` + `processes` | L | M |
| 4 | B2 Stack spec + `drop up` + plan API | B | L |
| 5 | G1 `drop logs -f` · H1 app rollback (parallel fillers) | G/H | S+S |
| 6 | M0 Console re-platform + foundation (Vite/ESM, wouter, data layer, design system, status contract, CSP) | M | M–L |
| 6b | M0.5 Drop zone — drag-and-drop publish from the console | M | S |
| 7 | C1 Read-only canvas with live state | C | M |
| 8 | I1 Tenant object storage (buckets) (+FM item 10) | I | M |
| 9 | A2 L4 plane: NLB + TCP router + port registry | A | L |
| 10 | J1 Service accounts / scoped CI tokens | J | S–M |
| 11 | D1 Template registry | D | M |
| 12 | E1 Static previews · H2 cron (parallel) | E/H | S–M |
| 13 | I2 Managed Valkey · I3 PG depth (pgvector/pooler) (parallel) | I | S+S |
| 14 | L1b Queue-scaled workers (KEDA on Valkey lists) | L | S |
| 15 | A3 `db:proxy` tunnel (Future.md item 2, folded in) | A | M |
| 16 | F1 `drop detect` + stack MCP tools | F | M |
| 17 | M1 Console IA: sidebar, org switcher, ⌘K palette, first-run onboarding | M | M |
| 18 | J2 Generic OIDC platform login | J | M |
| 19 | G2 Edge request metrics · G2b uptime checks | G | M+S |
| 20 | M2 Permission-aware UI: capabilities API, tokens/webhooks/quota panels, admin governance | M | M |
| 21 | K1 Managed auth resource (engine + wiring) | K | L |
| 22 | C2 Canvas editing (magnetic connections) | C | L |
| 23 | J3 `drop exec` | J | S–M |
| 24 | K2 App RBAC seed + claims hook + `@drop/auth` SDK | K | M |
| 25 | M4 Data-heavy views: metrics charts (uPlot), tables at scale, stack page, SSE stream | M | M |
| 26 | H3 App→app edges (service discovery) | H | M |
| 27 | E2 App previews | E | M |
| 28 | L2 Database branching for previews | L | M |
| 29 | I4 SQL console · I5 constrained volumes (parallel) | I | S+M |
| 29b | M3 Streaming surfaces: live logs, exec terminal (xterm), SQL grid | M | M–L |
| 30 | D2 Template upstream diff ("outdated") | D | M |
| 31 | E3 Environments | E | M |
| 32 | L3 `drop dev` (local loop) | L | M |
| 33 | F2 AI intent layer | F | S–M |
| 34 | L4 Runtime config / feature flags | L | S–M |
| 35 | G3 Alerting / notifications | G | M |
| 36 | L5 Platform OpenAPI + generated typed client | L | M |
| 37 | B3 GitOps mode (`stack link`) | B | S–M |
| 38 | G4 Searchable log retention | G | M–L |
| 39 | M5 Console quality bar (a11y, **responsive/mobile pass**, perf budget, Playwright e2e) | M | M (ongoing) |

---

# Workstream A — Network plane

## A1. WebSockets through the edge

**Problem.** `examples/chat-ws` needs `kubectl port-forward` (bypasses authz). The local
nginx and (post-A2) the LB both pass upgrades fine; the failure is inside the edge — the
fetch-based proxy cannot carry an `Upgrade`, and it strips the header deliberately.

**Design.**
1. Node-level `server.on('upgrade')` handler in the edge, *before* Hono: parse Host →
   resolve site → **run the full visibility/session gate pre-upgrade** (reject 403 before
   101; a viewer-blocked WS must never half-open).
2. Proxy path: verify whether the pinned KEDA HTTP interceptor version passes WS
   (check `infra/local/compute-up.sh` + Helm values; recent interceptor versions do). If
   yes: open the upgrade against the interceptor and splice sockets
   (`socket.pipe(upstream).pipe(socket)`). If not: route the upgrade **directly to the
   app Service** (`<name>.<ns>.svc`), with a wake shim — on a 0-replica app, fire one
   throwaway GET through the interceptor, poll readiness (bounded ~10 s), then connect.
   Document that latency; apps needing instant WS set `scale.min: 1`.
3. Limits: per-host concurrent-upgrade cap + idle timeout (default 5 min, config)
   so long-lived sockets can't pin edge memory. Count WS bytes into A2's metrics later.
4. Prod note: ALB supports WS but its idle timeout (default 60 s) will drop quiet
   sockets — raise via ingress annotation now; NLB (A2) removes the concern (350 s,
   and truly transparent).

**Touch points.** `src/edge/server.ts` + new `src/edge/ws-proxy.ts`; interceptor version
pin; ALB idle-timeout annotation in the Helm chart; `examples/chat-ws` README; docs.

**Testing.** e2e on `make up`: two WS clients echo through the edge; a scale-from-zero
wake test; unit test the pre-upgrade auth gate with FakeKube.

## A2. L4 plane — NLB, TCP router, port-based access

**Problem.** Everything today is HTTPS:443 through an L7 ALB. Raw-TCP workloads —
`psql` from a laptop, Redis, MQTT brokers, gRPC over plain TCP, game servers — have no
path. `app-config.ts` already models `protocol: "tcp"`; `assertHttpOnly` is the only
gate. The ask: evolve the LB story from L7 to L4 so port-based access exists alongside
the HTTP plane.

**Analysis — the three constraints that shape the design.**
1. **No Host header at L4.** Only two routing keys exist for raw TCP: **TLS SNI**
   (client sends the hostname in the handshake — libpq does since PG14, TLS Redis does,
   many others do) or a **dedicated port per service** (universal but scarce: NLB
   listener quota is ~50 default). Therefore: SNI-routing on shared well-known ports is
   the primary mechanism; per-service port allocation is the fallback for non-SNI
   protocols.
2. **No Google login at L4.** Visibility/roles are HTTP-session-borne and cannot gate a
   TCP SYN. TCP exposure must be **opt-in per resource, default off**, audited, LB kept
   `internal`, backed by protocol-native auth (DB password, Redis `requirepass`), and
   fenced by the existing default-deny NetworkPolicy (an explicit allow from the TCP
   router only). `db:proxy` (A3) remains the *strongly-authorized* alternative — the two
   are complements, not competitors.
3. **No scale-to-zero for TCP.** The KEDA HTTP interceptor can't wake on a TCP SYN.
   Config validation must enforce `scale.min ≥ 1` for any app exposing TCP. Databases
   (CNPG) are always-on — unaffected.

**LB topology — two shapes, recommended migration path.**
- **Step 1 (recommended): dual-LB.** Keep the ALB exactly as-is for HTTPS. Add an
  **internal NLB** for the TCP plane, created by the AWS LB Controller from a
  `Service type=LoadBalancer` (annotated `nlb-target-type: ip`, `internal`) that fronts
  the new TCP router. Zero churn to the HTTP plane; L4 ships independently.
- **Step 2 (consolidation end-state): single NLB.** Move :443 to an NLB **TLS listener**
  (ACM wildcard) forwarding to the edge. Verified viable against current code: the edge
  prefers `X-Forwarded-Host` then falls back to `Host` (`src/edge/server.ts:180`), and
  the HTTP `Host` header survives NLB TLS termination untouched, so routing keeps
  working with no header injection. Enable **PROXY protocol v2** on the target group and
  parse it in the edge to recover client IP (new small parser; nginx locally sets it
  with `proxy_protocol on`). WS becomes fully transparent at the LB. Trade-off: lose
  ALB per-path health checks and any future WAF attachment — acceptable for an internal
  platform; keep Step 1's dual mode as a supported deployment profile either way
  (Helm value `lb.mode: alb|nlb|dual`).

**In-cluster TCP router (`edge-tcp`).** A new small deployment (same repo, new entry
`src/edge-tcp/server.ts`, bundled by `build.mjs` like api/edge):
- Listens on the shared protocol ports (`5432` first; the set is config) + the allocated
  dynamic range.
- **SNI path:** peeks the ClientHello (no termination — bytes pass through end-to-end
  encrypted), extracts SNI `<name>.<baseDomain>`, resolves the workload via a read-only
  metastore lookup (same posture as the edge), checks `tcp_exposed`, and splices to the
  target Service. For Postgres specifically, handle the **libpq SSLRequest preamble**
  (an 8-byte cleartext probe before TLS): read it, forward it, relay the server's `S`,
  then SNI-peek the following ClientHello. Non-TLS Postgres connections on the shared
  port are rejected (no routing key) — `sslmode=require` becomes the documented default.
- **Port path:** connections to an allocated port map directly to one workload; no
  parsing at all. For non-SNI protocols (plain Redis, MQTT, anything).
- Runs **in-cluster** so it has Service DNS and NetworkPolicy identity; the tenant
  default-deny gains a single allow-from-edge-tcp rule *only* for exposed workloads.
- Limits: per-connection idle timeout, per-workload concurrent-connection cap,
  byte counters (feeds G2).

**Port registry + API surface.** Migration adds:

```
tcp_endpoints(site_name, port int null, mode 'sni'|'port', protocol text,
              created_by, created_at)
```

- `POST /v1/sites/:name/expose  {mode, protocol, port?}` — authz `can("manage")`;
  `mode:sni` for TLS-SNI protocols (no port consumed), `mode:port` allocates from a
  configured range (default `7000–7099`, cap enforced — NLB listener quota is the real
  ceiling; SNI mode exists precisely to conserve it). `DELETE` to unexpose. Both audited
  (`tcp.expose` / `tcp.unexpose`).
- On allocate/release the API **patches the edge-tcp Service's port list**; the LB
  controller reconciles NLB listeners from it. (This is the one eventually-consistent
  hop — surface "provisioning" state until the listener is live.)
- CLI: `drop expose <name> [--port|--sni] [--protocol tcp|postgres|redis]`,
  `drop expose ls`, `drop unexpose`. MCP mirrors. Console: an "exposure" panel on the
  detail page showing the connect string (`host:port` or SNI host), with a copy button.
- `app-config.ts`: retire `assertHttpOnly` for stacks/apps that declare
  `services[].protocol: tcp` **and** are exposed; enforce `scale.min ≥ 1` there.
  Databases: `drop db expose <db>` is the primary consumer (direct psql).

**Local parity.** nginx gains a `stream {}` block: `listen 5432; ssl_preread on;` map
SNI → edge-tcp NodePort, plus a raw forward for the dynamic range. `make up` wires it;
`infra/local/doctor.sh` checks the ports.

**Touch points.** New `src/edge-tcp/` (~400 lines: SNI peek, PG preamble, splice,
limits); `build.mjs`; migration + `src/metastore/store.ts`; `src/api/server.ts`
(expose routes + Service patch via `KubeClient`); `src/kube/manifests.ts` (edge-tcp
Deployment/Service emitted by the chart, tenant NetworkPolicy allow rule);
`src/app-config.ts`; CLI/MCP/console; `infra/helm` (`lb.mode`, NLB Service +
annotations); `infra/terraform/eks` (NLB security group, quota note); `infra/nginx`
(stream block); docs page "TCP access" with a security section stating plainly what L4
does *not* authenticate.

**Testing.** Unit: SNI extractor + PG-preamble state machine against recorded
handshake bytes; port-registry allocation/exhaustion. e2e (`make up`): `psql` through
nginx-stream → edge-tcp → CNPG with `sslmode=verify-full`; a plain-TCP echo app on an
allocated port; assert an *unexposed* workload refuses.

**Risks.** SNI availability varies by client (old libpq, some GUI tools) — the port
path and A3's tunnel are the escape hatches, say so in docs. NLB listener quota — cap +
`org usage` reporting (extends Future.md item 4 metering). Security review of the
NetworkPolicy delta is mandatory before ship.

## A3. `db:proxy` — authenticated tunnel (absorbs Future.md item 2)

Even with A2, the tunnel earns its place: it works on deployments **without** the L4
plane (static-only, locked-down networks), it carries **real per-user authz + audit**
(L4 cannot), and it needs no exposure opt-in. Design: `drop db proxy <db> [--port]`
opens a local listener; each connection dials a **WebSocket to the API**
(`/v1/databases/:name/tunnel`, rides A1's upgrade handling on the api side), which
authorizes (`can("logs")`-tier or a new `can("connect")`), then splices to the DB
Service in-cluster. Short-lived tunnel tickets (single-use token bound to user+db,
60 s TTL) prevent replay; per-user concurrent-tunnel cap; every open audited
(`db.tunnel.open`). Touch: `src/api` tunnel route, `src/cli` local listener, authz verb,
docs. Explicitly *not* raw `kubectl port-forward` — the whole point is authz.

---

# Workstream B — Stack core

## B1. First-class DB binding — **land Future.md item 1 exactly as designed there.**
`uses: [{database: name}]` → `envFrom: {secretRef: <db>-app}` + CNPG CA mount +
`PGSSLMODE=verify-full`. It is the edge primitive for everything below; do not invent a
second binding mechanism. (Its TLS story also pre-solves A2's `sslmode` default.)

## B2. Stack spec + `drop up`

**Problem.** Drop's unit is a single resource; app↔DB↔secret wiring is a three-command
imperative dance recorded nowhere. Canvas, templates, previews-of-stacks, detection,
and AI intent all need a declarative multi-resource graph.

**Spec.** New top-level `stack:` in `drop.yaml` (unknown-key posture keeps old CLIs
safe):

```yaml
stack:
  name: myproduct
  resources:
    db:  { type: database, storage: 1Gi }
    api:
      type: app
      dir: ./api                # build context → existing --build streaming path (FM item 8)
      uses: [{ database: db }]  # B1 edge
      expose: { tcp: false }    # A2 opt-in lives in the spec too
      env: { NODE_ENV: production }
    web:
      type: site
      dir: ./web/dist
      env_from: [{ resource: api, output: url, as: API_BASE }]  # publish-time substitution
```

Sanitizer in `src/stack-config.ts` mirroring `sanitizeAppConfig` conventions
(defensive, junk-ignoring, round-trip safe). ≤ 16 resources v1. Edge kinds v1:
`app→database` (`uses`), `site→app` (`env_from`). `app→app` is H3.

**Metastore (migration):**

```
stacks(id, name, org_id, spec jsonb, spec_version int,
       from_template text null, from_template_version text null,   -- D2 provenance
       created_by, created_at, updated_at)
stack_resources(stack_id, resource_key, site_name)
```

Resources stay ordinary `sites` rows — every existing route, role, and console page
keeps working; the stack is grouping + desired state. Edges live in `spec` jsonb (few,
always read whole). Stack delete offers cascade or orphan.

**Reconciler.** `POST /v1/stacks/:name/up` (spec in body):
1. Validate + authz (org membership, per-resource `can()`).
2. Diff spec vs `stack_resources` + live state → ordered plan
   (create → update → flagged-delete), topologically sorted from edges; cycle-reject.
3. Execute by calling **existing internal operations** (claim, db create, deploy,
   publish) — orchestration, not new resource logic. Halt on failure; applied steps
   stay; retry converges (server-side-apply mental model).
4. `?dry_run=1` returns the plan without executing — this endpoint is also C1's
   pending-changes overlay **and** C2's editor apply-path **and** F1/F2's agent-preview.
Concurrency: metastore advisory lock `stack:<id>` (same mechanism Future.md item 7
needs for rotation — build it once, in `src/metastore`, share it).

CLI: `drop up [dir] [--org] [--dry-run]`; `drop stack ls|status|rm`. `up` packs `dir:`
contexts via the existing image-stream path per app and the tarball path per site.

**Touch points.** `src/stack-config.ts`, `src/stacks/{store,plan}.ts` (plan = pure
diff/toposort — the unit-test asset), migration, `src/api/server.ts` (~4 routes),
CLI/MCP (`stack_up`, `stack_status`, `stack_plan`), audit (`stack.up`, `stack.delete`),
docs "Stacks".

**Testing.** Plan-level table tests: (spec, live) → exact ordered steps. e2e: `drop up`
the guestbook example.

## B3. GitOps mode — `drop stack link`

**Problem.** `drop up` is push-based; teams that want git as the source of truth must
wire CI themselves. The reconciler makes a pull loop nearly free.

**Design.** `drop stack link <name> --repo <url> [--branch main] [--path drop.yaml]`
stores a link row (`stack_links(stack_id, repo, branch, path, auth_secret_ref,
last_sha, last_status, …)`). A poller in the API (interval, jittered; no webhooks v1 —
inbound webhooks mean exposing the API to the git host, keep it pull-only) fetches the
file (token via a write-only secret for private repos), and when the sha changes runs
the standard `up` under the stack's advisory lock. Failures land in the G3 events feed;
`drop stack link status` and a console badge show last-sync sha/status/error.
`--dry-run-only` mode gates execution on a human confirming the plan in the console
(the B2 dry-run endpoint again). Build contexts (`dir:`) are out of scope for the
poller v1 — GitOps mode covers spec-only changes (images pinned by ref); full
source-build-on-push composes later with Future.md item 8 step 3 (in-cluster builds).

**Touch points.** Migration (`stack_links`), poller in `src/api` housekeeping,
CLI (`stack link|unlink|sync`), console badge, audit (`stack.sync`), docs.

---

# Workstream C — Canvas

## C1. Read-only canvas with live state

- SPA route `/stack/<name>` (`parseRoute` in `src/ui/app.tsx`) + a stacks grouping tab.
- `@xyflow/react`, **code-split** (`splitting: true` in `build.mjs`) so list/detail
  pages don't pay; ≤16 nodes means a hand-rolled dagre-ish SVG fallback stays feasible
  if bundle size ever becomes a hard constraint.
- `GET /v1/stacks/:name/graph`: nodes (key, name, type, runtime state, version,
  asleep/hibernated, restart count) + edges from spec. Status via one aggregated
  namespace list per kind, not N calls.
- Node → existing full detail pages (zero new detail UI). Status dot: green/gray-asleep/
  amber-progressing/red-crashloop. Edge labels: what flows (`PG* via <db>-app`);
  post-A2, TCP exposure renders as a distinct badge/edge to an "external" affordance.
- Pending-changes overlay = the B2 dry-run plan, badging create/update nodes.

## C2. Canvas editing ("magnetic connections")

**Principle.** The editor is a **spec editor with a graphical skin**. It never calls
resource APIs; every gesture mutates a client-side copy of the stack spec, and "Apply"
posts it to the same `up` endpoint (`dry-run` first → show the plan → confirm →
execute). One source of truth; CLI and canvas can never diverge.

- Palette: add resource (site/app/database) → node with a form (name key, type-specific
  fields mirroring the sanitizers — reuse the same validation by compiling
  `stack-config` checks for the browser bundle).
- **Magnetic edges:** dragging an app node's edge handle to a database snaps a `uses`
  edge (B1 semantics shown inline: "injects PG* + CA"); site→app snaps `env_from`.
  Illegal edges (db→db, cycles) refuse with the reason. This is a *typed* connection
  system, not free-form lines.
- Deletion marks a node `pending-delete` (plan shows it flagged; execution honors the
  cascade/orphan choice).
- Concurrency: spec carries `spec_version`; `up` rejects on mismatch (optimistic lock)
  → editor prompts rebase (re-fetch, replay local ops — ops are a small command list,
  replay is tractable at this scale).
- Secrets never appear in the editor; the secrets panel stays on the detail page
  (write-only invariant untouched).

**Touch points.** `src/ui/stack-editor.tsx` (+ shared graph components with C1),
browser-safe exports from `src/stack-config.ts`, no new API (reuses B2). Sized L mostly
for UI polish + rebase UX, not backend.

---

# Workstream D — Templates

## D1. Registry

- Model: per-instance; publish org-scoped; visibility `public` (instance-wide default —
  internal tool) or `org`.

```
templates(id, slug, org_id, name, description, visibility, created_by, created_at)
template_versions(template_id, version, spec jsonb, variables jsonb, readme,
                  created_by, created_at)
```

- Variables: `{key, description, default?, required, secret?}`; `${var.x}` substitution
  at instantiate; `secret:true` values are collected then written through the existing
  write-only secret path — never stored in template or stack spec.
- Publish: `drop template publish [--from-stack <name>]`. From-stack export runs a
  **schema-driven strip pass**: drop concrete image digests (keep `dir:`), drop env
  keys in `app_secret_keys` + credential-looking values (key-name + entropy heuristics),
  `${stack}`-prefix names. **Fail closed**: refuse to publish an un-variable-ized
  credential-looking value (`--allow` to override, audited).
- Instantiate: `drop new <slug> [--version] [--org] [--set k=v]` → resolve vars
  (interactive prompt / `--set`) → concrete spec → B2 `up`. Record provenance
  (`from_template`, `from_template_version` on `stacks`).
- Console: templates tab — readme, variables form, **read-only canvas preview** (C1
  component fed the template spec — free), "Deploy this stack" button; deep link
  `/template/<slug>` for docs-site badges.
- Seed: convert `examples/guestbook-node` + `examples/notes-next` into published
  templates in the local seed — proves the loop and starts the golden-path catalog.

## D2. Upstream diff — "Dependabot for infra"

- `drop stack outdated [<name>]` / console badge: compare the stack's provenance
  version to the template's latest; render a **three-way diff** (template@pinned →
  template@latest vs template@pinned → current spec) so local drift is visible
  separately from upstream changes.
- `drop stack upgrade <name> [--to <version>]`: apply upstream changes that don't
  conflict with local drift; conflicts listed per-resource-key with `--take-upstream` /
  `--keep-local` resolution (spec-level, per top-level key — not textual merge; the
  spec is small and structured, keep it that way).
- Result feeds the standard dry-run plan before executing. Console: an "update
  available" banner on the stack page opening the diff view (reuse C1 canvas with
  added/changed/removed node badges).
- Touch: `src/stacks/diff.ts` (pure, table-tested), one API route, CLI, console view.

---

# Workstream E — Previews

## E1. Static previews

- `drop publish ./dist myapp --preview [label]` → version created, `current_version`
  untouched, row in:

```
previews(site_name, label, version_id, created_by, created_at, expires_at)
```

- Hostname `name--label.<baseDomain>` (flat wildcard cert survives; **reserve `--` in
  `src/names.ts`** — verify it isn't currently claimable). Edge splits on `--`, serves
  those version bytes, same visibility gate as parent + `X-Robots-Tag: noindex`.
- Expiry default 7 d; sweep in existing API housekeeping (bytes are version bytes —
  existing retention/GC applies).
- Docs: a ~30-line GitHub Action recipe (`--preview pr-$PR` + URL comment); token login
  already supports non-interactive use.

## E2. App previews

- Same `previews` table (schema already references any workload). `drop deploy … --preview
  <label>` deploys a **parallel manifest set** suffixed `-p-<label>` (Deployment,
  Service, HTTPScaledObject with host `name--label.<base>`; scale `{min:0,max:1}`
  forced), pointing at the freshly built image; secrets/`uses` bindings reference the
  *same* underlying secrets as the parent (read-only reuse — a preview never gets its
  own DB by default; `--with-db` clones an empty DB from the stack spec if the author
  opts in, torn down at expiry).
- Expiry sweep deletes the manifest set (idempotent, same code path as app delete).
- Quota-gated: counts against the org workload cap and A2/FM-item-10 storage caps —
  this is why E2 sequences after quota work, per the original deferral rationale.
- Edge: the `--` split from E1 already routes; `type=app` previews resolve to the
  suffixed host in the interceptor exactly like normal apps.

## E3. Environments

**Problem.** Previews are ephemeral branches of one stack; teams also need durable
parallel instantiations — `staging` and `prod` from one spec with per-env variables.
Designed here so previews and environments **share machinery** instead of growing
apart.

**Design.** An environment is a named, durable instantiation of a stack spec:
`drop env create staging --stack myproduct [--set k=v]` → resources named
`<stack>--<env>-<key>` (reusing the E1 `--` hostname convention), a row in
`environments(stack_id, name, variables jsonb, created_*)`, and a full `up` run with
the env's variable overlay. The *default* environment is the unnamed one that exists
today — zero migration for current users. `drop up --env staging` targets one env;
`drop env promote staging prod` re-runs prod's `up` with staging's currently-applied
spec (spec promotion, never image-less drift — images are pinned refs so promotion is
exact). Variables use the D1 template variable machinery (`${var.x}`), which is the
unification point: a template instantiates into a stack; a stack instantiates into
environments; a preview is a single-resource, expiring, label-named environment.
Canvas: an env switcher on the stack page (same C1 graph endpoint, env-scoped).
Quota: each env's resources count normally against the org caps — environments are not
free, say so.

**Touch points.** Migration (`environments` + env column on `stack_resources`),
reconciler naming/variable overlay, CLI (`env create|ls|rm|promote`, `--env` on
`up|status`), console switcher, docs "Environments" including the
preview-vs-environment decision table.

---

# Workstream F — Agent & intent

## F1. `drop detect` + stack-level MCP

- `drop detect [dir] [--write]`: pure local heuristics — Dockerfile→`app`;
  `prisma/`, `pg`/`postgres` deps, `PG*`/`DATABASE_URL` in `.env.example` →
  `database` + `uses`; build script emitting `dist|build|out` → `site`; one level of
  workspace walk for monorepos. Deterministic; **fixtures = the `examples/` directory**
  (every example must detect correctly — a standing regression suite).
- MCP: `stack_plan(spec|dir)` (dry-run — lets an agent *show the plan before applying*,
  the right agent-safety shape), `stack_up`, `stack_status`, `detect`, `template_list`,
  `template_deploy(slug, vars)`, `expose`/`unexpose` (A2). With these, "deploy this repo
  with a database and give me psql access" is one conversational turn.

## F2. AI intent layer

- Positioning: the deterministic path (F1) + the MCP tools already give agent-driven
  intent-first provisioning. F2 adds it **inside Drop's own console** for humans without
  an MCP client: a prompt box on the stack-create page → calls an operator-configured
  LLM endpoint (`DROP_LLM_URL`/key, provider-agnostic OpenAI/Anthropic-style; **off by
  default**, self-hosted platforms must never silently call out) with the stack JSON
  schema as the structured-output contract → the generated spec lands in the C2 editor
  as *proposed, unapplied* pending-changes — human reviews on the canvas, then Apply →
  dry-run plan → confirm.
- Guardrails: the LLM output goes through the same `stack-config` sanitizer (junk
  ignored), never executes directly, never sees secrets. Prompt template lives in-repo
  and is versioned.
- Touch: one API route (`POST /v1/stacks/generate`), config, console prompt box, docs.
  Deliberately thin — the value is the schema + editor + plan, all built earlier.

---

# Workstream G — Observability

## G1. `drop logs -f`
`GET /v1/sites/:name/logs?follow=1` streams the kube `follow=true` log request through
as chunked text; CLI renders lines; keep the secrets-aware `can("logs")` gate. Touch:
`src/kube/client.ts` (follow variant), `src/api/server.ts:884`, CLI. Console detail page
gains a live tail later (same endpoint via fetch-stream).

## G2. Edge request metrics
The edge (and edge-tcp) are the natural meters — count there:
- Per-hostname counters in-process (requests, bytes in/out, status classes, upstream
  latency histogram buckets; TCP: connections, bytes, durations), flushed every ~15 s to
  a metastore rollup table `traffic_minutes(site_name, minute, requests, bytes_in,
  bytes_out, p50_ms, p95_ms, s2xx, s4xx, s5xx)` (UPSERT; retention 30 d, swept).
  Postgres is fine at internal-platform volumes; the write path is one row/site/minute.
- Surfaces: `GET /v1/sites/:name/metrics?range=…` → detail-page sparkline; C1 canvas
  edge thickness/labels; `drop status` gains a one-line rate. A `/metrics` Prometheus
  endpoint on api/edge (behind admin) for operators who already run Prometheus —
  cheap to add from the same counters, don't build dashboards.
- Crash-loop detection formalized here: restart-count deltas recorded per flush →
  powers the C1 red dot **and** G3.

## G2b. Uptime / synthetic checks
The API pings each workload's URL (and, post-A2, opens a TCP connect for exposed
ports) on a per-workload interval (default 60 s, config), inside the network — no
external prober. Results roll into `uptime_checks(site_name, minute, ok, latency_ms,
status)` with the same retention/sweep as `traffic_minutes`. Failing streaks emit a
G3 event; the C1 status dot becomes *proactive* (a crashed-but-not-yet-requested app
shows red without waiting for a user to hit it). Scale-to-zero apps are **not** probed
by default (a probe would keep them awake) — opt-in `healthcheck: { keep_warm: true }`
or a lightweight interceptor-queue check that doesn't wake the pod. Touch: a poller in
the API, migration, config knob per app in `drop.yaml`, detail-page uptime strip.

## G3. Alerting / notifications
Deliberately minimal, event-driven, no pager pretensions:
- Event sources: crash-loop detected (G2), deploy failed, `stack up` halted, cert/quota
  warnings, preview expiring with traffic.
- Sinks v1: console notification badge (per-org event feed table `events(...)`,
  keyset-paged like audit) + **outbound webhook per org** (`drop org webhook set <url>`
  — covers Slack/Teams via their incoming-webhook URLs without bespoke integrations).
- Dedup: one open "incident" row per (site, kind); resolve on recovery.
- Touch: `events` migration, an emitter in api (called from reconciler/deploy paths) +
  a small poller consuming G2 rollups, org webhook config + delivery with retry/backoff,
  console badge/feed, `drop events`.

## G4. Searchable log retention
Streaming logs (G1) die with the pod; crash post-mortems need history. Full Loki is
against the platform's weight class; the middle path: a log-collector sidecar-free
design — the API tails each running workload's pod logs (one follow stream per pod,
resumable by sinceTime), batches structured lines
(`{ts, site, pod, stream, line}`) into **S3 objects** (`logs/<site>/<hour>.ndjson.gz`,
you already own S3) with a metastore index row per object. Retention default 7 d
(org-overridable via the FM item 10 quota override table), swept. Search:
`GET /v1/sites/:name/logs/search?from=&to=&q=` — time-range narrows to objects via the
index, text match streams through them server-side (grep-grade, not full-text — good
enough and honest about it). Console: a search box on the detail page's logs panel;
CLI `drop logs --since 2h --grep <pat>`. Secrets posture: same `can("logs")` gate;
retention makes the "logs can leak env" warning *more* true — say so in docs, and
exclude databases' verbose logs by default (opt-in). Sized M–L; deliberately last in
G — ship it when usage proves the pull, but it is now *in* the plan, designed to slot
in without rework.

---

# Workstream H — Supporting

## H1. App rollback
Record the image ref in the app's `versions` row config (the `--build` path already
mints per-version refs — Future.md item 8); `rollback` for `type=app` re-applies the
previous version's manifest set. Add the deploy-time pod-template annotation from FM
item 8's review follow-up (a) so same-tag redeploys roll. Removes the 409 at
`src/api/server.ts:803`.

## H2. Cron / scheduled jobs
`app.schedule: "0 3 * * *"` → CronJob manifest instead of Deployment+HTTPScaledObject
(mutually exclusive with `services`; validated). Tenant quota already counts pods.
Touch: `src/app-config.ts`, `src/kube/manifests.ts`, docs. Ends the "worker fronted by
HTTP" workaround.

## H3. App→app edges (service discovery)
Stack edge `uses: [{app: api}]` on another app/site resource:
- Consumer gets `<KEY>_URL` env = `http://<name>.<ns>.svc:<port>` (in-namespace,
  NetworkPolicy already allows intra-namespace) when the target has `scale.min ≥ 1`;
  when the target scales to zero, resolve to the interceptor host instead so the call
  wakes it (documented latency).
- Cross-namespace (cross-org) refs are **refused** in v1 — the isolation model is the
  product; don't hole it casually.
- Touch: `src/stack-config.ts` (edge kind), reconciler env resolution, C2 editor edge
  type, docs.

---

# Workstream I — Data & storage

## I1. Tenant object storage (buckets)

**Problem.** Drop already operates S3 (Floci locally, real S3 in prod) for site bytes,
but apps have no blessed way to store uploads/exports/artifacts — they abuse Postgres
bytea or get hand-provisioned corporate S3 + IAM, exactly the friction Drop exists to
remove.

**Design.**
- `drop bucket create <name> [--org]` → a `sites` row (`type: bucket` — extend the
  discriminator; one shared name namespace as today) mapping to an isolated **prefix**
  in the platform's bucket locally (Floci) and a **per-tenant real bucket or prefix +
  scoped IAM policy** in prod (Terraform-owned policy template; the API mints
  access/secret keys via STS or a per-bucket IAM user — provider-pluggable behind a
  `BucketStore` port, same shape as `SecretStore`/`ImageStore`).
- Binding: stack edge `uses: [{bucket: name}]` injects `S3_ENDPOINT`, `S3_BUCKET`,
  `S3_PREFIX`, and credentials **via the write-only secret path** (never in `drop.yaml`
  or responses). Rotation: `drop bucket rotate <name>` re-mints keys (same
  printed-never-stored posture as `db password`).
- Quota: bucket bytes counted into the FM item 10 storage budget (S3 inventory or a
  sweep totalling object sizes per prefix; eventually-consistent is fine for quota).
- Console: bucket detail page (size, object count, last rotate); no object browser v1
  (that's an app's job, not the platform's).
- Lifecycle: delete requires `--force` when non-empty; audited.

**Touch points.** New `src/buckets/` port + stores (floci-prefix / aws-iam), migration
(discriminator value; no new table — `sites` carries it), API routes, stack edge kind
in `stack-config`, CLI/MCP, Terraform policy template, docs.

**Testing.** Fake bucket store; e2e: guestbook example gains an avatar upload backed
by a bound bucket. **Isolation test is the critical one**: tenant A's creds must fail
against tenant B's prefix — table-test the generated policies.

## I2. Managed Valkey (cache/queue)

**Problem.** After Postgres, a cache/queue is the most-requested PaaS primitive;
BullMQ-style job queues also fall out of it, pairing with H2 cron.

**Design.** Deliberately tiny — the anti-Redis-Cluster: `drop cache create <name>
[--memory 256Mi] [--persistent]` → single-replica Valkey Deployment (+ optional small
PVC when `--persistent`; default **ephemeral**, restart loses data, documented loudly),
`requirepass` generated into a write-only secret, ClusterIP service, no HA, no
clustering — internal caches can be ephemeral and the plan says so. Binding:
`uses: [{cache: name}]` injects `REDIS_URL` (auth included) via the secret path.
Exposure: works with A2 (`drop expose` — TLS Valkey rides the SNI path; plain rides a
port) and A3-style tunnel later if wanted. `type: cache` in the discriminator;
lifecycle verbs reuse the app machinery (it *is* a managed workload).

**Touch points.** `src/kube/manifests.ts` (cache manifest set), config/sanitizer,
API routes, stack edge kind, CLI/MCP/console detail page, quota (pods/memory already
counted; PVC counts under FM item 10), docs with the ephemerality warning.

## I3. Postgres depth — pgvector, pooler

- **Extensions**: `drop db create --ext pgvector[,pg_trgm,…]` against a platform
  **allowlist** (config; pgvector + a curated few v1) → CNPG `Cluster` spec's
  postInit/shared_preload as appropriate. Internal AI tools are exactly Drop's
  audience; pgvector is the single highest-demand extension. `drop db ext add|ls`
  for existing DBs (CNPG handles the restart semantics; surface the "requires
  restart" fact honestly).
- **Connection pooling**: `drop db pooler enable <db> [--mode transaction]` → CNPG's
  first-class `Pooler` resource (PgBouncer) in the tenant namespace; the B1 binding
  gains a `via: pooler` option flipping the injected `PGHOST` to the pooler service.
  Matters as soon as per-request-connection apps meet scale-to-zero churn.
- Touch: `src/kube/cnpg.ts` (spec fields + Pooler manifest), `db-config.ts`
  (allowlist validation), CLI/MCP, DB detail page toggles, docs.

## I4. SQL console

**Problem.** "Let me just check this table" currently means the A3 tunnel + a local
client. A read-only console in the DB detail page is a massive DX win.

**Design.** `POST /v1/databases/:name/query` — authz behind a **new `can("query")`
permission** (owner/editor by default; explicitly *not* viewer), executes against the
DB using CNPG's app credentials over an API-side connection with:
`default_transaction_read_only = on`, `statement_timeout` (5 s), row cap (500),
result-size cap, and **every query audited** (`db.query`, statement text in audit
detail). Read-only is session-enforced, not parsed — no SQL-grammar games. A
`--unsafe-write` escalation is deliberately absent v1 (use the tunnel + real client
for writes). Console: a query box + results grid on the DB page; CLI `drop db query
<db> "select …"` for scripts; MCP tool **excluded** v1 (an agent free-querying tenant
data needs its own review — revisit with K2 claims).

**Touch points.** API route + a pooled read-only connector in `src/api`, authz verb,
audit action, console grid, CLI, docs (including the "audited, read-only, capped"
statement up front).

## I5. Constrained volumes (`stateful: true`)

**Problem.** Some workloads genuinely need a filesystem (SQLite-based tools, small
indexes). Unconstrained PVCs collide with KEDA scale-to-zero and Deployment semantics.

**Design.** Opt-in, deliberately boxed: `app.stateful: { volume: 2Gi, mount: /data }`
→ **forces** `scale: {min: 1, max: 1}` (validated; no HTTPScaledObject — a plain
always-on Deployment with `strategy: Recreate` so the RWO PVC never double-attaches),
one PVC per app, size within the FM item 10 budget (`requests.storage` +
PVC-count quota dims land there). No snapshots/backups v1 — the docs steer stateful
data to I1 buckets or the managed DB and position this as the escape hatch, not the
path. Delete tears down the PVC after an explicit `--force` (audited).

**Touch points.** `app-config.ts` (stateful block + validation), `kube/manifests.ts`
(PVC + Recreate strategy + skip-HTTPScaledObject branch), quota dims (with FM item 10),
CLI/console surfacing ("always-on, single replica" badge), docs.

---

# Workstream J — Platform identity & access

*(Scope note: this workstream is about who operates Drop — CI, operators, admins. It
deliberately does **not** extend platform identities into deployed apps; end-user auth
for apps is Workstream K, fully separate.)*

## J1. Service accounts / scoped CI tokens

**Problem.** CI reuses a human's session token today — unscoped, tied to a person,
unauditable as automation, and it dies when they leave.

**Design.** `drop token create --org <slug> --scope deploy:myapp[,publish:web]
[--expires 90d]` → a `service_tokens(id, org_id, name, scopes jsonb, token_hash,
expires_at, created_by, last_used_at)` row; the secret is printed **once** (same
posture as `db password`). Scopes reuse the existing permission verbs (`deploy`,
`publish`, `rollback`, `secrets.write`, …) optionally resource-qualified
(`verb:name` or `verb:*`). Auth middleware accepts `Authorization: Bearer drop_st_…`
alongside sessions; `can()` gains a token actor whose grants come from scopes instead
of roles. Suspension: revoke immediately (hash lookup per request — cheap); org
delete cascades. Every token action audited with the token id as actor
(`actor: "token:ci-deploy@org"`). The E1 GitHub Action recipe switches to these.
Console: org tokens tab (create/revoke/last-used); `drop token ls|revoke`.

**Touch points.** Migration, `src/auth/middleware.ts` (bearer branch),
`src/authz/permissions.ts` (token actor), API routes, CLI, console, docs. Small,
self-contained, high leverage — sequenced early.

## J2. Generic OIDC platform login

**Problem.** Login is hard-wired to Google Workspace (`src/auth/oidc.ts`); every
non-Google shop (Okta, Entra, Keycloak, Authentik) is locked out of adopting Drop.
Quietly the most important adoption item in the plan.

**Design.** The flow is already standard server-mediated OIDC — generalize the
provider: `DROP_OIDC_ISSUER`, `DROP_OIDC_CLIENT_ID/SECRET`, `DROP_OIDC_SCOPES`
(discovery via `/.well-known/openid-configuration`; Google becomes just the default
issuer, zero migration for existing deployments). Claim mapping config for
email/name (`DROP_OIDC_EMAIL_CLAIM`, default `email`) and an optional
allowed-domain/allowed-group gate replacing the implicit Workspace boundary
(`DROP_OIDC_ALLOWED_DOMAINS`, `DROP_OIDC_GROUPS_CLAIM` + required group). One
provider per deployment v1 (multi-IdP is enterprise-SSO scope creep — refuse it).
**Email/password local accounts stay out** except an env-configured break-glass admin
(no signup, no reset flow, no email dependency — consistent with SMTP deferral).

**Touch points.** `src/auth/oidc.ts` (issuer-generic discovery + claim mapping),
config, Helm values, `SETUP_GOOGLE.md` generalizes to `SETUP_SSO.md` (Google, Okta,
Entra, Keycloak recipes), e2e against a throwaway Keycloak in `make up` (also the
test double for K).

## J3. `drop exec`

**Problem.** Debugging a live app means `kubectl exec` with cluster creds — bypassing
Drop's authz entirely. Heroku's `run` is beloved for a reason.

**Design.** `drop exec <app> [-- cmd]` → WebSocket to
`POST /v1/apps/:name/exec` (rides A1's api-side upgrade handling + the A3 ticket
pattern: single-use, 60 s TTL, bound user+app) → API opens a kube exec stream
(`KubeApiClient` gains the exec subresource over the same `node:https` transport —
no client-node, per ADR-0005) and splices. Authz: a **new `can("exec")` permission**,
default owner/editor — *stricter framing than logs* because a shell sees env, i.e.
write-only secrets become readable; the docs and the permission description say this
in bold. Every session audited (`app.exec`, with command). Idle timeout, per-user
concurrent cap. Databases: **excluded** — `psql` access is A3/A2's job; a shell on
the CNPG pod is an operator action, not a tenant one.

**Touch points.** `src/kube/client.ts` (exec subresource, WS upgrade to kubelet
stream), API route + ticket, CLI raw-TTY handling, authz verb, audit, docs (secrets
warning), console "open shell" button later.

---

# Workstream K — Managed auth resource (Supabase-style, per-app)

*(Positioning, decided: Drop's platform auth is **never** shared with deployed apps.
Instead, auth is a managed **resource type** — like a database — giving each app its
own end-user pool. Model: Supabase/GoTrue — the engine runs per-resource in the
tenant's namespace, users live as rows in the tenant's own Postgres, identity methods
are password + per-app OAuth, authorization is app-defined RBAC stamped into JWT
claims. Drop owns lifecycle and wiring, not the auth engine's internals.)*

**Engine decision.** Embed, don't build: **GoTrue** (MIT, battle-tested, single
container + Postgres schema, env-configured) as the default engine behind an
`AuthEngine` port (image + env-mapping abstraction), so a future swap
(better-auth/SuperTokens) is a new adapter, not a redesign. Password hashing, session
rotation, OAuth linking, and token issuance are the most dangerous code one can write
— Drop writes none of it.

**SMTP boundary (per decision): deferred.** Everything requiring outbound email —
magic links, password reset, email verification, invite emails, email templates — is
**out of v1** and tracked as a named future task ("K-mail: org SMTP relay config +
email-dependent auth flows"). v1 identity methods: **email/password with
verification off** (or admin-created users) **+ per-app OAuth providers**. The
`drop.yaml` schema reserves the `smtp:`/`email:` keys now so K-mail is purely
additive.

## K1. The resource: provision + wiring

- `drop auth create <name> [--db <existing>|--with-db]` → `type: auth` in the
  discriminator; manifests: GoTrue Deployment (small resources, `scale {min:1,max:1}`
  — auth can't cold-start on a login) + Service in the tenant namespace, schema in the
  bound CNPG database (B1's binding mechanics reused for the engine's own DB
  connection: `envFrom` the `-app` secret + CA). JWT keys: **asymmetric per resource**,
  generated at create, private key in a write-only secret mounted to the engine,
  public keys served at a JWKS URL. `drop auth rotate-keys` re-mints (old key kept
  verifying for a grace window).
- Routing: the engine is reachable at `auth--<name>.<baseDomain>` (the E1 `--`
  convention — a reserved prefix class) through the normal edge; **auth endpoints are
  visibility-exempt by nature** (login *is* the auth) — the edge special-cases
  `type: auth` hosts to skip the platform session gate but applies **per-IP rate
  limits on the auth paths** (token, signup, verify) at the edge. This is the one
  carefully-reviewed exemption in the visibility model; documented as such.
- Config surface in `drop.yaml` (`auth:` section) v1: enabled providers
  (`google`, `github`, `oidc` with issuer) each carrying **the app's own** client
  id/secret (secret via write-only path — `drop secrets set <auth>:GOOGLE_SECRET`),
  redirect-URL allowlist, JWT TTLs, signup open/closed. Redirect topology:
  **per-app** callbacks (`https://<app>.<base>/auth/callback`) — no centralized
  broker, by decision (a shared broker drifts back toward shared platform auth).
- Binding: stack edge `uses: [{auth: name}]` injects `AUTH_URL`, `AUTH_JWKS_URL`,
  `AUTH_PUBLISHABLE_KEY` as env; the service/secret key is written to the app's
  write-only secrets (`AUTH_SECRET_KEY`) — publishable vs secret key semantics mirror
  Supabase's anon/service_role split.
- Console: auth detail page — user count, providers, key age, rate-limit counters;
  a minimal user-admin panel (list/search/disable/delete users, create user with
  temporary password — the no-SMTP onboarding path) proxying GoTrue's admin API with
  the resource's service key held server-side, gated by `can("manage")` and audited
  (`auth.user.create/disable/…`).

**Touch points.** `src/auth-resource/` (engine port + GoTrue adapter + manifest set),
discriminator value, `src/edge/server.ts` (visibility exemption + rate limits for
`type: auth` hosts), stack edge kind, API routes (create/config/rotate/user-admin
proxy), CLI (`auth create|ls|config|rotate-keys|users …`), MCP (create/status only —
no user-admin via MCP v1), Helm (engine image pin, air-gap mirror note), docs
("Auth" page with the SMTP-deferred flow matrix up front).

**Testing.** e2e on `make up`: create auth + DB, sign up a user via password, hit a
sample app that verifies the JWT against JWKS; key-rotation grace test; rate-limit
test; **isolation test**: resource A's tokens must fail resource B's JWKS.

## K2. App RBAC + claims hook + SDK

- **RBAC seed**: `drop auth create --with-rbac` (or `auth.rbac: true`) seeds the
  Supabase-pattern tables in the *app's* database — `roles`, `role_permissions`,
  `user_roles` (many-to-many both hops: users↔roles, roles↔permissions — the exact
  model requested) — plus a **claims hook** (a Postgres function GoTrue's custom
  access-token hook calls) stamping resolved `roles: []` and `permissions: []` into
  every issued JWT. Vocabulary is entirely app-defined; fully disjoint from platform
  `can()`. Apps on the bound Drop Postgres can additionally enforce via RLS
  referencing the claims — documented pattern, not platform machinery.
- **APIs first**: the API *is* the engine's REST surface (signup, token, refresh,
  logout, JWKS, admin) at the auth host — stable, documented, curl-able from day one.
- **SDKs later**: phase one is nearly free — `@supabase/auth-js` speaks GoTrue;
  `@drop/auth` (new `packages/auth` in-repo, published) wraps it: reads the injected
  env (`AUTH_URL`, keys), exposes `signIn/signUp/getUser`, plus a server-side
  `verifyRequest(req)` doing JWKS-cached JWT verification and returning
  `{user, roles, permissions}`. Node first (all examples are Node); Python later.
  One example app (`examples/notes-next`) gains login + a role-gated admin page —
  the living integration test and the template seed ("Next.js + Postgres + Auth"
  golden path via D1).
- **MCP**: `auth_status`, `auth_config` — deliberately no end-user CRUD via agents v1.

**Touch points.** RBAC seed migration files shipped as engine-provision assets,
claims-hook function template, `packages/auth` (new workspace — first published
package; wire into `build.mjs`/CI), example app update, template, docs "Roles &
permissions for your app" (clearly separated from the platform's roles page).

**Risks.** Drop becomes a security-critical dependency for every app using K —
key rotation, engine CVE tracking (pin + advisory watch for the GoTrue image),
token revocation on user-disable (respect within TTL; keep TTLs short, 1 h default).
Same "security review mandatory" flag as A2. The visibility exemption at the edge is
the single most sensitive change — it gets its own ADR.

---

# Workstream L — App development loop

*(Design coherence rule: L1's three additions — `healthcheck`, `release`, `processes`
— all touch `app-config.ts` and are **designed as one drop.yaml evolution**, reviewed
together, even if shipped in slices. Piecemeal schema growth here is how config
formats rot.)*

## L1. drop.yaml evolution — `healthcheck:`, `release:`, `processes:`

**Problem.** Three correctness gaps, not luxuries: (a) no readiness/liveness probes —
Kubernetes routes to unready pods and "rolling" deploys aren't zero-downtime; (b) no
release phase — DB migrations run at container boot, so a failing migration
crash-loops the app and scale-to-zero makes "boot" happen at unpredictable times,
racing the B1 binding story; (c) HTTP-fronted processes only — the long-running queue
consumer has no home (H2 cron covers scheduled, not continuous).

**Design.**
- **`healthcheck:`** — `{path: /healthz, interval?: 10s, timeout?: 2s, grace?: 15s}`
  → readiness + liveness probes on the container (readiness gates traffic; liveness
  restarts wedged pods — same endpoint by default, split fields available). Default
  when absent: TCP-socket readiness on the service port (better than nothing, honest
  about it). Ships **before** previews/environments multiply deploy volume.
- **`release:`** — `release: "npm run migrate"` (or `{command, timeout?: 5m}`) → the
  deploy path runs a **Job** (same image/env/bindings as the app, same write-only
  secrets, `backoffLimit: 0`) *after* image readiness and *before* the Deployment
  rollout; Job failure **halts the deploy** — old version keeps serving, the failure
  surfaces in `drop deploy` output, the G3 events feed, and (M2) live deploy progress.
  Serialized per app under the B2 advisory lock so two deploys can't interleave
  migrations. Release logs stream through the G1 path (`drop logs --release`).
- **`processes:`** — a map replacing the implicit single process:

  ```yaml
  app:
    processes:
      web:    { command: "node server.js" }          # gets Service + HTTPScaledObject
      worker: { command: "node worker.js",
                scale_on: { queue: jobs, target: 10 } }  # plain Deployment
  ```

  Exactly one `web` (or zero — worker-only apps become legal, retiring the
  "worker fronted by HTTP" hack for good). Workers get a plain Deployment
  (no Service, no HTTPScaledObject), `scale: {min,max}` static by default. Absent
  `processes:`, today's single-process behavior is unchanged — zero migration.
  Per-process resources override the app-level default; all processes share env,
  secrets, and bindings.
- **L1b — queue-scaled workers** (activates after I2): `scale_on: {queue: <list>,
  target: <depth>}` emits a KEDA `ScaledObject` with the Redis-lists scaler pointed at
  the bound Valkey (address + password from the I2 binding secret — KEDA's
  `TriggerAuthentication` referencing it, staying inside the write-only posture).
  BullMQ + Valkey + queue-scaled workers is the complete async story with zero new
  infrastructure.

**Touch points.** `src/app-config.ts` (the coherent schema + validation: web
uniqueness, release timeout caps, probe bounds), `src/kube/manifests.ts` (probes,
release Job, per-process Deployments, ScaledObject in L1b), deploy path in
`src/api/server.ts` (Job gate + halt semantics), G1 (`--release` log target),
CLI/MCP surface (`drop ps` gains per-process rows), quota (extra processes count
pods — already metered), docs "Processes, health, and releases" as one page.

**Testing.** Manifest snapshot tests per schema permutation; e2e: a deliberately
failing migration must leave the old version serving; a worker-only app must deploy
with no Service; L1b: queue depth scales replicas against local Valkey.

## L2. Database branching for previews

**Problem.** E2 gives app previews an *empty* DB. For internal tools the question is
"does my change break against real data?" — a production-data branch is
disproportionately valuable, and the machinery is ~90 % built by Future.md items 3
(backups shipped) and 9 (`bootstrap.recovery` design).

**Design.** `drop deploy --preview <label> --with-db --from-backup [--at <ts>]` →
the preview's DB is a fresh CNPG Cluster bootstrapped via `bootstrap.recovery` from
the parent DB's latest Barman backup (point-in-time with `--at`) — never a live
volume touch, same principle as FM item 9. Governance, explicit by design: branching
prod data requires the **same permission tier as the parent DB** (`can("manage")` on
it, not just on the preview), the branched DB inherits the parent's role list, the
action is audited (`db.branch`), and the flag is opt-in — never default. Lifecycle:
the branch dies with the preview (expiry sweep tears the Cluster down); storage
counts against the org budget (FM item 10) — a branch is a full copy, say so.
Console: the preview row shows "branched from <db>@<ts>".

**Touch points.** `src/kube/cnpg.ts` (recovery bootstrap — shared with FM item 9;
build it once here, item 9 consumes it), E2 preview path (+ flags), authz check,
audit, quota accounting, docs (with the storage-cost warning).

## L3. `drop dev` — the local inner loop

**Problem.** Drop is where apps end up, not where they're built: running locally
against the app's *managed* resources means hand-copying env and `kubectl
port-forward`.

**Design.** `drop dev [app] [-- cmd]` composes existing machinery: (1) fetch the
app's **non-secret** env + binding metadata; (2) open A3-style authorized tunnels to
each bound DB/cache, allocating local ports; (3) materialize an env with binding
hosts rewritten to `localhost:<port>` (e.g. `PGHOST`); (4) exec the user's command
(or the web process's `command` from L1) with that env, tearing tunnels down on exit.
**Secrets stay write-only — never pulled.** The gap is bridged locally:
`--env-file .env.dev` overlays local values (developer-owned dev credentials), and
`drop dev --check` lists which secret *keys* the app expects (names from
`app_secret_keys` — names, never values) so the developer knows what to fill.
Tunnels are per-user authorized + audited (A3's ticket model), so `drop dev` against
a prod-org DB is visible and gated like any tunnel — teams that want a hard wall put
dev in its own env (E3) and scope roles accordingly.

**Touch points.** `src/cli/dev.ts` (tunnel orchestration + env materialization +
process supervision), a `GET /v1/apps/:name/dev-context` route (env + bindings +
secret key names, authz `can("deploy")`-tier), docs "Local development" —
mostly CLI work by design.

## L4. Runtime config / feature flags

**Problem.** Every config change is a redeploy; "flip a flag" needs a lighter path.

**Design.** Deliberately small — a per-app KV, not a flag platform:
`drop config set <app> key=value`, `ls`, `rm` → `app_configs(app, key, value,
version, updated_by, updated_at)` in the metastore (values are **non-secret** by
definition and validated against a size cap; secrets stay in the secret path —
the CLI refuses credential-looking values with the D1 heuristics). Read path:
`GET /v1/apps/:name/config` returns the map + a version etag; the SDK
(`@drop/config`, a sibling entry in the K2 `packages/` workspace) polls with
`If-None-Match` every 30 s (configurable) and exposes `get(key)`/`onChange`.
Apps authenticate the read with… nothing new: the endpoint is served to the app's
namespace via an injected per-app read token (write-only secret, minted at deploy)
— J1's token machinery with a single implicit `config.read:<app>` scope. Mutations
audited (`config.set/rm`); the console app page gains a config table with inline
edit (M2 action flows). Documented honestly next to the alternative: "a config
table in your bound Postgres is fine too — use this when you want audit + console
edit + no schema."

**Touch points.** Migration, API routes, J1 scope addition + deploy-time token
mint, `packages/config`, CLI, console table, docs.

## L5. Platform OpenAPI + generated typed client

**Problem.** The API is hand-routed Hono; every integrator (and the CLI/MCP
themselves) hand-maintains request/response shapes. "APIs first, SDKs later" applied
to Drop itself.

**Design.** Adopt schema-first routes incrementally: zod schemas per route via
`@hono/zod-openapi` (new routes are born with schemas; existing routes migrate
opportunistically — no big-bang), spec served at `GET /v1/openapi.json` + a rendered
reference page in the docs site (generated at build, kept in `docs/`). Generate
`@drop/client` (typed fetch client, `packages/client`) from the spec in CI; the CLI's
`src/cli/client.ts` migrates to it route-by-route, making the CLI the first consumer
and the permanent conformance test. Versioning: the spec is tagged with the release
version (`drop --version` already bakes it); breaking changes require a spec diff
check in CI (fail on removed/changed fields without a version bump).

**Touch points.** Route schema migration (mechanical, spread across slices),
`packages/client` + codegen in CI, docs reference page, a spec-diff CI gate,
`src/cli/client.ts` migration.

---

# Workstream M — Production-grade console (re-platformed as a proper React app)

**Problem.** The console is React in name but not in architecture: one 1,019-line
`app.tsx`, a 3-route hand-rolled regex router, a ~95-line CSS **template string
injected from `main.tsx` at runtime** (dark-only, hardcoded hex, `color-scheme:dark`
— there is no light mode), a hand-written HTML shell generated server-side
(`src/api/dashboard.ts`) with **no CSP or security headers**, an **IIFE** bundle
(esbuild `format:"iife"` in `build.mjs` — code-splitting is impossible without moving
to ESM), one unversioned `/ui/app.js` asset (no hashing, no cache strategy), native
`confirm()`/`prompt()` for destructive actions, no dev server (edit → full rebuild →
manual refresh), uncached ad-hoc fetches, and **client-side re-implementation of the
permission model** (`isOwner = d?.owner === me.email || me.admin` plus a parallel
`canDeploy` role check inside `WorkloadPage`). Proportionate to 3 resource types and
~10 actions; this plan brings 6+ resource types, ~40 new actions, a canvas editor,
three streaming surfaces, charts, and multi-env navigation.

**Decision: re-platform to a proper React application** — real toolchain, real
project structure, real dev loop — while preserving the deployment invariants that
make Drop simple: the console remains a **static bundle served by the API** (no SSR,
no separate deploy, no CDN, air-gap friendly), and the api/edge node bundles remain
React-free (existing `build.mjs` guarantee).

## M0. Re-platform + foundation

**Toolchain (the "proper React app" change-set, analyzed):**
- **Vite** replaces the hand-rolled esbuild UI block in `build.mjs`. What it buys
  over extending esbuild by hand: a dev server with HMR, ESM output with
  code-splitting and **content-hashed filenames + a manifest**, first-class CSS
  files (imported per component, extracted and hashed), env handling, and an
  ecosystem-standard project shape — versus hand-rolling a manifest/hashing/HMR
  layer on raw esbuild. (Not a bundler ideology change: Vite uses esbuild + Rollup
  internally.) Dev-dependency only; the production artifact is still static files.
- **Project structure**: `src/ui/` → `console/` as a Vite root —
  `console/index.html` (Vite-owned shell; `dashboardHtml()` in
  `src/api/dashboard.ts` is **deleted**), `console/src/{pages,components,lib,styles}`,
  its own strict `tsconfig` with path aliases. Same top-level `package.json`
  (Vite + plugins as devDeps); `node build.mjs` shells out to `vite build` for the
  `ui` target so the one-command build invariant holds.
- **Dev loop**: `make dev-console` → `vite dev` on :5173 proxying `/v1` and the auth
  routes to the local API (:8473); same-origin cookies pass through the proxy
  unchanged. Edit → HMR in ~50 ms replaces edit → rebuild → refresh. The API keeps
  serving the *built* console so non-frontend workflows are untouched.
- **Serving & caching**: the API serves `dist/ui/` — `index.html` (no-cache) at the
  SPA routes it already owns; `assets/*` (content-hashed) with
  `Cache-Control: immutable`. Lazy chunks (canvas, xterm, uPlot, tar) come free
  from ESM splitting.
- **Security headers (new)**: the API sets a strict same-origin **CSP** on console
  responses (`default-src 'self'`, no inline script or style), `frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`. This becomes
  possible precisely *because* the runtime-injected `<style>` string dies in this
  migration — CSS becomes real hashed files, so no `unsafe-inline` anywhere.
  Mandatory before M3's exec terminal and SQL box exist.
- **Router**: adopt **wouter** (~1.6 kB) — ADR-justified like every dependency here:
  the 3-route regex doesn't survive `/stack/:name/env/:env`, `/template/:slug`,
  `/org/:slug/tokens`, and nested admin tabs; wouter gives params/nesting/hooks at
  near-zero cost versus growing the hand-rolled router into a worse version of it.
  (react-router rejected: ~10× the size for unneeded features.)
- **Data layer**: **TanStack Query** — cache, invalidation, polling, optimistic
  updates, request dedup. Conventions: query keys mirror API paths; lifecycle
  mutations optimistically update + invalidate; polling centralized (list 15 s,
  detail 5 s, paused on hidden tab). Replaces the per-page `useState`/`load()`
  pattern and the no-op `onChanged` plumbing. **Live updates**: polling v1; when the
  G3 events table exists, an SSE `/v1/events/stream` feeds the same layer (an event
  invalidates its query key) — real-time without rearchitecting, planned into M4.

**Status contract (API change, small but critical)**: the API returns a normalized
`status: running|asleep|progressing|degraded|stopped|error` + `reason`, computed
server-side in one place — the client-side `StatusPill` regex over free-text reason
strings is deleted. Canvas dots, list pills, uptime strips, CLI, MCP, and G3 events
consume the same enum.

**Design system**:
- **Theming, direction corrected**: tokenize the *existing dark palette* into CSS
  custom properties first (the console is dark-only today), then **add light mode**
  + `prefers-color-scheme` detection + a manual toggle in the user menu.
- Primitives in `components/`: `Button` (danger/loading), `Table` (sortable,
  keyset-paginated), `Form` fields with inline validation (zod schemas shared with
  the server sanitizers via browser-safe exports — zod is already a dependency),
  `Modal` + focus trap, `Toast`, `EmptyState` (per resource type, docs-linked),
  `Skeleton`, `CopyField`, `Tabs`, **`ConfirmDialog`** with type-the-name for
  destructive actions (replaces every native `confirm()`/`prompt()`), and
  **`RevealOnce`** — a named primitive for show-once secrets: copy button, explicit
  "I saved it" dismissal, never-refetchable semantics. Five consumers justify it:
  DB password rotation (today an ad-hoc `pw` state), J1 tokens, I1 bucket keys,
  K1 auth keys, I2 cache passwords.
- **Per-type detail pages (explicit)**: a shared `WorkloadFrame` (header, status,
  members, audit slice, danger zone) + per-type panel modules (`SitePanels`,
  `AppPanels`, `DbPanels`; later `BucketPanels`, `CachePanels`, `AuthPanels`). The
  270-line conditional `WorkloadPage` monolith is decomposed — a discriminator
  growing to six types must not become six-way conditionals.
- **Error taxonomy**: an error boundary per page; API errors mapped to
  toast/inline/page-level by status; a session-expiry interceptor that preserves
  location and re-enters login (today an expired session fails silently mid-action).

## M0.5. Drop zone — drag-and-drop publish

**Problem.** The console is manage-only; nothing can be *shipped* from it. For a
product named **Drop**, the drag-a-folder-onto-the-browser publish (Netlify's iconic
flow) is conspicuously absent — and the backend already exists: the API ingests
gzipped tarballs with path-traversal rejection (`src/archive.ts`,
`/v1/sites/:name/versions`).

**Design.** Packaging happens **in the browser**, keeping the API surface unchanged.
(Analyzed alternative — accept zip server-side — rejected: it adds a second upload
format, a new dependency in the hot ingest path, and a second traversal-hardening
surface, for zero user-visible gain.)
- A drop zone on the list page and each site detail page. Folder drag via
  `DataTransferItem.webkitGetAsEntry()` traversal (all evergreen browsers), with an
  `<input webkitdirectory>` picker fallback.
- The client packs a USTAR tarball (a ~60-line pure writer — the format is trivial)
  and gzips with **fflate** (~8 kB, lazy chunk); uploads to the existing versions
  endpoint with a progress bar (size caps already enforced server-side).
- New-site flow: dropping onto the list page prompts for a name (zod-validated with
  the shared `validateName`), claims, then publishes — the browser equivalent of
  `drop publish ./dist myapp`. A `drop.yaml` inside the dropped folder is honored
  exactly as the CLI path honors it (same server-side parse).
- Respects M2 capabilities: the zone renders only with `publish` capability;
  version history + one-click H1 rollback sit beside it.

**Touch points.** `console/src/lib/tar.ts` (pure; table-tested against
`src/archive.ts` extraction in bun tests — writer and reader verify each other),
drop-zone components, **no API changes**; docs "Publish from the browser". Sequenced
immediately after M0 — small, launch-worthy on its own, and the strongest demo of
the re-platformed console.

## M1. Information architecture — nav, org switcher, command palette

- **Global frame**: persistent sidebar — org switcher at top (org is *context*,
  carried in the URL `?org=` so links are shareable), then Stacks, Workloads
  (filterable by type **and a text filter**), Templates, Activity (events + audit),
  Settings (members, tokens, webhooks, usage/quota), Admin (admin-only).
  Breadcrumbs on detail pages (`org / stack / env / resource`).
- **User menu** replaces the bare email in the header: identity, theme toggle,
  version chip (build sha — already baked for the CLI), docs link, logout.
- **Command palette (⌘K)**: fuzzy jump to any resource/stack/template + verb
  shortcuts; implemented as a filtered index over the already-cached list queries.
- **Environment switcher** on stack pages (E3); preview badges on site/app pages
  (E1/E2). URL scheme carries env context so deep links land correctly.
- **First-run onboarding**: a zero-workloads home showing the instance-configured
  CLI install curl (the API already serves it filled-in), an M0.5 "drag a folder
  here" zone as the no-CLI first win, and template-gallery shortcuts (post-D1).
  Per-route `document.title` and a favicon land here too.

## M2. Permission-aware UI + capabilities API

- A `capabilities` field on list/detail responses: resolved `can()` verbs for the
  current actor, computed server-side — **deleting the client-side permission
  re-implementation** (`isOwner`/`canDeploy` in today's `WorkloadPage`). Convention:
  hidden for admin-only surfaces, disabled-with-tooltip for role-gated actions.
- Org Settings gains: members (exists), **tokens** (J1: scope picker, `RevealOnce`,
  last-used, revoke), **webhooks** (G3), **usage/quota** (with FM item 10 storage
  dims and A2 port counts).
- Token actors render distinctly (`token:<name>`) in audit and events views.
- **Admin governance depth**: the FM item 10 per-org quota **editor** (cpu / memory /
  storage / workload-cap overrides), admin all-workloads with the same capabilities
  conventions, and user management (exists) restyled onto the M0 primitives.

## M3. Streaming surfaces

- **Live logs** (G1): fetch-stream reader → virtualized log view (follow toggle,
  process selector post-L3, client-side grep, pause-on-scroll, download). One
  component reused across app / db / release-Job (L1) surfaces.
- **Exec terminal** (J3): **xterm.js** (lazy chunk) over the exec WS; reconnect
  banner, idle-timeout notice, the secrets warning shown *before* the first session
  per app.
- **SQL grid** (I4): editor (a textarea v1 — no Monaco), results in the shared
  `Table`, row/time caps surfaced, the "read-only, audited" banner permanent.
- All three share a connection-state header (live/reconnecting/closed) and respect
  the M0 session-expiry interceptor.

## M4. Data-heavy views

- **Metrics** (G2/G2b): sparkline on cards; a traffic panel on detail pages
  (requests, p50/p95, error rate, bytes; uptime strip) — **uPlot** (lazy chunk);
  time-range picker (1h/24h/7d) matching rollup granularity.
- **Tables at scale**: audit (→ shared Table + filters by action/actor/org), events
  (G3), tokens, users, template versions, backups — keyset-paginated server-side
  (audit already is; make it the convention).
- **SSE event stream** (`/v1/events/stream`, from the G3 events table): pushes
  invalidations into the M0 query layer and powers a live activity feed — list and
  canvas status flip in real time instead of on the next poll.
- **Stack page composition**: canvas (C1/C2) + env switcher + per-resource metric
  chips + pending-plan drawer — the flagship page; it gets a deliberate design
  pass, not accretion.

## M5. Quality bar

- **Accessibility**: keyboard paths for every action, focus management in
  modals/drawers, ARIA on tables/tabs, contrast-checked tokens in **both** themes.
- **Responsive**: breakpoint passes for list, detail, logs, and events views —
  internal platforms get checked from phones. Canvas and terminal stay honestly
  desktop-first (a "best on desktop" notice, never a broken layout).
- **Perf budget**: initial JS ≤ 250 KB gz (canvas/xterm/uPlot/tar in lazy chunks);
  a bundle-size CI check reading the Vite manifest.
- **Testing**: component tests for primitives + permission rendering + the tar
  writer (bun test + testing-library/happy-dom — stays in the existing runner;
  vitest rejected to avoid a second test runner); **Playwright e2e** riding
  `make up` for golden paths (login → drag-drop publish → deploy → logs → rollback;
  token create/reveal-once/revoke; template instantiate).
- **Resilience details**: relative timestamps with absolute-on-hover, timezone
  honesty, number formatting, no layout-shift loading, list virtualization past
  ~200 rows, an offline/API-down banner.

**Non-goal (stated)**: the docs site (`docs/`, static HTML on GitHub Pages) stays
static by design — it is content, not an app; re-platforming it buys nothing.

**Sequencing note.** M0 lands **before C1** so the canvas ships onto the new
architecture; M0.5 immediately after (small, launch-worthy, the re-platform's best
demo); M2 before the permission-heavy features surface; M3/M4 when their backends
(G1/J3/I4, G2) exist; M5 partly continuous with a final hardening slice.

---

# Cross-cutting

- **Future.md reconciliation.** This plan absorbs item 1 (B1), item 2 (A3); it depends
  on item 8's image path (B2, H1, B3) and item 4/10's quotas (A2 port caps, E2/E3,
  I1 bucket bytes, I5 PVC dims, L2 branch storage — **FM item 10 should be scheduled
  alongside I1**); the advisory-lock utility built for B2 satisfies item 7's need
  (and serializes L1 release Jobs) — implement it once in `src/metastore`. Item 9
  (`db migrate`) remains tracked there; **L2 builds the `bootstrap.recovery` machinery
  item 9 consumes**, and post-B2 its cutover step becomes a stack-spec edit + `up`.
- **The `sites` discriminator grows**: `site|app|database` + `bucket` (I1),
  `cache` (I2), `auth` (K1). Each reuses the shared name namespace, org ownership,
  roles, audit, and console patterns — the extension mechanism working as designed;
  keep new types on it rather than new top-level tables.
- **Ports pattern continuity**: `BucketStore` (I1) and `AuthEngine` (K1) follow the
  existing `SecretStore`/`ImageStore` port shape — fake for tests, env-selected
  backends.
- **Audit coverage.** New audited actions: `stack.up/delete/sync`, `template.publish`,
  `stack.instantiate/upgrade`, `env.create/promote`, `tcp.expose/unexpose`,
  `db.tunnel.open`, `db.query`, `app.exec`, `preview.create/expire`,
  `org.webhook.set`, `bucket.create/rotate/delete`, `cache.create/delete`,
  `token.create/revoke` (+ token-as-actor), `auth.create/rotate-keys/user.*`,
  `db.branch` (L2), `config.set/rm` (L4).
- **New permission verbs** (all platform-defined, wired through `can()`): `expose`,
  `connect` (tunnel), `query`, `exec` — each with an explicit default-role mapping
  documented next to the verb.
- **Docs.** New pages: Stacks, Environments, Templates, TCP access (with the L4
  security statement), Previews, Observability, Buckets, Cache, Auth (with the
  SMTP-deferred flow matrix), SSO setup (generalizing `SETUP_GOOGLE.md`), Tokens &
  automation, Processes/health/releases (L1), Local development (L3), Runtime
  config (L4), plus a generated API reference (L5); update Architecture with the
  NLB/edge-tcp diagram, the `lb.mode` profiles, and the auth-host visibility
  exemption.
- **Testing posture.** Every pure module (plan/toposort, diff, SNI/PG-preamble
  parser, detect, strip pass, bucket-policy generator, token-scope resolver) is
  table-tested with fixtures; e2e additions ride `make up` (which gains a throwaway
  Keycloak for J2 and the GoTrue engine for K). The `examples/` directory doubles as
  the detect + template fixture corpus and now the K2 integration app. The console
  gains component tests + a Playwright smoke pass (M5); the CLI migrating onto the
  generated `@drop/client` (L5) doubles as permanent API-conformance testing; a
  spec-diff CI gate guards breaking API changes.

# Explicitly deferred (named future tasks)

- **K-mail** — org SMTP relay configuration + all email-dependent flows: magic links,
  password reset, email verification, invites, auth email templates, and the G3 email
  sink. `drop.yaml` reserves `auth.email/smtp` keys now so this lands additively.
- **Tier-3 OIDC provider** (Drop itself as an IdP for third-party tools) — only on
  proven pull; evaluate delegating to the K engine or Keycloak before building.
- **OpenTelemetry** — no collectors/storage; a documented
  `OTEL_EXPORTER_OTLP_ENDPOINT` env convention only.
- **Buildpacks / no-Dockerfile deploys** — excluded by decision for now; when
  revisited, implement as an extension of Future.md item 8 step 3 (the in-cluster
  builder runs Nixpacks/CNB when no Dockerfile exists; F1's detect already sniffs
  languages) rather than a separate build system.
- **LLM gateway** (managed `llm` resource: platform-held provider keys, scoped proxy,
  per-app metering) — excluded by decision for now; F2's operator-configured endpoint
  config is the seed if revisited.
- **Managed search** (Meilisearch/Typesense) — pg_trgm + pgvector (I3) cover
  internal-tool search; revisit on pull.
- **Realtime/pubsub as a service** — Valkey pubsub (I2) + WebSockets (A1) compose it;
  ship a documented pattern, not a subsystem.
- **Canary / traffic-splitting deploys** — L1's health checks + release phase capture
  most of the safety at a fraction of the cost; revisit if E3 environments create
  demand for progressive promotion.
- **Multi-IdP platform login**, **read replicas**, **custom external domains**,
  **multi-region**, **cost showback** — out by decision; revisit only on demand.

# Delivery order (restated with rationale)

A1 → B1 → **L1** → B2 → (G1+H1) → **M0 → M0.5** → C1 → I1 (+FM item 10) → A2 → J1 →
D1 → (E1+H2) → (I2+I3) → **L1b** → A3 → F1 → **M1** → J2 → (G2+G2b) → **M2** → K1 →
C2 → J3 → K2 → **M4** → H3 → E2 → **L2** → (I4+I5) → **M3** → D2 → E3 → **L3** → F2 →
**L4** → G3 → **L5** → B3 → G4 → **M5**.

Why the notable placements: **L1 immediately after B1** — health checks and the
release phase are correctness fixes that every subsequent deploy-multiplying feature
(previews, environments, GitOps) must inherit, and the release Job wants B1's binding
semantics; **M0 before C1** — the re-platform (Vite/ESM, router, data layer, CSP,
design system) must exist before the canvas and ~15 new surfaces pile onto the
3-route SPA (C1's code-splitting requires the ESM move anyway), and **M0.5 rides its
tail** — drag-and-drop publish is small, needs no API change, and is the
re-platform's best demo; **L1b right after I2** — queue-scaled workers are a
one-slice composition of `processes:` + Valkey; **M1 after F1** — IA lands once
stacks/templates give the sidebar something to organize; **M2 after J1+G2** — the
capabilities API and governance panels need tokens and quota data to govern;
**M4 after K2** — data views + the SSE stream land when metrics, events, and the
things they display all exist; **M3 after I4/J3** — streaming UIs land with their
backends (logs came earlier; the terminal and SQL grid gate this slice);
**L2 after E2** — branching extends the preview DB flag and builds the recovery
machinery FM item 9 then consumes; **L3 after A3+E3-adjacent** — `drop dev`
composes tunnels and is most useful once environments give dev a home;
**L5 late but not last** — schema-first routes accrete from whenever it starts, the
slice is the codegen + CI gate; **M5 closes** — the quality bar (including the
responsive/mobile pass) runs standing throughout, with a final slice to certify it; **I1 before A2**, **J1 early**,
**J2 before K1**, **K1 after G2**, **A3 after A2**, **B3 and G4 as pull-driven
capstones** — rationale unchanged from v3.
