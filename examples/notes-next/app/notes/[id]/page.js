import Link from "next/link";
import { notFound } from "next/navigation";
import { pool, ensureSchema } from "../../../lib/db";
import { updateNote } from "../../actions";

// Detail/edit page for a single note. Always read from the live DB (no static caching).
export const dynamic = "force-dynamic";

export default async function NotePage({ params }) {
  // In Next.js 15 `params` is a Promise — await it before reading the route segment.
  const { id } = await params;
  const noteId = Number(id);

  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT id, body, created_at FROM notes WHERE id = $1",
    [noteId]
  );
  const note = rows[0];
  if (!note) notFound();

  // Bind this note's id so the action runs as updateNote(id, formData) on submit.
  const update = updateNote.bind(null, note.id);

  return (
    <main>
      <p className="back">
        <Link href="/">‹ back to all notes</Link>
      </p>

      <h1>▸ edit note</h1>
      <p className="sub">
        note #{note.id} · created {new Date(note.created_at).toLocaleString()}
      </p>

      <form action={update} className="edit">
        <textarea
          name="body"
          defaultValue={note.body}
          rows={5}
          maxLength={500}
          autoComplete="off"
        />
        <div className="edit-actions">
          <button type="submit">save</button>
          <Link href="/" className="cancel">
            cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
