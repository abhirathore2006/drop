import Link from "next/link";
import { cookies } from "next/headers";
import { verifyRequest } from "@drop/auth";
import { SESSION_COOKIE } from "../../lib/auth";

// A role-gated admin page. It verifies the session JWT locally (HS256, using the injected
// AUTH_JWT_SECRET) and checks for the app-defined `admin` role — the role/permission arrays are stamped
// into the token by the app-RBAC claims hook (auth.rbac: true). Assign the role once with:
//     INSERT INTO app_roles (name) VALUES ('admin');
//     INSERT INTO app_user_roles (user_id, role_id)
//       SELECT '<user-uuid>', id FROM app_roles WHERE name = 'admin';
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  let session = null;
  try {
    session = token ? await verifyRequest(token) : null; // reads AUTH_JWT_SECRET
  } catch {
    session = null; // expired / bad / missing → treat as signed-out
  }

  if (!session || !session.roles.includes("admin")) {
    return (
      <main>
        <p className="back">
          <Link href="/">‹ back to all notes</Link>
        </p>
        <h1>▸ admin</h1>
        <p className="sub">
          {session ? "you are signed in but lack the admin role" : "you are not signed in"} —{" "}
          <Link href="/login">sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <p className="back">
        <Link href="/">‹ back to all notes</Link>
      </p>
      <h1>▸ admin</h1>
      <p className="sub">
        welcome, {session.user.email || session.user.id} · roles: {session.roles.join(", ") || "none"} ·
        permissions: {session.permissions.join(", ") || "none"}
      </p>
      <ul>
        <li className="body">This page is only reachable by users with the app-defined <code>admin</code> role.</li>
      </ul>
    </main>
  );
}
