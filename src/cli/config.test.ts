import { test, expect } from "bun:test";
import { resolveUpdateUrl } from "./config.ts";

test("resolveUpdateUrl: --api > recorded installUrl > apiBase/install.sh", () => {
  // recorded installUrl wins over apiBase
  expect(resolveUpdateUrl({ apiBase: "https://a.io", installUrl: "https://b.io/install.sh" })).toBe("https://b.io/install.sh");
  // fall back to apiBase + /install.sh (trailing slash trimmed)
  expect(resolveUpdateUrl({ apiBase: "https://a.io/" })).toBe("https://a.io/install.sh");
  // --api overrides the recorded source
  expect(resolveUpdateUrl({ installUrl: "https://b.io/install.sh" }, { api: "https://c.io" })).toBe("https://c.io/install.sh");
});

test("resolveUpdateUrl: errors when no source is known, and refuses non-http(s) URLs", () => {
  expect(() => resolveUpdateUrl({})).toThrow(/no install source/);
  expect(() => resolveUpdateUrl({ installUrl: "file:///etc/passwd" })).toThrow(/non-http/); // never shell a weird scheme
  expect(() => resolveUpdateUrl({}, { api: "ftp://evil" })).toThrow(/non-http/);
});
