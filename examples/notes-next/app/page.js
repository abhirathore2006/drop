import Link from "next/link";
import { pool, ensureSchema } from "../lib/db";
import { addNote, deleteNote } from "./actions";

// Always render from the live database (no static caching of the notes list).
export const dynamic = "force-dynamic";

export default async function Page() {
  await ensureSchema();
  const { rows } = await pool.query("SELECT id, body, created_at FROM notes ORDER BY id DESC");

  return (
    <main>
      <h1>▸ notes</h1>
      <p className="sub">
        {rows.length} {rows.length === 1 ? "note" : "notes"} · a Drop Next.js app, persisted in a managed Postgres database
      </p>

      <form action={addNote} className="add">
        <input name="body" placeholder="write a note…" autoComplete="off" maxLength={500} />
        <button type="submit">add</button>
      </form>

      <ul>
        {rows.map((n) => (
          <li key={n.id}>
            <Link className="body" href={`/notes/${n.id}`} title="edit note">
              {n.body}
            </Link>
            <form action={deleteNote}>
              <input type="hidden" name="id" value={n.id} />
              <button className="del" title="delete">
                ✕
              </button>
            </form>
          </li>
        ))}
        {rows.length === 0 && <li className="muted">no notes yet — add one above</li>}
      </ul>
    </main>
  );
}
