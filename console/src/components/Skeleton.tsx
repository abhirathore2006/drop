/** Loading placeholders. `lines` renders text-shaped bars; `card` renders a card-shaped block. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel skel-line" style={{ width: `${90 - (i % 3) * 18}%` }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true" style={{ marginTop: 28 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skel skel-card" />
      ))}
    </div>
  );
}
