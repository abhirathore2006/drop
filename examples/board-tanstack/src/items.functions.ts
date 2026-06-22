// Server functions = the DB layer for the board, callable from route loaders and components as
// type-safe RPCs. The tanstackStart() compiler strips the handlers (and their server-only
// imports, i.e. ./db -> pg) out of the client bundle and replaces each call with a fetch to the
// server. Inputs are validated in `.validator()` before the handler runs.
import { createServerFn } from '@tanstack/react-start'
import { listItems, getItem, createItem, updateItem, deleteItem, type Item } from './db'

// Normalize a posted url: trim, treat empty as null. Bare domains get an https:// prefix so the
// list links are clickable.
function cleanUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s.slice(0, 2048)
  return `https://${s}`.slice(0, 2048)
}

function cleanTitle(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 200)
}

export const fetchItems = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Item[]> => listItems(),
)

export const fetchItem = createServerFn({ method: 'GET' })
  .validator((data: { id: number }) => ({ id: Number(data.id) }))
  .handler(async ({ data }): Promise<Item | null> => getItem(data.id))

export const addItem = createServerFn({ method: 'POST' })
  .validator((data: { title: string; url?: string }) => ({
    title: cleanTitle(data.title),
    url: cleanUrl(data.url),
  }))
  .handler(async ({ data }): Promise<{ id: number }> => {
    if (!data.title) throw new Error('title is required')
    const item = await createItem(data.title, data.url)
    return { id: item.id }
  })

export const editItem = createServerFn({ method: 'POST' })
  .validator((data: { id: number; title: string; url?: string }) => ({
    id: Number(data.id),
    title: cleanTitle(data.title),
    url: cleanUrl(data.url),
  }))
  .handler(async ({ data }): Promise<void> => {
    if (!data.title) throw new Error('title is required')
    await updateItem(data.id, data.title, data.url)
  })

export const removeItem = createServerFn({ method: 'POST' })
  .validator((data: { id: number }) => ({ id: Number(data.id) }))
  .handler(async ({ data }): Promise<void> => {
    await deleteItem(data.id)
  })
