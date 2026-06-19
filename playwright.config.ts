import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // Always-on (not CI-only): a committed `.only` runs a single test and would
  // otherwise report green — the exact partial-run-as-full vector behind M04 D-02.
  forbidOnly: true,
  // CI retries absorb genuinely non-deterministic flake — chiefly the GPU-compositor paint checks
  // (artifact-paint.spec): headless CI can transiently blank a sandbox="" iframe screenshot that is
  // NOT the real bug (that spec's own caveat — owner IRL is the acceptance gate). A persistent blank
  // still fails every attempt. Local stays at 0 so flake is visible during development.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // `list` for humans + `json` for the completeness guard (scripts/e2e-complete-guard.cjs,
  // run after `playwright test` in the `e2e` npm script) to confirm the WHOLE suite ran.
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  timeout: 30_000,
  // Visual-regression tolerance (docs/gates.md M02). A small per-pixel-ratio
  // budget absorbs sub-pixel font anti-aliasing differences between the local
  // Windows machine where the baseline is captured (after the human visual
  // review) and the windows-latest CI runner that re-checks it.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
