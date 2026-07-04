// Templates (M1 / D1). The golden-path catalog: cards for every template the caller can see (public +
// their orgs'), each deep-linking to /template/<slug> (the readme + variables form + canvas preview +
// "Deploy this stack" page). Publish one with `drop template publish`.
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { api, orgLabel } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { POLL_LIST_MS } from "../lib/query.ts";

export function TemplatesPage() {
  useDocumentTitle("templates · drop");
  const q = useQuery({ queryKey: ["/v1/templates"], queryFn: api.templates, refetchInterval: POLL_LIST_MS });
  const templates = q.data?.templates ?? [];

  return (
    <section>
      <h2>
        Templates {templates.length > 0 && <span className="count">{templates.length}</span>}
      </h2>
      {q.isPending ? (
        <SkeletonCards count={4} />
      ) : q.isError ? (
        <div className="err">couldn't load templates: {q.error.message}</div>
      ) : templates.length === 0 ? (
        <EmptyState title="No templates yet.">
          Publish one from a working stack with <code>drop template publish --from-stack &lt;name&gt;</code> — it strips secrets and image digests, then anyone can{" "}
          <code>drop new &lt;slug&gt;</code> to instantiate it.
        </EmptyState>
      ) : (
        <div className="grid">
          {templates.map((t) => (
            <Link key={t.slug} href={`/template/${encodeURIComponent(t.slug)}`} className="card">
              <div className="card-top">
                <span className="dot" />
                <span className="card-name">{t.name}</span>
                <span className={`badge ${t.visibility === "public" ? "badge-site" : "badge-database"}`}>{t.visibility === "public" ? "PUBLIC" : "ORG"}</span>
              </div>
              <div className="card-owner">
                {t.description ? t.description : <span className="muted">no description</span>}
              </div>
              <div className="card-foot">
                {t.org && (
                  <span className="card-org" title={`org: ${t.org.slug}`}>
                    🏢 {orgLabel(t.org)}
                  </span>
                )}
                <span className="ver">
                  {t.resources} resource{t.resources === 1 ? "" : "s"}
                  {t.latestVersion && ` · v${t.latestVersion}`}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
