"use server";

import { revalidatePath } from "next/cache";
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
