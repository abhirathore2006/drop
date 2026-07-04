// Stacks list (M1). The stacks that used to sit above the workloads grid now get their own
// page; the cards link to the read-only canvas (/stack/<name>). Org-scoped by ?org context.
//
// (F2) AI intent: when the operator has enabled the feature (probe /v1/features → llmEnabled), a prompt box
// sits above the grid — the new-stack entry point for humans without an MCP client. Generating a spec hands
// it to the C2 editor as PROPOSED, unapplied pending-changes (seeded onto an empty base): the human reviews
// on the canvas, then Apply → dry-run → confirm → execute creates the stack via the SAME `/v1/stacks/:name/up`
// contract as `drop up`. Nothing is applied by the generate call itself, and it never sees secrets.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonCards } from "../components/Skeleton.tsx";
import { useStacksQuery } from "../components/workloads.tsx";
import { useOrgsQuery } from "../components/OrgSwitcher.tsx";
import { orgLabel, type StackGraph } from "../lib/api.ts";
import { apiExtra, type GeneratedStack } from "../lib/api-extra.ts";
import { StackEditor } from "../canvas/StackEditor.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { currentOrg, filterByOrg, useOrgParam } from "../lib/org.ts";
import { POLL_LIST_MS } from "../lib/query.ts";

export function StacksPage() {
  useDocumentTitle("stacks · drop");
  const q = useStacksQuery(POLL_LIST_MS);
  const [param] = useOrgParam();
  const org = currentOrg(useOrgsQuery().data?.orgs, param);
  const stacks = filterByOrg(q.data?.stacks ?? [], org);

  // (F2) The AI-intent prompt box renders ONLY when the operator enabled the feature. `retry: false` + the
  // `?? false` default means a 404/501 (older API / feature off) simply hides the box — never an error state.
  const featuresQ = useQuery({ queryKey: ["/v1/features"], queryFn: apiExtra.features, retry: false, staleTime: 60_000 });
  const llmEnabled = featuresQ.data?.llmEnabled ?? false;
  const [generated, setGenerated] = useState<GeneratedStack | null>(null);

  // While reviewing an AI-generated stack the C2 editor takes over the page (mirrors StackPage edit mode).
  // The synthetic base graph carries no live nodes (nothing exists yet); the seeded spec supplies every node
  // as a proposed "create". Cancel/Apply both call onExit → back to the list.
  if (generated) {
    const syntheticGraph: StackGraph = { name: generated.spec.name, org: null, specVersion: 0, nodes: [], edges: [], plan: [] };
    return (
      <section className="ai-stack-review">
        <div className="phead">
          <div className="dname">
            {generated.spec.name} <span className="badge badge-app">NEW STACK</span>
          </div>
        </div>
        {/* Guardrail note: the spec is a proposal, not a deployment. */}
        <div className="ai-guardrail" data-testid="ai-guardrail" role="note">
          <b>AI-generated — review before applying.</b> Nothing is created until you Apply and confirm the plan.
          {generated.notes && generated.notes.length > 0 && (
            <ul className="ai-notes">
              {generated.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
        <StackEditor name={generated.spec.name} baseGraph={syntheticGraph} seed={generated.spec} onExit={() => setGenerated(null)} />
      </section>
    );
  }

  return (
    <section>
      <h2>
        Stacks {stacks.length > 0 && <span className="count">{stacks.length}</span>}
      </h2>

      {llmEnabled && <AiStackPrompt org={org?.slug} onGenerated={setGenerated} />}

      {q.isPending ? (
        <SkeletonCards count={4} />
      ) : q.isError ? (
        <div className="err">couldn't load stacks: {q.error.message}</div>
      ) : stacks.length === 0 ? (
        <EmptyState title="No stacks yet.">
          Declare an app, database, and their wiring in one <code>drop.yaml</code>, then <code>drop up</code> to create them together.
          {llmEnabled && " Or describe what you want above and let AI draft one."}
        </EmptyState>
      ) : (
        <div className="grid">
          {stacks.map((s) => (
            <Link key={s.name} href={`/stack/${encodeURIComponent(s.name)}`} className="card">
              <div className="card-top">
                <span className="dot" />
                <span className="card-name">{s.name}</span>
                <span className="badge badge-app">STACK</span>
              </div>
              <div className="card-owner">
                {s.resources} resource{s.resources === 1 ? "" : "s"}
                {s.fromTemplate && <span className="sub"> · from {s.fromTemplate}</span>}
              </div>
              <div className="card-foot">
                {s.org && (
                  <span className="card-org" title={`org: ${s.org.slug}`}>
                    🏢 {orgLabel(s.org)}
                  </span>
                )}
                <span className="ver">v{s.specVersion}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// (F2) The prompt box: a textarea + Generate button. Calls /v1/stacks/generate; on success the returned
// (sanitized) spec is handed up to open the C2 editor seeded with it as pending changes. The generated spec
// is NEVER applied here — the guardrail note + the Apply → dry-run → confirm flow are the human review gate.
function AiStackPrompt({ org, onGenerated }: { org?: string; onGenerated: (g: GeneratedStack) => void }) {
  const [prompt, setPrompt] = useState("");
  const gen = useMutation({
    mutationFn: () => apiExtra.generateStack(prompt.trim(), org),
    onSuccess: (g) => onGenerated(g),
  });
  const canSubmit = prompt.trim().length > 0 && !gen.isPending;
  return (
    <div className="ai-stack-prompt" data-testid="ai-stack-prompt">
      <label className="ai-prompt-label" htmlFor="ai-stack-prompt-input">
        Describe what you want to deploy and let AI draft a stack:
      </label>
      <textarea
        id="ai-stack-prompt-input"
        data-testid="ai-stack-prompt-input"
        className="ai-prompt-input"
        rows={3}
        value={prompt}
        placeholder="describe what you want to deploy… e.g. a Node API with a Postgres database and a static site front-end"
        onChange={(e) => setPrompt(e.target.value)}
      />
      {gen.isError && <div className="err">{(gen.error as Error).message}</div>}
      <div className="ai-prompt-actions">
        <span className="muted small">AI-generated — you review it on the canvas before applying.</span>
        <Button variant="primary" size="sm" loading={gen.isPending} disabled={!canSubmit} data-testid="ai-generate-btn" onClick={() => gen.mutate()}>
          Generate
        </Button>
      </div>
    </div>
  );
}
