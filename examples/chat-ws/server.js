// A Postgres-backed live chat room — a plain Node.js (no framework) Drop app that runs BOTH an
// HTTP server (the chat page + /healthz) AND a WebSocket server on the SAME port (8080). The `ws`
// library's WebSocketServer is attached to the http.Server via its 'upgrade' event, so one process
// and one port serve both. Chat messages persist in a managed Drop Postgres and broadcast to every
// connected client in real time. It connects with the standard libpq PG* env vars (PGHOST/PGPORT/
// PGUSER/PGPASSWORD/PGDATABASE) that you map from `drop db:create` + `drop db:password` (see
// examples/DATABASE_APPS.md). CNPG serves a self-signed (operator-CA) TLS cert, so we encrypt in
// transit WITHOUT verifying it — the app and DB share one tenant namespace and are isolated by
// NetworkPolicy. Set PGSSLMODE=disable to turn TLS off entirely.
const http = require("node:http");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);

const pool = new Pool({
  host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. chat-db-rw
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "app",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "app",
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
});

// Create the table (and confirm connectivity) with a retry loop — on first deploy the database
// may still be starting, and after a restart the pod reconnects here.
async function init() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        author TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM messages");
      console.log(`chat: connected to Postgres (${rows[0].n} existing messages)`);
      return;
    } catch (e) {
      if (attempt > 30) throw e;
      console.log(`chat: DB not ready (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── the chat page: inline CSS + a vanilla-JS WebSocket client ──────────────────────────────────
// The client connects back to the SAME origin over ws(s):// (wss when the page is https), renders
// each incoming message, shows a live presence count, and sends on Enter / the Send button.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>chat · drop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:32px auto;padding:0 20px;background:#0b0d10;color:#e7e9ea;display:flex;flex-direction:column;height:calc(100vh - 64px)}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#8a9099;margin:0 0 16px;font-size:14px}
  .sub .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#6b7280;margin-right:6px;vertical-align:middle}
  .sub .dot.on{background:#9be15d}
  #log{flex:1;overflow-y:auto;list-style:none;padding:0;margin:0 0 14px;display:flex;flex-direction:column;gap:8px}
  #log li{padding:10px 13px;border:1px solid #1c2128;border-radius:12px;background:#11151a}
  #log li .meta{font-size:13px;color:#8a9099}
  #log li .meta b{color:#9be15d}#log li .meta time{margin-left:6px}
  #log li p{margin:4px 0 0;white-space:pre-wrap;word-break:break-word}
  #log li.system{background:none;border:0;color:#6b7280;font-size:13px;text-align:center;padding:2px}
  .compose{display:flex;gap:8px}
  .compose input{flex:1;padding:11px 13px;border-radius:10px;border:1px solid #2a2f37;background:#11151a;color:inherit;font:inherit;min-width:0}
  .compose input#name{flex:0 0 120px}
  .compose button{padding:10px 18px;border-radius:10px;border:0;background:#9be15d;color:#0b0d10;font-weight:600;cursor:pointer}
  footer{margin-top:12px;color:#6b7280;font-size:13px}
</style></head><body>
  <h1>▸ chat</h1>
  <p class="sub"><span class="dot" id="dot"></span><span id="presence">connecting…</span> · a Drop WebSocket app, persisted in managed Postgres</p>
  <ul id="log"></ul>
  <form class="compose" id="compose">
    <input id="name" placeholder="your name" autocomplete="off" maxlength="80">
    <input id="body" placeholder="message…" autocomplete="off" maxlength="500" required>
    <button>send</button>
  </form>
  <footer>drop · Node + ws + pg + managed CNPG database</footer>
<script>
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const log = document.getElementById("log");
  const dot = document.getElementById("dot");
  const presence = document.getElementById("presence");
  const nameEl = document.getElementById("name");
  const bodyEl = document.getElementById("body");

  function system(text) {
    const li = document.createElement("li");
    li.className = "system";
    li.textContent = text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function render(m) {
    const li = document.createElement("li");
    const when = m.created_at ? new Date(m.created_at).toISOString().slice(0, 16).replace("T", " ") : "";
    li.innerHTML = '<div class="meta"><b>' + esc(m.author || "anon") + '</b> <time>' + esc(when) + '</time></div><p>' + esc(m.body) + '</p>';
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  let ws;
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/");
    ws.onopen = () => { dot.classList.add("on"); };
    ws.onclose = () => {
      dot.classList.remove("on");
      presence.textContent = "disconnected — reconnecting…";
      setTimeout(connect, 2000); // simple auto-reconnect
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "history") { msg.messages.forEach(render); }
      else if (msg.type === "message") { render(msg); }
      else if (msg.type === "presence") {
        presence.textContent = msg.count + (msg.count === 1 ? " person here" : " people here");
      }
    };
  }
  connect();

  document.getElementById("compose").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = bodyEl.value.trim();
    if (!body || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ author: nameEl.value.trim(), body }));
    bodyEl.value = "";
    bodyEl.focus();
  });
</script>
</body></html>`;

// Track every open client so we can fan-out broadcasts. (Single-pod only — see drop.yaml: a
// multi-pod deployment would need a shared pub/sub, e.g. Postgres LISTEN/NOTIFY or Redis.)
const clients = new Set();

function broadcast(obj) {
  const frame = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(frame);
      } catch {
        // a send race against a closing socket — ignore; 'close' will clean it up
      }
    }
  }
}

const broadcastPresence = () => broadcast({ type: "presence", count: clients.size });

init().then(() => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return res.end("ok");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  // Attach the WebSocket server to the SAME http.Server. `ws` hooks the server's 'upgrade' event,
  // so HTTP requests hit createServer above while `Upgrade: websocket` requests become WS sessions
  // — one process, one port (8080).
  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws) => {
    clients.add(ws);
    broadcastPresence();

    // On connect, replay the last 50 messages (oldest-first) to just this client.
    try {
      const { rows } = await pool.query(
        "SELECT author, body, created_at FROM messages ORDER BY id DESC LIMIT 50",
      );
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "history", messages: rows.reverse() }));
      }
    } catch (e) {
      console.log(`chat: history query failed: ${e.message}`);
    }

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      const author = (msg.author || "anon").toString().trim().slice(0, 80) || "anon";
      const body = (msg.body || "").toString().trim().slice(0, 500);
      if (!body) return;

      // Persist first, then broadcast the stored row. An INSERT failure must NOT crash the process.
      let created_at;
      try {
        const { rows } = await pool.query(
          "INSERT INTO messages (author, body) VALUES ($1, $2) RETURNING created_at",
          [author, body],
        );
        created_at = rows[0].created_at;
      } catch (e) {
        console.log(`chat: insert failed: ${e.message}`);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "message", author: "system", body: "message not saved (db error)", created_at: new Date().toISOString() }));
        }
        return;
      }
      broadcast({ type: "message", author, body, created_at });
    });

    ws.on("close", () => {
      clients.delete(ws);
      broadcastPresence();
    });
    ws.on("error", () => {
      clients.delete(ws);
      broadcastPresence();
    });
  });

  server.listen(PORT, "0.0.0.0", () => console.log(`chat: listening on :${PORT} (http + ws)`));
});
