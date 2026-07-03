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
    queryCache: new QueryCache({ onError: on401 }),
    mutationCache: new MutationCache({ onError: on401 }),
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
