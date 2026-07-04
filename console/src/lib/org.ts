// Org context (M1). The current org is CONTEXT carried in the URL as ?org=<slug> so links
// are shareable. Personal is the default (an absent ?org resolves to the personal org);
// ?org=* is the explicit "All orgs" (unfiltered) view — `*` is never a valid slug
// (validateOrgSlug requires DNS labels), so it can't collide with a real org.
//
// Lists are filtered CLIENT-SIDE (v1): GET /v1/sites and GET /v1/stacks each return
// everything the caller can see with an `org` field, so no server round-trip is needed to
// re-scope the view. See filterByOrg below.

import { useSearchParams } from "wouter";
import type { OrgSummary } from "./api-extra.ts";

/** Sentinel ?org value for the unfiltered "All orgs" view. */
export const ALL_ORGS = "*";

/** Resolve the current org from the loaded org list + the ?org param.
 *  Returns null when the view is unfiltered — either "All orgs" was picked, or the org
 *  list hasn't loaded yet (so nothing is hidden before we know the user's orgs). */
export function currentOrg(orgs: OrgSummary[] | undefined, param: string | null): OrgSummary | null {
  if (!orgs?.length) return null; // not loaded → don't filter
  if (param === ALL_ORGS) return null; // explicit "all"
  if (param) {
    const match = orgs.find((o) => o.slug === param);
    if (match) return match;
  }
  // Default: the personal org (there is exactly one). Falls back to the first org.
  return orgs.find((o) => o.kind === "personal") ?? orgs[0]!;
}

/** Filter a list of org-tagged resources to the current org. A null org means "all"
 *  (unfiltered). Resources with no org of their own belong to the caller's personal org,
 *  so they surface in the personal context. */
export function filterByOrg<T extends { org?: { slug: string; kind: string } | null }>(
  items: T[],
  org: OrgSummary | null,
): T[] {
  if (!org) return items;
  return items.filter((i) => (i.org ? i.org.slug === org.slug : org.kind === "personal"));
}

/** Read/write the ?org context, preserving the current pathname. */
export function useOrgParam(): readonly [string | null, (slug: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get("org");
  const set = (slug: string | null): void => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (slug) next.set("org", slug);
      else next.delete("org");
      return next;
    });
  };
  return [value, set] as const;
}
