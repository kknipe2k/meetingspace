import type { CatalogModel } from '@shared/types';
import { STATIC_CATALOG } from '@shared/models';

/*
 * Provider-scoped dynamic model catalog. Each provider identity owns an independent cache, so a
 * failed refresh after switching providers can never expose the previous provider's models.
 * Initial list() calls fail soft to that provider's fallback; explicit refresh() calls reject so
 * the renderer can show an honest failure instead of a dead-looking refresh control.
 */
export { STATIC_CATALOG };

type Clock = () => number;

export interface ModelCatalogContext {
  readonly key: string;
  readonly listModels: () => Promise<CatalogModel[]>;
  readonly fallback?: readonly CatalogModel[];
}

export interface ModelCatalogDeps {
  getContext: () => ModelCatalogContext;
  now?: Clock;
  ttlMs?: number;
}

export interface ModelCatalog {
  list(): Promise<CatalogModel[]>;
  refresh(): Promise<CatalogModel[]>;
  cachedMaxTokens(model: string): number | null;
  isKnownModel(model: string): boolean;
}

interface CacheEntry {
  lastKnown: CatalogModel[] | null;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalog {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  const stateFor = (key: string): CacheEntry => {
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const created = { lastKnown: null, fetchedAt: -Infinity };
    cache.set(key, created);
    return created;
  };

  const fetchLive = async (
    context: ModelCatalogContext,
    failSoft: boolean,
  ): Promise<CatalogModel[]> => {
    const state = stateFor(context.key);
    try {
      const models = await context.listModels();
      if (models.length === 0) {
        throw new Error('The provider returned an empty model catalog.');
      }
      state.lastKnown = models;
      state.fetchedAt = now();
      return models;
    } catch (error) {
      if (!failSoft) {
        throw error;
      }
      return state.lastKnown ?? [...(context.fallback ?? STATIC_CATALOG)];
    }
  };

  return {
    async list(): Promise<CatalogModel[]> {
      const context = deps.getContext();
      const state = stateFor(context.key);
      if (state.lastKnown !== null && now() - state.fetchedAt < ttlMs) {
        return state.lastKnown;
      }
      return fetchLive(context, true);
    },
    refresh(): Promise<CatalogModel[]> {
      return fetchLive(deps.getContext(), false);
    },
    cachedMaxTokens(model: string): number | null {
      const context = deps.getContext();
      const known = stateFor(context.key).lastKnown;
      if (known === null) {
        return null;
      }
      const match = known.find(
        (candidate) => model === candidate.id || model.startsWith(candidate.id),
      );
      return match ? match.maxOutputTokens : null;
    },
    isKnownModel(model: string): boolean {
      const context = deps.getContext();
      const known = stateFor(context.key).lastKnown ?? context.fallback ?? STATIC_CATALOG;
      return known.some((candidate) => model === candidate.id || model.startsWith(candidate.id));
    },
  };
}
