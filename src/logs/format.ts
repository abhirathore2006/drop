// (G4) On-disk shape of a retained log object. The collector batches structured lines into ONE gzipped
// NDJSON object per (site, hour) at `logs/<site>/<hourLabel>.ndjson.gz`; the search path reads them back.
// Kept free of any store / kube / blob coupling so it unit-tests in isolation and both the collector and
// the search reader share exactly one serialization contract.
import { gzipSync, gunzipSync } from "node:zlib";

export type LogStream = "stdout" | "stderr";

/** One retained log line. `ts` is the collector's RECEIVE time (kube's follow stream carries no per-line
 *  timestamp by default) — ISO8601, and the field the time-range search filters on. `pod` is the followed
 *  pod (v1 tails the first ready pod, so it carries the workload name — see the collector). */
export interface LogRecord {
  ts: string; // ISO8601 collector receive time
  site: string;
  pod: string;
  stream: LogStream;
  line: string;
}

export const HOUR_MS = 3_600_000;

/** The hour bucket a timestamp falls in (UTC hour start). One S3 object + one index row per bucket. */
export function hourStart(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** The object-key hour label, `YYYY-MM-DDTHH` — colon-free so the key is clean on every backend. */
export function hourLabel(hour: Date): string {
  return hour.toISOString().slice(0, 13); // "2026-07-04T10"
}

/** The S3 object key for a site's hour bucket: `logs/<site>/<YYYY-MM-DDTHH>.ndjson.gz`. Unique per
 *  (site, hour) — the retention sweep can therefore delete exactly one object by this key. */
export function logObjectKey(site: string, hour: Date): string {
  return `logs/${site}/${hourLabel(hour)}.ndjson.gz`;
}

/** Serialize records to gzipped NDJSON (one JSON object per line). Empty input → an empty gzip member. */
export function serializeNdjsonGz(records: LogRecord[]): Uint8Array {
  const ndjson = records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  return new Uint8Array(gzipSync(Buffer.from(ndjson, "utf8")));
}

/** Parse a gzipped-NDJSON object back to records. A corrupt line is skipped, not thrown — grep-grade
 *  history tolerates a torn tail (e.g. a half-written object recovered after a crash). */
export function parseNdjsonGz(bytes: Uint8Array): LogRecord[] {
  const text = gunzipSync(Buffer.from(bytes)).toString("utf8");
  const out: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      /* skip a corrupt/partial line — best-effort */
    }
  }
  return out;
}
