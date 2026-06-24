import { describe, expect, it, vi } from 'vitest';

import { createModelCatalog, STATIC_CATALOG } from '../../electron/llm/model-catalog';
import type { CatalogModel } from '@shared/types';

/*
 * The dynamic model catalog (ADR-0021; closes F22/TD-012). Lists all current models per active
 * provider via the injected lister (the real one calls client.models.list()), caches with a TTL,
 * and FAILS SOFT to the static list so a dead network never blocks the picker. The model-aware
 * generation cap reads the live ceiling synchronously off the cache.
 */
const LIVE: CatalogModel[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', maxOutputTokens: 128000 },
  { id: 'claude-new-mini', label: 'Claude New Mini', maxOutputTokens: 16000 },
];

function catalogFor(
  listModels: () => Promise<CatalogModel[]>,
  options: { key?: string; ttlMs?: number; now?: () => number } = {},
) {
  return createModelCatalog({
    getContext: () => ({
      key: options.key ?? 'anthropic',
      listModels,
    }),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe('createModelCatalog', () => {
  it('lists the live models from the provider', async () => {
    const lister = vi.fn(() => Promise.resolve(LIVE));
    const catalog = catalogFor(lister);
    expect(await catalog.list()).toEqual(LIVE);
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('caches within the TTL and re-fetches after it (manual refresh forces a fetch)', async () => {
    let t = 1000;
    const lister = vi.fn(() => Promise.resolve(LIVE));
    const catalog = catalogFor(lister, { ttlMs: 100, now: () => t });

    await catalog.list();
    await catalog.list(); // within TTL — served from cache
    expect(lister).toHaveBeenCalledTimes(1);

    t += 200; // past TTL
    await catalog.list();
    expect(lister).toHaveBeenCalledTimes(2);

    await catalog.refresh(); // manual refresh ignores the TTL
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it('fails soft to the static catalog when the lister throws — never empty', async () => {
    const catalog = catalogFor(() =>
      Promise.reject(new Error('offline / gateway has no /v1/models')),
    );
    const models = await catalog.list();
    expect(models).toEqual(STATIC_CATALOG);
    expect(models.length).toBeGreaterThan(0);
  });

  it('falls back to the LAST-KNOWN live list when a later fetch fails', async () => {
    let t = 0;
    let fail = false;
    const catalog = catalogFor(
      () => (fail ? Promise.reject(new Error('blip')) : Promise.resolve(LIVE)),
      { ttlMs: 10, now: () => t },
    );
    await catalog.list(); // populates last-known
    t += 100;
    fail = true;
    expect(await catalog.list()).toEqual(LIVE); // last-known, not the static fallback
  });

  it('cachedMaxTokens reads the live ceiling synchronously; null when not cached/unknown', async () => {
    const catalog = catalogFor(() => Promise.resolve(LIVE));
    expect(catalog.cachedMaxTokens('claude-new-mini')).toBeNull(); // nothing fetched yet
    await catalog.list();
    expect(catalog.cachedMaxTokens('claude-new-mini')).toBe(16000); // live ceiling
    expect(catalog.cachedMaxTokens('totally-unknown')).toBeNull();
  });

  /*
   * S3-001 (independent audit 2026-06-17) — the renderer-supplied model must be validated against
   * the catalog main-side. isKnownModel is the live-aware membership predicate the services use to
   * default an unknown/forged model id; it matches by prefix (a dated snapshot id like
   * claude-haiku-4-5-20251001 still resolves) over the live list when present, else the static floor.
   */
  describe('isKnownModel', () => {
    it('falls back to the STATIC catalog before any live fetch — known iff in the static floor', () => {
      const catalog = catalogFor(() => Promise.resolve(LIVE));
      // Nothing fetched yet → the static catalog is the membership floor.
      expect(catalog.isKnownModel('claude-haiku-4-5')).toBe(true);
      expect(catalog.isKnownModel('claude-new-mini')).toBe(false); // live-only, not fetched yet
      expect(catalog.isKnownModel('totally-forged-model')).toBe(false);
    });

    it('accepts a LIVE-only model once fetched (the dynamic catalog widens the set)', async () => {
      const catalog = catalogFor(() => Promise.resolve(LIVE));
      await catalog.list();
      expect(catalog.isKnownModel('claude-new-mini')).toBe(true); // now in the live list
      expect(catalog.isKnownModel('totally-forged-model')).toBe(false);
    });

    it('uses the active provider fallback before its first fetch', () => {
      const gatewayModels: CatalogModel[] = [
        { id: 'corp-custom-model', label: 'Corp Custom Model', maxOutputTokens: 32000 },
      ];
      const catalog = createModelCatalog({
        getContext: () => ({
          key: 'gateway:https://corp.example',
          fallback: gatewayModels,
          listModels: () => Promise.resolve(gatewayModels),
        }),
      });

      expect(catalog.isKnownModel('corp-custom-model')).toBe(true);
      expect(catalog.isKnownModel('claude-opus-4-8')).toBe(false);
    });

    it('matches a dated snapshot id by prefix', async () => {
      const catalog = catalogFor(() => Promise.resolve(LIVE));
      await catalog.list();
      expect(catalog.isKnownModel('claude-opus-4-8-20260101')).toBe(true);
    });
  });

  it('keeps independent caches for different provider keys', async () => {
    let key = 'anthropic';
    const gatewayModels: CatalogModel[] = [
      { id: 'corp-model', label: 'Corp Model', maxOutputTokens: 32000 },
    ];
    const catalog = createModelCatalog({
      getContext: () => ({
        key,
        listModels: () => Promise.resolve(key === 'anthropic' ? LIVE : gatewayModels),
      }),
    });

    expect(await catalog.list()).toEqual(LIVE);
    key = 'gateway:https://corp.example';
    expect(await catalog.list()).toEqual(gatewayModels);
    key = 'anthropic';
    expect(await catalog.list()).toEqual(LIVE);
  });

  it('rejects an explicit refresh failure so the UI can report it', async () => {
    const catalog = catalogFor(() => Promise.reject(new Error('offline')));
    await expect(catalog.refresh()).rejects.toThrow('offline');
  });
});
