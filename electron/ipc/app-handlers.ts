import { ANTHROPIC_PRICING_URL } from '@shared/links';

import { APP_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * App-level external-navigation handlers (M10.B ext#2, §10). The deny-all window-open policy
 * (electron/window-guards.ts) forbids window.open / target=_blank, so an in-app external link opens
 * through this channel instead. `app:open-pricing-docs` is deliberately ARGUMENT-LESS: the handler
 * calls shell.openExternal on a HARDCODED shared constant and IGNORES anything the untrusted renderer
 * sends — there is no open-arbitrary-URL surface. Pure seam over an { openExternal } dep so the policy
 * is Node-unit-testable; main.ts injects the real Electron shell (the thin, coverage-excluded wrapper).
 */
export interface AppExternalDeps {
  readonly openExternal: (url: string) => void;
}

export function registerAppExternalHandlers(
  registrar: IpcHandleRegistrar,
  deps: AppExternalDeps,
): void {
  // Ignore every renderer-supplied argument — the URL is the hardcoded constant, always.
  registrar.handle(APP_CHANNELS.openPricingDocs, () => deps.openExternal(ANTHROPIC_PRICING_URL));
}
