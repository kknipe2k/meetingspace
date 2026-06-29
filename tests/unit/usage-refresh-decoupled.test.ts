import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/*
 * M08.C fan-out grep — the modal-dependent usage-refresh chain is GONE. The counter refreshes off
 * the app-wide `gen:run-ended` event (subscribed in useUsageCounter), so the prop relay through
 * LLMPanel → ChatPanel → GeneratedDocView → useGeneration must leave no residue. A leftover prop is
 * a silent half-removed wire (a missed refresh OR a duplicate). vitest runs from the repo root.
 */
const read = (path: string): string => readFileSync(path, 'utf8');

describe('M08.C — the modal-dependent usage-refresh chain is fully removed', () => {
  it('no renderer source references usageRefreshKey / onGenerationComplete / usageToken', () => {
    const files = [
      'src/components/ChatPanel.tsx',
      'src/components/LLMPanel.tsx',
      'src/components/GeneratedDocView.tsx',
    ];
    for (const file of files) {
      const src = read(file);
      expect(src, `${file} still references usageRefreshKey`).not.toMatch(/usageRefreshKey/);
      expect(src, `${file} still references onGenerationComplete`).not.toMatch(
        /onGenerationComplete/,
      );
      expect(src, `${file} still references usageToken`).not.toMatch(/usageToken/);
    }
  });

  it('useGeneration no longer carries the onComplete generation-refresh option', () => {
    const src = read('src/hooks/useGeneration.ts');
    expect(src).not.toMatch(/onComplete/);
  });
});
