// D2 note: the plan asked for an optional "update available" chip on this page's INSTANCES. The template
// page does not (and cannot cheaply) enumerate the stacks derived from a template — there is no
// list-stacks-by-template endpoint, so surfacing that chip needs a NEW query per instance. Per the D2
// brief ("skip if it needs new queries — note it"), it is deferred. The update signal lives where it is
// cheap: the StackPage's /outdated banner (one call, on the page that can act on it).
//
// D1: the template detail page at /template/:slug (deep-linked from docs-site badges + the catalog).
// Three panes: a rendered README, a variables form (required/default/secret — secret inputs are
// type=password), and a READ-ONLY canvas preview (the C1 StackCanvas fed the template spec — nodes only,
// no live status). "Deploy this stack" collects a name + the variable values, instantiates the template
// (server substitutes vars + runs the same up path), writes the returned write-only secrets, restarts the
// apps that got them, then navigates to the new stack's canvas.
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "../components/Button.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { Field } from "../components/Field.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { TypeBadge } from "../components/badges.tsx";
import { api, orgLabel, templatePreviewGraph, type TemplateDetail, type TemplateVariable } from "../lib/api.ts";
import { validateName } from "../lib/validateName.ts";

const StackCanvas = lazy(() => import("../canvas/StackCanvas.tsx"));

export function TemplatePage({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ["/v1/templates", slug], queryFn: () => api.template(slug) });
  return (
    <div className="page templatepage">
      <Link href="/templates" className="back">
        ← all templates
      </Link>
      {q.isPending ? <Skeleton lines={8} /> : q.isError ? <div className="err">{q.error.message}</div> : <TemplateView t={q.data} />}
    </div>
  );
}

function TemplateView({ t }: { t: TemplateDetail }) {
  const [, navigate] = useLocation();
  const previewGraph = useMemo(() => templatePreviewGraph(t.spec), [t.spec]);

  // Form state — seeded from each variable's default.
  const [name, setName] = useState(t.slug);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(t.variables.filter((v) => v.default != null).map((v) => [v.key, v.default!] as const)),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const missingRequired = t.variables.filter((v) => v.required && !(values[v.key] && values[v.key]!.length > 0));
  const nameErr = validateName(name);
  const canDeploy = !busy && missingRequired.length === 0 && nameErr === null;

  const setVar = (key: string, val: string) => setValues((prev) => ({ ...prev, [key]: val }));

  async function deploy() {
    if (!canDeploy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.instantiate(t.slug, { name, vars: values, version: t.version });
      // Write the write-only secrets the server lifted out of the spec, then roll the apps that got them.
      const restarted = new Set<string>();
      for (const s of res.secretsToSet ?? []) await api.setSecret(s.app, s.key, s.value);
      for (const s of res.secretsToSet ?? []) {
        if (restarted.has(s.app)) continue;
        restarted.add(s.app);
        await api.restartApp(s.app).catch(() => {});
      }
      navigate(`/stack/${encodeURIComponent(res.stack)}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="phead">
        <div className="dname">
          {t.name} <span className={`badge ${t.visibility === "public" ? "badge-site" : "badge-database"}`}>{t.visibility === "public" ? "PUBLIC" : "ORG"}</span>
        </div>
        <div className="downer">
          {t.org && <span title={`org slug: ${t.org.slug}`}>org: {orgLabel(t.org)} · </span>}
          v{t.version} · {Object.keys(t.spec.resources).length} resources · <code>drop new {t.slug}</code>
        </div>
        {t.description && <p className="muted">{t.description}</p>}
      </div>

      <div className="template-grid">
        {/* README */}
        <section className="template-readme">
          <h3>Readme</h3>
          {t.readme ? <div className="readme">{renderReadme(t.readme)}</div> : <p className="muted">No readme.</p>}
        </section>

        {/* Deploy form */}
        <section className="template-deploy">
          <h3>Deploy this stack</h3>
          <Field error={name.length > 0 ? nameErr : null}>
            <label className="lbl">stack name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-stack" aria-label="stack name" />
          </Field>

          {t.variables.length > 0 && <div className="lbl vars-head">variables</div>}
          {t.variables.map((v) => (
            <VarInput key={v.key} v={v} value={values[v.key] ?? ""} onChange={(val) => setVar(v.key, val)} />
          ))}

          {err && <div className="err">{err}</div>}
          <Button variant="primary" onClick={deploy} disabled={!canDeploy} loading={busy}>
            Deploy this stack
          </Button>
          {missingRequired.length > 0 && <p className="muted small">fill required variable{missingRequired.length === 1 ? "" : "s"}: {missingRequired.map((v) => v.key).join(", ")}</p>}
        </section>
      </div>

      {/* Read-only canvas preview — nodes only, no live status. */}
      <section className="template-preview">
        <h3>Preview</h3>
        <div className="template-legend">
          {previewGraph.nodes.map((n) => (
            <span key={n.key} className="legend-chip" title={n.siteName}>
              <span className="legend-name">{n.key}</span>
              <TypeBadge t={n.type} />
            </span>
          ))}
        </div>
        <ErrorBoundary resetKey={t.slug}>
          <div className="stack-canvas">
            <Suspense fallback={<div className="spin">loading preview…</div>}>
              <StackCanvas graph={previewGraph} preview />
            </Suspense>
          </div>
        </ErrorBoundary>
      </section>
    </>
  );
}

function VarInput({ v, value, onChange }: { v: TemplateVariable; value: string; onChange: (val: string) => void }) {
  return (
    <Field>
      <label className="lbl">
        {v.key}
        {v.required && <span className="req"> *</span>}
        {v.secret && <span className="badge badge-database vars-secret">SECRET</span>}
      </label>
      {v.description && <p className="muted small">{v.description}</p>}
      <input
        type={v.secret ? "password" : "text"}
        value={value}
        placeholder={v.default != null ? `default: ${v.default}` : v.required ? "required" : ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label={v.key}
      />
    </Field>
  );
}

/** Tiny, dependency-free README renderer: `#`/`##`/`###` headings, `- ` bullets, blank-line paragraphs.
 *  Renders TEXT nodes only (never dangerouslySetInnerHTML) — no markup injection from a template author. */
function renderReadme(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let bullets: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(<p key={out.length}>{para.join(" ")}</p>);
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length) out.push(<ul key={out.length}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushBullets();
      const level = h[1]!.length;
      const txt = h[2]!;
      out.push(level === 1 ? <h4 key={out.length}>{txt}</h4> : level === 2 ? <h5 key={out.length}>{txt}</h5> : <h6 key={out.length}>{txt}</h6>);
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      bullets.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushPara();
      flushBullets();
    } else {
      flushBullets();
      para.push(line);
    }
  }
  flushPara();
  flushBullets();
  return out;
}
