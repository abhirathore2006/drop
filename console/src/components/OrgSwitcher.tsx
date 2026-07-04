// Org switcher at the top of the sidebar. The selection is context, written to the URL as
// ?org=<slug> (shareable); "all orgs" is the ?org=* sentinel. Personal is the default and
// leads the list.
import { useQuery } from "@tanstack/react-query";
import { apiExtra, type OrgSummary } from "../lib/api-extra.ts";
import { ALL_ORGS, currentOrg, useOrgParam } from "../lib/org.ts";

/** Personal orgs are named after the owner's email; show "personal" instead (the email is
 *  already the signed-in identity). Team orgs show their name. */
const orgOptionLabel = (o: OrgSummary): string => (o.kind === "personal" ? "personal" : o.name);

export function useOrgsQuery() {
  return useQuery({ queryKey: ["/v1/orgs"], queryFn: apiExtra.orgs, staleTime: 60_000 });
}

export function OrgSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const orgsQ = useOrgsQuery();
  const orgs = orgsQ.data?.orgs;
  const [param, setParam] = useOrgParam();
  const active = currentOrg(orgs, param);
  const value = param === ALL_ORGS ? ALL_ORGS : (active?.slug ?? ALL_ORGS);

  // Collapsed rail: a compact glyph standing in for the switcher (opens on click via the
  // sidebar's expand). Keep it non-interactive here to avoid a hidden <select>.
  if (collapsed) {
    return (
      <div className="org-rail" title={active ? orgOptionLabel(active) : "all orgs"} aria-hidden="true">
        🏢
      </div>
    );
  }

  return (
    <label className="org-switcher">
      <span className="org-switcher-label">org</span>
      <select
        aria-label="org context"
        value={value}
        disabled={!orgs}
        onChange={(e) => setParam(e.target.value === ALL_ORGS ? ALL_ORGS : e.target.value)}
      >
        <option value={ALL_ORGS}>all orgs</option>
        {orgs?.map((o) => (
          <option key={o.slug} value={o.slug}>
            {orgOptionLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
}
