import type { WorkloadType } from "../lib/api.ts";
import { deriveStatus, phaseKind, pillClass, type DeriveStatusInput, type NormalizedStatus } from "../lib/status.ts";

const TYPE_LABEL: Record<WorkloadType, string> = { site: "SITE", app: "APP", database: "DB", bucket: "BUCKET", cache: "CACHE" };

export function TypeBadge({ t }: { t: WorkloadType }) {
  return <span className={`badge badge-${t}`}>{TYPE_LABEL[t]}</span>;
}

/** Pill for an already-derived normalized status. */
export function Pill({ s }: { s: NormalizedStatus }) {
  return (
    <span className={pillClass(s.status)} title={s.status}>
      {s.reason}
    </span>
  );
}

/** Status pill over the normalized status contract (server field or client fallback). */
export function StatusPill({ input }: { input: DeriveStatusInput }) {
  return <Pill s={deriveStatus(input)} />;
}

/** Pill for free-text phases (backup phases etc.) mapped onto the same buckets. */
export function PhasePill({ phase }: { phase: string }) {
  return (
    <span className={pillClass(phaseKind(phase))} title={phase}>
      {phase}
    </span>
  );
}
