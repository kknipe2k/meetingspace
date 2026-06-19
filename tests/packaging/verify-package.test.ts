import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

/*
 * The pure decision seam of the packaged-bundle verifier (M05.C). The actual asar
 * read + main-bundle read + process.exit in scripts/verify-package.cjs main() is the
 * excluded OS-call wrapper (run after `electron-builder --dir`); the predicate that
 * decides "is this a safe, complete shipped bundle?" is testable against fixture
 * entry lists. Mirrors the e2e-complete-guard seam/wrapper split.
 *
 * What it guards:
 *  - the TEST-ONLY entry (renderer/probe.html, permissive CSP) is NOT in the bundle;
 *  - the production entries (index.html + main.js) ARE in the bundle;
 *  - the bundled main carries no `dangerouslyAllowBrowser` (renderer key-escape risk).
 */
const require = createRequire(import.meta.url);
const { evaluatePackagedContents } = require('../../scripts/verify-package.cjs') as {
  evaluatePackagedContents: (
    asarEntries: string[],
    bundledMainSource?: string,
  ) => { ok: boolean; problems: string[] };
};

const CLEAN_ENTRIES = ['package.json', 'out/main/main.js', 'out/renderer/index.html'];
const CLEAN_MAIN = 'webPreferences: { contextIsolation: true, sandbox: true }';

describe('evaluatePackagedContents', () => {
  it('passes a clean bundle: production entries present, no probe, no browser-key escape', () => {
    const result = evaluatePackagedContents(CLEAN_ENTRIES, CLEAN_MAIN);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('fails when the test-only probe.html is shipped in the bundle', () => {
    const result = evaluatePackagedContents(
      [...CLEAN_ENTRIES, 'out/renderer/probe.html'],
      CLEAN_MAIN,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/probe\.html/);
    expect(result.problems.join(' ')).toMatch(/test-only/i);
  });

  it('detects probe.html regardless of path separator (Windows asar listings)', () => {
    const result = evaluatePackagedContents(
      ['out\\main\\main.js', 'out\\renderer\\index.html', 'out\\renderer\\probe.html'],
      CLEAN_MAIN,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/probe\.html/);
  });

  it('fails when the production renderer entry (index.html) is missing', () => {
    const result = evaluatePackagedContents(['package.json', 'out/main/main.js'], CLEAN_MAIN);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/index\.html/);
  });

  it('fails when the main-process entry (main.js) is missing', () => {
    const result = evaluatePackagedContents(
      ['package.json', 'out/renderer/index.html'],
      CLEAN_MAIN,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/main\.js/);
  });

  it('fails when the bundled main carries dangerouslyAllowBrowser', () => {
    const result = evaluatePackagedContents(
      CLEAN_ENTRIES,
      'new Anthropic({ apiKey, dangerouslyAllowBrowser: true })',
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/dangerouslyAllowBrowser/);
  });

  it('tolerates a missing main source (entry checks still apply)', () => {
    const result = evaluatePackagedContents(CLEAN_ENTRIES);
    expect(result.ok).toBe(true);
  });
});
