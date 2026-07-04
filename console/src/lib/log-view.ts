// Pure helpers behind the live-logs surface (M3): stream-to-line assembly, a client-side grep filter,
// fixed-row-height virtualization windowing, and a download serializer. Kept free of React/DOM so they
// unit-test in isolation (log-view.test.ts); LogsPanel owns the id counter, the ring-buffer cap, and the
// scroll element — this module only computes.

/** One buffered log line. `id` is monotonic (assigned by the panel) so React keys and the ring-buffer
 *  cap survive filtering; `text` is the line WITHOUT its trailing newline. */
export interface LogLine {
  id: number;
  text: string;
}

/** Retain at most this many lines in memory (a ring buffer): live-following a chatty pod is unbounded
 *  otherwise. The download button dumps whatever is currently retained. */
export const LOG_BUFFER_CAP = 5000;

/** Render every line below this count; virtualize (window) only past it. A few hundred DOM nodes is
 *  cheap — windowing earns its keep only when the buffer grows large. */
export const VIRTUALIZE_THRESHOLD = 500;

/** Assemble a raw stream chunk into complete lines. `carry` is the incomplete trailing line left over
 *  from the previous chunk (a stream splits mid-line); the returned `carry` feeds the next call. The
 *  panel flushes a non-empty final carry as one last line when the stream ends. Pure. */
export function splitStreamChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split("\n");
  const nextCarry = parts.pop() ?? "";
  return { lines: parts, carry: nextCarry };
}

/** Case-insensitive substring filter. A blank/whitespace query passes everything; otherwise the subset
 *  (ids + order preserved) whose text contains the query. Pure. */
export function grepLines(lines: LogLine[], query: string): LogLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter((l) => l.text.toLowerCase().includes(q));
}

/** The visible slice [start,end) plus the spacer heights that keep the scrollbar honest. */
export interface LogWindow {
  start: number;
  end: number;
  padTop: number; // px spacer standing in for the [0,start) rows
  padBottom: number; // px spacer standing in for the [end,total) rows
}

/** Compute which fixed-height rows to actually render for a scroll viewport. Below VIRTUALIZE_THRESHOLD
 *  (or with a degenerate measurement) it renders the whole range with no spacers. `overscan` rows are
 *  drawn beyond each edge so a fast scroll never flashes blank. Pure + clamped. */
export function computeWindow(total: number, scrollTop: number, viewportH: number, lineH: number, overscan = 12): LogWindow {
  if (total <= VIRTUALIZE_THRESHOLD || lineH <= 0 || viewportH <= 0) {
    return { start: 0, end: total, padTop: 0, padBottom: 0 };
  }
  const first = Math.max(0, Math.floor(scrollTop / lineH) - overscan);
  const visible = Math.ceil(viewportH / lineH) + overscan * 2;
  const start = Math.min(first, total);
  const end = Math.min(total, start + visible);
  return { start, end, padTop: start * lineH, padBottom: (total - end) * lineH };
}

/** Serialize buffered lines for the download button (a trailing newline iff non-empty). Pure. */
export function dumpLines(lines: LogLine[]): string {
  return lines.length ? lines.map((l) => l.text).join("\n") + "\n" : "";
}
