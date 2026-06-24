import { test, expect } from "bun:test";
import { installScript } from "./install.ts";

test("installScript bakes the API URL into a self-contained node-wrapper installer", () => {
  const s = installScript("https://api.drop.example.com");
  expect(s.startsWith("#!/bin/sh")).toBe(true);
  expect(s).toContain('API="https://api.drop.example.com"');
  expect(s).toContain("/cli/drop.mjs"); // fetches the bundles this API serves
  expect(s).toContain("/cli/mcp.mjs");
  expect(s).toContain('exec node "%s/drop.mjs" "$@"'); // node wrapper, no npm
  expect(s).toContain('"apiBase": "%s", "installUrl": "%s/install.sh"'); // auto-config write records the install source
  expect(s).toContain("drop update"); // points the user at the update command
  expect(s).toContain("Node.js is required"); // node prerequisite check
  // only the API URL is interpolated — no stray JS template artifacts
  expect(s).not.toContain("${");
});
