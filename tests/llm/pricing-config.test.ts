import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CatalogModel } from '@shared/types';

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

/*
 * M10.A — pricing engine v2. loadModels now returns the SEED as the base with the on-disk file
 * merged on top (user overrides win per-id) so a new seed model backfills into an existing file
 * (gap #3). updatePrice persists a user override atomically (temp + rename; a crash mid-swap must
 * never corrupt the file) and mutates the in-memory map IN PLACE so the usage rollup's priceFor
 * closure reprices with no restart. unpricedModels reports catalog ids with no price (prefix-aware).
 */
describe('createPricingConfig — seed-merge backfill (M10.A)', () => {
  it('backfills a seed model absent from an existing file WITHOUT overwriting a user override', () => {
    // A pre-existing file the user hand-edited: only one model present, at a custom rate.
    writeFileSync(
      path,
      JSON.stringify({ models: { 'claude-haiku-4-5': { inputPerMTok: 42, outputPerMTok: 84 } } }),
      'utf8',
    );
    const config = createPricingConfig(path);
    // The user's override still wins for the model present in the file...
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 42, outputPerMTok: 84 });
    // ...and a seed model ABSENT from the file is now priced (backfill — fixes gap #3).
    expect(config.priceFor('claude-opus-4-8')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it('prices claude-sonnet-5 from the seed at the $2/$10 introductory rate', () => {
    const config = createPricingConfig(path);
    expect(config.priceFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
  });

  it('does NOT rewrite an existing file on load (seed-merge is in-memory only — no surprise writes)', () => {
    // A partial, deliberately compact file (missing several seed models incl. sonnet-5).
    const onDisk = '{"models":{"claude-haiku-4-5":{"inputPerMTok":1,"outputPerMTok":5}}}';
    writeFileSync(path, onDisk, 'utf8');
    const config = createPricingConfig(path);
    // The merge backfills in memory...
    expect(config.priceFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    // ...but the on-disk bytes are untouched (A.3 §1: no auto-rewrite of the user's file).
    expect(readFileSync(path, 'utf8')).toBe(onDisk);
  });

  it('falls back to the FULL seed when the file is corrupt (not a partial map)', () => {
    writeFileSync(path, '{ this is not valid json', 'utf8');
    const config = createPricingConfig(path);
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(config.priceFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
  });
});

describe('PricingConfig.updatePrice (M10.A)', () => {
  it('persists a user override and reprices the SAME in-memory closure with no restart', () => {
    const config = createPricingConfig(path);
    // The exact closure the UsageStore holds (usage-store.ts:111 calls priceFor at read time).
    const priceForRef = config.priceFor;
    config.updatePrice('gateway-corp-model', { inputPerMTok: 4, outputPerMTok: 4 });
    // In-place mutation: the held closure reprices immediately — no re-create needed.
    expect(priceForRef('gateway-corp-model')).toEqual({ inputPerMTok: 4, outputPerMTok: 4 });
    // Persisted: a fresh config reads the override back from disk.
    expect(createPricingConfig(path).priceFor('gateway-corp-model')).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 4,
    });
  });

  it('overrides an existing seed price (file wins on the next load)', () => {
    const config = createPricingConfig(path);
    config.updatePrice('claude-haiku-4-5', { inputPerMTok: 9, outputPerMTok: 90 });
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 9, outputPerMTok: 90 });
    expect(createPricingConfig(path).priceFor('claude-haiku-4-5')).toEqual({
      inputPerMTok: 9,
      outputPerMTok: 90,
    });
  });

  it('leaves the original file byte-intact when the atomic rename fails (crash-safe)', () => {
    createPricingConfig(path); // first run seeds the file
    const original = readFileSync(path, 'utf8');
    const failing = createPricingConfig(path, {
      renameSync: () => {
        throw new Error('simulated crash mid-swap');
      },
    });
    expect(() =>
      failing.updatePrice('claude-haiku-4-5', { inputPerMTok: 9, outputPerMTok: 9 }),
    ).toThrow(/simulated crash/);
    // The config file is untouched — no partial/corrupt write.
    expect(readFileSync(path, 'utf8')).toBe(original);
    // No orphaned temp file left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    // The in-memory map rolled back too — the existing seed value is unchanged.
    expect(failing.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it('rolls the in-memory map back to unpriced when a NEW override fails to persist', () => {
    createPricingConfig(path); // seed the file
    const failing = createPricingConfig(path, {
      renameSync: () => {
        throw new Error('simulated crash mid-swap');
      },
    });
    expect(() =>
      failing.updatePrice('gateway-brand-new', { inputPerMTok: 3, outputPerMTok: 3 }),
    ).toThrow(/simulated crash/);
    // A model that had no price before must NOT be left priced in memory after a failed write.
    expect(failing.priceFor('gateway-brand-new')).toBeNull();
  });

  it('rejects a non-finite or negative price and persists nothing', () => {
    const config = createPricingConfig(path);
    expect(() => config.updatePrice('m', { inputPerMTok: -1, outputPerMTok: 1 })).toThrow();
    expect(() => config.updatePrice('m', { inputPerMTok: 1, outputPerMTok: Number.NaN })).toThrow();
    expect(() =>
      config.updatePrice('m', { inputPerMTok: Number.POSITIVE_INFINITY, outputPerMTok: 1 }),
    ).toThrow();
    expect(config.priceFor('m')).toBeNull();
  });
});

/*
 * M10.B ext#2 (§10) — DELETE MEANS DELETE. removePrice drops the entry outright for seed and non-seed
 * alike (priceFor → null; never the seed price). Because loadModels seed-merges on every launch, a
 * deleted SEED id is TOMBSTONED in the file (`removed: string[]`) so it doesn't resurrect on restart;
 * updatePrice clears the tombstone. Atomic temp+rename with an in-memory rollback of BOTH the map and
 * the tombstone set on write failure; mutates the same map the priceFor closure holds (live reprice).
 */
describe('PricingConfig.removePrice (M10.B ext#2 — delete + tombstone)', () => {
  it('removes a NON-seed override → priceFor null and the file no longer lists it', () => {
    const config = createPricingConfig(path);
    config.updatePrice('gateway-corp-model', { inputPerMTok: 7, outputPerMTok: 7 });
    expect(config.priceFor('gateway-corp-model')).toEqual({ inputPerMTok: 7, outputPerMTok: 7 });

    config.removePrice('gateway-corp-model');

    // The override is gone → "cost unknown", never a stale/wrong number.
    expect(config.priceFor('gateway-corp-model')).toBeNull();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { models: Record<string, unknown> };
    expect(onDisk.models['gateway-corp-model']).toBeUndefined();
    // A fresh load agrees — the deleted override is not resurrected.
    expect(createPricingConfig(path).priceFor('gateway-corp-model')).toBeNull();
  });

  it('deletes a SEED model outright (priceFor null, NOT the seed price) and tombstones it', () => {
    const config = createPricingConfig(path);
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });

    config.removePrice('claude-haiku-4-5');

    // Delete means delete — the seed does NOT come back as a fallback price.
    expect(config.priceFor('claude-haiku-4-5')).toBeNull();
    // Persisted as a tombstone (not merely an absent model), so the seed-merge won't resurrect it.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { removed?: string[] };
    expect(onDisk.removed).toContain('claude-haiku-4-5');
  });

  it('keeps a deleted SEED model unpriced across a restart (tombstone survives the seed-merge)', () => {
    createPricingConfig(path).removePrice('claude-haiku-4-5');
    // A fresh config over the SAME file (an app restart) must still see it unpriced.
    expect(createPricingConfig(path).priceFor('claude-haiku-4-5')).toBeNull();
  });

  it('reprices the SAME held closure to null on remove (no restart)', () => {
    const config = createPricingConfig(path);
    const priceForRef = config.priceFor;
    config.removePrice('claude-haiku-4-5');
    expect(priceForRef('claude-haiku-4-5')).toBeNull();
  });

  it('leaves the original file byte-intact AND rolls the map back when the rename fails', () => {
    const seeded = createPricingConfig(path);
    seeded.updatePrice('gateway-corp-model', { inputPerMTok: 7, outputPerMTok: 7 });
    const original = readFileSync(path, 'utf8');

    const failing = createPricingConfig(path, {
      renameSync: () => {
        throw new Error('simulated crash mid-swap');
      },
    });
    expect(() => failing.removePrice('gateway-corp-model')).toThrow(/simulated crash/);

    // The config file is untouched — no partial/corrupt write, no orphan temp.
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    // In-memory rollback: the override the delete tried to drop is still present.
    expect(failing.priceFor('gateway-corp-model')).toEqual({ inputPerMTok: 7, outputPerMTok: 7 });
  });

  it('is an idempotent no-op when the model has no price (non-seed, not tombstoned)', () => {
    const config = createPricingConfig(path);
    expect(() => config.removePrice('never-priced-model')).not.toThrow();
    expect(config.priceFor('never-priced-model')).toBeNull();
  });

  it('rejects an empty or non-string id and persists nothing', () => {
    const config = createPricingConfig(path);
    const before = readFileSync(path, 'utf8');
    // Match the production validation message so a MISSING method (which throws
    // "removePrice is not a function") cannot satisfy this assertion (CLAUDE.md §5).
    expect(() => config.removePrice('')).toThrow(/non-empty string/);
    // @ts-expect-error runtime guard for a non-string id crossing the boundary
    expect(() => config.removePrice(123)).toThrow(/non-empty string/);
    // Nothing persisted — the file is byte-untouched.
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

/*
 * M10.B ext#2 — tombstone lifecycle: a re-set (updatePrice) durably clears the tombstone; a failed
 * write rolls the tombstone set back; old files without `removed` load unchanged; a file override
 * beats a stale tombstone with no rewrite-on-load.
 */
describe('PricingConfig tombstones (M10.B ext#2)', () => {
  it('updatePrice on a tombstoned SEED id re-prices it durably (tombstone cleared on the next load)', () => {
    const config = createPricingConfig(path);
    config.removePrice('claude-haiku-4-5');
    expect(config.priceFor('claude-haiku-4-5')).toBeNull();

    config.updatePrice('claude-haiku-4-5', { inputPerMTok: 3, outputPerMTok: 6 });
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 6 });

    // Survives a restart — the tombstone was cleared and the override persisted.
    expect(createPricingConfig(path).priceFor('claude-haiku-4-5')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 6,
    });
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { removed?: string[] };
    expect(onDisk.removed ?? []).not.toContain('claude-haiku-4-5');
  });

  it('restores the tombstone when a re-price of a tombstoned id fails to persist', () => {
    createPricingConfig(path).removePrice('claude-haiku-4-5'); // tombstone (persisted)

    // A config whose NEXT write fails once, then succeeds.
    let failNext = true;
    const guarded = createPricingConfig(path, {
      renameSync: (from, to) => {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        renameSync(from, to);
      },
    });
    expect(guarded.priceFor('claude-haiku-4-5')).toBeNull(); // loaded tombstoned

    // The re-price fails → rollback must delete the map entry AND re-add the tombstone.
    expect(() =>
      guarded.updatePrice('claude-haiku-4-5', { inputPerMTok: 4, outputPerMTok: 4 }),
    ).toThrow(/boom/);
    expect(guarded.priceFor('claude-haiku-4-5')).toBeNull(); // map rolled back

    // A subsequent SUCCESSFUL write must persist the RESTORED tombstone — a half rollback would
    // drop it, and the seed-merge on reload would wrongly resurrect the seed price.
    guarded.updatePrice('gateway-y', { inputPerMTok: 2, outputPerMTok: 2 });
    const reloaded = createPricingConfig(path);
    expect(reloaded.priceFor('claude-haiku-4-5')).toBeNull();
    expect(reloaded.priceFor('gateway-y')).toEqual({ inputPerMTok: 2, outputPerMTok: 2 });
  });

  it('loads an OLD-format file without `removed` unchanged (old installs stay valid, no rewrite)', () => {
    const onDisk = '{"models":{"claude-haiku-4-5":{"inputPerMTok":1,"outputPerMTok":5}}}';
    writeFileSync(path, onDisk, 'utf8');
    const config = createPricingConfig(path);
    // Backfill still works, existing override preserved.
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(config.priceFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    // No surprise rewrite on load.
    expect(readFileSync(path, 'utf8')).toBe(onDisk);
  });

  it('a file override beats a stale tombstone for the same id (no rewrite on load)', () => {
    const onDisk = JSON.stringify({
      models: { 'claude-haiku-4-5': { inputPerMTok: 8, outputPerMTok: 9 } },
      removed: ['claude-haiku-4-5'],
    });
    writeFileSync(path, onDisk, 'utf8');
    const config = createPricingConfig(path);
    // The explicit price wins — the model is priced, not tombstoned.
    expect(config.priceFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 8, outputPerMTok: 9 });
    expect(readFileSync(path, 'utf8')).toBe(onDisk);
  });
});

describe('PricingConfig.unpricedModels (M10.A)', () => {
  it('returns exactly the catalog ids with no price (a prefix-resolving snapshot is NOT unpriced)', () => {
    const config = createPricingConfig(path);
    const catalog: CatalogModel[] = [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', maxOutputTokens: 64000 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', maxOutputTokens: 128000 },
      // A dated snapshot resolves to its base by prefix → priced, so NOT reported unpriced.
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5 (snapshot)',
        maxOutputTokens: 64000,
      },
      // A corporate gateway id with no seed + no override → unpriced.
      { id: 'gateway-mystery-model', label: 'Gateway Mystery', maxOutputTokens: 8192 },
    ];
    expect(config.unpricedModels(catalog)).toEqual([
      { id: 'gateway-mystery-model', label: 'Gateway Mystery' },
    ]);
  });
});
