import { useEffect, useState, useSyncExternalStore } from "react";
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

export function useThemePreference(): readonly [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference);
  return [pref, setThemePreference] as const;
}
