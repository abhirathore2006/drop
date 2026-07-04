// Templates (M1). The registry is D1 — not built yet — so this is an honest empty state,
// not a fake gallery. When D1 lands, list from GET /v1/templates here and link each to
// /template/<slug>.
//
// D1: replace this EmptyState with a query over GET /v1/templates (route does not exist
// yet) → a card grid + a variables form + a read-only canvas preview (the C1 component fed
// the template spec) + a "deploy this stack" button.
import { EmptyState } from "../components/EmptyState.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";

export function TemplatesPage() {
  useDocumentTitle("templates · drop");
  return (
    <section>
      <h2>Templates</h2>
      <EmptyState title="No templates yet.">
        Templates arrive with the registry. Publish one from a working stack with <code>drop template publish --from-stack &lt;name&gt;</code> — it
        strips secrets and image digests, then anyone can <code>drop new &lt;slug&gt;</code> to instantiate it.
      </EmptyState>
    </section>
  );
}
