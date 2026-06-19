import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * Dark mode (M06.A; REVIEW-V11 F5). The renderer follows the OS via a pure-CSS
 * `prefers-color-scheme: dark` override of the design tokens (no in-app toggle is in scope) —
 * so OS-dark users no longer get a white app. jsdom does not resolve `@media` against computed
 * style, so this is a structural check on tokens.css: the dark block exists and overrides the
 * core surface/text/border tokens, and the root opts into the dark UA color-scheme. The
 * generated-doc iframe + HTML export keep their own (light) CSS and are unaffected by design.
 */
const TOKENS = readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8');

function darkBlock(): string {
  const start = TOKENS.indexOf('@media (prefers-color-scheme: dark)');
  expect(start).toBeGreaterThanOrEqual(0);
  // The dark block is the brace-balanced region following the media query.
  let depth = 0;
  let end = start;
  for (let i = TOKENS.indexOf('{', start); i < TOKENS.length; i += 1) {
    if (TOKENS[i] === '{') {
      depth += 1;
    } else if (TOKENS[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return TOKENS.slice(start, end + 1);
}

describe('dark mode tokens', () => {
  it('opts the root into the dark UA color-scheme so form controls and scrollbars adapt', () => {
    expect(TOKENS).toMatch(/color-scheme:\s*light dark/);
  });

  it('defines a prefers-color-scheme: dark override block', () => {
    expect(TOKENS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('overrides the core surface, text, and border tokens in the dark block', () => {
    const block = darkBlock();

    for (const token of [
      '--color-bg',
      '--color-surface',
      '--color-surface-raised',
      '--color-text',
      '--color-text-muted',
      '--color-border',
    ]) {
      expect(block).toContain(token);
    }
  });

  it('lets the System preference follow the OS but lets Light/Dark override it (M06.A IRL fix)', () => {
    // The OS-driven (system) dark block must NOT apply when an explicit light/dark choice is set.
    expect(TOKENS).toContain(":root:not([data-theme='light']):not([data-theme='dark'])");
    // Explicit Dark forces the dark palette regardless of the OS.
    expect(TOKENS).toContain(":root[data-theme='dark']");
  });
});
