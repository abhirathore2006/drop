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
