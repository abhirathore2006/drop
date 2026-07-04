// Permission gating for the console (M2). The server computes the caller's resolved capability set
// per resource (src/authz/permissions.ts → capabilitiesFor) and ships it as `capabilities` on list /
// detail responses. The console gates PURELY on that — it never re-derives permissions from
// owner/role math. Convention:
//   - admin-only surfaces are HIDDEN (routing / nav already fence those);
//   - a whole role-gated SURFACE whose data even READS behind a verb (app secrets, danger zone) is
//     hidden when the verb is absent;
//   - an individual role-gated ACTION button stays visible but DISABLED with a `title` tooltip
//     (discoverable affordance) — see denyReason().
import type { Capability } from "./api.ts";

/** True iff the current actor holds `verb` on this resource. Absent capabilities (older API that
 *  predates M2) → false, so every gated control safely stays hidden/disabled rather than open. */
export function cap(d: { capabilities?: Capability[] }, verb: Capability): boolean {
  return !!d.capabilities?.includes(verb);
}

/** Tooltip for a disabled, role-gated control — why it's not available to this actor. */
export function denyReason(verb: Capability): string {
  return `you need the "${verb}" permission on this resource`;
}
