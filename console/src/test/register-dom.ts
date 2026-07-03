// Registers the happy-dom globals at module-evaluation time. This module MUST be the
// first import of setup.ts (imports run in declaration order) so that libraries which
// sniff `document` at module load — e.g. @testing-library/dom's `screen` — see a DOM.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function register(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export function unregister(): void {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
}

register();
