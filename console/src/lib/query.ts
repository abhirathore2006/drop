// TanStack Query conventions for the console.
//
// - Query keys mirror API paths: ["/v1/sites"], ["/v1/sites", name], ["/v1/apps", name,
//   "secrets"], ["/v1/admin/audit", filters], … — invalidation reads like the API surface.
// - Polling is centralized here: lists every 15 s, detail pages every 5 s, and NEVER while
//   the tab is hidden (refetchIntervalInBackground stays false).
// - 4xx responses never retry (they won't get better); everything else retries twice.
// - Session expiry: any 401 flips the sessionExpired store — App overlays the login gate
//   WITHOUT navigating, so the current location is preserved and restored after sign-in.

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.ts";

export const POLL_LIST_MS = 15_000;
export const POLL_DETAIL_MS = 5_000;

const RETURN_TO_KEY = "drop.console.returnTo";

let expired = false;
const expiryListeners = new Set<() => void>();
export const sessionExpiry = {
  subscribe(fn: () => void): () => void {
    expiryListeners.add(fn);
    return () => {
      expiryListeners.delete(fn);
    };
  },
  getSnapshot(): boolean {
    return expired;
  },
  set(v: boolean): void {
    if (expired === v) return;
    expired = v;
    expiryListeners.forEach((l) => l());
  },
};

// ── Offline / API-down detection (M5) ────────────────────────────────────────────────────────
// A fetch that reaches the server and gets an HTTP status throws an ApiError; a fetch that can't
// reach the server at all (DNS/connection/CORS/offline) rejects with a TypeError. We treat a run
// of transport failures as "the API is unreachable" and surface a global banner; any successful
// query/mutation clears it. AbortErrors (unmounts, cancelled polls) are ignored.
const OFFLINE_STREAK = 2; // consecutive transport failures before we declare offline

let offline = false;
let netFailStreak = 0;
const offlineListeners = new Set<() => void>();

export const networkStatus = {
  subscribe(fn: () => void): () => void {
    offlineListeners.add(fn);
    return () => {
      offlineListeners.delete(fn);
    };
  },
  getSnapshot(): boolean {
    return offline;
  },
  /** Force the flag (the banner's recovery ping clears it; tests drive it directly). */
  set(v: boolean): void {
    if (v) return; // only "recovered → online" is set directly; going offline goes through reportError
    netFailStreak = 0;
    if (offline) {
      offline = false;
      offlineListeners.forEach((l) => l());
    }
  },
};

function isTransportError(err: unknown): boolean {
  if (err instanceof ApiError) return false; // the server answered — not a transport failure
  if (err instanceof DOMException && err.name === "AbortError") return false;
  // fetch() rejects network failures as a TypeError ("Failed to fetch" / "Load failed").
  return err instanceof TypeError;
}

/** Feed every query/mutation outcome here: a transport error advances the offline streak; any
 *  success (or a real HTTP response) clears it. Exported for the recovery ping + unit tests. */
export function reportNetworkResult(err: unknown): void {
  if (err === null) {
    netFailStreak = 0;
    if (offline) {
      offline = false;
      offlineListeners.forEach((l) => l());
    }
    return;
  }
  if (!isTransportError(err)) {
    // A real HTTP response also proves the API is reachable.
    if (!(err instanceof ApiError)) return;
    netFailStreak = 0;
    if (offline) {
      offline = false;
      offlineListeners.forEach((l) => l());
    }
    return;
  }
  netFailStreak += 1;
  if (netFailStreak >= OFFLINE_STREAK && !offline) {
    offline = true;
    offlineListeners.forEach((l) => l());
  }
}

/** Remember where the user was; the login flow lands on "/" (server redirect), and App
 *  navigates back via consumeReturnTo() once /v1/me succeeds again. */
export function rememberLocation(): void {
  try {
    const here = location.pathname + location.search;
    if (here !== "/") sessionStorage.setItem(RETURN_TO_KEY, here);
  } catch {
    /* ignore */
  }
}

export function consumeReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    if (v) sessionStorage.removeItem(RETURN_TO_KEY);
    return v;
  } catch {
    return null;
  }
}

const on401 = (err: unknown): void => {
  if (err instanceof ApiError && err.status === 401) {
    rememberLocation();
    sessionExpiry.set(true);
  }
};

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        on401(err);
        reportNetworkResult(err);
      },
      onSuccess: () => reportNetworkResult(null),
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        on401(err);
        reportNetworkResult(err);
      },
      onSuccess: () => reportNetworkResult(null),
    }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchIntervalInBackground: false, // paused on hidden tabs
        retry: (failureCount, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = makeQueryClient();
