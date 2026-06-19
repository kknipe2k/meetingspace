import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE,
  FOCUS_PROMPT,
  MINUTES_PROMPT,
  SEED_TEMPLATE_ID,
  WHITEPAPER_PROMPT,
} from '../../electron/gen/prompt-templates';

/*
 * The shipped two-part prompt (M04.A), app-adapted from the product owner's
 * agentic-CLI original. The load-bearing translation: every Claude-Code
 * file-reading artifact is stripped (there is no Read tool — the main process
 * assembles the corpus and sends it inline), while the FOCUS document's
 * structural mandates (Section A Analysis / Section B Implementation) and Part
 * 2's self-contained-HTML mandate are preserved (memory m04-whitepaper-generation).
 */

// The agentic-CLI machinery that MUST NOT survive into the app-API prompt.
const AGENTIC_TOKENS = [
  'read tool',
  'offset',
  'working directory',
  'pdf pages',
  'focus-document.md',
  'proxy idle timeout',
];

describe('app-adapted two-part prompt', () => {
  it('strips every agentic-CLI token from the FOCUS prompt', () => {
    const lower = FOCUS_PROMPT.toLowerCase();
    for (const token of AGENTIC_TOKENS) {
      expect(lower).not.toContain(token);
    }
  });

  it('strips every agentic-CLI token from the white-paper prompt', () => {
    const lower = WHITEPAPER_PROMPT.toLowerCase();
    for (const token of AGENTIC_TOKENS) {
      expect(lower).not.toContain(token);
    }
  });

  it('preserves the FOCUS document structure markers (Section A Analysis, Section B Implementation)', () => {
    expect(FOCUS_PROMPT).toContain('A: Analysis');
    expect(FOCUS_PROMPT).toContain('B: Implementation');
  });

  it('preserves Part 2 self-contained-HTML + illustration mandates (exercised in Stage B)', () => {
    const lower = WHITEPAPER_PROMPT.toLowerCase();
    expect(lower).toContain('self-contained');
    expect(lower).toContain('html');
    expect(lower).toContain('illustration');
  });

  it('instructs the model NOT to add external font links (M04.C: fonts are app-provided)', () => {
    // Fonts are self-hosted as base64 @font-face and external <link>s are stripped by
    // the sanitizer (ADR-0013), so the prompts must stop requesting a Google-Fonts
    // <link> — otherwise the model wastes tokens emitting a tag that gets removed.
    for (const prompt of [WHITEPAPER_PROMPT, MINUTES_PROMPT]) {
      const lower = prompt.toLowerCase();
      expect(lower).toContain('do not add external font');
      expect(lower).not.toContain('google fonts');
      expect(lower).not.toContain('googleapis');
    }
  });

  it('exposes the immutable default seed template carrying both prompt parts', () => {
    expect(DEFAULT_TEMPLATE.id).toBe(SEED_TEMPLATE_ID);
    expect(DEFAULT_TEMPLATE.isDefault).toBe(true);
    expect(DEFAULT_TEMPLATE.focusPrompt).toBe(FOCUS_PROMPT);
    expect(DEFAULT_TEMPLATE.whitepaperPrompt).toBe(WHITEPAPER_PROMPT);
  });
});
