// First-run home (M1): shown when the signed-in user has no workloads at all. Two first
// wins — install the instance-configured CLI (the copyable one-liner), or drag a folder to
// publish without it — plus a pointer to the docs.
import type { ReactNode } from "react";
import { CopyField } from "./CopyField.tsx";

/** `curl -fsSL <origin>/install.sh | sh` — /install.sh is served by this instance,
 *  pre-pointed at this origin. Falls back to a placeholder when origin is unavailable. */
function installOneLiner(): string {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://your-drop-instance";
  return `curl -fsSL ${origin}/install.sh | sh`;
}

/** `children` is the no-CLI path — the publish drop zone, owned by the workloads page. */
export function Onboarding({ children }: { children?: ReactNode }) {
  return (
    <section className="onboarding">
      <h1 className="onboarding-title">
        <span className="tri">▸</span> ship your first workload
      </h1>
      <p className="onboarding-lead muted">Two ways in — install the CLI, or drag a folder into the browser. Either works right now.</p>

      <div className="onboarding-steps">
        <div className="onboarding-step">
          <div className="onboarding-step-head">
            <span className="onboarding-num">1</span>
            <h2>install the CLI</h2>
          </div>
          <p className="muted">Run this — it installs <code>drop</code> already pointed at this instance.</p>
          <CopyField value={installOneLiner()} />
          <p className="muted onboarding-hint">
            then: <code>drop deploy ./app</code> · <code>drop db create mydb</code> · <code>drop publish ./site</code>
          </p>
        </div>

        <div className="onboarding-step">
          <div className="onboarding-step-head">
            <span className="onboarding-num">2</span>
            <h2>or drag a folder</h2>
          </div>
          <p className="muted">No CLI needed — drop a built site folder here to publish it live.</p>
          {children}
        </div>
      </div>

      <p className="onboarding-foot muted">
        New to Drop? Read the{" "}
        <a href="/docs/" target="_blank" rel="noreferrer">
          quickstart ↗
        </a>
        . Templates land here once someone runs <code>drop template publish</code>.
      </p>
    </section>
  );
}
