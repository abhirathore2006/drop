// A Postgres-backed guestbook — a plain Node.js (no framework) Drop app that reads/writes a
// managed Drop database. It connects with the standard libpq PG* env vars (PGHOST/PGPORT/
// PGUSER/PGPASSWORD/PGDATABASE) that you map from `drop db:create` + `drop db:password` (see
// examples/DATABASE_APPS.md). CNPG serves a self-signed (operator-CA) TLS cert, so we encrypt
// in transit WITHOUT verifying it — the app and DB share one tenant namespace and are isolated
// by NetworkPolicy. Set PGSSLMODE=disable to turn TLS off entirely.
const http = require("node:http");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8080);

const pool = new Pool({
  host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. guestbook-db-rw
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "app",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "app",
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
});

// Create the table (and confirm connectivity) with a retry loop — on first deploy the database
// may still be starting, and after a scale-from-zero the pod reconnects here.
async function init() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM entries");
      console.log(`guestbook: connected to Postgres (${rows[0].n} existing entries)`);
      return;
    } catch (e) {
      if (attempt > 30) throw e;
      console.log(`guestbook: DB not ready (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(entries) {
  const rows = entries
    .map(
      (e) => `<li>
        <div class="meta"><b>${esc(e.name)}</b> <time>${new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ")}</time></div>
        <p>${esc(e.message)}</p>
        <form method="post" action="/delete/${e.id}"><button class="del" title="delete">✕</button></form>
      </li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>guestbook · drop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  body{font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;background:#0b0d10;color:#e7e9ea}
  h1{font-size:26px;margin:0 0 4px}.sub{color:#8a9099;margin:0 0 24px;font-size:14px}
  .add{display:flex;flex-direction:column;gap:8px;margin-bottom:24px}
  .add input,.add textarea{padding:11px 13px;border-radius:10px;border:1px solid #2a2f37;background:#11151a;color:inherit;font:inherit}
  .add textarea{min-height:64px;resize:vertical}
  .add button{align-self:flex-start;padding:10px 18px;border-radius:10px;border:0;background:#9be15d;color:#0b0d10;font-weight:600;cursor:pointer}
  ul{list-style:none;padding:0;margin:0}
  li{position:relative;padding:13px 15px;border:1px solid #1c2128;border-radius:12px;margin-bottom:10px;background:#11151a}
  li .meta{font-size:13px;color:#8a9099}li .meta time{margin-left:6px}
  li p{margin:6px 0 0;white-space:pre-wrap}
  .del{position:absolute;top:10px;right:10px;border:0;background:none;color:#6b7280;cursor:pointer}
  .del:hover{color:#ef4444}form{margin:0}
  footer{margin-top:24px;color:#6b7280;font-size:13px}
</style></head><body>
  <h1>▸ guestbook</h1>
  <p class="sub">${entries.length} entries · a Drop Node app, persisted in a managed Postgres database</p>
  <form class="add" method="post" action="/add">
    <input name="name" placeholder="your name" autocomplete="off" maxlength="80">
    <textarea name="message" placeholder="leave a message…" maxlength="500"></textarea>
    <button>sign</button>
  </form>
  <ul>${rows || '<li class="sub">no entries yet — be the first to sign</li>'}</ul>
  <footer>drop · Node + pg + managed CNPG database</footer>
</body></html>`;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const parseForm = (b) => Object.fromEntries(new URLSearchParams(b));
const redirect = (res) => {
  res.writeHead(303, { location: "/" });
  res.end();
};

init().then(() => {
  http
    .createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://x");
        if (url.pathname === "/healthz") return res.end("ok");
        if (req.method === "POST" && url.pathname === "/add") {
          const f = parseForm(await readBody(req));
          const name = (f.name || "anon").trim().slice(0, 80) || "anon";
          const message = (f.message || "").trim().slice(0, 500);
          if (message) await pool.query("INSERT INTO entries (name, message) VALUES ($1, $2)", [name, message]);
          return redirect(res);
        }
        if (req.method === "POST" && url.pathname.startsWith("/delete/")) {
          await pool.query("DELETE FROM entries WHERE id = $1", [Number(url.pathname.split("/")[2])]);
          return redirect(res);
        }
        const { rows } = await pool.query("SELECT id, name, message, created_at FROM entries ORDER BY id DESC");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(rows));
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`db error: ${e.message}`);
      }
    })
    .listen(PORT, () => console.log(`guestbook: listening on :${PORT}`));
});
