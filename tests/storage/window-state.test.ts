import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrefsStore } from '../../electron/prefs-store';
import {
  intersectsAnyDisplay,
  resolveWindowOptions,
  type DisplayBounds,
  type WindowState,
} from '../../electron/window-state';

/*
 * Window-state persistence (M06.A; REVIEW-V11 F4). Size/pos/maximized round-trip through the
 * (non-secret) PrefsStore, and on restore the saved bounds are validated against the CURRENT
 * displays — a bound that lies off every display drops its x/y so the window snaps back onto
 * the primary display instead of restoring off-screen (the monitor-removed case). The
 * resolve/validate logic is a pure seam; the resize/move/close save wiring is the thin
 * main-process wrapper.
 */
const PRIMARY: DisplayBounds = { x: 0, y: 0, width: 1280, height: 800 };
const DEFAULTS = { width: 1280, height: 800 };

let dir: string;
let prefsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-winstate-'));
  prefsPath = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('window-state persistence', () => {
  it('round-trips a saved window state through prefs', () => {
    const state: WindowState = { width: 1000, height: 700, x: 120, y: 80, maximized: false };
    new PrefsStore(prefsPath).set({ windowState: state });

    expect(new PrefsStore(prefsPath).get().windowState).toEqual(state);
  });

  it('does not disturb unrelated prefs when saving window state', () => {
    const store = new PrefsStore(prefsPath);
    store.set({ chatModel: 'claude-haiku-4-5' });
    store.set({ windowState: { width: 900, height: 600, x: 10, y: 10 } });

    expect(store.get().chatModel).toBe('claude-haiku-4-5');
    expect(store.get().windowState?.width).toBe(900);
  });
});

describe('intersectsAnyDisplay', () => {
  it('is true when the window overlaps a display', () => {
    expect(intersectsAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, [PRIMARY])).toBe(true);
  });

  it('is false when the window lies entirely off every display', () => {
    expect(intersectsAnyDisplay({ x: 5000, y: 5000, width: 800, height: 600 }, [PRIMARY])).toBe(
      false,
    );
  });
});

describe('resolveWindowOptions', () => {
  it('keeps the saved position when it is on a current display', () => {
    const resolved = resolveWindowOptions(
      { width: 1000, height: 700, x: 120, y: 80 },
      [PRIMARY],
      DEFAULTS,
    );

    expect(resolved).toEqual({ width: 1000, height: 700, x: 120, y: 80 });
  });

  it('drops x/y (snaps to primary) when the saved position is off all displays', () => {
    const resolved = resolveWindowOptions(
      { width: 1000, height: 700, x: 5000, y: 5000 },
      [PRIMARY],
      DEFAULTS,
    );

    expect(resolved).toEqual({ width: 1000, height: 700 });
    expect(resolved).not.toHaveProperty('x');
  });

  it('falls back to the default size when no state is saved', () => {
    expect(resolveWindowOptions(undefined, [PRIMARY], DEFAULTS)).toEqual(DEFAULTS);
  });

  it('falls back to the default size when a saved dimension is invalid', () => {
    const resolved = resolveWindowOptions(
      { width: 0, height: -10, x: 100, y: 100 },
      [PRIMARY],
      DEFAULTS,
    );

    expect(resolved.width).toBe(DEFAULTS.width);
    expect(resolved.height).toBe(DEFAULTS.height);
  });

  it('keeps a partially-overlapping position (the window is still reachable)', () => {
    const resolved = resolveWindowOptions(
      { width: 600, height: 400, x: 1200, y: 600 },
      [PRIMARY],
      DEFAULTS,
    );

    expect(resolved.x).toBe(1200);
    expect(resolved.y).toBe(600);
  });
});
