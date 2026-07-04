// Golden path: instantiate a template (Templates → open one → Deploy this stack). This creates a
// stack, so it rides `make up` (+ `make seed-templates`). Skips gracefully when no templates are
// published (the static-only / unseeded case), so it's a no-op on a plain `make start`.
import { test, expect } from "@playwright/test";
import { gotoApp, listTemplates, uid } from "./helpers";

test("template instantiate → new stack", async ({ page, request }) => {
  const templates = await listTemplates(request);
  test.skip(templates.length === 0, "no templates published — skipping instantiate (run `make seed-templates`)");

  await gotoApp(page, "/templates");
  // Open the first template card.
  const firstCard = page.locator("a.card").first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page.getByRole("heading", { name: "Deploy this stack" })).toBeVisible();

  const stackName = uid("e2e-stk");
  await page.getByRole("textbox", { name: "stack name" }).fill(stackName);

  // Best-effort fill any required variable text inputs so the Deploy button enables.
  const varInputs = page.locator(".template-deploy input").filter({ hasNot: page.locator('[aria-label="stack name"]') });
  const count = await varInputs.count();
  for (let i = 0; i < count; i++) {
    const inp = varInputs.nth(i);
    if ((await inp.getAttribute("aria-label")) === "stack name") continue;
    if ((await inp.inputValue()) === "") await inp.fill("e2e-value").catch(() => {});
  }

  const deployBtn = page.getByRole("button", { name: "Deploy this stack" });
  test.skip(!(await deployBtn.isEnabled().catch(() => false)), "template needs inputs the e2e can't auto-fill");
  await deployBtn.click();

  // Instantiate navigates to the new stack's canvas page.
  await expect(page).toHaveURL(new RegExp(`/stack/${stackName}`), { timeout: 60_000 });
});
