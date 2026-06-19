import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The env-seam class guard (M05.G / CFG-001) — the load-bearing deliverable.
 *
 * Successive audits kept finding the SAME class one instance at a time: a dev/test
 * process.env seam honored in a packaged build because it wasn't gated
 * !app.isPackaged. This guard closes the class: the ONLY place process.env may be
 * read in electron/ is the gated accessor (electron/dev-env.ts). Any other raw
 * read — the next CFG-00N — fails this test in CI and never ships.
 *
 * If a genuinely always-on packaged env var is ever needed, it is added to the
 * ALLOWLIST below with a one-line rationale — a conscious decision, not a default.
 */
const ELECTRON_ROOT = resolve(__dirname, '../../electron');

// The only files permitted to read process.env directly. Keyed by path relative to
// electron/ (forward-slashed). Each entry carries its rationale.
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'dev-env.ts',
    'the single !app.isPackaged-gated dev/test env accessor — the one place process.env is read',
  ],
]);

const RAW_ENV_READ = /process\.env/;

function tsSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourcesUnder(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function relKey(absPath: string): string {
  return relative(ELECTRON_ROOT, absPath).split(sep).join('/');
}

describe('env-seam class guard: no ungated process.env reads in electron/', () => {
  it('every electron/ source reads env only through the gated dev-env accessor', () => {
    const offenders = tsSourcesUnder(ELECTRON_ROOT)
      .filter((file) => !ALLOWLIST.has(relKey(file)))
      .filter((file) => RAW_ENV_READ.test(readFileSync(file, 'utf8')))
      .map(relKey);

    expect(offenders).toEqual([]);
  });

  it('the scan actually detects a process.env read (matcher + allowlist are load-bearing)', () => {
    // Anti-vacuous self-check: the one allowlisted file MUST contain a real
    // process.env read, proving the matcher works and the allowlist shields a
    // genuine read rather than passing trivially.
    const devEnvPath = join(ELECTRON_ROOT, 'dev-env.ts');
    expect(ALLOWLIST.has(relKey(devEnvPath))).toBe(true);
    expect(RAW_ENV_READ.test(readFileSync(devEnvPath, 'utf8'))).toBe(true);
  });
});
