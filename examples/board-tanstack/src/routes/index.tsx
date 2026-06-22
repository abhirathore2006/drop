// The board: list every item (newest first) + an inline "add link" form + per-item edit/delete.
// The loader calls the GET server function to render the list on the server (SSR); mutations call
// POST server functions and then `router.invalidate()` to refetch the loader and update the UI.
import { useState } from 'react'
import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { fetchItems, addItem, removeItem } from '../items.functions'

export const Route = createFileRoute('/')({
  component: Board,
  loader: async () => await fetchItems(),
})

function Board() {
  const items = Route.useLoaderData()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addItem({ data: { title, url } })
      setTitle('')
      setUrl('')
      await router.invalidate()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id: number) {
    setBusy(true)
    setError(null)
    try {
      await removeItem({ data: { id } })
      await router.invalidate()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>▸ board</h1>
      <p className="sub">
        {items.length} {items.length === 1 ? 'link' : 'links'} · a Drop TanStack Start app,
        persisted in a managed Postgres database
      </p>

      {error && <p className="error">{error}</p>}

      <form className="form" onSubmit={onAdd}>
        <input
          name="title"
          placeholder="title"
          autoComplete="off"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="row">
          <input
            name="url"
            placeholder="https://… (optional)"
            autoComplete="off"
            maxLength={2048}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={busy || !title.trim()}>
            add
          </button>
        </div>
      </form>

      <ul>
        {items.length === 0 && <li className="sub">no links yet — add the first one above</li>}
        {items.map((it) => (
          <li key={it.id}>
            <div className="title">
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer">
                  {it.title}
                </a>
              ) : (
                it.title
              )}
            </div>
            {it.url && <div className="urlline sub">{it.url}</div>}
            <div className="meta">
              {new Date(it.created_at).toISOString().slice(0, 16).replace('T', ' ')}
            </div>
            <div className="actions">
              <Link to="/items/$itemId" params={{ itemId: String(it.id) }} className="btn ghost">
                open
              </Link>
              <Link
                to="/items/$itemId/edit"
                params={{ itemId: String(it.id) }}
                className="btn ghost"
              >
                edit
              </Link>
              <button type="button" className="danger" disabled={busy} onClick={() => onDelete(it.id)}>
                delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <footer>drop · TanStack Start + pg + managed CNPG database</footer>
    </main>
  )
}
