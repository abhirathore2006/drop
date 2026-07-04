// Playwright config for the Drop console golden-path e2e (M5). These specs ride a RUNNING local
// stack — bring it up first:
//
//   node build.mjs ui        # build the console into dist/ui (served by the API at /)
//   make start               # static-only stack: Floci + api(:8473) + edge(:8474)  — OR —
//   make up                  # full platform (adds the k3s cluster) for the deploy/template specs
//   npm run e2e:console       # (or: make e2e-console)
//
// Auth: the stack runs with DROP_DEV_AUTH=1, which accepts `Authorization: Bearer <sub>:<email>`.
// We set that header on the whole browser context via `extraHTTPHeaders`, so the SPA's own
// same-origin fetches to /v1/* are authenticated as alice without an OIDC round-trip.
//
// Overridable via env: DROP_E2E_ORIGIN (API base URL), DROP_E2E_EMAIL / DROP_E2E_SUB (identity).
import { defineConfig } from "@playwright/test";

const API_ORIGIN = process.env.DROP_E2E_ORIGIN ?? "http://localhost:8473";
const DEV_SUB = process.env.DROP_E2E_SUB ?? "alice";
const DEV_EMAIL = process.env.DROP_E2E_EMAIL ?? "alice@example.com";

export default defineConfig({
  testDir: "./e2e",
  // Specs are named *.e2e.ts (not *.spec.ts) so `bun test` — which collects *.spec.ts / *.test.ts —
  // never tries to run them; only Playwright does, via this matcher.
  testMatch: "**/*.e2e.ts",
  // The specs publish/create/revoke shared server state — run them serially for determinism.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    baseURL: API_ORIGIN,
    // Dev-auth bearer — applies to browser navigations, the SPA's fetches, AND the `request`
    // fixture (so tests can read /v1/* directly to set up / detect preconditions).
    extraHTTPHeaders: { Authorization: `Bearer ${DEV_SUB}:${DEV_EMAIL}` },
    // Detail/list pages poll on an interval, so `networkidle` never settles — every helper waits on
    // `domcontentloaded` + a concrete DOM signal instead.
    navigationTimeout: 20_000,
    actionTimeout: 12_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Bundled chromium (not channel:"chrome") — the CI-safe choice.
  projects: [{ name: "chromium", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } }],
});
