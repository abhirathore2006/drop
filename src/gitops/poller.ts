// (B3) The GitOps poll loop — PULL-ONLY by design (no inbound webhooks v1: accepting pushes would mean
// exposing the API to the git host; a jittered poll needs nothing inbound). Joins the bin/api.ts
// housekeeping loops: each tick sweeps every `stack_links` row, runs the shared per-stack sync
// (sync.ts — the SAME function the manual sync route calls), and logs outcomes. Best-effort like its
// sibling sweeps: one stack's failure logs (and lands in its G3 event) without stopping the sweep, and
// a tick error never crashes the process. Sequential per tick — the set is one row per linked stack,
// and the reconcile itself serializes on the stack advisory lock anyway.
import type { StackRow } from "../stacks/store.ts";
import type { StackLinkRow, StackLinkStore } from "./store.ts";
import type { GitopsSyncResult } from "./sync.ts";

export interface GitopsPollerDeps {
  links: Pick<StackLinkStore, "list">;
  stacks: { getById(id: string): Promise<StackRow | null> };
  /** The wired sync runner (server.ts hands it over via Deps.onGitopsSync). */
  run: (stack: StackRow, link: StackLinkRow) => Promise<GitopsSyncResult>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/** One poll sweep over every linked stack. Exported separately so tests drive a tick without timers. */
export async function gitopsPollTick(deps: GitopsPollerDeps): Promise<void> {
  const links = await deps.links.list();
  for (const link of links) {
    // The stack row can lapse between list() and here (delete cascades the link) — just skip.
    const stack = await deps.stacks.getById(link.stackId).catch(() => null);
    if (!stack) continue;
    try {
      const r = await deps.run(stack, link);
      if (r.outcome === "synced") deps.log?.(`gitops: synced stack ${stack.name} @ ${r.sha?.slice(0, 12)}`);
      else if (r.outcome === "pending_review") deps.log?.(`gitops: change for stack ${stack.name} parked for review @ ${r.sha?.slice(0, 12)}`);
      else if (r.outcome === "failed") deps.error?.(`gitops: sync ${stack.name} failed: ${r.error}`);
    } catch (e) {
      // sync.ts records/emits its own failures; this catches only unexpected throws (e.g. a DB hiccup).
      deps.error?.(`gitops: sync ${stack.name} threw: ${(e as Error).message}`);
    }
  }
}

/** Start the jittered interval (default 60s via DROP_GITOPS_POLL_MS in bin/api.ts). A setTimeout CHAIN
 *  (not setInterval) so each gap is independently jittered ±25% — replicas don't align their fetch
 *  bursts against the git host — and a slow tick never overlaps the next. unref'd like the sibling
 *  housekeeping timers. Returns a stop handle (tests / graceful shutdown). */
export function startGitopsPoller(deps: GitopsPollerDeps & { intervalMs: number; jitter?: () => number }): { stop(): void } {
  const jitter = deps.jitter ?? Math.random;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const delay = Math.max(1000, deps.intervalMs * (0.75 + jitter() * 0.5)); // ±25%, floor 1s
    timer = setTimeout(() => {
      void gitopsPollTick(deps)
        .catch((e) => deps.error?.(`gitops poll tick failed: ${(e as Error).message}`))
        .finally(() => {
          if (!stopped) schedule();
        });
    }, delay);
    timer.unref?.();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
