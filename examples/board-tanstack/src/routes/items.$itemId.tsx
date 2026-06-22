// Detail page for one item. The loader fetches it by id via a GET server function; a 404-ish
// notFound state renders when the row is gone. Includes a delete action that navigates back to
// the board. File name `items.$itemId.tsx` maps to the path /items/:itemId.
import { createFileRoute, useRouter, Link, useNavigate } from '@tanstack/react-router'
import { fetchItem, removeItem } from '../items.functions'

export const Route = createFileRoute('/items/$itemId')({
  component: ItemDetail,
  loader: async ({ params }) => await fetchItem({ data: { id: Number(params.itemId) } }),
})

function ItemDetail() {
  const item = Route.useLoaderData()
  const { itemId } = Route.useParams()
  const router = useRouter()
  const navigate = useNavigate()

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

  async function onDelete() {
    await removeItem({ data: { id: item!.id } })
    await router.invalidate()
    await navigate({ to: '/' })
  }

  return (
    <main>
      <h1>
        <Link to="/">▸ board</Link>
      </h1>
      <p className="sub">item #{item.id}</p>

      <ul>
        <li>
          <div className="title">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </div>
          {item.url && <div className="urlline sub">{item.url}</div>}
          <div className="meta">
            created {new Date(item.created_at).toISOString().slice(0, 16).replace('T', ' ')}
          </div>
          <div className="actions">
            <Link to="/items/$itemId/edit" params={{ itemId: String(item.id) }} className="btn ghost">
              edit
            </Link>
            <button type="button" className="danger" onClick={onDelete}>
              delete
            </button>
          </div>
        </li>
      </ul>

      <footer>
        <Link to="/">← back to board</Link>
      </footer>
    </main>
  )
}
