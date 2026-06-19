import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import {
  backgroundColorForTheme,
  resolveAppIconPath,
  SECURE_WEB_PREFERENCES,
  WINDOW_BACKGROUND,
} from '../../electron/window-config';

describe('backgroundColorForTheme', () => {
  it('uses the dark surface when the OS prefers dark (no white flash before the renderer paints)', () => {
    expect(backgroundColorForTheme(true)).toBe(WINDOW_BACKGROUND.dark);
  });

  it('uses the light surface when the OS prefers light', () => {
    expect(backgroundColorForTheme(false)).toBe(WINDOW_BACKGROUND.light);
  });
});

describe('renderer security boundary', () => {
  it('isolates the renderer context from the preload/main context', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
  });

  it('keeps Node integration disabled in the renderer', () => {
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  it('runs the renderer in a sandbox', () => {
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
  });
});

describe('resolveAppIconPath (M06.E live window/taskbar icon)', () => {
  it('resolves the packaged icon under resourcesPath/build (the extraResources target)', () => {
    expect(
      resolveAppIconPath({
        isPackaged: true,
        resourcesPath: '/app/resources',
        appPath: '/app/resources/app.asar',
      }),
    ).toBe(join('/app/resources', 'build', 'icon.png'));
  });

  it('resolves the dev icon under the app path (the repo root when unpackaged)', () => {
    expect(
      resolveAppIconPath({
        isPackaged: false,
        resourcesPath: '/electron/dist/resources',
        appPath: '/repo',
      }),
    ).toBe(join('/repo', 'build', 'icon.png'));
  });

  it('does NOT use the asar app path when packaged (the png is unpacked under resources)', () => {
    // Mutation guard: a packaged build that pointed at app.getAppPath() would resolve INTO the
    // asar where build/icon.png does not ship, silently falling back to the Electron icon.
    const packaged = resolveAppIconPath({
      isPackaged: true,
      resourcesPath: '/app/resources',
      appPath: '/app/resources/app.asar',
    });
    expect(packaged).not.toContain('app.asar');
  });
});
