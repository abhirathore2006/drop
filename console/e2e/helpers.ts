// Shared helpers for the console e2e specs (M5). Written to be RESILIENT against the console's
// polling detail pages: every navigation waits on `domcontentloaded` + a concrete DOM signal
// rather than `networkidle` (which never settles while a page polls).
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const DEV_EMAIL = process.env.DROP_E2E_EMAIL ?? "alice@example.com";
export const EDGE_ORIGIN = process.env.DROP_E2E_EDGE ?? "http://localhost:8474";
export const BASE_DOMAIN = process.env.DROP_E2E_BASE_DOMAIN ?? "drop.localhost";

/** A short, unique, DNS-safe suffix for names created during a run. */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;
}

/** Navigate to an app route and wait until the React shell has mounted something. */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The SPA renders into #root; wait for the signed-in shell (sidebar) rather than networkidle.
  await expect(page.locator("aside.sidebar")).toBeVisible();
}

/** True when the API is reachable at all (used to fail fast with a clear message if the stack is down). */
export async function apiReachable(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get("/healthz", { failOnStatusCode: false });
    return res.ok() || res.status() < 500;
  } catch {
    return false;
  }
}

/** The list of workloads visible to the dev-auth identity. */
export async function listWorkloads(request: APIRequestContext): Promise<Array<{ name: string; type: string; capabilities?: string[] }>> {
  try {
    const res = await request.get("/v1/sites", { failOnStatusCode: false });
    if (!res.ok()) return [];
    const body = (await res.json()) as { sites?: Array<{ name: string; type: string; capabilities?: string[] }> };
    return body.sites ?? [];
  } catch {
    return [];
  }
}

/** Name of the first `app` workload (proxy for "compute is available"), or null on a static-only stack. */
export async function firstApp(request: APIRequestContext): Promise<string | null> {
  const apps = (await listWorkloads(request)).filter((w) => w.type === "app");
  return apps[0]?.name ?? null;
}

/** Templates the identity can instantiate (empty on an unseeded / static-only stack). */
export async function listTemplates(request: APIRequestContext): Promise<Array<{ slug: string; name: string }>> {
  try {
    const res = await request.get("/v1/templates", { failOnStatusCode: false });
    if (!res.ok()) return [];
    const body = (await res.json()) as { templates?: Array<{ slug: string; name: string }> };
    return body.templates ?? [];
  } catch {
    return [];
  }
}
