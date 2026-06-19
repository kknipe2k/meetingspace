import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/*
 * Safety-primitive coverage gate (docs/gates.md M02 — ≥95% line on the storage
 * layer). Runs the storage + IPC suites (which exercise the stores) and measures
 * only electron/storage/** at the higher bar, with the OS-seam app-paths.ts
 * excluded (documented in vitest.config.ts and docs/gates.md). The workspace
 * 80% gate stays in vitest.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/storage/**/*.test.ts', 'tests/ipc/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['electron/storage/**/*.ts'],
      exclude: ['electron/storage/app-paths.ts'],
      thresholds: { lines: 95 },
    },
  },
});
