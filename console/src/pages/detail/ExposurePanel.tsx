// TCP (L4) exposure panel (A2b) — shown on app + database detail pages. Shows the current exposure
// (mode/protocol/port + a copyable connect string) or, when not exposed, a simple mode/protocol
// picker to turn it on. Unexpose is guarded by a ConfirmDialog. Follows the existing panel patterns
// (DbPanels/BucketPanels): reuses Button/ConfirmDialog/CopyField/KV + useWorkloadAction.
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { KV } from "../../components/Field.tsx";
import { api, type Detail } from "../../lib/api.ts";
import { useWorkloadAction } from "./useWorkloadAction.ts";

export function ExposurePanel({ d, canExpose }: { d: Detail; canExpose: boolean }) {
  const tcp = d.tcp;
  const isDb = d.type === "database";
  const [mode, setMode] = useState<"sni" | "port">("sni");
  const [protocol, setProtocol] = useState(isDb ? "postgres" : "tcp");
  const [confirmUnexpose, setConfirmUnexpose] = useState(false);
  const exposeAct = useWorkloadAction({ success: "exposed" });
  const unexposeAct = useWorkloadAction({ onSuccess: () => setConfirmUnexpose(false), success: "unexposed" });

  return (
    <div className="sec">
      <h3>tcp exposure</h3>
      {tcp ? (
        <>
          <KV label="mode">
            {tcp.mode}
            {tcp.port != null ? ` · port ${tcp.port}` : ""}
          </KV>
          <KV label="protocol">{tcp.protocol}</KV>
          <KV label="connect">
            <CopyField value={tcp.connect} />
          </KV>
          {tcp.sslmode && (
            <KV label="tls">
              <span className="sub">{tcp.sslmode}</span>
            </KV>
          )}
          {canExpose && (
            <KV label="manage">
              <Button size="sm" variant="danger" loading={unexposeAct.isPending} onClick={() => setConfirmUnexpose(true)}>
                unexpose
              </Button>
              <ConfirmDialog
                open={confirmUnexpose}
                title={`Unexpose ${d.name}`}
                body={
                  <>
                    Remove TCP exposure for <b>{d.name}</b>? Clients connecting over the L4 plane will lose their path (the workload stays
                    reachable inside the cluster).
                  </>
                }
                confirmLabel="unexpose"
                danger
                busy={unexposeAct.isPending}
                onCancel={() => setConfirmUnexpose(false)}
                onConfirm={() => unexposeAct.mutate(() => api.unexpose(d.name))}
              />
            </KV>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            not exposed — reachable only inside the cluster.
            {d.type === "app" ? " A TCP-exposed app must run with scale.min ≥ 1." : ""}
          </p>
          {canExpose && (
            <div className="item visrow">
              <select className="input" aria-label="mode" value={mode} disabled={exposeAct.isPending} onChange={(e) => setMode(e.target.value as "sni" | "port")}>
                <option value="sni">sni (shared port)</option>
                <option value="port">port (dedicated)</option>
              </select>
              <select className="input" aria-label="protocol" value={protocol} disabled={exposeAct.isPending} onChange={(e) => setProtocol(e.target.value)}>
                <option value="tcp">tcp</option>
                <option value="postgres">postgres</option>
                <option value="redis">redis</option>
              </select>
              <Button size="sm" loading={exposeAct.isPending} onClick={() => exposeAct.mutate(() => api.expose(d.name, mode, protocol))}>
                expose
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
