import { describe, expect, it } from 'vitest';

import { CHAT_MODELS, maxOutputTokensFor } from '@shared/models';

/*
 * M07.D item 5/7 — static per-model maxOutputTokens seeds (F22 deferred: no dynamic fetch,
 * just the static ceilings that feed the model-aware GENERATION_MAX_TOKENS cap). Web-verified
 * ceilings: Sonnet 4.6 / Haiku 4.5 = 64000, Opus 4.8 = 128000. An unknown model resolves to
 * null so the cap falls soft to the static 32000.
 */
describe('static maxOutputTokens seeds', () => {
  it('every curated model carries a positive maxOutputTokens', () => {
    for (const model of CHAT_MODELS) {
      expect(model.maxOutputTokens, model.id).toBeTypeOf('number');
      expect(model.maxOutputTokens as number).toBeGreaterThan(0);
    }
  });

  it('maxOutputTokensFor returns the per-model ceiling for knowns', () => {
    expect(maxOutputTokensFor('claude-sonnet-4-6')).toBe(64000);
    expect(maxOutputTokensFor('claude-haiku-4-5')).toBe(64000);
    expect(maxOutputTokensFor('claude-opus-4-8')).toBe(128000);
  });

  it('matches by prefix (a dated snapshot id still resolves)', () => {
    expect(maxOutputTokensFor('claude-sonnet-4-6-20260101')).toBe(64000);
  });

  it('returns null for an unknown model (cap falls soft to the static 32000)', () => {
    expect(maxOutputTokensFor('claude-some-future-9')).toBeNull();
  });
});
