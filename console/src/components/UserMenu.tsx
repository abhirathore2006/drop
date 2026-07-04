// The header's right-side identity menu (M1): who you are, theme, the instance version,
// docs, and logout — a dismissible dropdown replacing the bare email + scattered links.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiExtra } from "../lib/api-extra.ts";
import type { Me } from "../lib/api.ts";
import { useDismiss } from "../lib/hooks.ts";
import { useThemePreference } from "../lib/hooks.ts";

const THEME_ICON = { system: "◐", light: "☀", dark: "☾" } as const;
const THEME_NEXT = { system: "light", light: "dark", dark: "system" } as const;

export function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const [pref, setPref] = useThemePreference();
  const versionQ = useQuery({ queryKey: ["/version"], queryFn: apiExtra.version, staleTime: Infinity, retry: false });

  return (
    <div className="usermenu" ref={ref}>
      <button className="usermenu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="usermenu-avatar" aria-hidden="true">
          {me.email[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="usermenu-email">{me.email}</span>
        <span className="usermenu-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="usermenu-pop" role="menu">
          <div className="usermenu-head">
            <div className="usermenu-email-full">{me.email}</div>
            <div className="sub">{me.admin ? "platform admin" : "member"}</div>
          </div>
          <button className="usermenu-item" role="menuitem" onClick={() => setPref(THEME_NEXT[pref])}>
            <span aria-hidden="true">{THEME_ICON[pref]}</span> theme: {pref}
          </button>
          <a className="usermenu-item" role="menuitem" href="/docs/" target="_blank" rel="noreferrer">
            <span aria-hidden="true">❐</span> docs ↗
          </a>
          <div className="usermenu-sep" />
          <div className="usermenu-version">
            <span className="sub">version</span>
            <code>{versionQ.data?.version ?? "…"}</code>
          </div>
          <a className="usermenu-item danger" role="menuitem" href="/logout">
            <span aria-hidden="true">⏻</span> log out
          </a>
        </div>
      )}
    </div>
  );
}
