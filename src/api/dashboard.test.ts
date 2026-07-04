import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleShell, consoleAsset } from "./dashboard.ts";

function withBuiltConsole(indexHtml: string): { cliDir: string; cleanup: () => void } {
  const cliDir = mkdtempSync(join(tmpdir(), "drop-console-"));
  mkdirSync(join(cliDir, "ui", "assets"), { recursive: true });
  writeFileSync(join(cliDir, "ui", "index.html"), indexHtml);
  return { cliDir, cleanup: () => rmSync(cliDir, { recursive: true, force: true }) };
}

const cspOf = (r: Response) => r.headers.get("content-security-policy") ?? "";
const nonceInCsp = (csp: string) => csp.match(/style-src [^;]*'nonce-([A-Za-z0-9_-]+)'/)?.[1] ?? null;

describe("consoleShell CSP style nonce", () => {
  test("stamps a matching nonce into both the CSP header and the shell meta", async () => {
    const { cliDir, cleanup } = withBuiltConsole(
      `<!doctype html><meta name="csp-style-nonce" content="__CSP_STYLE_NONCE__" /><div id=root></div>`,
    );
    try {
      const res = consoleShell({ cliDir, baseDomain: "drop.localhost" });
      const csp = cspOf(res);
      const nonce = nonceInCsp(csp);
      expect(nonce).toBeTruthy();
      const html = await res.text();
      // the placeholder is fully replaced and the served nonce equals the CSP nonce
      expect(html).not.toContain("__CSP_STYLE_NONCE__");
      expect(html).toContain(`content="${nonce}"`);
      // script-src stays strict: no unsafe-inline anywhere
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
    } finally {
      cleanup();
    }
  });

  test("mints a fresh nonce per response", () => {
    const { cliDir, cleanup } = withBuiltConsole(`<meta name="csp-style-nonce" content="__CSP_STYLE_NONCE__" />`);
    try {
      const a = nonceInCsp(cspOf(consoleShell({ cliDir, baseDomain: "d" })));
      const b = nonceInCsp(cspOf(consoleShell({ cliDir, baseDomain: "d" })));
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).not.toBe(b);
    } finally {
      cleanup();
    }
  });

  test("not-built fallback still carries a nonce'd CSP and never throws", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "drop-empty-"));
    try {
      const res = consoleShell({ cliDir, baseDomain: "d" });
      expect(nonceInCsp(cspOf(res))).toBeTruthy();
      expect(await res.text()).toContain("not built");
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
    }
  });
});

describe("consoleAsset traversal guard", () => {
  test("serves a hashed asset immutable and rejects traversal", async () => {
    const { cliDir, cleanup } = withBuiltConsole("<div id=root></div>");
    writeFileSync(join(cliDir, "ui", "assets", "app.js"), "console.log(1)");
    try {
      const ok = await consoleAsset({ cliDir, baseDomain: "d" }, "assets/app.js");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toContain("immutable");
      for (const bad of ["../secret", "..%2f", "/etc/passwd", "a/../../x"]) {
        expect((await consoleAsset({ cliDir, baseDomain: "d" }, bad)).status).toBe(404);
      }
    } finally {
      cleanup();
    }
  });
});
