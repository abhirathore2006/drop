// (G4) Searchable-log SEARCH. Grep-grade, honestly NOT full-text: the time range narrows to the set of
// `log_objects` (via the index) and the text match then STREAMS through those objects server-side. The
// matcher is a plain substring test (optionally case-insensitive) or an optional regex — no tokenizer, no
// inverted index. Objects are processed newest-first up to a cap so a wide range returns the freshest
// matches without reading (or buffering) the entire history.
import type { BlobStore } from "../blob/types.ts";
import { parseNdjsonGz } from "./format.ts";

export interface LogSearchHit {
  ts: string;
  pod: string;
  line: string;
}

export interface LogSearchResult {
  lines: LogSearchHit[];
  truncated: boolean; // the cap was hit — there may be more matches
  scanned: number; // how many S3 objects were actually read
}

/** An index row the search reads: the object's hour bucket + its S3 key. Ordered newest-first. */
export interface LogObjectRef {
  hour: Date;
  key: string;
}

/** Build the line predicate. Empty query → match everything. Regex mode compiles `query` (throwing on a
 *  bad pattern — the route surfaces a 400); otherwise a substring test, optionally case-insensitive. */
export function makeMatcher(query: string, opts: { regex?: boolean; ignoreCase?: boolean } = {}): (line: string) => boolean {
  if (!query) return () => true;
  if (opts.regex) {
    const re = new RegExp(query, opts.ignoreCase ? "i" : "");
    return (l) => re.test(l);
  }
  if (opts.ignoreCase) {
    const q = query.toLowerCase();
    return (l) => l.toLowerCase().includes(q);
  }
  return (l) => l.includes(query);
}

/** Parse a `from`/`to` query param: epoch seconds, epoch ms, or an ISO8601 string → epoch ms (or null).
 *  The seconds-vs-ms split uses a 1e12 threshold (year 2001 in ms / year 33658 in s) — a safe boundary. */
export function parseTs(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Stream matching lines out of the given objects (newest-first), bounded by `limit`. A record whose ts
 *  is outside [from,to] is skipped (an hour bucket straddles the range edges). Reads one object at a time
 *  — the memory bound is a single object plus the accumulated hits, never the whole range. */
export async function searchLogObjects(opts: {
  blob: BlobStore;
  objects: LogObjectRef[]; // newest-first (hour DESC)
  from: Date;
  to: Date;
  match: (line: string) => boolean;
  limit: number;
}): Promise<LogSearchResult> {
  const { blob, objects, from, to, match, limit } = opts;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const hits: LogSearchHit[] = [];
  let scanned = 0;
  let truncated = false;

  for (const obj of objects) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    const res = await blob.get(obj.key);
    if (!res) continue; // an index row whose object was already swept (retention race) — skip, don't fail
    scanned++;
    const bytes = new Uint8Array(await new Response(res.body).arrayBuffer());
    for (const r of parseNdjsonGz(bytes)) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && (t < fromMs || t > toMs)) continue;
      if (!match(r.line)) continue;
      hits.push({ ts: r.ts, pod: r.pod, line: r.line });
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
    }
  }
  return { lines: hits, truncated, scanned };
}
