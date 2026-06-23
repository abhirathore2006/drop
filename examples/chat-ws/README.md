# chat — Node.js WebSockets + managed Postgres

A live chat room: a Drop **container app** (`drop deploy`), not a static site. One plain Node.js
process (no framework) runs **both** an HTTP server (the chat page + `/healthz`) **and** a WebSocket
server on the **same port** (8080) — the [`ws`](https://github.com/websockets/ws) `WebSocketServer`
attaches to the `http.Server` via its `upgrade` event. Messages persist in
[`pg`](https://node-postgres.com) and broadcast to every connected client in real time. Reads the
standard libpq `PG*` env vars.

## ⚠ Status: WebSockets through the Drop edge are not wired up yet

- **The app itself is correct** and runs anywhere that speaks raw WebSockets (locally, in a plain
  container, behind any HTTP-upgrade-aware proxy).
- **TODAY, exercise it by port-forwarding straight to the pod/Service**, which bypasses the edge +
  KEDA HTTP interceptor:
  ```bash
  # find your tenant namespace
  NS=$(kubectl get ns --no-headers -o custom-columns=N:.metadata.name | grep '^drop-t-' | head -1)
  kubectl port-forward -n "$NS" deploy/chat 8080:8080
  # then open the chat in a couple of tabs:
  open http://localhost:8080
  ```
- **Routing it through the public edge hostname** (`https://chat.drop.localhost`) requires the
  platform work in [`../../planning/2026-06-23-websocket-support-plan.md`](../../planning/2026-06-23-websocket-support-plan.md),
  because the Drop edge proxy doesn't tunnel HTTP `Upgrade` requests, and the KEDA HTTP add-on
  interceptor returns **403** for WebSocket upgrades ([kedacore/http-add-on#654](https://github.com/kedacore/http-add-on/issues/654)).
  Until that lands, the public hostname will serve the HTML page but the WebSocket connection from
  the browser will fail — use the port-forward above to see it working.

## Deploy (local k3s dev stack)

**Prereqs:** the compute stack is up (`make compute-up`) and you're logged in
(`drop dev-login me you@example.com`, or `drop login`).

```bash
# 1. create the managed Postgres database
drop db create chat-db

# 2. build + deploy in one step — Drop builds the Dockerfile and pushes the image through
#    Drop for you (no registry creds, no manual ctr import; same command locally and in prod)
drop deploy examples/chat-ws --build --no-start

# 3. set the DB password as a write-only SECRET (never committed), then apply it
drop db password chat-db                                # prints the password ONCE
printf '<that password>' | drop secrets set chat PGPASSWORD --stdin
drop start chat                                       # first boot, already has the password

# 4. open it — see the "Status" note above: today, port-forward to the pod (the public edge
#    hostname serves the page but the WebSocket upgrade does not tunnel through the edge yet)
NS=$(kubectl get ns --no-headers -o custom-columns=N:.metadata.name | grep '^drop-t-' | head -1)
kubectl port-forward -n "$NS" deploy/chat 8080:8080
open http://localhost:8080                              # open it in two tabs and chat
```

> `--build` uses `docker` by default; set `DROP_BUILDER=podman` to build with podman. To create
> the app inside a team org instead of your personal org, add `--org <slug>` (likewise on
> `drop db create`). `drop push examples/chat-ws` does just build+push and prints the ref.

<details><summary>Prebuilt-image alternative (no <code>--build</code>): build + import into k3s yourself</summary>

If you'd rather build out-of-band and reference a fixed `image:` in `drop.yaml`:

```bash
# build (use the docker.io/library/ prefix so k8s and containerd agree on the name)
podman build -t docker.io/library/chat-ws:1 examples/chat-ws
# import into k3s's containerd (k3s runs as the podman container `k3s`)
podman save docker.io/library/chat-ws:1 \
  | podman exec -i k3s ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -
drop deploy examples/chat-ws      # uses image: chat-ws:1 from drop.yaml
```
</details>

The non-secret connection config (`PGHOST: chat-db-rw`, `PGUSER`/`PGDATABASE: app`, `PGSSLMODE`)
lives in [`drop.yaml`](./drop.yaml); **`PGPASSWORD` is a secret** — set write-only via `drop secrets`
(stored in the secret manager, injected as an env var, never readable again). To rotate later:
`drop db password chat-db` → `drop secrets set chat PGPASSWORD --stdin` → `drop start chat`.
Manage secrets from the console (the app's page → Secrets) or `secret_*` MCP tools too.

## How the chat works

- **One port, two servers.** `http.createServer` serves `GET /` (the self-contained HTML + inline
  WebSocket client) and `GET /healthz` → `ok`. A `WebSocketServer({ server })` attaches to the same
  `http.Server`, so `Upgrade: websocket` requests become WS sessions on the very same `:8080`.
- **On connect:** the server replays the **last 50 messages** (oldest-first) to that one client, and
  broadcasts an updated **presence count** to everyone.
- **On an incoming message:** the server **INSERTs** it into Postgres, then **broadcasts**
  `{author, body, created_at}` as a JSON frame to **all** open clients. An INSERT failure is caught
  and reported to the sender — it never crashes the process.
- **State is per-pod** (the live client set lives in memory), which is why `drop.yaml` pins
  `scale: {min: 1, max: 1}` — see the comments there.

> `drop.yaml` also carries `app.websocket: true`, a flag that marks this app for the edge's
> (forthcoming) WebSocket routing path — see the plan linked in the Status section above.

## Verify it persisted

```bash
NS=$(kubectl get ns --no-headers -o custom-columns=N:.metadata.name | grep '^drop-t-' | head -1)

# app logs — also in the console (open "chat" → logs)
kubectl logs -n "$NS" -l app.kubernetes.io/name=chat --tail=20

# query the database directly through its primary pod
kubectl exec chat-db-1 -c postgres -n "$NS" -- psql -U app -d app -c "SELECT author, body FROM messages ORDER BY id DESC LIMIT 10;"
```

Full walkthrough (the binding model, secrets, lifecycle, troubleshooting):
[`../DATABASE_APPS.md`](../DATABASE_APPS.md).
