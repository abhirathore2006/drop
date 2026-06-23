# Drop example sites (test fixtures)

Sample apps for exercising Drop — plain multi-page HTML, an agent-style report, and a
Vite+React SPA. The HTML ones publish as-is; the Vite app builds to `dist/` first.

> **Database-backed container apps:** see **[`DATABASE_APPS.md`](./DATABASE_APPS.md)** for a
> step-by-step walkthrough of creating a managed Postgres and mapping its connection into an
> app's env, plus runnable examples across stacks: [`guestbook-node/`](./guestbook-node)
> (Node + `pg` + HTML), [`tasks-node-ts/`](./tasks-node-ts) (Node + TypeScript via `tsx`),
> [`blog-express/`](./blog-express) (Express 5 + EJS templates), [`notes-next/`](./notes-next)
> (Next.js), [`board-tanstack/`](./board-tanstack) (TanStack Start), and
> [`chat-ws/`](./chat-ws) (Node WebSocket chat — works, but WebSockets don't traverse the
> public edge yet, so today you reach it via `kubectl port-forward`). Those are container
> **apps** — shipped with `drop deploy <dir> --build` (Drop builds the Dockerfile and pushes
> the image for you), not static **sites** (`make publish`) like the ones below.

Assumes the local stack is up (`make start` from the repo root → edge on :8474) and
you're logged in (`make login`, or dev mode auto-logs-in via `make publish`).

## 1. `multipage/` — classic multi-page static site (no build)
Separate HTML docs + shared CSS, `cleanUrls`, custom 404, `spaFallback:false`.
```bash
make publish DIR=examples/multipage NAME=multipage
open http://multipage.drop.localhost:8474/        # try /about, /contact, /nope
```

## 2. `report/` — agent-generated report (no build)
A self-contained analytics report — the canonical "agent output" artifact.
```bash
make publish DIR=examples/report NAME=report
open http://report.drop.localhost:8474/
```

## 3. `vite-react/` — Vite + React SPA with client-side routing (build first)
Exercises the route-aware SPA fallback (`/about`, `/dashboard` resolve to `index.html`).
```bash
cd examples/vite-react
npm install
npm run build                                     # → dist/ (includes _drop.json from public/)
cd ../..
make publish DIR=examples/vite-react/dist NAME=viteapp
open http://viteapp.drop.localhost:8474/          # navigate, then REFRESH on /about
```

> Local URLs are `http://<name>.drop.localhost:8474/` (http + edge port). `*.drop.localhost`
> resolves to 127.0.0.1 automatically on macOS — no `/etc/hosts` needed.
