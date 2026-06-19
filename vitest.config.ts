import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
  test: {
    globals: true,
    // Node is the default runtime (storage + IPC handler + client suites). The
    // component suites opt into jsdom per-file via `// @vitest-environment jsdom`
    // so the fast Node suites are never slowed by a DOM they don't use.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // A single recursive glob over the whole tests tree (M04.C) — the prior
    // per-directory list silently SKIPPED any dir not enumerated (tests/shared was
    // missing, so models.test.ts never ran). `**/*.test.*` guarantees no directory
    // can be omitted again. The e2e specs live under tests/e2e and run via Playwright
    // (separate config), so exclude them from the vitest run here.
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'electron/window-config.ts',
        'electron/menu.ts',
        'electron/context-menu.ts',
        'electron/window-state.ts',
        'electron/zoom.ts',
        'electron/secure-store.ts',
        'electron/prefs-store.ts',
        // M06.C Node-tested seams (the OS wrappers — printToPDF window, nativeImage codec, save/
        // open dialogs, app.relaunch — live in main.ts, which is excluded):
        'electron/pdf-export.ts',
        'electron/thumbnails.ts',
        'electron/backup.ts',
        // M06.E top-level seams (the OS wrappers — dialog/shell, app.getPath('logs') — live in
        // main.ts, which is excluded). logger.ts is a Hard-Rule §10 surface (key redaction).
        'electron/about.ts',
        'electron/logger.ts',
        'electron/llm/**/*.ts',
        'electron/gen/**/*.ts',
        'electron/storage/**/*.ts',
        'electron/ipc/**/*.ts',
        'shared/**/*.ts',
        'src/**/*.{ts,tsx}',
      ],
      // Excluded as documented OS-call / bootstrap wrappers (CLAUDE.md §5):
      // - app-paths.ts imports Electron `app` (not loadable under Node).
      // - main.tsx / main.ts are entrypoints (createRoot / app.whenReady).
      // - preload.ts is the contextBridge wrapper; its pure mapping lives in
      //   the Node-tested electron/ipc/session-bridge.ts.
      // - global.d.ts is type-only (erased).
      // - shared/fonts/font-data.ts is generated base64 woff2 (no logic) — ADR-0013.
      //   (M04.D: export screenshot acquisition reads RAW bytes — the confined file read +
      //   the save-dialog write are thin wrappers in main.ts (not in `include`); the pure
      //   collectRawImages orchestration in electron/gen/raw-images.ts IS Node-unit-tested.)
      exclude: [
        'electron/storage/app-paths.ts',
        'src/main.tsx',
        'src/global.d.ts',
        'shared/fonts/font-data.ts',
      ],
      thresholds: { lines: 80 },
    },
  },
});
