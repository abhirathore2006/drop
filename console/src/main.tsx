import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { queryClient } from "./lib/query.ts";
import { initTheme } from "./lib/theme.ts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

// Resolve the persisted theme before first render — no inline script needed (CSP-clean):
// nothing paints until this module runs.
initTheme();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
