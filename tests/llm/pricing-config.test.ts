import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPricingConfig } from '../../electron/llm/pricing-config';

/*
 * Config-driven pricing (ADR-0021). Pricing lives in an UPDATABLE data file the app reads —
 * editable without a code change. Cost is shown when the model's price is known, "cost unknown"
 * (null) otherwise. NO hardcoded prices in components — the config is the single source.
 */
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-pricing-'));
  path = join(dir, 'pricing.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createPricingConfig', () => {
  it('seeds the default pricing file on first run and prices the seeded models', () => {
    const config = createPricingConfig(path);
    // The seed reflects the current web-verified prices (Sonnet 4.6 = $3 / $15).
    expect(config.priceFor('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    // First read seeds the file so the user can edit it without a code change.
    expect(() => readFileSync(path, 'utf8')).not.toThrow();
  });

  it('returns null for an unknown model (→ "cost unknown", never a wrong number)', () => {
    const config = createPricingConfig(path);
    expect(config.priceFor('gateway-mystery-model')).toBeNull();
  });

  it('matches a dated snapshot id by prefix', () => {
    const config = createPricingConfig(path);
    expect(config.priceFor('claude-haiku-4-5-20251001')).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
  });

  it('reads user-edited prices from the file (editable without a release)', () => {
    writeFileSync(
      path,
      JSON.stringify({ models: { 'claude-sonnet-4-6': { inputPerMTok: 99, outputPerMTok: 199 } } }),
      'utf8',
    );
    const config = createPricingConfig(path);
    expect(config.priceFor('claude-sonnet-4-6')).toEqual({ inputPerMTok: 99, outputPerMTok: 199 });
  });

  it('exposes priced entries with labels for the settings display', () => {
    const config = createPricingConfig(path);
    const entries = config.entries();
    expect(entries.length).toBeGreaterThan(0);
    const sonnet = entries.find((e) => e.model === 'claude-sonnet-4-6');
    expect(sonnet).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(typeof sonnet?.label).toBe('string');
  });
});
