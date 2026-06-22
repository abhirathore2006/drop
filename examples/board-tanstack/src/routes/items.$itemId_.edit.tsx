// Edit page for one item. Loads current values into a controlled form, submits via the editItem
// POST server function, then invalidates + navigates back to the detail page. File name
// `items.$itemId.edit.tsx` maps to /items/:itemId/edit.
import { useState } from 'react'
import { createFileRoute, useRouter, useNavigate, Link } from '@tanstack/react-router'
import { fetchItem, editItem } from '../items.functions'

export const Route = createFileRoute('/items/$itemId_/edit')({
  component: EditItem,
  loader: async ({ params }) => await fetchItem({ data: { id: Number(params.itemId) } }),
})

function EditItem() {
  const item = Route.useLoaderData()
  const { itemId } = Route.useParams()
  const router = useRouter()
  const navigate = useNavigate()

  const [title, setTitle] = useState(item?.title ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!item) {
    return (
      <main>
        <h1>
          <Link to="/">▸ board</Link>
        </h1>
        <p className="sub">item #{itemId} not found.</p>
        <Link to="/" className="btn ghost">
          back to board
        </Link>
      </main>
    )
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setError(null)
    try {
      await editItem({ data: { id: item!.id, title, url } })
      await router.invalidate()
      await navigate({ to: '/items/$itemId', params: { itemId: String(item!.id) } })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>
        <Link to="/">▸ board</Link>
      </h1>
      <p className="sub">edit item #{item.id}</p>

      {error && <p className="error">{error}</p>}

      <form className="form" onSubmit={onSave}>
        <input
          name="title"
          placeholder="title"
          autoComplete="off"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          name="url"
          placeholder="https://… (optional)"
          autoComplete="off"
          maxLength={2048}
          value={url ?? ''}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={busy || !title.trim()}>
            save
          </button>
          <Link to="/items/$itemId" params={{ itemId: String(item.id) }} className="btn ghost">
            cancel
          </Link>
        </div>
      </form>

      <footer>
        <Link to="/">← back to board</Link>
      </footer>
    </main>
  )
}
