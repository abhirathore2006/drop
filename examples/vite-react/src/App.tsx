import { Routes, Route, Link, useLocation } from "react-router-dom";

function Nav() {
  const { pathname } = useLocation();
  const A = ({ to, children }: { to: string; children: string }) => (
    <Link to={to} className={pathname === to ? "active" : ""}>
      {children}
    </Link>
  );
  return (
    <header>
      <b>⚡ Vite + React</b>
      <nav>
        <A to="/">Home</A>
        <A to="/about">About</A>
        <A to="/dashboard">Dashboard</A>
      </nav>
    </header>
  );
}

const Home = () => (
  <main>
    <h1>Home</h1>
    <p>
      A client-side-routed SPA. Click around, then <b>refresh on any route</b> (e.g.
      <code> /about</code>) — the edge serves <code>index.html</code> (SPA fallback) and React Router
      re-renders the right page. That's the deep-link test.
    </p>
  </main>
);
const About = () => (
  <main>
    <h1>About</h1>
    <p>This route only exists in the browser. Reloading here proves Drop's route-aware SPA fallback.</p>
  </main>
);
const Dashboard = () => (
  <main>
    <h1>Dashboard</h1>
    <p>Another deep route. Missing <i>assets</i> still 404 correctly — only navigations fall back to index.</p>
  </main>
);
const NotFound = () => (
  <main>
    <h1>404</h1>
    <p>Client-side not-found. <Link to="/">Home →</Link></p>
  </main>
);

export default function App() {
  return (
    <>
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <footer>served by drop · vite + react example</footer>
    </>
  );
}
