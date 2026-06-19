/*
 * Window navigation guards (audit finding S6-001). The preload exposes the
 * privileged `window.api` IPC bridge to the top frame, so that frame must never
 * spawn a child window or navigate to a remote origin — either would hand the
 * bridge to content the app doesn't control. These are pure policy predicates;
 * the BrowserWindow wiring in `main.ts` (the thin, coverage-excluded OS wrapper)
 * applies them via `setWindowOpenHandler` and the `will-navigate` event.
 *
 * No live vector exists today (untrusted HTML is confined to the sandbox="" iframe,
 * notes render as escaped React text, CSP is default-src 'self') — this is the
 * standard Electron hardening seatbelt, applied before distribution.
 */
export type WindowOpenAction = { readonly action: 'deny' };

/** Deny every `window.open` / `target="_blank"` — the app never opens child windows. */
export function denyWindowOpen(): WindowOpenAction {
  return { action: 'deny' };
}

/**
 * Block any navigation that leaves the app's current page. The app is a single
 * loaded SPA: the only legitimate `will-navigate` is a reload of the same URL
 * (e.g. a dev HMR full-reload). Anything else — a remote/external origin — is
 * denied so it can never inherit the privileged preload bridge.
 */
export function shouldBlockNavigation(targetUrl: string, currentUrl: string): boolean {
  return targetUrl !== currentUrl;
}

/*
 * Deny-by-default web-permission handlers (audit S9-001). The renderer needs NO web permissions —
 * screen capture is a main-side `desktopCapturer` call, not a renderer grant — so the Electron
 * hardening baseline is to deny every permission request AND every permission check on the app
 * session. This is the standard seatbelt: the renderer is trusted UI under a strict CSP and the
 * untrusted-HTML iframe is sandbox="" (which cannot request permissions anyway), so there is no live
 * vector today — but a future feature or regression that triggers a permission request is denied by
 * default rather than silently granted. Pure seam over a session-like object; main.ts wires the real
 * `session.defaultSession` (the thin, coverage-excluded OS wrapper).
 */
export interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
}

export function installPermissionHandlers(session: PermissionSessionLike): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
