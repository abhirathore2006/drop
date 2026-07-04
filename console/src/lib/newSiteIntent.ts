// A one-shot cross-component signal: the command palette's "new site" verb fires this, and
// the workloads page (which owns the publish drop zone) scrolls it into view and focuses it.
// A counter (not a boolean) so repeated requests always re-fire, even without an intervening
// reset. External-store shaped so components subscribe with useSyncExternalStore.

let count = 0;
const listeners = new Set<() => void>();

export const newSiteIntent = {
  request(): void {
    count += 1;
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): number {
    return count;
  },
};
