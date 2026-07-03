// Theme management: dark (the original palette) is the default visual character; light is
// opt-in or follows the OS. The persisted *preference* is system | light | dark; the
// resolved theme is stamped on <html data-theme="…"> which tokens.css keys off. Resolving
// in JS (instead of duplicating dark tokens under a media query) keeps the CSS single-source
// and needs no inline <script> — the app renders nothing until main.tsx runs anyway, so
// there is no flash-of-wrong-theme window.

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "drop.console.theme";
const listeners = new Set<() => void>();
let pref: ThemePreference = "system";

function systemTheme(): "light" | "dark" {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark"; // default to the console's native look
  }
}

export function resolvedTheme(p: ThemePreference = pref): "light" | "dark" {
  return p === "system" ? systemTheme() : p;
}

function apply(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  listeners.forEach((l) => l());
}

export function getThemePreference(): ThemePreference {
  return pref;
}

export function setThemePreference(next: ThemePreference): void {
  pref = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable (private mode) — theme still applies for the session */
  }
  apply();
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Call once before first render: restores the persisted preference and follows OS changes. */
export function initTheme(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") pref = stored;
  } catch {
    /* ignore */
  }
  apply();
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (pref === "system") apply();
    });
  } catch {
    /* matchMedia unavailable */
  }
}
