"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pool, ensureSchema } from "../lib/db";

export async function addNote(formData) {
  const body = String(formData.get("body") || "").trim().slice(0, 500);
  if (body) {
    await ensureSchema();
    await pool.query("INSERT INTO notes (body) VALUES ($1)", [body]);
  }
  revalidatePath("/");
}

export async function deleteNote(formData) {
  await ensureSchema();
  await pool.query("DELETE FROM notes WHERE id = $1", [Number(formData.get("id"))]);
  revalidatePath("/");
}

// Edit an existing note's body. The edit page (app/notes/[id]/page.js) binds the note id with
// `updateNote.bind(null, n.id)`, so Next calls this with (id, formData) when the form submits.
export async function updateNote(id, formData) {
  const noteId = Number(id);
  const body = String(formData.get("body") || "").trim().slice(0, 500);
  if (noteId && body) {
    await ensureSchema();
    await pool.query("UPDATE notes SET body = $1 WHERE id = $2", [body, noteId]);
  }
  revalidatePath("/");
  revalidatePath(`/notes/${noteId}`);
  redirect("/");
}
