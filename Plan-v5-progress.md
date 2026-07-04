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
| 5 | G1 `drop logs -f` · H1 app rollback | done | 60096ac | follow streams first-ready pod; app rollback re-applies version config under deploy lock; drop.dev/version anno |
| 6 | M0 Console re-platform + foundation | done | 5c0118c | Vite@6, wouter, TanStack Query; CSP strict; normalizeStatus pure (server wiring pending); vite dev proxy :8473 |
| 6b | M0.5 Drop zone publish | done | a2ef18f | USTAR writer lockstep-tested vs archive.ts; fflate lazy chunk; + status field wired into site detail |
| 7 | C1 Read-only canvas | done | 4506133 | graph endpoint w/ aggregated ns status lists; xyflow lazy chunk; CSP unchanged |
| 8 | I1 Buckets (+FM item 10 quotas) | done | eba3cc9 | floci prefix store; org_quotas migration 0008; aws-iam store deferred (TF template) |
| 9 | A2 L4 plane: NLB + TCP router | done | see log | A2a a477b9c + A2b (this commit); stack-driven expose deferred |
| 10 | J1 Service accounts / CI tokens | done | 2b4056c | drop_st_ tokens; scope grammar; DROP_TOKEN CI env; console Tokens tab |
| 11 | D1 Template registry | done | see log | reconcileStack shared with up; fail-closed strip; seeds via make seed-templates |
| 12 | E1 Static previews · H2 cron | done | see log | E1 this commit; H2 in eba3cc9 |
| 13 | I2 Valkey · I3 PG depth | done | see log | cache rotate absent by design; ext add live db = 409 |
| 14 | L1b Queue-scaled workers | done | ee23fd2 | TriggerAuth reads <cache>-cache secret; min-0 workers legal with scale_on |
| 15 | A3 `db:proxy` tunnel | done | caad9dc | in-cluster dial only v1 (local API 501s); src/ws/frames.ts shared codec |
| 16 | F1 `drop detect` + stack MCP | done | f9d80c7 | 9/9 examples fixture corpus; evidence-only fields |
| 17 | M1 Console IA: sidebar/⌘K/onboarding | done | 38530d2 | pulled ahead of order (console-only); ?org= context; templates/tokens/webhooks stubs pending D1/J1/G3 |
| 18 | J2 Generic OIDC login | done | see log | Keycloak live-tested; break-glass scrypt; zero-migration Helm-verified |
| 19 | G2 Edge metrics · G2b uptime checks | done | see log | p95=max merge honesty; keep_warm; crash-loop history → G3 |
| 20 | M2 Permission-aware UI + capabilities | done | see log | capabilitiesFor one-pass; fixed pooler+rollback gating drift |
| 21 | K1 Managed auth resource | done | 095496e | HS256 v1 (no OSS JWKS); edge exemption module; gotrue v2.170.0 pinned |
| 22 | C2 Canvas editing | done | a2a864a | pure ops+rebase model; legal-edge lockstep caught auth kind mid-flight |
| 23 | J3 `drop exec` | done | fa46e79 | v4.channel exec; tunnel_tickets kind column; console terminal → M3 |
| 24 | K2 App RBAC + SDK | done | d16c906 | HS256 verifyRequest (no JWKS); rbac-seed printed not auto-run; packages/auth workspace |
| 25 | M4 Data-heavy views | done | 33df150 | uPlot lazy chunk; SVG list sparklines; SSE stream; Table keyset+virtualize |
| 26 | H3 App→app edges | done | e8112dc | plain env <KEY>_URL; scale-to-zero → public host wake; mutual refs = cycle |
| 27 | E2 App previews | done | 70397be | parallel suffixed set; shared parent secrets; --with-db empty clone; L2 seam |
| 28 | L2 DB branching for previews | done | dddd402 | bootstrap.recovery (FM9 machinery); parent manage-tier gate; migration 0021 provenance |
| 29 | I4 SQL console · I5 volumes | done | e76f22d,d85f034 | I4 in-cluster only (501 local); I5 Recreate+forced 1/1, no snapshots v1 |
| 29b | M3 Streaming surfaces | done | 421b9d2,bc5b168 | xterm lazy chunk; per-response CSP style nonce; verified live in Chrome |
| 30 | D2 Template upstream diff | done | fe43017 | pure three-way diff; conflict take-upstream/keep-local; canvas diff badges |
| 31 | E3 Environments | done | af19ef2 | single-dash env naming; per-env var overlay; promote bakes image; default-env compat |
| 32 | L3 `drop dev` | done | c1e4ebf | dev-context (key names only); localhost tunnel rewrite; --check/--no-tunnel |
| 33 | F2 AI intent layer | done | e9d498a | off by default; provider-agnostic; sanitized → C2 editor, never executes |
| 34 | L4 Runtime config / flags | done | a0df77d | app_configs 0018; lazy config-read token; @drop/config etag SDK |
| 35 | G3 Alerting / notifications | done | ea22630 | events 0017; dedup incidents; org webhooks (Slack adapter); /v1/me badge |
| 36 | L5 OpenAPI + typed client | done | 5720145 | zod→schema (no dep); /v1/openapi.json; @drop/client; check:openapi CI gate |
| 37 | B3 GitOps mode | done | 5720145 | pull-only poller; sha256 change-detect; token on row; dry-run-only review |
| 38 | G4 Searchable log retention | done | 3b0e29c | tail→S3 NDJSON 0020; 7d org-override; grep-grade search; DBs excluded |
| 39 | M5 Console quality bar | done | 5ec0335 | a11y (aria-sort/tabs/labels); WCAG AA token test; 109KB gz initial; Playwright e2e |
