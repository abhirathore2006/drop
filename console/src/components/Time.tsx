// (M4 / M5-preview) A shared timestamp helper: a relative label ("2m ago") with the absolute local
// timestamp on hover (title). The relative math is a pure function (relativeTime) so it unit-tests
// without a clock; the component re-renders on a coarse interval so "just now" ages into "1m ago"
// without a per-instance timer storm (one shared ticker for all mounted <Time>s).
import { useEffect, useState } from "react";

/** A compact relative label for `iso` vs `now` (both epoch-comparable). Future stamps read "in …";
 *  past stamps read "… ago"; within 5s reads "just now". Pure — `now` is injected for tests. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const deltaMs = now - t;
  const future = deltaMs < 0;
  const s = Math.floor(Math.abs(deltaMs) / 1000);
  const say = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (s < 5) return "just now";
  if (s < 60) return say(s, "s");
  const m = Math.floor(s / 60);
  if (m < 60) return say(m, "m");
  const h = Math.floor(m / 60);
  if (h < 24) return say(h, "h");
  const d = Math.floor(h / 24);
  if (d < 30) return say(d, "d");
  const mo = Math.floor(d / 30);
  if (mo < 12) return say(mo, "mo");
  return say(Math.floor(mo / 12), "y");
}

/** The absolute label shown in the tooltip: the local, human-readable timestamp. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 19);
  }
}

// One shared 30s ticker drives every mounted <Time> so relative labels age without N timers.
const tickers = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
function subscribeTick(fn: () => void): () => void {
  tickers.add(fn);
  if (!interval) interval = setInterval(() => tickers.forEach((t) => t()), 30_000);
  return () => {
    tickers.delete(fn);
    if (tickers.size === 0 && interval) {
      clearInterval(interval);
      interval = null;
    }
  };
}

/** Render a relative timestamp with the absolute time on hover. `at` null/empty renders an em dash.
 *  Pass `absolute` to show the absolute time as the visible label instead (still with the ISO title). */
export function Time({ at, absolute = false, className }: { at: string | null | undefined; absolute?: boolean; className?: string }) {
  const [, force] = useState(0);
  useEffect(() => subscribeTick(() => force((n) => n + 1)), []);
  if (!at) return <span className={className}>—</span>;
  const abs = absoluteTime(at);
  return (
    <time dateTime={at} title={abs} className={className}>
      {absolute ? abs : relativeTime(at)}
    </time>
  );
}
