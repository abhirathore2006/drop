// L5 — generate the committed OpenAPI spec + a hand-rolled HTML reference from the route registry.
//
//   node scripts/gen-openapi.mjs
//
// Writes docs/openapi.json (the machine-readable spec, tagged with the semver from package.json so it is
// deterministic across commits) and docs/api-reference.html (a readable, dependency-free endpoint table).
// The registry is TypeScript, so we bundle src/api/openapi/index.ts with esbuild (already a devDep, no new
// dependency) to a temp ESM module, import it, and call buildSpec(version).

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", root), "utf8")).version;

/** Bundle the TS spec builder to a temp ESM file and import it — returns the assembled document. */
export async function loadSpec(version) {
  const out = join(mkdtempSync(join(tmpdir(), "drop-openapi-")), "spec.mjs");
  await build({
    entryPoints: [new URL("./src/api/openapi/index.ts", root).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: out,
  });
  const mod = await import(pathToFileURL(out).href);
  return mod.buildSpec(version);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A compact one-line rendering of a JSON Schema type (for the reference table). */
function typeStr(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeStr).join(" | ");
  const t = schema.type;
  if (Array.isArray(t)) return t.join(" | ");
  if (t === "array") return `${typeStr(schema.items)}[]`;
  if (t === "object") {
    if (schema.additionalProperties && schema.additionalProperties !== true) return `Record<string, ${typeStr(schema.additionalProperties)}>`;
    return "object";
  }
  return t ?? "any";
}

/** Render a response/body object schema's top-level fields as a small table. */
function fieldsTable(schema) {
  if (!schema || schema.type !== "object" || !schema.properties) {
    return `<div class="muted">${esc(typeStr(schema))}</div>`;
  }
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(schema.properties)
    .map(
      ([k, v]) =>
        `<tr><td><code>${esc(k)}</code>${required.has(k) ? "" : ' <span class="opt">?</span>'}</td><td><code>${esc(typeStr(v))}</code></td></tr>`,
    )
    .join("");
  return `<table class="fields"><thead><tr><th>field</th><th>type</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtml(spec) {
  const byTag = new Map();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const tag = (op.tags && op.tags[0]) || "other";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method: method.toUpperCase(), op });
    }
  }
  const sections = [...byTag.keys()].sort().map((tag) => {
    const ops = byTag
      .get(tag)
      .map(({ path, method, op }) => {
        const params = (op.parameters ?? [])
          .map((p) => `<li><code>${esc(p.name)}</code> <span class="muted">(${p.in}${p.required ? ", required" : ""})</span></li>`)
          .join("");
        const body = op.requestBody
          ? `<div class="block"><h4>Request body</h4><div class="muted">${esc(Object.keys(op.requestBody.content)[0])}</div>${fieldsTable(Object.values(op.requestBody.content)[0].schema)}</div>`
          : "";
        const resSchema = op.responses?.["200"]?.content?.["application/json"]?.schema;
        return `<div class="endpoint">
  <div class="sig"><span class="method ${method.toLowerCase()}">${method}</span> <code class="path">${esc(path)}</code></div>
  <p class="summary">${esc(op.summary ?? "")}</p>
  <p class="opid">operationId: <code>${esc(op.operationId)}</code></p>
  ${params ? `<div class="block"><h4>Parameters</h4><ul>${params}</ul></div>` : ""}
  ${body}
  <div class="block"><h4>Response 200</h4>${fieldsTable(resSchema)}</div>
</div>`;
      })
      .join("\n");
    return `<section><h2>${esc(tag)}</h2>${ops}</section>`;
  });

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drop Platform API reference</title>
<link rel="stylesheet" href="assets/style.css">
<style>
  .api { max-width: 920px; margin: 0 auto; padding: 24px 20px 80px; }
  .api h1 { margin-bottom: 4px; }
  .api .lede { color: var(--muted, #8b95a7); margin-top: 0; }
  .endpoint { border: 1px solid rgba(140,150,170,.25); border-radius: 10px; padding: 14px 16px; margin: 14px 0; }
  .sig { display: flex; align-items: center; gap: 10px; font-size: 15px; }
  .method { font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; letter-spacing: .04em; }
  .method.get { background: #10331f; color: #4ade80; }
  .method.post { background: #10233f; color: #60a5fa; }
  .method.put, .method.patch { background: #33280f; color: #fbbf24; }
  .method.delete { background: #331414; color: #f87171; }
  .path { font-size: 15px; }
  .summary { margin: 8px 0 2px; }
  .opid { margin: 0 0 8px; font-size: 12px; color: var(--muted, #8b95a7); }
  .block { margin-top: 10px; }
  .block h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted, #8b95a7); }
  table.fields { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.fields th { text-align: left; font-weight: 600; color: var(--muted, #8b95a7); padding: 3px 8px; }
  table.fields td { padding: 3px 8px; border-top: 1px solid rgba(140,150,170,.15); }
  .opt { color: #f59e0b; }
  .muted { color: var(--muted, #8b95a7); font-size: 13px; }
  ul { margin: 4px 0; padding-left: 20px; }
  .note { border: 1px solid rgba(140,150,170,.25); border-radius: 10px; padding: 4px 16px; margin: 16px 0 8px; background: rgba(140,150,170,.06); }
  .note p { font-size: 14px; }
</style>
<div class="api">
  <h1>Drop Platform API</h1>
  <p class="lede">Version <code>${esc(spec.info.version)}</code> · <a href="index.html">docs home</a> · <a href="openapi.json">openapi.json</a></p>
  <p>${esc(spec.info.description)}</p>
  <div class="note">
    <p><strong>Machine-readable spec.</strong> The live spec is served at <code>GET /v1/openapi.json</code>
    (public, like <code>/version</code>) and committed to <a href="openapi.json">docs/openapi.json</a>.
    This page + the spec are GENERATED from the route registry in <code>src/api/openapi</code> — never edit
    them by hand; run <code>npm run gen:openapi</code>.</p>
    <p><strong>Typed client.</strong> <code>@drop/client</code> (<code>packages/client</code>, zero runtime
    deps) is generated from this spec: <code>createClient({ baseUrl }).getSite({ name })</code> returns a
    typed response. The Drop CLI is its first consumer, which makes it the permanent conformance test.</p>
    <p><strong>Versioning.</strong> <code>info.version</code> is the API's semver (the build-sha suffix is
    stripped, so the committed spec is stable across commits). A CI gate (<code>npm run check:openapi</code>)
    fails on any drift; removing or changing a field requires bumping the version — added fields do not.</p>
  </div>
  ${sections.join("\n")}
</div>
`;
}

async function main() {
  const spec = await loadSpec(pkgVersion);
  writeFileSync(new URL("./docs/openapi.json", root), JSON.stringify(spec, null, 2) + "\n");
  writeFileSync(new URL("./docs/api-reference.html", root), renderHtml(spec));
  console.log(`✓ wrote docs/openapi.json + docs/api-reference.html (v${spec.info.version}, ${Object.keys(spec.paths).length} paths)`);
}

// Run when invoked directly (not when imported by check-openapi.mjs).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
