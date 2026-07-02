import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { CatalogModel, ModelPrice, PricingEntry, UnpricedModel } from '@shared/types';
import { CHAT_MODELS, modelLabel } from '@shared/models';

/*
 * Config-driven pricing (M06.D, ADR-0021; v2 at M10.A, ADR-0027). The Models API returns the model
 * list + per-model output ceiling but NOT pricing (verified via the claude-api reference) — so
 * pricing lives in an UPDATABLE data file the app reads (a userData JSON, like prefs/templates).
 * Cost is shown when a model's price is known, "cost unknown" (null) otherwise — never a wrong
 * number. NO hardcoded prices in components: this is the single source, consumed main-side by the
 * usage rollup and surfaced to Settings over `usage:pricing`.
 *
 * M10.A (ADR-0027) makes the map a real feature:
 *  - loadModels returns the SEED as the base with the on-disk file merged on top (user overrides win
 *    per-id), so a new seed model backfills into an existing file — no more file-only-when-present.
 *  - updatePrice writes a user override atomically (temp + rename; a crash mid-swap never corrupts
 *    the file) and mutates the in-memory map IN PLACE so the usage rollup's priceFor closure reprices
 *    with no restart.
 *  - unpricedModels reports catalog ids with no price so Settings can prompt the user to set one.
 */
export type { ModelPrice } from '@shared/types';

// Prompt-cache pricing multipliers (relative to the input price; documented in the claude-api
// reference): cache reads ≈ 0.1×, 5-minute cache writes ≈ 1.25×. The usage rollup applies these
// so the cost reflects real cached-token spend rather than under-counting it.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

export interface PricingConfig {
  priceFor(model: string): ModelPrice | null;
  entries(): PricingEntry[];
  // M10.A (ADR-0027): persist a user override atomically + reprice the live map in place.
  updatePrice(model: string, price: ModelPrice): void;
  // M10.B ext#2 (ADR-0027, §10): DELETE the model's price outright (seed and non-seed → "cost
  // unknown"; never a fallback seed price). A deleted SEED id is tombstoned in the file so the
  // seed-merge on the next launch doesn't resurrect it. Atomic; rolls back BOTH the map and the
  // tombstone set on write failure; mutates the same map the priceFor closure holds (live reprice).
  removePrice(model: string): void;
  // M10.A (ADR-0027): the catalog models with no price (prefix-aware), for the Settings override UI.
  unpricedModels(catalog: readonly CatalogModel[]): UnpricedModel[];
}

// Injectable fs seam (M10.A) so a test can force a write/rename failure and assert the original file
// is left byte-intact. Production uses the fsync-durable atomic writer below.
export interface PricingConfigDeps {
  readonly writeFileSync?: (path: string, data: string) => void;
  readonly renameSync?: (from: string, to: string) => void;
}

interface PricingFile {
  readonly models: Record<string, ModelPrice>;
  // M10.B ext#2: tombstones — ids the user deleted. A deleted SEED id lives here so the seed-merge
  // on the next launch doesn't resurrect it. Optional: an old file without it loads unchanged.
  readonly removed?: readonly string[];
}

// loadModels' return: the merged price map + the tombstone set, held together by createPricingConfig
// so writes persist both and rollback restores both.
interface LoadedPricing {
  readonly models: Record<string, ModelPrice>;
  readonly removed: Set<string>;
}

const DEFAULT_MODELS: Record<string, ModelPrice> = Object.fromEntries(
  CHAT_MODELS.map((m) => [m.id, { inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok }]),
);

function isModelPrice(value: unknown): value is ModelPrice {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelPrice).inputPerMTok === 'number' &&
    typeof (value as ModelPrice).outputPerMTok === 'number'
  );
}

// Load the pricing map: the SEED as the base with the on-disk file merged on top (user entries win
// per-id), so a new seed model is priced for everyone on next launch and a user override is
// preserved. M10.B ext#2: an optional `removed` tombstone list deletes ids the user removed — a
// deleted SEED that the seed-merge would otherwise resurrect stays gone (a file override for the
// same id beats a stale tombstone). A corrupt/partial file falls back to the full seed (no
// tombstones) rather than throwing (a bad price config must never break chat or generation). The
// merge is IN-MEMORY only — an existing file is never rewritten on load (no surprise writes).
function loadModels(filePath: string): LoadedPricing {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PricingFile;
      const fileModels = parsed?.models;
      if (fileModels && typeof fileModels === 'object') {
        const out: Record<string, ModelPrice> = {};
        for (const [id, price] of Object.entries(fileModels)) {
          if (isModelPrice(price)) {
            out[id] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
          }
        }
        // Tombstones: strings only; absent → none (an old-format file loads exactly as before).
        const removed = new Set<string>(
          Array.isArray(parsed.removed)
            ? parsed.removed.filter((id): id is string => typeof id === 'string')
            : [],
        );
        // Seed base + file overrides (file wins) — backfills new seed models, keeps user edits.
        const models: Record<string, ModelPrice> = { ...DEFAULT_MODELS, ...out };
        // Honor tombstones: drop any tombstoned id NOT explicitly priced in the file. An explicit
        // file price beats a stale tombstone — clear it in memory so a later write drops it too.
        for (const id of [...removed]) {
          if (Object.prototype.hasOwnProperty.call(out, id)) {
            removed.delete(id);
          } else {
            delete models[id];
          }
        }
        return { models, removed };
      }
    } catch {
      // Fall through to the seed — a corrupt config must not break the app.
    }
    return { models: { ...DEFAULT_MODELS }, removed: new Set() };
  }
  // First run: seed the file so the user has an editable starting point.
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ models: DEFAULT_MODELS }, null, 2), 'utf8');
  } catch {
    // A read-only userData dir is non-fatal — pricing still works from the in-memory seed.
  }
  return { models: { ...DEFAULT_MODELS }, removed: new Set() };
}

// Durable write: write to the fd, fsync, close — so the bytes are on stable storage before the
// caller renames over the real file. Paired with the temp+rename in `persist` for an atomic swap.
function defaultWriteFileSync(path: string, data: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createPricingConfig(filePath: string, deps: PricingConfigDeps = {}): PricingConfig {
  const writeFile = deps.writeFileSync ?? defaultWriteFileSync;
  const rename = deps.renameSync ?? renameSync;
  const { models, removed } = loadModels(filePath);

  // Match an exact id first, then by prefix (so a dated snapshot id — e.g.
  // claude-haiku-4-5-20251001 — still resolves), mirroring maxOutputTokensFor / modelLabel.
  const priceFor = (model: string): ModelPrice | null => {
    if (models[model]) {
      return models[model];
    }
    const prefix = Object.keys(models).find((id) => model.startsWith(id));
    return prefix ? models[prefix]! : null;
  };

  const entries = (): PricingEntry[] =>
    Object.entries(models).map(([model, price]) => ({
      model,
      label: modelLabel(model),
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
    }));

  // Atomic persist of the whole map: write a sibling temp, then rename over the real file. A crash
  // (or injected failure) mid-swap leaves the original file untouched; on a rename failure the temp
  // is removed so no orphan/partial file remains.
  const persist = (): void => {
    const tmp = `${filePath}.tmp`;
    writeFile(tmp, JSON.stringify({ models, removed: [...removed] }, null, 2));
    try {
      rename(tmp, filePath);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort — the original file is already safe (never renamed over)
      }
      throw error;
    }
  };

  const updatePrice = (model: string, price: ModelPrice): void => {
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('pricing: model must be a non-empty string');
    }
    for (const value of [price?.inputPerMTok, price?.outputPerMTok]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError('pricing: input/output price must be a finite, non-negative number');
      }
    }
    const next: ModelPrice = {
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
    };
    // Mutate the SAME map the priceFor closure (held by the UsageStore) reads, so the next
    // summary() reprices with no restart; roll back if the atomic write fails so map + disk agree.
    const previous = Object.prototype.hasOwnProperty.call(models, model)
      ? models[model]
      : undefined;
    // A re-set clears any tombstone so the price survives the next launch's seed-merge.
    const wasTombstoned = removed.has(model);
    models[model] = next;
    removed.delete(model);
    try {
      persist();
    } catch (error) {
      if (previous === undefined) {
        delete models[model];
      } else {
        models[model] = previous;
      }
      if (wasTombstoned) {
        removed.add(model);
      }
      throw error;
    }
  };

  // M10.B ext#2 (§10): DELETE the model's price outright — seed and non-seed alike go unpriced
  // (priceFor → null; never a fallback seed price). A deleted SEED id is tombstoned so the
  // seed-merge on the next launch doesn't resurrect it. Persist atomically like updatePrice; on a
  // write failure roll BOTH the map and the tombstone set back so map + disk stay consistent.
  // Mutates the SAME map the priceFor closure holds (live reprice). Deleting an id with no price is
  // an idempotent no-op.
  const removePrice = (model: string): void => {
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('pricing: model must be a non-empty string');
    }
    const previous = Object.prototype.hasOwnProperty.call(models, model)
      ? models[model]
      : undefined;
    const isSeed = Object.prototype.hasOwnProperty.call(DEFAULT_MODELS, model);
    const wasTombstoned = removed.has(model);
    // Nothing to change: no live price AND (not a seed, or already tombstoned) → no-op, no write.
    if (previous === undefined && (!isSeed || wasTombstoned)) {
      return;
    }
    delete models[model];
    if (isSeed) {
      removed.add(model);
    }
    try {
      persist();
    } catch (error) {
      if (previous !== undefined) {
        models[model] = previous;
      }
      if (isSeed && !wasTombstoned) {
        removed.delete(model);
      }
      throw error;
    }
  };

  const unpricedModels = (catalog: readonly CatalogModel[]): UnpricedModel[] =>
    catalog
      .filter((model) => priceFor(model.id) === null)
      .map((model) => ({ id: model.id, label: model.label }));

  return { priceFor, entries, updatePrice, removePrice, unpricedModels };
}
