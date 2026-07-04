// The persistent global frame (M1): org switcher, command-palette launcher, and section
// nav. Collapses to an icon rail on wide viewports (toggle) and becomes an overlay drawer
// on narrow ones. Admin is gated on me.admin (from /v1/me).
import { Link, useLocation, useSearch } from "wouter";
import type { Me } from "../lib/api.ts";
import { OrgSwitcher } from "./OrgSwitcher.tsx";

interface NavItem {
  href: string;
  label: string;
  glyph: string;
  /** Path prefixes that also light this item (so detail pages keep their section active). */
  match: (loc: string) => boolean;
  admin?: boolean;
}

const NAV: NavItem[] = [
  { href: "/stacks", label: "stacks", glyph: "⧉", match: (l) => l === "/stacks" || l.startsWith("/stack/") },
  { href: "/", label: "workloads", glyph: "▦", match: (l) => l === "/" || /^\/(site|app|database|bucket)\//.test(l) },
  { href: "/templates", label: "templates", glyph: "❏", match: (l) => l.startsWith("/templates") || l.startsWith("/template/") },
  { href: "/activity", label: "activity", glyph: "≋", match: (l) => l.startsWith("/activity") },
  { href: "/settings", label: "settings", glyph: "⚙", match: (l) => l.startsWith("/settings") },
  { href: "/admin", label: "admin", glyph: "★", match: (l) => l.startsWith("/admin"), admin: true },
];

interface SidebarProps {
  me: Me;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenPalette: () => void;
}

export function Sidebar({ me, collapsed, onToggleCollapse, mobileOpen, onCloseMobile, onOpenPalette }: SidebarProps) {
  const [loc] = useLocation();
  const search = useSearch(); // preserve ?org context when moving between sections
  const withCtx = (href: string) => (search ? `${href}?${search}` : href);
  const items = NAV.filter((n) => !n.admin || me.admin);

  return (
    <>
      {/* scrim sits behind the drawer on narrow viewports */}
      {mobileOpen && <div className="sidebar-scrim" onClick={onCloseMobile} aria-hidden="true" />}
      <aside className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " open" : ""}`}>
        <Link href={withCtx("/")} className="sidebar-brand" onClick={onCloseMobile}>
          <span className="tri">▸</span>
          <span className="sidebar-brand-text">
            drop <span className="tag">console</span>
          </span>
        </Link>

        <OrgSwitcher collapsed={collapsed} />

        <button className="sidebar-search" onClick={onOpenPalette} title="search (⌘K)">
          <span aria-hidden="true">⌕</span>
          <span className="sidebar-search-text">search</span>
          <kbd className="sidebar-kbd">⌘K</kbd>
        </button>

        <nav className="sidebar-nav" aria-label="sections">
          {items.map((n) => {
            const on = n.match(loc);
            // (G3) The activity item carries the unread badge — OPEN warning/error incidents across the
            // caller's orgs (from /v1/me). Shown as a count pill; on the collapsed rail it's a dot.
            const badge = n.href === "/activity" ? (me.unresolvedEvents ?? 0) : 0;
            return (
              <Link
                key={n.href}
                href={withCtx(n.href)}
                onClick={onCloseMobile}
                className={`sidebar-link${on ? " on" : ""}`}
                aria-current={on ? "page" : undefined}
                title={badge > 0 ? `${n.label} (${badge} unresolved)` : n.label}
              >
                <span className="sidebar-glyph" aria-hidden="true">
                  {n.glyph}
                  {badge > 0 && <span className="sidebar-badge-dot" aria-hidden="true" />}
                </span>
                <span className="sidebar-link-text">{n.label}</span>
                {badge > 0 && (
                  <span className="sidebar-badge" aria-label={`${badge} unresolved events`}>
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <button className="sidebar-collapse" onClick={onToggleCollapse} title={collapsed ? "expand" : "collapse"}>
          <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
          <span className="sidebar-link-text">collapse</span>
        </button>
      </aside>
    </>
  );
}
