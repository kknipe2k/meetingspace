import { describe, expect, it, vi } from 'vitest';

import {
  denyWindowOpen,
  installPermissionHandlers,
  shouldBlockNavigation,
} from '../../electron/window-guards';

/*
 * Audit S6-001 — the main window's navigation policy. The preload exposes the
 * privileged window.api bridge to the top frame, so the frame must never open a
 * child window or navigate to a remote origin. These pure predicates carry the
 * policy; main.ts wires them onto webContents (the thin, coverage-excluded wrapper).
 */
describe('window navigation guards (S6-001)', () => {
  it('denies every window.open / target=_blank', () => {
    expect(denyWindowOpen()).toEqual({ action: 'deny' });
  });

  it('blocks navigation to a different (remote) origin', () => {
    expect(shouldBlockNavigation('https://evil.example/', 'file:///app/index.html')).toBe(true);
    expect(
      shouldBlockNavigation('http://localhost:5173/probe.html', 'http://localhost:5173/'),
    ).toBe(true);
  });

  it('allows a reload of the same URL (dev HMR full-reload)', () => {
    expect(shouldBlockNavigation('file:///app/index.html', 'file:///app/index.html')).toBe(false);
  });
});

/*
 * S9-001 (independent audit 2026-06-17) — deny-by-default web-permission handlers. The app needs no
 * renderer web permissions (screen capture is main-side desktopCapturer, not a renderer grant), so
 * the Electron-hardening baseline is to deny every permission request + check. Pure seam over an
 * injected session-like object; main.ts wires session.defaultSession (the coverage-excluded wrapper).
 * Mutation-verified: flip a handler to grant and these fail.
 */
describe('installPermissionHandlers (S9-001)', () => {
  it('installs a request handler that denies every permission (callback(false))', () => {
    const setPermissionRequestHandler = vi.fn();
    const session = { setPermissionRequestHandler, setPermissionCheckHandler: vi.fn() };

    installPermissionHandlers(session);

    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    const requestHandler = setPermissionRequestHandler.mock.calls[0]?.[0] as (
      wc: unknown,
      perm: string,
      cb: (granted: boolean) => void,
    ) => void;
    const granted = vi.fn();
    requestHandler({}, 'media', granted);
    expect(granted).toHaveBeenCalledWith(false);
  });

  it('installs a check handler that returns false for every permission', () => {
    const setPermissionCheckHandler = vi.fn();
    const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler };

    installPermissionHandlers(session);

    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    const checkHandler = setPermissionCheckHandler.mock.calls[0]?.[0] as () => boolean;
    expect(checkHandler()).toBe(false);
  });
});
