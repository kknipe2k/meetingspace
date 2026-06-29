import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const sharedAlias = { '@shared': resolve(__dirname, 'shared') };

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps `dependencies` (notably the native
    // better-sqlite3 addon) out of the Rollup bundle — they are require()'d
    // from node_modules at runtime instead. Bundling a .node binary breaks it.
    // EXCEPTION (M08.A / ADR-0026): parse5 is ESM-only, so a packaged CommonJS
    // main cannot require() it — it MUST be bundled. Excluding it from
    // externalization makes Rollup inline it into main.js.
    plugins: [externalizeDepsPlugin({ exclude: ['parse5'] })],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      rollupOptions: { output: { entryFileNames: 'main.js' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      rollupOptions: { output: { entryFileNames: 'preload.js' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    resolve: { alias: sharedAlias },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          // The production entry (strict CSP).
          index: resolve(__dirname, 'src/index.html'),
          // Test-only sandbox-probe entry (permissive CSP); main.ts loads it only
          // when sandboxProbeEnabled() — unreachable in a shipped build.
          probe: resolve(__dirname, 'src/probe.html'),
        },
      },
    },
  },
});
