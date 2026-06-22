import { createHash } from "node:crypto";

/** Per-tenant namespace for a workload owner. Deterministic + DNS-1123-safe.
 *  v1 tenant == owner email; a long/odd email is slugged with a hash suffix so
 *  it stays unique and within the 63-char k8s label limit. */
export function tenantNamespace(email: string): string {
  const lower = email.toLowerCase();
  const base = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const h = createHash("sha256").update(lower).digest("hex").slice(0, 8);
  return `drop-t-${base}-${h}`.slice(0, 63).replace(/-+$/g, "");
}

/** Namespace for a TEAM organisation (personal orgs reuse tenantNamespace(ownerEmail), stored on the
 *  org row). Deterministic + DNS-1123-safe, hashed on the slug to stay unique within 63 chars. */
export function orgSlugNamespace(slug: string): string {
  const s = slug.toLowerCase();
  const base = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  const h = createHash("sha256").update("org:" + s).digest("hex").slice(0, 8);
  return `drop-t-org-${base}-${h}`.slice(0, 63).replace(/-+$/g, "");
}
