import type { CatalogModel } from '@shared/types';
import { STATIC_CATALOG } from '@shared/models';

/*
 * The dynamic model catalog (M06.D, ADR-0021; closes F22/TD-012). Lists all current models per
 * ACTIVE provider via the injected lister (the real one calls client.models.list() with the active
 * credential + baseURL), caches with a TTL + manual refresh, and FAILS SOFT so a dead network — or
 * a gateway with no /v1/models — never blocks the picker: it returns the last-known live list when
 * present, else the static fallback (never empty). The model-aware generation cap reads the LIVE
 * per-model ceiling synchronously off this cache (cachedMaxTokens), with the static seed as the
 * offline fallback in the caller.
 *
 * The key NEVER leaves main — the lister reads the credential per call and returns only model
 * metadata (no secret on CatalogModel). F29 read-only lock unaffected.
 */
export { STATIC_CATALOG };

type Clock = () => number;

export interface ModelCatalogDeps {
  listModels: () => Promise<CatalogModel[]>;
  now?: Clock;
  ttlMs?: number;
  fallback?: readonly CatalogModel[];
}

export interface ModelCatalog {
  list(): Promise<CatalogModel[]>;
  refresh(): Promise<CatalogModel[]>;
  cachedMaxTokens(model: string): number | null;
  // Main-side membership check (audit S3-001) — is `model` a real catalog id? Matched by prefix
  // (a dated snapshot like claude-haiku-4-5-20251001 resolves) over the live list when present,
  // else the static floor. The services use this to default an unknown/forged renderer-supplied id.
  isKnownModel(model: string): boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — the catalog moves slowly.

export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalog {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const fallback = deps.fallback ?? STATIC_CATALOG;

  // The last successful LIVE fetch (null until one lands). Kept so a later failure degrades to the
  // last-known list rather than the static fallback, and so cachedMaxTokens reads live ceilings.
  let lastKnown: CatalogModel[] | null = null;
  let fetchedAt = -Infinity;

  const fetchLive = async (): Promise<CatalogModel[]> => {
    try {
      const models = await deps.listModels();
      // A successful-but-empty answer is treated like a miss — never blank the picker.
      if (models.length > 0) {
        lastKnown = models;
        fetchedAt = now();
        return models;
      }
    } catch {
      // Offline / gateway without /v1/models — fall through to the soft fallback below.
    }
    return lastKnown ?? [...fallback];
  };

  return {
    async list(): Promise<CatalogModel[]> {
      if (lastKnown !== null && now() - fetchedAt < ttlMs) {
        return lastKnown;
      }
      return fetchLive();
    },
    refresh(): Promise<CatalogModel[]> {
      return fetchLive();
    },
    cachedMaxTokens(model: string): number | null {
      if (lastKnown === null) {
        return null;
      }
      const match = lastKnown.find((m) => model === m.id || model.startsWith(m.id));
      return match ? match.maxOutputTokens : null;
    },
    isKnownModel(model: string): boolean {
      const known = lastKnown ?? fallback;
      return known.some((m) => model === m.id || model.startsWith(m.id));
    },
  };
}
