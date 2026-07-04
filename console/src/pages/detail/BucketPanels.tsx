// Tenant object-storage (bucket) detail panel: connection info (endpoint/bucket/prefix),
// size + object count, and credential rotation (revealed once). No object browser v1 —
// that's an app's job, not the platform's. Force-delete lives in the shared danger zone.
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { KV } from "../../components/Field.tsx";
import { RevealOnce } from "../../components/RevealOnce.tsx";
import { api, type Detail } from "../../lib/api.ts";
import { cap, denyReason } from "../../lib/caps.ts";
import { useWorkloadAction } from "./useWorkloadAction.ts";

/** Human-readable binary-SI size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function BucketPanels({ d }: { d: Detail }) {
  const b = d.bucket;
  // The just-rotated credentials, shown ONCE via RevealOnce; the API never returns them again.
  const [rotated, setRotated] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const rotate = useWorkloadAction({ onSuccess: () => setConfirmRotate(false) });
  const canRotate = cap(d, "configure"); // credential rotation is `configure`-gated (like db password)

  return (
    <div className="sec">
      <h3>object storage</h3>
      {b ? (
        <>
          <KV label="endpoint">{b.endpoint ? <CopyField value={b.endpoint} /> : <span className="sub">AWS default</span>}</KV>
          <KV label="bucket">
            <CopyField value={b.bucket} />
          </KV>
          <KV label="prefix">
            <CopyField value={b.prefix} />
          </KV>
          <KV label="size">
            {fmtBytes(b.bytes)} · {b.objects} object{b.objects === 1 ? "" : "s"}
          </KV>
        </>
      ) : (
        <KV label="storage">
          <span className="sub">unavailable</span>
        </KV>
      )}
      <KV label="credentials">
        {rotated ? (
          <RevealOnce
            value={`S3_ACCESS_KEY_ID=${rotated.accessKeyId}\nS3_SECRET_ACCESS_KEY=${rotated.secretAccessKey}`}
            note="shown once — store both now. redeploy apps bound to this bucket to pick up the new key."
            onDismiss={() => setRotated(null)}
          />
        ) : (
          <>
            <Button size="sm" loading={rotate.isPending} disabled={!canRotate} title={canRotate ? undefined : denyReason("configure")} onClick={() => setConfirmRotate(true)}>
              rotate credentials
            </Button>
              <ConfirmDialog
                open={confirmRotate}
                title="Rotate bucket credentials"
                body={
                  <>
                    Re-mint the access credentials for <b>{d.name}</b>? The new key is shown once; apps must be redeployed to pick it up.
                  </>
                }
                confirmLabel="rotate credentials"
                busy={rotate.isPending}
                onCancel={() => setConfirmRotate(false)}
                onConfirm={() =>
                  rotate.mutate(async () => {
                    const r = await api.rotateBucket(d.name);
                    setRotated({ accessKeyId: r.accessKeyId, secretAccessKey: r.secretAccessKey });
                  })
                }
              />
            </>
          )}
        </KV>
    </div>
  );
}
