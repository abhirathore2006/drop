// A Postgres-backed tasks/todo tracker — a plain Node.js + TypeScript (no framework) Drop app that
// reads/writes a managed Drop database. It connects with the standard libpq PG* env vars (PGHOST/
// PGPORT/PGUSER/PGPASSWORD/PGDATABASE) that you map from `drop db:create` + `drop db:password` (see
// examples/DATABASE_APPS.md). CNPG serves a self-signed (operator-CA) TLS cert, so we encrypt in
// transit WITHOUT verifying it — the app and DB share one tenant namespace and are isolated by
// NetworkPolicy. Set PGSSLMODE=disable to turn TLS off entirely.
//
// TypeScript is run directly with `tsx` (no build step) — see the Dockerfile's CMD.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";

const PORT = Number(process.env.PORT || 8080);

const pool = new Pool({
  host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. tasks-db-rw
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "app",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "app",
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
});

interface Task {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

// Create the table (and confirm connectivity) with a retry loop — on first deploy the database may
// still be starting, and after a scale-from-zero the pod reconnects here.
async function init(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        done BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks");
      console.log(`tasks: connected to Postgres (${rows[0].n} existing tasks)`);
      return;
    } catch (e) {
      const err = e as Error;
      if (attempt > 30) throw err;
      console.log(`tasks: DB not ready (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type Filter = "all" | "open" | "done";

function page(tasks: Task[], filter: Filter): string {
  const remaining = tasks.filter((t) => !t.done).length;
  const tab = (key: Filter, label: string): string =>
    `<a class="tab${filter === key ? " on" : ""}" href="/?filter=${key}">${label}</a>`;
  const rows = tasks
    .map(
      (t) => `<li class="${t.done ? "done" : ""}">
        <form method="post" action="/toggle/${t.id}"><button class="chk" title="toggle done">${t.done ? "✓" : ""}</button></form>
        <div class="body">
          <p class="title">${esc(t.title)}</p>
          <time>${new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ")}</time>
        </div>
        <form method="post" action="/delete/${t.id}"><button class="del" title="delete">✕</button></form>
      </li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>tasks · drop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  body{font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;background:#0b0d10;color:#e7e9ea}
  h1{font-size:26px;margin:0 0 4px}.sub{color:#8a9099;margin:0 0 24px;font-size:14px}
  .add{display:flex;gap:8px;margin-bottom:18px}
  .add input{flex:1;padding:11px 13px;border-radius:10px;border:1px solid #2a2f37;background:#11151a;color:inherit;font:inherit}
  .add button{padding:10px 18px;border-radius:10px;border:0;background:#9be15d;color:#0b0d10;font-weight:600;cursor:pointer}
  .tabs{display:flex;gap:6px;margin-bottom:18px}
  .tab{padding:6px 13px;border-radius:999px;border:1px solid #2a2f37;color:#8a9099;text-decoration:none;font-size:14px}
  .tab.on{background:#1c2128;color:#e7e9ea;border-color:#3a414b}
  ul{list-style:none;padding:0;margin:0}
  li{display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px solid #1c2128;border-radius:12px;margin-bottom:10px;background:#11151a}
  li .body{flex:1;min-width:0}
  li .title{margin:0;white-space:pre-wrap;word-break:break-word}
  li time{font-size:12px;color:#8a9099}
  li.done .title{text-decoration:line-through;color:#6b7280}
  .chk{width:24px;height:24px;flex:none;border-radius:7px;border:1px solid #3a414b;background:#0b0d10;color:#9be15d;font-weight:700;cursor:pointer;line-height:1}
  li.done .chk{background:#9be15d;color:#0b0d10;border-color:#9be15d}
  .del{flex:none;border:0;background:none;color:#6b7280;cursor:pointer}
  .del:hover{color:#ef4444}form{margin:0}
  footer{margin-top:24px;color:#6b7280;font-size:13px}
</style></head><body>
  <h1>▸ tasks</h1>
  <p class="sub">${remaining} open · ${tasks.length} shown · a Drop Node + TypeScript app, persisted in a managed Postgres database</p>
  <form class="add" method="post" action="/add">
    <input name="title" placeholder="add a task…" autocomplete="off" maxlength="200">
    <button>add</button>
  </form>
  <div class="tabs">${tab("all", "all")}${tab("open", "open")}${tab("done", "done")}</div>
  <ul>${rows || '<li class="sub">nothing here yet</li>'}</ul>
  <footer>drop · Node + TypeScript (tsx) + pg + managed CNPG database</footer>
</body></html>`;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const parseForm = (b: string): Record<string, string> => Object.fromEntries(new URLSearchParams(b));
const redirect = (res: ServerResponse, location = "/"): void => {
  res.writeHead(303, { location });
  res.end();
};

init().then(() => {
  http
    .createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || "/", "http://x");
        if (url.pathname === "/healthz") return res.end("ok");

        if (req.method === "POST" && url.pathname === "/add") {
          const f = parseForm(await readBody(req));
          const title = (f.title || "").trim().slice(0, 200);
          if (title) await pool.query("INSERT INTO tasks (title) VALUES ($1)", [title]);
          return redirect(res);
        }
        if (req.method === "POST" && url.pathname.startsWith("/toggle/")) {
          const id = Number(url.pathname.split("/")[2]);
          await pool.query("UPDATE tasks SET done = NOT done WHERE id = $1", [id]);
          return redirect(res);
        }
        if (req.method === "POST" && url.pathname.startsWith("/delete/")) {
          const id = Number(url.pathname.split("/")[2]);
          await pool.query("DELETE FROM tasks WHERE id = $1", [id]);
          return redirect(res);
        }

        // list (GET /) with a done filter: ?filter=all|open|done
        const raw = url.searchParams.get("filter");
        const filter: Filter = raw === "open" || raw === "done" ? raw : "all";
        const where = filter === "open" ? "WHERE done = false" : filter === "done" ? "WHERE done = true" : "";
        const { rows } = await pool.query<Task>(
          `SELECT id, title, done, created_at FROM tasks ${where} ORDER BY done ASC, id DESC`,
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(rows, filter));
      } catch (e) {
        const err = e as Error;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`db error: ${err.message}`);
      }
    })
    .listen(PORT, "0.0.0.0", () => console.log(`tasks: listening on :${PORT}`));
});
