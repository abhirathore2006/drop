import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { apiRegistry, buildSpec } from "./index.ts";

const pkgVersion = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;

test("the registered route set is the documented representative subset", () => {
  const ids = apiRegistry.all().map((r) => r.operationId).sort();
  expect(ids).toEqual(
    [
      "getFeatures",
      "getMe",
      "getOrg",
      "getOrgUsage",
      "getSite",
      "getVersion",
      "listOrgs",
      "listSites",
      "publishSiteVersion",
    ].sort(),
  );
});

test("buildSpec assembles paths + response schemas + version from the registry", () => {
  const spec = buildSpec("1.2.3");
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.info.version).toBe("1.2.3");
  // every registered route contributes a path + method + a JSON response schema
  for (const route of apiRegistry.all()) {
    const p = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const op = (spec.paths[p] as Record<string, any>)[route.method.toLowerCase()];
    expect(op.operationId).toBe(route.operationId);
    expect(op.responses["200"].content["application/json"].schema).toBeDefined();
  }
});

test("committed docs/openapi.json == a fresh generation (the CI spec-diff invariant)", () => {
  const committed = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"));
  // The committed file is generated with the package.json semver (build-sha suffix stripped).
  expect(committed).toEqual(buildSpec(pkgVersion) as unknown as typeof committed);
});
