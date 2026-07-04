import { useRef } from "react";

export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

export interface TabsProps<Id extends string> {
  tabs: Tab<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** Accessible name for the tablist (announced by screen readers). */
  label?: string;
}

/** Tabbed section switcher (M1) with full WAI-ARIA tab semantics (M5): a `role=tablist` of
 *  `role=tab` buttons with `aria-selected`, roving tabindex (only the active tab is in the tab
 *  order), and Left/Right/Home/End arrow-key navigation that activates as it moves. */
export function Tabs<Id extends string>({ tabs, active, onChange, label }: TabsProps<Id>) {
  const listRef = useRef<HTMLDivElement>(null);

  const move = (from: number, delta: number) => {
    const next = (from + delta + tabs.length) % tabs.length;
    onChange(tabs[next]!.id);
    // Follow focus so keyboard users see the roving focus land on the new tab.
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(tabs.length - 1, 0);
    }
  };

  return (
    <div className="tabs adminbar" role="tablist" aria-label={label} ref={listRef}>
      {tabs.map((t, i) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={on ? "navlink on" : "navlink"}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
