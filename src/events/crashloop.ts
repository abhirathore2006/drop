// (G2/G3) Crash-loop detection — the formalization the plan assigned jointly to G2/G3. The API
// housekeeping sweep enumerates each active namespace's app statuses (restart counts + reason) and
// diffs them against the PREVIOUS sweep's restart counts. This is the pure core, kept separate from the
// bin/api.ts wiring so the emit/resolve decision is exhaustively table-testable with fake status deltas.
//
// Bounded state: the `prev` map is REBUILT from the current sweep each tick (see nextRestarts), so it
// only ever holds an entry per app seen THIS sweep — it can't grow unbounded, and a deleted app drops
// out (no ghost crash-loop lingers).

/** A snapshot of one app's live status this sweep (a subset of kube AppStatus + its identity/org). */
export interface AppStatusSnapshot {
  name: string; // the site/app name (globally unique) — the event's site_name + resolve key
  orgId: string; // owning org (the event's org_id)
  restarts: number; // max container restarts across the app's pods
  ready: number; // ready replicas
  replicas: number; // desired replicas (0 = scaled to zero)
  reason: string; // "Running" | "CrashLoopBackOff" | "Pending" | ...
}

/** True when the app is crash-looping RIGHT NOW: kube reports CrashLoopBackOff, or it has pods that keep
 *  restarting without becoming ready (restarts climbed since last sweep while not fully ready). */
export function isCrashLooping(prevRestarts: number | undefined, s: AppStatusSnapshot): boolean {
  if (s.reason === "CrashLoopBackOff") return true;
  const climbed = prevRestarts != null && s.restarts > prevRestarts;
  return climbed && s.replicas > 0 && s.ready < s.replicas;
}

/** True when the app is healthy enough to CLOSE an open crash-loop incident (recovery): it's running its
 *  desired replicas and not in a crash-loop reason. A scaled-to-zero app (replicas 0) is intentionally
 *  offline — neither crashing nor "recovered", so it's left alone (no spurious resolve). */
export function isRecovered(s: AppStatusSnapshot): boolean {
  if (s.reason === "CrashLoopBackOff") return false;
  return s.replicas > 0 && s.ready >= s.replicas;
}

export interface CrashLoopDiff {
  emit: AppStatusSnapshot[]; // apps now crash-looping → emit a crashloop event (the store dedups repeats)
  resolve: AppStatusSnapshot[]; // apps that recovered → resolve any open crashloop incident
  next: Map<string, number>; // the restart-count map to carry into the NEXT sweep (bounded to this sweep)
}

/** Diff the current sweep against the previous restart counts. `emit` are the crash-loopers (the store's
 *  dedup collapses a still-crashing app to one open row + a bumped count); `resolve` are the recovered
 *  ones (resolve is a no-op when nothing is open, so it's safe to call unconditionally). */
export function diffCrashLoops(prev: Map<string, number>, current: AppStatusSnapshot[]): CrashLoopDiff {
  const emit: AppStatusSnapshot[] = [];
  const resolve: AppStatusSnapshot[] = [];
  const next = new Map<string, number>();
  for (const s of current) {
    next.set(s.name, s.restarts);
    if (isCrashLooping(prev.get(s.name), s)) emit.push(s);
    else if (isRecovered(s)) resolve.push(s);
  }
  return { emit, resolve, next };
}
