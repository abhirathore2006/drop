# WebSocket support for Drop apps — implementation plan

> **For agentic workers:** implement task-by-task; each task is independently testable and
> committable. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Drop container app accept WebSocket (and other HTTP `Upgrade`) connections through
its public edge hostname (`https://<app>.<baseDomain>/`), end to end.

**Architecture:** Add a raw-socket `upgrade` tunnel to the edge proxy, and route WebSocket-marked
apps **directly to their in-cluster Service**, bypassing the KEDA HTTP add-on interceptor (which
rejects upgrades). WS apps run with `min ≥ 1` (no scale-to-zero) and `max: 1` for v1 (single-pod
broadcast state). Visibility/password gates are enforced on the upgrade path identically to the
GET path.

**Tech stack:** Node `http`/`net` (no new deps), `@hono/node-server` (already returns the raw
`http.Server`), Kubernetes Service + NetworkPolicy, KEDA HTTPScaledObject (unchanged for routing).

---

## Why it doesn't work today (evidence)

Two **independent** blockers sit on the request path `client → nginx/ALB → edge → KEDA interceptor → pod`:

1. **The edge proxy does not tunnel HTTP upgrades.** `src/edge/server.ts`:
   - It is a Hono app whose handler returns a buffered/streamed `Response` (`app.all("*")`, line 179).
     A WebSocket handshake needs a `101 Switching Protocols` plus a hijacked raw socket — impossible
     to express as a `Response`.
   - `bin/edge.ts:28` starts it with `serve({ fetch: app.fetch, port })` and never touches the
     returned `http.Server`, so no `'upgrade'` listener is attached.
   - `HOP_BY_HOP` (line 57) includes `"upgrade"` and `"connection"`, and they are stripped from both
     the forwarded request headers (line 69) and the upstream response headers (line 86). Even if an
     upgrade reached this code, the headers that drive the handshake would be removed.

2. **The KEDA HTTP add-on interceptor rejects WebSockets.** Upgrade requests through the interceptor
   return **HTTP 403** — WebSockets are explicitly unsupported (tracking issue
   [kedacore/http-add-on#654](https://github.com/kedacore/http-add-on/issues/654)). Bidirectional
   *streaming* (e.g. SSE) now works, but not the `Upgrade` handshake. Since `src/edge/server.ts:191`
   always routes `type==="app"` through the interceptor (`proxyToApp`), this blocks WS even if the
   edge tunneled it.

**Conclusion:** WS apps must (a) get a real upgrade tunnel in the edge, and (b) be routed **around**
the interceptor, straight to the app's Service. That also means WS apps cannot scale to zero (there
is no pod to hold the long-lived connection, and the interceptor — the only component that wakes a
zero-scaled pod — is out of the path), so they run `min ≥ 1`.

---

## Design

### Routing
- Mark an app as WebSocket-capable with an app-level `websocket: true` in `drop.yaml` (this is the
  grain the edge routes on — one hostname per app; the same pod serves the HTML page and the
  upgrade on one port). The example `examples/chat-ws/drop.yaml` already uses this flag. (The deploy
  handler may also accept the equivalent per-service `protocol: "ws"`, since `services[].protocol`
  already exists alongside `"http"`/`"tcp"` — see `src/api/server.test.ts:289,324` — but the
  app-level flag is canonical.)
- The edge's `'upgrade'` handler resolves the app by Host (reuse `siteFromHost`), reads the pointer,
  and for a WS app opens a raw TCP socket **to the app's in-cluster Service**
  (`<name>.<namespace>.svc.cluster.local:<SERVICE_PORT>`) — **not** the interceptor. The pointer
  already carries the app's `namespace` (added in the organisations work — `Site.namespace`); surface
  it through `getPointer` into the edge cache entry.
- Normal (non-`ws`) apps are unaffected: they keep going through the interceptor on the request path.

### Scale-to-zero
- A `"ws"` service forces `scale.min ≥ 1`. Reject a deploy that combines `protocol: "ws"` with
  `scale.min: 0` (clear 400), rather than silently "fixing" it.
- v1 also pins `scale.max: 1`: broadcast/connection state is per-pod, so fan-out across replicas
  would need a shared pub/sub (Postgres `LISTEN/NOTIFY` or Redis). That is out of scope for v1 and
  noted as a follow-up.

### Security
- The upgrade handler MUST enforce the same gates as the GET path **before** tunneling: `private`
  → reject (close the socket with `403`), `password`/`basicAuth` → require the `Authorization`
  header (browsers can't set it on the WS handshake, so document that WS apps should be `public`
  in v1, or use a cookie/token check — see Task 6). Failing to gate here would let WS bypass the
  visibility model the GET path enforces.

### NetworkPolicy
- `src/kube/manifests.ts:175` creates `<name>-allow-interceptor`, allowing ingress **only from the
  `keda` namespace**. For direct edge→pod routing, a `"ws"` app's ingress policy must also allow
  ingress from the **edge's** namespace/pod. Add that `from` selector for WS apps, and the matching
  edge egress, without widening non-WS apps.

### Alternatives considered
- **Wait for KEDA interceptor WS support (#654):** external, unscheduled dependency — rejected as the
  primary path; we can switch WS apps back through the interceptor later if it lands.
- **A separate dedicated WS ingress/Service:** more infra and a second public entrypoint — rejected;
  reusing the edge with an upgrade tunnel keeps one front door.

---

## Tasks

### Task 1: Plumb the `ws` protocol + namespace into the edge pointer

**Files:**
- Modify: `src/metastore/store.ts` (`getPointer` / pointer shape), `src/metastore/types.ts`
- Modify: `src/edge/server.ts` (`CacheEntry`, `current()`)

- [ ] **Step 1:** Add `websocket: boolean` and `namespace: string` to the edge `CacheEntry` and
  populate them in `current()` from the pointer. `Site.namespace` already exists; add a
  `websocket` flag derived from whether any service has `protocol: "ws"` (persist it on deploy — Task 2).
- [ ] **Step 2:** Extend `MetaStore.getPointer` to return `{ namespace, websocket }` alongside the
  existing fields. Add a store test asserting a WS app's pointer carries `websocket: true` + the
  right namespace.
- [ ] **Step 3:** `bun test src/metastore/store.test.ts` — green.
- [ ] **Step 4:** Commit.

### Task 2: Persist + validate the `ws` protocol on deploy

**Files:**
- Modify: `src/api/server.ts` (deploy handler), `src/kube/manifests.ts`

- [ ] **Step 1:** In the deploy handler, read the app-level `websocket: true` flag (also accept
  `services.some(s => s.protocol === "ws")` as equivalent). Persist a `websocket` flag on the site
  record. If WS is set AND `scale.min === 0`, return
  `400 {"error":"websocket apps cannot scale to zero; set scale.min >= 1"}`.
- [ ] **Step 2:** In `appManifests`, when WS: clamp `scale.max` to `1` (v1) and extend `ingressPolicy`
  with an additional `from` selector for the edge namespace (define `EDGE_NAMESPACE` next to
  `KEDA_NAMESPACE`). Keep the keda `from` so the HSO/probe still works.
- [ ] **Step 3:** Add `src/kube/manifests.test.ts` cases: a `ws` app's `ingressPolicy.spec.ingress`
  includes the edge namespace; `scale.max` is pinned to 1; a non-`ws` app is unchanged.
- [ ] **Step 4:** Add an `src/api/server.test.ts` case: deploy with `protocol:"ws"` + `scale.min:0` → 400.
- [ ] **Step 5:** `bun test src/kube src/api/server.test.ts` — green. Commit.

### Task 3: Edge — extract the upgrade tunnel as a wireable function

**Files:**
- Modify: `src/edge/server.ts` (export `attachUpgradeProxy(server, deps)`)
- Modify: `bin/edge.ts` (capture the server from `serve()` and call it)

- [ ] **Step 1:** Export `attachUpgradeProxy(server: http.Server, deps)` from the edge module. It
  registers `server.on("upgrade", handler)`. Reuse `siteFromHost`, the pointer cache (`current`),
  and the deps already in `createEdge` (factor the shared bits so both the Hono app and the upgrade
  handler see the same `cache`/`meta`).
- [ ] **Step 2:** In `bin/edge.ts`, capture `const server = serve({ fetch: app.fetch, port }, …)` and
  call `attachUpgradeProxy(server, deps)` (`@hono/node-server`'s `serve()` returns the Node
  `http.Server`).
- [ ] **Step 3:** No behavior change for HTTP yet; `bun test src/edge` still green. Commit.

### Task 4: Edge — the raw-socket upgrade handler (the core)

**Files:**
- Modify: `src/edge/server.ts`

- [ ] **Step 1:** Implement the handler:
  1. `name = siteFromHost(req.headers["x-forwarded-host"] ?? req.headers.host)`; if none → write
     `HTTP/1.1 404` to the socket and destroy.
  2. `entry = await current(name)`. If `entry.type !== "app" || !entry.websocket || !entry.version`
     → `404`/`426` and destroy.
  3. **Auth gate** (Task 6 fills the password case): if `entry.visibility === "private"` → `403` + destroy.
  4. Open `const upstream = net.connect(SERVICE_PORT, "<name>.<namespace>.svc.cluster.local")`
     (namespace from the entry; the upstream base is configurable for local dev — Task 7).
  5. Re-serialize the upgrade request line + **all** headers (do NOT strip `upgrade`/`connection`/
     `sec-websocket-*`) to `upstream`, write the buffered `head`, then `clientSocket.pipe(upstream)`
     and `upstream.pipe(clientSocket)`.
  6. Robust teardown: on `error`/`close`/`timeout` of either socket, destroy the other; never let an
     unhandled socket `error` crash the edge replica (cross-tenant DoS — same hazard already handled
     at `src/edge/server.ts:103`).
- [ ] **Step 2:** Unit test with a fake upstream `net`/`http` server that echoes a WS handshake: assert
  the client receives `101` and a round-tripped frame; assert a `private` app gets `403` and no
  upstream connection; assert a non-`ws` app is not tunneled.
- [ ] **Step 3:** `bun test src/edge` — green. Commit.

### Task 5: NetworkPolicy + egress wiring (verify end to end in k3s)

**Files:**
- Modify: `infra/local/compute-up.sh` (label the edge namespace if needed), `infra/local/verify-*.sh`

- [ ] **Step 1:** Ensure the edge namespace carries `kubernetes.io/metadata.name=<edge-ns>` (used by
  the Task 2 ingress selector) and that the edge has egress to tenant Services on `SERVICE_PORT`.
- [ ] **Step 2:** Add `infra/local/verify-websocket.sh`: deploy `examples/chat-ws`, `db:create
  chat-db`, set the secret, then open a WS through the edge hostname (`wscat`/a tiny Node client),
  send a message, assert it echoes/broadcasts. Assert a `private` WS app is refused.
- [ ] **Step 3:** Run it against local k3s; capture output in the PR.

### Task 6: Auth on the WS handshake (visibility parity)

**Files:**
- Modify: `src/edge/server.ts`

- [ ] **Step 1:** For `visibility === "password"`/`basicAuth`: browsers cannot set `Authorization`
  on a WS handshake, so accept the gate via (a) the `Sec-WebSocket-Protocol` token convention or
  (b) a signed cookie checked in the upgrade handler. Pick the cookie path to match the console's
  existing `drop_session` cookie model; document that v1 WS apps are recommended `public`.
- [ ] **Step 2:** Test: password WS app rejects an unauthenticated upgrade, accepts an authenticated one.
- [ ] **Step 3:** Commit.

### Task 7: Local-dev upstream + docs

**Files:**
- Modify: `bin/edge.ts`/edge deps (a `DROP_APP_UPSTREAM_BASE` for local, e.g. a port-forwarded Service),
  `examples/chat-ws/README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1:** Make the WS upstream base configurable so local dev (no in-cluster DNS) can point at
  a port-forward, mirroring `DROP_INTERCEPTOR_URL`.
- [ ] **Step 2:** Update `examples/chat-ws/README.md` to drop the "not wired up yet" caveat once the
  edge path works; document the `protocol: "ws"` + `min ≥ 1` rules in `docs/ARCHITECTURE.md` §7.
- [ ] **Step 3:** Commit.

---

## Out of scope (follow-ups)
- **Multi-pod WS fan-out** (`scale.max > 1`): needs shared pub/sub (Postgres `LISTEN/NOTIFY` or
  Redis) so a message on pod A reaches clients on pod B. v1 pins `max: 1`.
- **Connection-count autoscaling:** the HTTP add-on can't drive WS apps; a future KEDA trigger
  (Prometheus active-connections) could.
- **Scale-to-zero for WS:** revisit if/when the interceptor supports upgrades (#654).

## Self-review
- Spec coverage: both blockers (edge upgrade, interceptor 403) have owning tasks (3–4 edge, routing
  bypass in 1–2/4-5). Security parity has its own task (6). NetworkPolicy both-sides covered (2, 5).
- The `protocol: "ws"` field reuses the existing `services[].protocol`; `Site.namespace` reuses the
  organisations work — no new metadata layers invented.
- Risk: browsers can't authenticate the WS handshake with `Authorization` — explicitly handled in
  Task 6, with `public` as the documented v1 default.
