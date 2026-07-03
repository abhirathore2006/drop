import type { ReactNode } from "react";

export function EmptyState({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {title && <p>{title}</p>}
      {children && <p className="muted">{children}</p>}
    </div>
  );
}
