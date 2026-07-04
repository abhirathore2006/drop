// Golden path: deploy → logs → rollback. Deploys themselves are a CLI/CI flow; the CONSOLE surface
// under test is an app's live-logs panel and its rollback control. This needs a running app, which
// needs a compute cluster — so it's guarded behind a compute-available check and SKIPS cleanly on a
// static-only stack (`make start`), where no `app` workloads exist. Bring compute up with `make up`.
import { test, expect } from "@playwright/test";
import { firstApp, gotoApp } from "./helpers";

test("app detail exposes live logs and a rollback path (compute)", async ({ page, request }) => {
  const app = await firstApp(request);
  test.skip(!app, "no app workload present (static-only stack) — skipping deploy → logs → rollback");

  await gotoApp(page, `/app/${app}`);
  await expect(page.locator(".dname")).toContainText(app!);

  // Live logs surface (M3 StreamHeader titled "logs").
  await expect(page.getByRole("heading", { name: "logs", exact: true })).toBeVisible();

  // Rollback is capability-gated and needs a prior release; when offered it must be operable.
  const rollback = page.getByRole("button", { name: "rollback" }).first();
  if (await rollback.isVisible().catch(() => false)) {
    await expect(rollback).toBeEnabled();
  }
});
