"use client";

import { useState } from "react";
import Link from "next/link";
import { getAuthClient, SESSION_COOKIE } from "../../lib/auth";

// A minimal email/password sign-in against the app's managed auth resource (GoTrue). On success we
// stash the access token in a cookie the server components (e.g. /admin) read back with verifyRequest.
export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      const { access_token } = await getAuthClient().signIn(form.get("email"), form.get("password"));
      document.cookie = `${SESSION_COOKIE}=${access_token}; Path=/; SameSite=Lax`;
      window.location.href = "/admin";
    } catch {
      setError("sign-in failed — check your email and password");
      setBusy(false);
    }
  }

  return (
    <main>
      <p className="back">
        <Link href="/">‹ back to all notes</Link>
      </p>
      <h1>▸ sign in</h1>
      <p className="sub">authenticate against this app's managed auth resource</p>

      <form onSubmit={onSubmit} className="edit">
        <input name="email" type="email" placeholder="you@example.com" autoComplete="username" required />
        <input name="password" type="password" placeholder="password" autoComplete="current-password" required />
        <div className="edit-actions">
          <button type="submit" disabled={busy}>
            {busy ? "signing in…" : "sign in"}
          </button>
        </div>
      </form>
      {error && <p className="muted">{error}</p>}
    </main>
  );
}
