// L5 — the CI spec-diff gate.
//
//   node scripts/check-openapi.mjs   (npm run check:openapi)
//
// Regenerates the OpenAPI spec from the route registry and diffs it against the committed docs/openapi.json.
// Policy:
//   * no drift                         → PASS.
//   * ONLY added fields                → FAIL "spec out of date" (regenerate + commit; additive, no bump needed).
//   * removed / changed fields, and info.version UNCHANGED → FAIL "breaking change without a version bump".
//   * removed / changed fields, but info.version bumped    → FAIL "spec out of date" (regenerate + commit).
// A breaking change (removed/changed field) is only ALLOWED through review by bumping package.json's
// version; the committed spec must always be regenerated + committed either way (so `check` fails on any
// drift), which is also the "committed == fresh generation" invariant.

import { readFileSync } from "node:fs";
import { loadSpec } from "./gen-openapi.mjs";

const root = new URL("..", import.meta.url);
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", root), "utf8")).version;

/** Flatten a JSON value into a map of dotted-path → leaf value (arrays indexed by position). */
function flatten(value, prefix, out) {
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    if (entries.length === 0) out.set(prefix, Array.isArray(value) ? "[]" : "{}");
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

function diff(oldObj, newObj) {
  const a = flatten(oldObj, "", new Map());
  const b = flatten(newObj, "", new Map());
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of b) if (!a.has(k)) added.push(k);
  for (const [k, v] of a) {
    if (!b.has(k)) removed.push(k);
    else if (JSON.stringify(b.get(k)) !== JSON.stringify(v)) changed.push(k);
  }
  return { added, removed, changed };
}

async function main() {
  let committed;
  try {
    committed = JSON.parse(readFileSync(new URL("./docs/openapi.json", root), "utf8"));
  } catch {
    console.error("✗ docs/openapi.json is missing — run `npm run gen:openapi` and commit it.");
    process.exit(1);
  }

  const fresh = await loadSpec(pkgVersion);
  const { added, removed, changed } = diff(committed, fresh);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log(`✓ docs/openapi.json is up to date (v${fresh.info.version})`);
    return;
  }

  // Drift exists. The version-tag path (info.version) shows up in `changed` when package.json was bumped.
  const versionBumped = committed.info?.version !== fresh.info.version;
  // Breaking = a removed or changed field OTHER THAN the version tag itself.
  const breaking = [...removed, ...changed.filter((p) => p !== "info.version")];

  console.error("✗ docs/openapi.json is out of date. Diff vs a fresh generation:");
  if (added.length) console.error(`  + added:   ${added.join(", ")}`);
  if (removed.length) console.error(`  - removed: ${removed.join(", ")}`);
  if (changed.length) console.error(`  ~ changed: ${changed.join(", ")}`);

  if (breaking.length > 0 && !versionBumped) {
    console.error(
      "\n  BREAKING: fields were removed/changed without bumping the API version. Bump `version` in " +
        "package.json (a breaking spec change is a version bump), then run `npm run gen:openapi` and commit.",
    );
  } else {
    console.error("\n  Run `npm run gen:openapi` and commit the regenerated docs/openapi.json + docs/api-reference.html.");
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
