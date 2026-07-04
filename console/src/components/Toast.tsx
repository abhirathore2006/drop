import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ToastItem {
  id: number;
  kind: "success" | "error";
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastItem["kind"], message: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const apiRef = useMemo<ToastApi>(
    () => ({ success: (m) => push("success", m), error: (m) => push("error", m) }),
    [push],
  );

  return (
    <ToastCtx.Provider value={apiRef}>
      {children}
      {items.length > 0 &&
        createPortal(
          // A polite live region: success toasts announce via role=status; errors escalate to
          // role=alert (assertive) so failures interrupt. aria-live on the region keeps late-added
          // toasts announced even in browsers that don't re-scan role changes.
          <div className="toasts" aria-live="polite" aria-atomic="false">
            {items.map((t) => (
              <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
                <span>{t.message}</span>
                <button aria-label="dismiss" onClick={() => dismiss(t.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
