// The document shell. Renders the <html>/<head>/<body> for every page; child routes render into
// <Outlet />. HeadContent injects the route head() meta; Scripts injects the client bundle.
import { Outlet, createRootRoute, HeadContent, Scripts, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
// `?url` gives us the hashed asset path; we link it from <head> so SSR ships styled HTML.
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'board · drop' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <main>
      <h1>
        <Link to="/">▸ board</Link>
      </h1>
      <p className="sub">page not found.</p>
      <Link to="/" className="btn ghost">
        back to board
      </Link>
    </main>
  ),
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
