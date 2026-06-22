// A Postgres-backed blog — an Express + EJS Drop app that reads/writes a managed Drop database.
// It connects with the standard libpq PG* env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
// that you map from `drop db:create` + `drop db:password` (see examples/DATABASE_APPS.md). CNPG
// serves a self-signed (operator-CA) TLS cert, so we encrypt in transit WITHOUT verifying it —
// the app and DB share one tenant namespace and are isolated by NetworkPolicy. Set
// PGSSLMODE=disable to turn TLS off entirely.
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8080);

const pool = new Pool({
  host: process.env.PGHOST, // the managed DB's `-rw` Service, e.g. blog-db-rw
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
      await pool.query(`CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM posts");
      console.log(`blog: connected to Postgres (${rows[0].n} existing posts)`);
      return;
    } catch (e) {
      if (attempt > 30) throw e;
      console.log(`blog: DB not ready (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false })); // parse HTML form POST bodies

// Liveness probe — must not touch the DB (used by the platform to know the pod is up).
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

// List — GET /
app.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, body, created_at, updated_at FROM posts ORDER BY id DESC",
    );
    res.render("list", { posts: rows });
  } catch (e) {
    next(e);
  }
});

// New post form — GET /posts/new  (declared before /posts/:id so "new" isn't read as an id)
app.get("/posts/new", (_req, res) => {
  res.render("new", { errors: [], post: { title: "", body: "" } });
});

// Create — POST /posts
app.post("/posts", async (req, res, next) => {
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  const errors = [];
  if (!title) errors.push("Title is required.");
  if (!body) errors.push("Body is required.");
  if (errors.length) {
    return res.status(400).render("new", { errors, post: { title, body } });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO posts (title, body) VALUES ($1, $2) RETURNING id",
      [title, body],
    );
    res.redirect(303, `/posts/${rows[0].id}`);
  } catch (e) {
    next(e);
  }
});

// View one — GET /posts/:id
app.get("/posts/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, body, created_at, updated_at FROM posts WHERE id = $1",
      [Number(req.params.id)],
    );
    if (!rows.length) return res.status(404).render("notfound", { id: req.params.id });
    res.render("post", { post: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Edit form — GET /posts/:id/edit
app.get("/posts/:id/edit", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, title, body FROM posts WHERE id = $1",
      [Number(req.params.id)],
    );
    if (!rows.length) return res.status(404).render("notfound", { id: req.params.id });
    res.render("edit", { errors: [], post: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Update — POST /posts/:id  (HTML forms can't send PUT, so we POST to the resource path)
app.post("/posts/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  const errors = [];
  if (!title) errors.push("Title is required.");
  if (!body) errors.push("Body is required.");
  if (errors.length) {
    return res.status(400).render("edit", { errors, post: { id, title, body } });
  }
  try {
    const { rowCount } = await pool.query(
      "UPDATE posts SET title = $1, body = $2, updated_at = now() WHERE id = $3",
      [title, body, id],
    );
    if (!rowCount) return res.status(404).render("notfound", { id });
    res.redirect(303, `/posts/${id}`);
  } catch (e) {
    next(e);
  }
});

// Delete — POST /posts/:id/delete
app.post("/posts/:id/delete", async (req, res, next) => {
  try {
    await pool.query("DELETE FROM posts WHERE id = $1", [Number(req.params.id)]);
    res.redirect(303, "/");
  } catch (e) {
    next(e);
  }
});

// Centralized error handler (Express recognizes the 4-arg signature).
app.use((err, _req, res, _next) => {
  console.error("blog: request error:", err.message);
  res.status(500).type("text/plain").send(`db error: ${err.message}`);
});

init().then(() => {
  // Bind 0.0.0.0 so the pod is reachable from outside the container, not just localhost.
  app.listen(PORT, "0.0.0.0", () => console.log(`blog: listening on :${PORT}`));
});
