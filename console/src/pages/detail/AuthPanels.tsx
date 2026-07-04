// Managed auth resource (GoTrue) detail panel (K1): the config surface (login URL, bound database,
// enabled providers, signup state, JWT alg + key age), key rotation, and a minimal user-admin panel
// (list / create-with-temp-password / disable / delete). Key MATERIAL is never shown — a created
// user's temp password is the only secret surfaced, and only ONCE via RevealOnce.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { KV, AddRow, validateEmail } from "../../components/Field.tsx";
import { Pill } from "../../components/badges.tsx";
import { RevealOnce } from "../../components/RevealOnce.tsx";
import { api, type AuthUser, type Detail } from "../../lib/api.ts";
import { cap, denyReason } from "../../lib/caps.ts";
import { deriveStatus } from "../../lib/status.ts";
import { useWorkloadAction } from "./useWorkloadAction.ts";

/** Relative age of the last key mint (drives the "rotate your keys" nudge). */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function AuthPanels({ d }: { d: Detail }) {
  const a = d.auth;
  const st = a ? deriveStatus({ type: "auth", status: d.status, authStatus: a.status }) : null;
  const canConfigure = cap(d, "configure");
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotateNote, setRotateNote] = useState<string | null>(null);
  const rotate = useWorkloadAction({ onSuccess: () => setConfirmRotate(false) });

  return (
    <>
      <div className="sec">
        <h3>managed auth (gotrue)</h3>
        {a ? (
          <>
            <KV label="status">{st ? <Pill s={st} /> : "—"}</KV>
            <KV label="login / api base">
              <CopyField value={a.url} />
            </KV>
            <KV label="database">{a.db ?? <span className="sub">—</span>}</KV>
            <KV label="providers">{a.providers.length ? a.providers.join(", ") : <span className="sub">password only</span>}</KV>
            <KV label="signup">
              <span className={a.signup === "open" ? "pill pill-ok" : "pill pill-idle"}>{a.signup}</span>
            </KV>
            <KV label="jwt">
              {a.jwtAlg} · ttl {a.jwtTtl}
            </KV>
            <KV label="signing key">
              minted {ago(a.keyMintedAt)}
              {rotateNote && <div className="sub">{rotateNote}</div>}
            </KV>
            <KV label="rotate keys">
              <Button size="sm" loading={rotate.isPending} disabled={!canConfigure} title={canConfigure ? undefined : denyReason("configure")} onClick={() => setConfirmRotate(true)}>
                rotate signing key
              </Button>
            </KV>
            <p className="muted" style={{ marginTop: 6 }}>
              v1 JWT is <b>HS256</b> (no JWKS): bound apps verify tokens with the shared secret injected as{" "}
              <code>AUTH_JWT_SECRET</code>. Email verification is OFF (no SMTP yet) — password sign-in, admin-created users, and OAuth work; magic
              links / password reset are deferred.
            </p>
            <ConfirmDialog
              open={confirmRotate}
              title="Rotate signing key"
              body={
                <>
                  Re-mint the JWT signing secret for <b>{d.name}</b>? Bound apps are re-injected with the new secret (and the previous one for a grace
                  window) and restarted.
                </>
              }
              confirmLabel="rotate signing key"
              busy={rotate.isPending}
              onCancel={() => setConfirmRotate(false)}
              onConfirm={() =>
                rotate.mutate(async () => {
                  const r = await api.rotateAuthKeys(d.name);
                  setRotateNote(r.grace ? "rotated — previous secret kept verifying during the grace window" : "rotated");
                })
              }
            />
          </>
        ) : (
          <KV label="auth">
            <span className="sub">unavailable</span>
          </KV>
        )}
      </div>
      {canConfigure && <UserAdminPanel d={d} />}
    </>
  );
}

/** The no-SMTP onboarding surface: list / create-with-temp-password / disable / delete end users. */
function UserAdminPanel({ d }: { d: Detail }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["/v1/auths", d.name, "users"],
    queryFn: () => api.authUsers(d.name),
    retry: false,
  });
  const [tempPw, setTempPw] = useState<{ email: string; password: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AuthUser | null>(null);
  const refetch = () => qc.invalidateQueries({ queryKey: ["/v1/auths", d.name, "users"] });
  const create = useWorkloadAction({ onSuccess: refetch });
  const act = useWorkloadAction({ onSuccess: refetch });
  const users = data?.users ?? [];

  return (
    <div className="sec">
      <h3>users</h3>
      {error ? (
        <p className="muted">user admin unavailable — the engine may not be reachable yet.</p>
      ) : isLoading ? (
        <p className="muted">loading…</p>
      ) : users.length === 0 ? (
        <p className="muted">no users yet — create one below (they get a temporary password to sign in with).</p>
      ) : (
        users.map((u) => (
          <div className="item" key={u.id}>
            <div className="meta">
              <b>{u.email ?? u.id}</b>
              <div className="sub">
                {u.id}
                {u.banned_until && u.banned_until !== "" ? " · disabled" : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" disabled={act.isPending} onClick={() => act.mutate(() => api.disableAuthUser(d.name, u.id, !(u.banned_until && u.banned_until !== "")))}>
                {u.banned_until && u.banned_until !== "" ? "enable" : "disable"}
              </Button>
              <Button size="sm" variant="danger" disabled={act.isPending} onClick={() => setConfirmDelete(u)}>
                delete
              </Button>
            </div>
          </div>
        ))
      )}
      {tempPw && (
        <KV label={`temp password for ${tempPw.email}`}>
          <RevealOnce value={tempPw.password} note="shown once — hand it to the user; they sign in with it immediately (no email is sent)." onDismiss={() => setTempPw(null)} />
        </KV>
      )}
      <AddRow
        placeholder="user@example.com"
        cta="create user"
        validate={validateEmail}
        busy={create.isPending}
        onSubmit={(email) =>
          create.mutate(async () => {
            const r = await api.createAuthUser(d.name, email);
            if (r.tempPassword) setTempPw({ email, password: r.tempPassword });
          })
        }
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete user"
        body={
          <>
            Permanently delete <b>{confirmDelete?.email ?? confirmDelete?.id}</b> from this auth resource?
          </>
        }
        confirmLabel="delete user"
        danger
        busy={act.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => act.mutate(() => api.removeAuthUser(d.name, confirmDelete!.id), { onSuccess: () => setConfirmDelete(null) })}
      />
    </div>
  );
}
