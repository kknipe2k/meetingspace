import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * License resolved to MIT. This pins the release-gate artifacts so "license present"
 * is a test, not a claim: the LICENSE file, the package.json field, the README
 * AI-assistance disclosure, and the README License section (no longer TBD).
 */
const root = resolve(__dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

describe('license presence (MIT)', () => {
  it('ships a LICENSE file containing the MIT license text', () => {
    expect(existsSync(resolve(root, 'LICENSE'))).toBe(true);
    const license = read('LICENSE');
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Permission is hereby granted, free of charge/);
  });

  it('declares the MIT license in package.json (not UNLICENSED)', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string };
    expect(pkg.license).toBe('MIT');
  });

  it('records the AI-assistance disclosure in the README', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/AI assistance/i);
    expect(readme).toMatch(/Claude/);
  });

  it('states MIT (not TBD) in the README License section', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/##\s*License[\s\S]{0,120}MIT/);
    expect(readme).not.toMatch(/##\s*License[\s\S]{0,40}TBD/);
  });
});
