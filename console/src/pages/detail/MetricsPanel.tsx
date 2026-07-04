// (G2 / G2b) Traffic + uptime panel — NUMBERS ONLY in v1 (M4 replaces the totals with a sparkline and
// the uptime line with a 24h strip). Uptime comes straight off the detail response (d.uptime); the
// traffic totals are a small extra fetch of the 1h window. Rendered for site/app/database — the types
// that see edge traffic and are uptime-probed.
import { useQuery } from "@tanstack/react-query";
import { KV } from "../../components/Field.tsx";
import { api, type Detail } from "../../lib/api.ts";

function fmtBytes(n: number): string {
  const k = 1024;
  if (n < k) return `${n} B`;
  if (n < k * k) return `${(n / k).toFixed(1)} KiB`;
  if (n < k * k * k) return `${(n / (k * k)).toFixed(1)} MiB`;
  return `${(n / (k * k * k)).toFixed(1)} GiB`;
}

/** "99.8% (24h) · 45ms" — or a plain-language fallback when there's no data yet. */
function uptimeLine(u: NonNullable<Detail["uptime"]>): string {
  if (u.last24hPct == null) return "no checks yet";
  const latency = u.lastCheck ? ` · ${u.lastCheck.latencyMs}ms` : "";
  const down = u.lastCheck && !u.lastCheck.ok ? " · last check DOWN" : "";
  return `${u.last24hPct}% (24h)${latency}${down}`;
}

export function MetricsPanel({ d }: { d: Detail }) {
  const q = useQuery({ queryKey: ["/v1/sites", d.name, "metrics"], queryFn: () => api.metrics(d.name, "1h") });
  const t = q.data?.totals;
  const errPct = t && t.requests > 0 ? `${((t.errors / t.requests) * 100).toFixed(1)}% (${t.errors})` : "—";
  return (
    <div className="sec">
      <h3>traffic &amp; uptime</h3>
      {d.uptime && <KV label="uptime">{uptimeLine(d.uptime)}</KV>}
      {q.isLoading && <p className="muted">loading…</p>}
      {q.isError && <div className="err">{(q.error as Error).message}</div>}
      {t && (
        <>
          <KV label="requests (1h)">{t.requests}</KV>
          <KV label="p50 · p95">
            {t.p50}ms · {t.p95}ms
          </KV>
          <KV label="errors (1h)">{errPct}</KV>
          <KV label="bytes out (1h)">{fmtBytes(t.bytesOut)}</KV>
          {t.requests === 0 && <div className="sub">no traffic in the last hour · charts land in M4</div>}
        </>
      )}
    </div>
  );
}
