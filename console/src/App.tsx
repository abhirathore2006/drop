import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { api, type Me } from "./lib/api.ts";
import { useThemePreference } from "./lib/hooks.ts";
import { consumeReturnTo, sessionExpiry } from "./lib/query.ts";
import { AdminPage } from "./pages/AdminPage.tsx";
import { LoginGate } from "./pages/LoginGate.tsx";
import { StackPage } from "./pages/StackPage.tsx";
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

const THEME_ICON = { system: "◐", light: "☀", dark: "☾" } as const;

function Header({ me }: { me: Me }) {
  const [loc] = useLocation();
  const [pref, setPref] = useThemePreference();
  const cycle = () => setPref(pref === "system" ? "light" : pref === "light" ? "dark" : "system");
  return (
    <header>
      <Link href="/" className="brand">
        <span className="tri">▸</span> drop <span className="tag">console</span>
      </Link>
      <nav>
        <Link href="/" className={loc === "/admin" ? "navlink" : "navlink on"}>
          my workloads
        </Link>
        {me.admin && (
          <Link href="/admin" className={loc === "/admin" ? "navlink on" : "navlink"}>
            all tenants
          </Link>
        )}
        <a className="navlink" href="/docs/" target="_blank" rel="noreferrer">
          docs ↗
        </a>
        <button className="theme-toggle" onClick={cycle} title="theme (cycles system → light → dark)">
          {THEME_ICON[pref]} {pref}
        </button>
        <span className="who">{me.email}</span>
        <a className="navlink" href="/logout">
          logout
        </a>
      </nav>
    </header>
  );
}

export function App() {
  const expired = useSyncExternalStore(sessionExpiry.subscribe, sessionExpiry.getSnapshot, sessionExpiry.getSnapshot);
  const meQ = useQuery({ queryKey: ["/v1/me"], queryFn: api.me, retry: false, staleTime: Infinity });
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

  return (
    <div>
      <Header me={me} />
      <main>
        <ErrorBoundary resetKey={loc}>
          <Switch>
            <Route path="/admin">{me.admin ? <AdminPage me={me} /> : <WorkloadsPage />}</Route>
            <Route path="/site/:name">{(p) => <WorkloadDetailPage key={p.name} name={dec(p.name)} me={me} />}</Route>
            <Route path="/app/:name">{(p) => <WorkloadDetailPage key={p.name} name={dec(p.name)} me={me} />}</Route>
            <Route path="/database/:name">{(p) => <WorkloadDetailPage key={p.name} name={dec(p.name)} me={me} />}</Route>
            <Route path="/stack/:name">{(p) => <StackPage key={p.name} name={dec(p.name)} />}</Route>
            <Route>
              <WorkloadsPage />
            </Route>
          </Switch>
        </ErrorBoundary>
      </main>
    </div>
  );
}
