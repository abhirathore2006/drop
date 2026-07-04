import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Route, Switch, useLocation } from "wouter";
import { Breadcrumbs } from "./components/Breadcrumbs.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { UserMenu } from "./components/UserMenu.tsx";
import { api, type Me, type WorkloadType } from "./lib/api.ts";
import { useDocumentTitle } from "./lib/hooks.ts";
import { consumeReturnTo, sessionExpiry } from "./lib/query.ts";
import { AdminPage } from "./pages/AdminPage.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { LoginGate } from "./pages/LoginGate.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { StackPage } from "./pages/StackPage.tsx";
import { StacksPage } from "./pages/StacksPage.tsx";
import { TemplatePage } from "./pages/TemplatePage.tsx";
import { TemplatesPage } from "./pages/TemplatesPage.tsx";
import { WorkloadDetailPage } from "./pages/WorkloadDetailPage.tsx";
import { WorkloadsPage } from "./pages/WorkloadsPage.tsx";

// Route params are raw path segments; names are DNS-safe so this is a no-op in practice,
// but stay correct for anything percent-encoded.
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Sets document.title for routes whose page component doesn't set its own (detail + stack
 *  pages, which this shell owns the framing of). Renders nothing. */
function DocTitle({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

const COLLAPSE_KEY = "drop.console.sidebarCollapsed";

function Shell({ me }: { me: Me }) {
  const [loc] = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapse = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  // ⌘K / Ctrl+K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [loc]);

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <Sidebar
        me={me}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="content">
        <header className="topbar">
          <button className="hamburger" aria-label="menu" onClick={() => setMobileOpen(true)}>
            ☰
          </button>
          <div className="topbar-spacer" />
          <UserMenu me={me} />
        </header>
        <main>
          <Breadcrumbs />
          <ErrorBoundary resetKey={loc}>
            <Switch>
              <Route path="/admin">{me.admin ? <AdminPage me={me} /> : <WorkloadsPage />}</Route>
              <Route path="/stacks">
                <StacksPage />
              </Route>
              <Route path="/templates">
                <TemplatesPage />
              </Route>
              <Route path="/template/:slug">
                {(p) => (
                  <>
                    <DocTitle title={`${dec(p.slug)} · template · drop`} />
                    <TemplatePage key={p.slug} slug={dec(p.slug)} />
                  </>
                )}
              </Route>
              <Route path="/activity">
                <ActivityPage me={me} />
              </Route>
              <Route path="/settings">
                <SettingsPage />
              </Route>
              <Route path="/site/:name">{(p) => <DetailRoute name={dec(p.name)} type="site" />}</Route>
              <Route path="/app/:name">{(p) => <DetailRoute name={dec(p.name)} type="app" />}</Route>
              <Route path="/database/:name">{(p) => <DetailRoute name={dec(p.name)} type="database" />}</Route>
              <Route path="/bucket/:name">{(p) => <DetailRoute name={dec(p.name)} type="bucket" />}</Route>
              <Route path="/cache/:name">{(p) => <DetailRoute name={dec(p.name)} type="cache" />}</Route>
              <Route path="/auth/:name">{(p) => <DetailRoute name={dec(p.name)} type="auth" />}</Route>
              <Route path="/stack/:name">
                {(p) => (
                  <>
                    <DocTitle title={`${dec(p.name)} · stack · drop`} />
                    <StackPage key={p.name} name={dec(p.name)} />
                  </>
                )}
              </Route>
              <Route>
                <WorkloadsPage />
              </Route>
            </Switch>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} me={me} />
    </div>
  );
}

/** A workload detail route: sets the tab title (the detail page itself is owned by another
 *  agent this round, so the title is set here) and renders the page. */
function DetailRoute({ name, type }: { name: string; type: WorkloadType }) {
  return (
    <>
      <DocTitle title={`${name} · ${type} · drop`} />
      <WorkloadDetailPage key={name} name={name} />
    </>
  );
}

export function App() {
  const expired = useSyncExternalStore(sessionExpiry.subscribe, sessionExpiry.getSnapshot, sessionExpiry.getSnapshot);
  // (G3) Poll /v1/me so the sidebar's unread-events badge (me.unresolvedEvents) stays fresh; the
  // response is tiny and the poll pauses on hidden tabs (query.ts sets refetchIntervalInBackground:false).
  const meQ = useQuery({ queryKey: ["/v1/me"], queryFn: api.me, retry: false, staleTime: 20_000, refetchInterval: 30_000 });
  const [loc, navigate] = useLocation();
  const me = meQ.data;

  // After a sign-in round-trip (the server lands on "/"), return to where the user was.
  useEffect(() => {
    if (!me) return;
    const back = consumeReturnTo();
    if (back && back !== loc) navigate(back, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  if (expired) return <LoginGate expired />;
  if (meQ.isError) return <LoginGate />;
  if (!me) return <div className="spin big">loading…</div>;

  return <Shell me={me} />;
}
