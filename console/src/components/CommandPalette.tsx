// Command palette (⌘K / Ctrl+K). A fuzzy index over the already-cached list queries
// (workloads + stacks) plus verb shortcuts. Built on the Modal primitive (portal, focus
// trap, Esc, focus-restore); arrow/enter navigation is layered on the always-focused input.
// No new dependency — the matcher is lib/fuzzy.ts.
import { useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { pathFor, type Me } from "../lib/api.ts";
import { fuzzyRank } from "../lib/fuzzy.ts";
import { useThemePreference } from "../lib/hooks.ts";
import { newSiteIntent } from "../lib/newSiteIntent.ts";
import { useWorkloadsQuery, useStacksQuery } from "./workloads.tsx";
import { Modal } from "./Modal.tsx";

export interface Command {
  id: string;
  label: string;
  /** Short right-aligned kind/section marker (e.g. "app", "stack", "go"). */
  hint: string;
  run: () => void;
}

/** Presentational palette body: a filter input + a fuzzy-ranked, keyboard-navigable list.
 *  Exported so the keyboard flow can be tested with injected commands. */
export function PaletteBox({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => fuzzyRank(query, commands, (c) => `${c.label} ${c.hint}`).map((r) => r.item), [query, commands]);
  const clampedActive = results.length ? Math.min(active, results.length - 1) : 0;

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (Math.min(a, results.length - 1) + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (Math.min(a, results.length - 1) + results.length - 1) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(clampedActive);
    }
    // Escape is handled by the Modal focus trap.
  };

  return (
    <div className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="jump to a workload, stack, or action…"
        aria-label="command palette filter"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[clampedActive] ? `palette-opt-${results[clampedActive]!.id}` : undefined}
      />
      <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
        {results.length === 0 ? (
          <li className="palette-empty">no matches</li>
        ) : (
          results.map((c, i) => (
            <li
              key={c.id}
              id={`palette-opt-${c.id}`}
              role="option"
              aria-selected={i === clampedActive}
              className={`palette-opt${i === clampedActive ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus on the input
                runAt(i);
              }}
            >
              <span className="palette-opt-label">{c.label}</span>
              <span className="palette-opt-hint">{c.hint}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** Assemble the live command set from cached data + verbs, then render the palette. */
export function CommandPalette({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [pref, setPref] = useThemePreference();
  // Read from cache without polling — the palette shouldn't drive traffic.
  const sitesQ = useWorkloadsQuery(false);
  const stacksQ = useStacksQuery(false);

  const commands = useMemo<Command[]>(() => {
    const withCtx = (href: string) => (search ? `${href}?${search}` : href);
    const goto = (href: string) => () => navigate(href);
    const verbs: Command[] = [
      { id: "go-workloads", label: "go to workloads", hint: "go", run: goto(withCtx("/")) },
      { id: "go-stacks", label: "go to stacks", hint: "go", run: goto(withCtx("/stacks")) },
      { id: "go-templates", label: "go to templates", hint: "go", run: goto(withCtx("/templates")) },
      { id: "go-activity", label: "go to activity", hint: "go", run: goto(withCtx("/activity")) },
      { id: "go-settings", label: "go to settings", hint: "go", run: goto(withCtx("/settings")) },
      {
        id: "new-site",
        label: "new site — publish a folder",
        hint: "action",
        run: () => {
          navigate(withCtx("/"));
          newSiteIntent.request();
        },
      },
      {
        id: "toggle-theme",
        label: "toggle theme",
        hint: "action",
        run: () => setPref(pref === "system" ? "light" : pref === "light" ? "dark" : "system"),
      },
    ];
    if (me.admin) verbs.splice(5, 0, { id: "go-admin", label: "go to admin", hint: "go", run: goto("/admin") });

    const sites: Command[] = (sitesQ.data?.sites ?? []).map((w) => ({
      id: `site-${w.type}-${w.name}`,
      label: w.name,
      hint: w.type,
      run: () => navigate(pathFor(w)),
    }));
    const stacks: Command[] = (stacksQ.data?.stacks ?? []).map((s) => ({
      id: `stack-${s.name}`,
      label: s.name,
      hint: "stack",
      run: () => navigate(`/stack/${encodeURIComponent(s.name)}`),
    }));
    return [...sites, ...stacks, ...verbs];
  }, [sitesQ.data, stacksQ.data, me.admin, navigate, search, pref, setPref]);

  return (
    <Modal open={open} title="command palette" onClose={onClose}>
      <PaletteBox commands={commands} onClose={onClose} />
    </Modal>
  );
}
