// `drop detect [dir] [--write]` (F1) — the CLI-facing half of local stack detection. The pure core
// (heuristics, in src/detect/detect.ts) never touches disk; this file wires it to the real filesystem,
// hand-serializes the proposed spec to YAML (no YAML *stringifier* is used anywhere else in this repo —
// only the parser — so this is a small serializer bounded to the shape `detectStack` actually emits:
// `type`/`dir`/`uses`, not a general StackSpec/YAML writer), and implements the `--write` merge.
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { detectStack, type DetectedSpec, type DetectResult } from "../detect/detect.ts";
import { createFsFileTree } from "../detect/fs-tree.ts";
import { CONFIG_FILE_YAML } from "../site-config.ts";
import { validateName } from "../names.ts";
import type { StackResource } from "../stack-config.ts";

/** A DNS-safe stack name proposed from a directory's basename (lowercased, non-DNS chars → "-"),
 *  falling back to a "-stack" suffixed form when the bare basename is reserved/invalid (e.g. "app",
 *  "api", or containing "--") so the printed proposal is usable as-is whenever possible. */
export function stackNameFromDir(dir: string): string {
  const base =
    basename(resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app";
  if (validateName(base) === null) return base;
  const withSuffix = `${base.slice(0, 57)}-stack`.replace(/^-+/, "");
  return validateName(withSuffix) === null ? withSuffix : "detected-stack";
}

/** Run detect against a real directory (the CLI/MCP entry point). */
export async function runDetect(dir: string): Promise<DetectResult> {
  const tree = createFsFileTree(resolve(dir));
  return detectStack(tree, { name: stackNameFromDir(dir) });
}

/** Quote a YAML scalar only when the bare form would round-trip as something else (a leading `#`,
 *  a `:`, wrapping whitespace, …); otherwise print it bare, matching the hand-written examples' style. */
function yamlScalar(v: string): string {
  return /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(v) ? v : JSON.stringify(v);
}

function usesToFlow(uses: NonNullable<StackResource["uses"]>): string {
  const parts = uses.map((u) => {
    if (u.database) return `{ database: ${yamlScalar(u.database)} }`;
    if (u.bucket) return `{ bucket: ${yamlScalar(u.bucket)} }`;
    if (u.cache) return `{ cache: ${yamlScalar(u.cache)} }`;
    return "{}";
  });
  return `[${parts.join(", ")}]`;
}

/** Hand-serialize a detected spec's `stack:` section. Bounded to the fields `detectStack` actually
 *  emits (`type`, `dir`, `uses`) — a full StackResource has far more optional fields (scale, env,
 *  healthcheck, …), all deliberately left for the user to add by hand; detect only ever proposes what
 *  it found real evidence for. Ends with exactly one trailing newline. */
export function serializeDetectedStack(spec: DetectedSpec): string {
  const lines: string[] = ["stack:", `  name: ${yamlScalar(spec.name)}`, "  resources:"];
  for (const key of Object.keys(spec.resources).sort()) {
    const res = spec.resources[key]!;
    lines.push(`    ${key}:`);
    lines.push(`      type: ${res.type}`);
    if (res.dir) lines.push(`      dir: ${yamlScalar(res.dir)}`);
    if (res.uses && res.uses.length) lines.push(`      uses: ${usesToFlow(res.uses)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Merge a detected `stack:` block into `<dir>/drop.yaml`. Refuses to clobber an EXISTING `stack:`
 * section unless `force`. This is a best-effort TEXT splice, not a full YAML-AST edit — it preserves
 * every other top-level section byte-for-byte by only ever touching the lines from an existing
 * `stack:` key to the next unindented, non-comment `key:` line (or EOF); with no existing `stack:` it
 * simply appends. Creates the file when it doesn't exist yet.
 */
export async function writeDetectedStack(dir: string, spec: DetectedSpec, opts: { force?: boolean } = {}): Promise<{ path: string; created: boolean }> {
  const path = resolve(dir, CONFIG_FILE_YAML);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined;
  }

  if (existing !== undefined) {
    let doc: unknown;
    try {
      doc = parseYaml(existing);
    } catch {
      doc = undefined; // an unparsable existing file is left to the writer's judgment — not our call
    }
    const hasStack = !!(doc && typeof doc === "object" && (doc as Record<string, unknown>).stack);
    if (hasStack && !opts.force) {
      throw new Error(`${path} already has a stack: section — pass --force to overwrite it`);
    }
  }

  const block = serializeDetectedStack(spec).replace(/\n+$/, "");
  let out: string;
  if (existing === undefined) {
    out = block;
  } else {
    const lines = existing.replace(/\n+$/, "").split("\n");
    const startIdx = lines.findIndex((l) => /^stack:(\s|$)/.test(l));
    if (startIdx === -1) {
      out = lines.length === 1 && lines[0] === "" ? block : `${lines.join("\n")}\n\n${block}`;
    } else {
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^[^\s#]/.test(lines[i]!)) {
          endIdx = i;
          break;
        }
      }
      // Trim blank-line padding at the splice boundaries so re-joining with an explicit blank-line
      // separator below doesn't accumulate extra blank lines run after run.
      const before = lines.slice(0, startIdx);
      while (before.length && before[before.length - 1] === "") before.pop();
      const after = lines.slice(endIdx);
      while (after.length && after[0] === "") after.shift();
      out = [...(before.length ? [before.join("\n")] : []), block, ...(after.length ? [after.join("\n")] : [])].join("\n\n");
    }
  }
  await writeFile(path, out.endsWith("\n") ? out : out + "\n", "utf8");
  return { path, created: existing === undefined };
}
