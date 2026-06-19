import { describe, expect, it } from 'vitest';

import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_GENERATION_MODEL,
  modelLabel,
} from '@shared/models';

/*
 * The model catalog (M03.D; M04.C flips the generation default Opus -> Sonnet 4.6
 * per ADR-0012, which supersedes the generation half of ADR-0008; the chat default
 * Haiku is unchanged). `modelLabel` is the single id->label helper shared by the
 * chat badge and the generation badge (lifted out of ChatPanel so both render the
 * same friendly name).
 */
describe('shared/models', () => {
  it('defaults generation to Sonnet 4.6 (ADR-0012 supersedes ADR-0008)', () => {
    expect(DEFAULT_GENERATION_MODEL).toBe('claude-sonnet-4-6');
  });

  it('leaves the chat default at Haiku 4.5 (unchanged by ADR-0012)', () => {
    expect(DEFAULT_CHAT_MODEL).toBe('claude-haiku-4-5');
  });

  it('the generation default is a real catalog entry', () => {
    expect(CHAT_MODELS.some((option) => option.id === DEFAULT_GENERATION_MODEL)).toBe(true);
  });

  it('modelLabel maps a catalog id to its friendly label', () => {
    expect(modelLabel('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(modelLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
  });

  it('modelLabel matches a dated snapshot by prefix and falls back to the raw id', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelLabel('claude-future-9-9')).toBe('claude-future-9-9');
  });
});
