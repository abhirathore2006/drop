// Golden path: the console loads under dev-auth, shows the signed-in identity, the theme toggle
// flips <html data-theme>, and the command palette (⌘K) navigates. No compute required — this
// suite runs against a plain `make start`.
import { test, expect } from "@playwright/test";
import { DEV_EMAIL, gotoApp } from "./helpers";

test.describe("shell", () => {
  test("loads the console and shows the signed-in identity", async ({ page }) => {
    await gotoApp(page, "/");
    // The frame chrome is present…
    await expect(page.locator("aside.sidebar")).toBeVisible();
    await expect(page.getByRole("link", { name: /workloads/ })).toBeVisible();
    // …and the identity menu shows who we are.
    await expect(page.locator(".usermenu-email")).toContainText(DEV_EMAIL);
  });

  test("the theme toggle flips data-theme (system → light → dark)", async ({ page }) => {
    await gotoApp(page, "/");
    await page.locator(".usermenu-trigger").click();
    const themeItem = page.getByRole("menuitem", { name: /theme:/ });
    await expect(themeItem).toBeVisible();

    // Starting from a fresh context the preference is `system`; the first toggle sets an explicit
    // `light`, the next `dark` — deterministic regardless of the OS scheme.
    await themeItem.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await themeItem.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("command palette (⌘K → type → Enter) navigates", async ({ page }) => {
    await gotoApp(page, "/");
    await page.keyboard.press("ControlOrMeta+k");

    const filter = page.getByRole("combobox", { name: "command palette filter" });
    await expect(filter).toBeVisible();

    await filter.fill("settings");
    // The "go to settings" verb is the top fuzzy match; Enter runs it.
    await expect(page.getByRole("option", { name: /go to settings/ })).toBeVisible();
    await filter.press("Enter");

    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole("heading", { name: /Settings/ })).toBeVisible();
  });
});
