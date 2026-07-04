// Golden path: publish a static folder through the drop-zone picker, see the new site appear in
// the console, and confirm the edge serves it. Static-site publish needs NO compute, so this runs
// against a plain `make start` (Floci + api + edge). The edge-serving assertion is guarded: it is
// skipped (not failed) when the edge origin isn't reachable.
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_DOMAIN, EDGE_ORIGIN, gotoApp, uid } from "./helpers";

// A tiny static site with a unique marker so we can prove the edge is serving THIS publish.
function makeSiteDir(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "drop-e2e-site-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><body><h1>${marker}</h1></body></html>`);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.css"), "body{color:#9be15d}");
  return dir;
}

test("drop-zone publish creates a site the edge serves", async ({ page, request }) => {
  const siteName = uid("e2e-site");
  const marker = `drop-e2e-${siteName}`;
  const dir = makeSiteDir(marker);

  await gotoApp(page, "/");

  // Feed the folder to the hidden <input webkitdirectory> — the picker path (setInputFiles a dir).
  const fileInput = page.locator('#new-site-zone input[type="file"]');
  await fileInput.setInputFiles(dir);

  // The name prompt opens after the folder is read.
  const nameInput = page.getByPlaceholder("my-cool-site");
  await expect(nameInput).toBeVisible();
  await nameInput.fill(siteName);
  await page.getByRole("button", { name: "publish" }).click();

  // On success the app routes to the new site's detail page and shows its name.
  await expect(page).toHaveURL(new RegExp(`/site/${siteName}`), { timeout: 30_000 });
  await expect(page.locator(".dname")).toContainText(siteName);

  // ── Edge serves it ────────────────────────────────────────────────────────────────────────
  // The edge routes by Host: <name>.<base-domain>; poll (edge state is cache-TTL'd, and a fresh
  // publish takes a beat to propagate). Skip gracefully if the edge origin isn't up.
  let edgeUp = true;
  try {
    await request.get(`${EDGE_ORIGIN}/`, { headers: { "x-forwarded-host": `${siteName}.${BASE_DOMAIN}` }, failOnStatusCode: false });
  } catch {
    edgeUp = false;
  }
  test.skip(!edgeUp, `edge not reachable at ${EDGE_ORIGIN} — skipping the serve check`);

  await expect
    .poll(
      async () => {
        const res = await request.get(`${EDGE_ORIGIN}/`, {
          headers: { "x-forwarded-host": `${siteName}.${BASE_DOMAIN}` },
          failOnStatusCode: false,
        });
        if (!res.ok()) return "";
        return await res.text();
      },
      { timeout: 30_000, intervals: [1000, 2000, 3000] },
    )
    .toContain(marker);
});
