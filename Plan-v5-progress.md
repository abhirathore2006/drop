# Plan v5 — delivery progress

Tracks implementation of `Plan-v5.md` on branch `feat/enhancement-v5`.
Status: `todo` · `in-progress` · `done` (committed, tests green) · `deferred`.

## Orchestration conventions

- Implementation agents work in this tree; they do **not** commit — the orchestrator
  reviews, runs `bun test` + `npx tsc --noEmit`, and commits per slice.
- One commit per slice, message prefixed with the slice id (e.g. `A1: …`).
- The `bun test` suite is flaky under parallel load — rerun a failing file once before
  treating it as a regression.
- Never stop or restart the `pi-*` podman containers (another project). Local Drop runs
  use remapped ports (PG 5433, S3 4567, HTTPS 8443) when the defaults are occupied.
- e2e browser validation (Chrome/Playwright) happens at milestone checkpoints, not per
  slice: after M0.5, after C1, after M1/M2, and a final full pass (M5).

## Delivery order

| # | Slice | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| 1 | A1 WebSockets through the edge | done | 3a0b730 | checkAccessGate shared with HTTP path; interceptor + DROP_WS_DIRECT wake-shim paths; caps/idle-timeout |
| 2 | B1 DB binding (Future.md item 1) | done | da3842f | envFrom `<db>-app` + `<db>-ca` ca.crt mount + verify-full; same-org 400 validation |
| 3 | L1 drop.yaml: healthcheck/release/processes | done | 169020c | + LockStore (locks table, migration 0006); drop ps; logs --release; 422 halt semantics |
| 4 | B2 Stack spec + `drop up` + plan API | done | 9af0966 | pure planner; stack lock; spec_version optimistic 409; release phase NOT run in stack path v1 |
| 5 | G1 `drop logs -f` · H1 app rollback | in-progress | | |
| 6 | M0 Console re-platform + foundation | done | 5c0118c | Vite@6, wouter, TanStack Query; CSP strict; normalizeStatus pure (server wiring pending); vite dev proxy :8473 |
| 6b | M0.5 Drop zone publish | in-progress | | |
| 7 | C1 Read-only canvas | todo | | |
| 8 | I1 Buckets (+FM item 10 quotas) | todo | | |
| 9 | A2 L4 plane: NLB + TCP router | todo | | |
| 10 | J1 Service accounts / CI tokens | todo | | |
| 11 | D1 Template registry | todo | | |
| 12 | E1 Static previews · H2 cron | todo | | |
| 13 | I2 Valkey · I3 PG depth | todo | | |
| 14 | L1b Queue-scaled workers | todo | | |
| 15 | A3 `db:proxy` tunnel | todo | | |
| 16 | F1 `drop detect` + stack MCP | todo | | |
| 17 | M1 Console IA: sidebar/⌘K/onboarding | todo | | |
| 18 | J2 Generic OIDC login | todo | | |
| 19 | G2 Edge metrics · G2b uptime checks | todo | | |
| 20 | M2 Permission-aware UI + capabilities | todo | | |
| 21 | K1 Managed auth resource | todo | | |
| 22 | C2 Canvas editing | todo | | |
| 23 | J3 `drop exec` | todo | | |
| 24 | K2 App RBAC + SDK | todo | | |
| 25 | M4 Data-heavy views | todo | | |
| 26 | H3 App→app edges | todo | | |
| 27 | E2 App previews | todo | | |
| 28 | L2 DB branching for previews | todo | | |
| 29 | I4 SQL console · I5 volumes | todo | | |
| 29b | M3 Streaming surfaces | todo | | |
| 30 | D2 Template upstream diff | todo | | |
| 31 | E3 Environments | todo | | |
| 32 | L3 `drop dev` | todo | | |
| 33 | F2 AI intent layer | todo | | |
| 34 | L4 Runtime config / flags | todo | | |
| 35 | G3 Alerting / notifications | todo | | |
| 36 | L5 OpenAPI + typed client | todo | | |
| 37 | B3 GitOps mode | todo | | |
| 38 | G4 Searchable log retention | todo | | |
| 39 | M5 Console quality bar | todo | | |
