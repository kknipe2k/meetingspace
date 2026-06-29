import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/*
 * Safety-primitive coverage gate (docs/gates.md — ≥95% line). Runs the suites that
 * exercise each measured primitive and measures only the safety-primitive set:
 *   - electron/storage/** (M02 — the SQLite + blob layer), OS-seam app-paths.ts excluded.
 *   - electron/gen/assembly.ts + electron/gen/normalize-html.ts (M08 — the white-paper
 *     HTML validation/normalization seams; ADR-0026). The parse5 `parse()` catch in
 *     normalize-html.ts is a documented exclusion (v8-ignored inline): parse5 does not
 *     throw on string input, so the branch is defensive-only (gates.md M08 baseline).
 * The workspace 80% gate stays in vitest.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/storage/**/*.test.ts',
      'tests/ipc/**/*.test.ts',
      'tests/gen/assembly.test.ts',
      'tests/gen/normalize-html.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: [
        'electron/storage/**/*.ts',
        'electron/gen/assembly.ts',
        'electron/gen/normalize-html.ts',
      ],
      exclude: ['electron/storage/app-paths.ts'],
      thresholds: { lines: 95, perFile: true },
    },
  },
});
