// Shared `drop up` orchestration — used by the CLI `up` command AND the MCP `stack_plan`/`stack_up`
// tools so both drive the reconciler identically. The server owns resource EXISTENCE + CONFIG; the
// CLI owns CONTENT: it builds + pushes app images (sending the resolved refs in the up body) and
// publishes site bytes to the row the server just created, substituting `env_from` outputs at pack time.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_FILE_YAML } from "../site-config.ts";
import { parseStackConfig, type StackSpec } from "../stack-config.ts";
import { packDir } from "./pack.ts";
import { buildAndPushImage } from "./build-push.ts";
import type { Client } from "./client.ts";

export interface PlanStep {
  action: "create" | "update" | "delete" | "noop";
  key: string;
  kind: "site" | "app" | "database";
  siteName: string;
  reason: string;
}
interface Need {
  key: string;
  kind: "app-image" | "site-publish";
  siteName: string;
}
interface UpResponse {
  stack: string;
  specVersion: number;
  plan: PlanStep[];
  needs: Need[];
  outputs: Record<string, { url: string }>;
  applied?: PlanStep[];
}

/** Load a folder's `stack:` section from drop.yaml. Throws with a clear message when absent/invalid. */
export async function loadStackSpec(dir: string): Promise<StackSpec> {
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE_YAML), "utf8");
  } catch {
    throw new Error(`no ${CONFIG_FILE_YAML} found in ${dir}`);
  }
  const spec = parseStackConfig(text);
  if (!spec) throw new Error(`${CONFIG_FILE_YAML} has no valid stack: section (needs a name and at least one resource)`);
  return spec;
}

/** Render a plan as an aligned table (CLI). */
export function formatPlan(plan: PlanStep[]): string {
  if (!plan.length) return "  (no changes — stack is up to date)";
  const rows = plan.map((s) => [s.action, s.kind, s.key, s.siteName, s.reason]);
  const head = ["ACTION", "KIND", "KEY", "RESOURCE", "REASON"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => "  " + cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

/**
 * Run the full `drop up` flow: dry-run for the plan, build+push app images the spec still owes, execute
 * the real up with those resolved refs, then publish each site's bytes (with `env_from` substitution)
 * to the rows the server created. `--dry-run` stops after the plan. `log` receives progress lines.
 */
export async function runStackUp(
  client: Client,
  dir: string,
  opts: { org?: string; dryRun?: boolean; prune?: boolean; log?: (s: string) => void } = {},
): Promise<{ dryRun: boolean; plan: PlanStep[]; needs: Need[]; result?: UpResponse }> {
  const log = opts.log ?? (() => {});
  const spec = await loadStackSpec(dir);

  // 1) Dry-run → the plan + which content the CLI still owes + resource outputs.
  const preview = (await client.stackUp(spec.name, spec, { org: opts.org, dryRun: true, prune: opts.prune })) as UpResponse & { specVersion: number };
  log(formatPlan(preview.plan));
  if (opts.dryRun) return { dryRun: true, plan: preview.plan, needs: preview.needs };

  // 2) Build + push images for every app resource that has a `dir:` but no pinned image.
  const resolved: Record<string, { image: string }> = {};
  for (const need of preview.needs) {
    if (need.kind !== "app-image") continue;
    const res = spec.resources[need.key]!;
    const appDir = resolve(dir, res.dir ?? ".");
    log(`  ▸ building image for ${need.key} (${appDir})…`);
    const { image } = await buildAndPushImage(client, appDir, need.siteName, { org: opts.org });
    resolved[need.key] = { image };
  }

  // 3) Execute the real up. Send spec_version only for an EXISTING stack (optimistic concurrency).
  log(`  ▸ applying stack ${spec.name}…`);
  const result = (await client.stackUp(spec.name, spec, {
    org: opts.org,
    prune: opts.prune,
    resolved,
    specVersion: preview.specVersion > 0 ? preview.specVersion : undefined,
  })) as UpResponse;

  // 4) Publish site bytes to the rows the server created, substituting env_from outputs at pack time.
  for (const need of result.needs) {
    if (need.kind !== "site-publish") continue;
    const res = spec.resources[need.key]!;
    const siteDir = resolve(dir, res.dir ?? ".");
    const substitutions: Record<string, string> = {};
    for (const e of res.env_from ?? []) {
      const url = result.outputs[e.resource]?.url;
      if (url) substitutions[e.as] = url;
    }
    log(`  ▸ publishing site ${need.key} → ${need.siteName}…`);
    const tarball = await packDir(siteDir, { substitutions });
    await client.publish(need.siteName, tarball, opts.org);
  }

  return { dryRun: false, plan: result.plan, needs: result.needs, result };
}

// ============================ D2: template upstream diff (outdated / upgrade) ============================
// The response shapes mirror the server (src/stacks/diff.ts). Kept local (a small structural mirror) so
// the CLI needn't import server-only types.
export type DiffClass = "unchanged" | "upstream-only" | "local-only" | "conflict";
interface FieldDiff {
  field: string;
  class: DiffClass;
  pinned?: unknown;
  latest?: unknown;
  current?: unknown;
}
interface ResourceDiff {
  key: string;
  class: string;
  conflict: boolean;
  badge: string;
  fields: FieldDiff[];
  inPinned: boolean;
  inLatest: boolean;
  inCurrent: boolean;
}
interface StackDiff {
  upstreamChanged: boolean;
  hasLocalDrift: boolean;
  resources: ResourceDiff[];
  conflicts: string[];
}
interface OutdatedResponse {
  upToDate: boolean;
  templateDerived: boolean;
  template?: string;
  fromVersion?: string;
  latestVersion: string | null;
  diff?: StackDiff;
}
interface UpgradeResponse {
  stack?: string;
  specVersion?: number;
  plan?: PlanStep[];
  needs?: Need[];
  applied?: PlanStep[];
  template?: string;
  fromVersion?: string;
  toVersion?: string;
  autoApplied?: string[];
  resolved?: { key: string; how: string }[];
  dryRun?: boolean;
}

const fmtVal = (v: unknown): string => (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));

/** Render the three-way diff as a per-key table: upstream change vs local drift vs conflict. */
export function formatStackDiff(diff: StackDiff): string {
  const changed = diff.resources.filter((r) => r.class !== "unchanged");
  if (changed.length === 0) return "  (no upstream changes — the stack matches the template's latest)";
  const lines: string[] = [];
  for (const r of changed) {
    const tag =
      r.conflict ? "conflict ⚠"
      : r.class === "added-upstream" ? "added upstream"
      : r.class === "removed-upstream" ? "removed upstream"
      : r.class === "added-local" ? "added locally"
      : r.class === "removed-local" ? "removed locally"
      : r.class; // upstream-only | local-only
    lines.push(`  ${r.key}  [${tag}]`);
    if (r.class === "added-upstream") lines.push(`      + new resource from the template's latest version`);
    else if (r.class === "removed-upstream") lines.push(`      - the template dropped this resource`);
    else if (r.class === "added-local") lines.push(`      · added locally (not from the template) — preserved`);
    else if (r.class === "removed-local") lines.push(`      · removed locally — stays removed`);
    for (const f of r.fields) {
      if (f.class === "upstream-only") lines.push(`      ${f.field}: ${fmtVal(f.pinned)} → ${fmtVal(f.latest)}  (upstream)`);
      else if (f.class === "local-only") lines.push(`      ${f.field}: ${fmtVal(f.pinned)} → ${fmtVal(f.current)}  (local drift)`);
      else if (f.class === "conflict") lines.push(`      ${f.field}: pinned=${fmtVal(f.pinned)}  latest=${fmtVal(f.latest)}  local=${fmtVal(f.current)}  (CONFLICT)`);
    }
  }
  if (diff.conflicts.length) {
    lines.push("");
    lines.push(`  ${diff.conflicts.length} conflict(s): ${diff.conflicts.join(", ")}`);
    lines.push(`  resolve each with:  --take-upstream <key>  or  --keep-local <key>`);
  }
  return lines.join("\n");
}

/** `drop stack outdated [<name>]`. With a name → render the three-way diff. Without → list every
 *  template-derived stack with an "update available" flag (one /outdated call per derived stack). */
export async function runStackOutdated(
  client: Client,
  name: string | undefined,
  opts: { org?: string; log?: (s: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  if (name) {
    const o = (await client.stackOutdated(name, opts.org)) as OutdatedResponse;
    if (o.upToDate) {
      log(`  ✓ ${name} is up to date with ${o.template ?? "its template"}${o.latestVersion ? ` (v${o.latestVersion})` : ""}`);
      return;
    }
    log(`  ${name}: from ${o.template} v${o.fromVersion} → latest v${o.latestVersion}`);
    log(formatStackDiff(o.diff!));
    log("");
    log(`  upgrade it:  drop stack upgrade ${name}${o.diff!.conflicts.length ? " (resolve conflicts first — see above)" : ""}`);
    return;
  }
  // No name: list all template-derived stacks with an update-available flag.
  const list = (await client.stackList(opts.org)) as { stacks: { name: string; fromTemplate: string | null; org?: unknown }[] };
  const derived = list.stacks.filter((s) => s.fromTemplate);
  if (derived.length === 0) {
    log("  (no template-derived stacks)");
    return;
  }
  const rows: string[][] = [["STACK", "TEMPLATE", "PINNED", "LATEST", "UPDATE"]];
  for (const s of derived) {
    const o = (await client.stackOutdated(s.name).catch(() => null)) as OutdatedResponse | null;
    if (!o || !o.templateDerived) {
      rows.push([s.name, s.fromTemplate ?? "—", "—", "—", "?"]);
      continue;
    }
    rows.push([s.name, o.template ?? s.fromTemplate ?? "—", o.fromVersion ?? "—", o.latestVersion ?? "—", o.upToDate ? "—" : o.diff && o.diff.conflicts.length ? "yes ⚠conflicts" : "yes"]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) log("  " + r.map((c, i) => c.padEnd(widths[i]!)).join("  "));
}

/**
 * `drop stack upgrade <name>`. Dry-runs the upgrade (surfacing unresolved conflicts as a 409 the caller
 * catches), prints the resulting plan, confirms, then executes. `--dry-run` stops after the plan.
 */
export async function runStackUpgrade(
  client: Client,
  name: string,
  opts: {
    to?: string;
    resolutions?: Record<string, "take-upstream" | "keep-local">;
    org?: string;
    prune?: boolean;
    dryRun?: boolean;
    log?: (s: string) => void;
    confirm?: () => Promise<boolean>;
  } = {},
): Promise<{ executed: boolean; result?: UpgradeResponse }> {
  const log = opts.log ?? (() => {});
  const payload = { ...(opts.to ? { to: opts.to } : {}), ...(opts.resolutions ? { resolutions: opts.resolutions } : {}) };

  // 1) Dry-run for the plan (also the point at which an unresolved conflict 409s).
  const preview = (await client.stackUpgrade(name, payload, { org: opts.org, prune: opts.prune, dryRun: true })) as UpgradeResponse;
  log(`  upgrade ${name}: ${preview.template} v${preview.fromVersion} → v${preview.toVersion}`);
  if (preview.autoApplied?.length) log(`  auto-applying upstream changes: ${preview.autoApplied.join(", ")}`);
  if (preview.resolved?.length) log(`  resolutions: ${preview.resolved.map((r) => `${r.key}=${r.how}`).join(", ")}`);
  log(formatPlan(preview.plan ?? []));
  if (opts.dryRun) {
    log("  (dry run — nothing applied)");
    return { executed: false, result: preview };
  }

  // 2) Confirm, then execute.
  const ok = opts.confirm ? await opts.confirm() : true;
  if (!ok) {
    log("  aborted.");
    return { executed: false };
  }
  const result = (await client.stackUpgrade(name, payload, { org: opts.org, prune: opts.prune })) as UpgradeResponse;
  log(`  ✓ ${name} upgraded to ${result.template} v${result.toVersion} (spec v${result.specVersion})`);
  for (const need of result.needs ?? []) log(`    · note: resource ${need.key} still needs ${need.kind} (re-run its build/publish from source)`);
  return { executed: true, result };
}
