// Golden path: create a service-account token, reveal the secret once, then revoke it
// (Settings → Tokens). Tokens are metadata — no compute required, runs against `make start`.
// Requires the dev-auth identity to own/admin an org (their personal org qualifies).
import { test, expect } from "@playwright/test";
import { gotoApp, uid } from "./helpers";

test("token create → reveal-once → revoke", async ({ page }) => {
  await gotoApp(page, "/settings");
  await page.getByRole("tab", { name: "tokens" }).click();

  // Owner/admin gate: a non-managing member sees an empty-state instead of the form.
  const createBtn = page.getByRole("button", { name: "create token" });
  test.skip(!(await createBtn.isVisible().catch(() => false)), "current identity can't manage tokens in the selected org");

  const tokenName = uid("e2e-tok");
  await page.getByPlaceholder("name (e.g. ci-deploy)").fill(tokenName);
  await createBtn.click();

  // Reveal-once: the secret shows exactly once, then is dismissed forever.
  const secret = page.locator(".reveal");
  await expect(secret).toBeVisible();
  expect((await secret.innerText()).trim().length).toBeGreaterThan(8);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(secret).toBeHidden();

  // The token now appears in the list with a revoke control.
  const row = page.locator(".item", { hasText: tokenName }).filter({ has: page.getByRole("button", { name: "revoke" }) });
  await expect(row).toBeVisible();

  // Revoke behind the confirm dialog; a toast confirms.
  await row.getByRole("button", { name: "revoke" }).click();
  await page.getByRole("button", { name: "revoke token" }).click();
  await expect(page.getByText(`revoked ${tokenName}`)).toBeVisible();
});
