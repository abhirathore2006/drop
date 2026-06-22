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
