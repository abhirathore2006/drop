// (G4) Log RETENTION sweep. Default 7 days, org-overridable via the FM-item-10 quota table
// (`log_retention_days`). Runs on the API housekeeping loop alongside the metrics/events sweeps. For each
// site that has log objects it resolves the retention window from the OWNING org's override (else the
// platform default), then deletes every object + index row past that cutoff.
//
// Orphan-safe ORDERING: delete the S3 object FIRST, then its index row. A crash between the two leaves a
// row pointing at a now-missing object; the next sweep re-issues the (idempotent) object delete and drops
// the row. The reverse order could strand bytes in S3 with no index left to find them. The `log_objects`
// row is NOT FK-bound to `sites` (like `traffic_minutes`) — a deleted site's rows survive here and this
// sweep is their sole reaper (using the default window once the org link is gone), so the delete handler
// never has to touch S3.
import type { BlobStore } from "../blob/types.ts";
import type { MetaStore } from "../metastore/store.ts";
import type { QuotaStore } from "../quotas/store.ts";

export const DEFAULT_LOG_RETENTION_DAYS = 7;

export async function sweepLogRetention(opts: {
  meta: MetaStore;
  blob: BlobStore;
  quotas: QuotaStore;
  defaultDays: number;
  now?: () => Date;
}): Promise<number> {
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const sites = await opts.meta.listLogObjectSites(); // [{ siteName, orgId }] — orgId null for a deleted site
  const retentionByOrg = new Map<string, number>(); // resolve each org's override at most once per sweep
  let removed = 0;

  for (const s of sites) {
    let days = opts.defaultDays;
    if (s.orgId) {
      let d = retentionByOrg.get(s.orgId);
      if (d === undefined) {
        d = await opts.quotas.resolvedLogRetentionDays(s.orgId, opts.defaultDays);
        retentionByOrg.set(s.orgId, d);
      }
      days = d;
    }
    const cutoff = new Date(nowMs - days * 86_400_000);
    for (const row of await opts.meta.listLogObjectsBefore(s.siteName, cutoff)) {
      // The key is unique, so a prefix-delete removes exactly this one object (BlobStore has no
      // single-key delete; deletePrefix over the exact key is the idempotent equivalent).
      await opts.blob.deletePrefix(row.key);
      await opts.meta.deleteLogObject(s.siteName, row.hour);
      removed++;
    }
  }
  return removed;
}
