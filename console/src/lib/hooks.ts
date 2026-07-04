import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getThemePreference, setThemePreference, subscribeTheme, type ThemePreference } from "./theme.ts";

/** Debounce a fast-changing value (filter inputs) so query keys don't churn per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Set document.title for the mounted route and restore it on unmount. The convention is
 *  "<page> · drop" (e.g. "stacks · drop"). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/** Close an open popover on an outside click or Escape. `onClose` fires only while `open`. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

export function useThemePreference(): readonly [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference);
  return [pref, setThemePreference] as const;
}
