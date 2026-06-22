import { test, expect } from "bun:test";
import { tenantNamespace } from "./tenant.ts";

test("tenantNamespace is deterministic, DNS-safe, prefixed, and per-owner distinct", () => {
  const ns = tenantNamespace("Alice.Smith@example.com");
  expect(ns).toMatch(/^drop-t-[a-z0-9-]{1,55}$/);
  expect(ns).toBe(tenantNamespace("Alice.Smith@example.com")); // stable
  expect(ns).not.toBe(tenantNamespace("bob@example.com")); // distinct tenants
});

test("tenantNamespace stays within the 63-char k8s label limit for long emails", () => {
  const ns = tenantNamespace("a".repeat(200) + "@example.com");
  expect(ns.length).toBeLessThanOrEqual(63);
  expect(ns).toMatch(/^drop-t-[a-z0-9-]+$/);
  expect(ns.endsWith("-")).toBe(false);
});
