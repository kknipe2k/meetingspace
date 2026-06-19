import { join } from 'node:path';

/*
 * The renderer security boundary, isolated as a pure testable seam so the
 * flags can be asserted without booting Electron (CLAUDE.md §5, Hard Rule §4.10).
 * electron/main.ts spreads these into the BrowserWindow's webPreferences; the
 * actual `new BrowserWindow()` OS call is the thin, coverage-excluded wrapper.
 *
 * These flags must never be relaxed (M01.A scope lock; docs/gotchas.md theme).
 */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

/*
 * Window background colors (M06.A; REVIEW-V11 F5). The BrowserWindow paints this before the
 * renderer's first frame; deriving it from `nativeTheme.shouldUseDarkColors` means OS-dark
 * users don't get a white flash before the dark renderer loads. Pure seam; the nativeTheme
 * read happens in the main.ts wrapper.
 */
export const WINDOW_BACKGROUND = {
  light: '#fbfbfd',
  dark: '#1b1b1f',
} as const;

export function backgroundColorForTheme(prefersDark: boolean): string {
  return prefersDark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

export const WINDOW_DEFAULTS = {
  width: 1280,
  height: 800,
  // Lowered 960 → 720 (TD-003) so the window can reach the ~960px responsive-collapse
  // threshold where the assistant panel becomes an overlay drawer (design.md §8). At
  // 960 the threshold was unreachable, which was the TD-003 root cause.
  minWidth: 720,
  minHeight: 640,
} as const;

/*
 * The live BrowserWindow icon path (M06.E IRL fix). electron-builder brands only the
 * PACKAGED .exe/.app (via build/icon.png → .ico/.icns); the runtime BrowserWindow still
 * needs `icon` set explicitly or both `npm run dev` AND the packaged app's taskbar fall
 * back to the default Electron icon. A wrong path SILENTLY falls back, so the two modes
 * are resolved as a pure, testable seam (the main.ts wrapper passes the live Electron
 * values), and the icon ships at the packaged path via electron-builder extraResources
 * (build/icon.png → <resources>/build/icon.png):
 *  - packaged: <process.resourcesPath>/build/icon.png  (extraResources target)
 *  - dev:      <app.getAppPath()>/build/icon.png        (the repo root when unpackaged)
 */
export function resolveAppIconPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'build', 'icon.png')
    : join(opts.appPath, 'build', 'icon.png');
}
