import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PricingEntry } from '@shared/types';
import { CHAT_MODELS, modelLabel } from '@shared/models';

/*
 * Config-driven pricing (M06.D, ADR-0021). The Models API returns the model list + per-model
 * output ceiling but NOT pricing (verified via the claude-api reference) — so pricing lives in an
 * UPDATABLE data file the app reads (a userData JSON, like prefs/templates). As Anthropic's prices
 * change, edit the file — no release required. Cost is shown when a model's price is known, "cost
 * unknown" (null) otherwise — never a wrong number. NO hardcoded prices in components: this is the
 * single source, consumed main-side by the usage rollup and surfaced to Settings over `usage:pricing`.
 *
 * The seed is derived from the shared model table so the initial prices stay in step with the
 * catalog seed; the file is written on first run so the user has something to edit.
 */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

// Prompt-cache pricing multipliers (relative to the input price; documented in the claude-api
// reference): cache reads ≈ 0.1×, 5-minute cache writes ≈ 1.25×. The usage rollup applies these
// so the cost reflects real cached-token spend rather than under-counting it.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

export interface PricingConfig {
  priceFor(model: string): ModelPrice | null;
  entries(): PricingEntry[];
}

interface PricingFile {
  readonly models: Record<string, ModelPrice>;
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

// Load the pricing map: the on-disk file when present (and valid), else the seed — which is also
// written to disk so the user can edit it. A corrupt/partial file falls back to the seed rather
// than throwing (a bad price config must never break chat or generation).
function loadModels(filePath: string): Record<string, ModelPrice> {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PricingFile;
      const models = parsed?.models;
      if (models && typeof models === 'object') {
        const out: Record<string, ModelPrice> = {};
        for (const [id, price] of Object.entries(models)) {
          if (isModelPrice(price)) {
            out[id] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
          }
        }
        if (Object.keys(out).length > 0) {
          return out;
        }
      }
    } catch {
      // Fall through to the seed — a corrupt config must not break the app.
    }
    return { ...DEFAULT_MODELS };
  }
  // First run: seed the file so the user has an editable starting point.
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ models: DEFAULT_MODELS }, null, 2), 'utf8');
  } catch {
    // A read-only userData dir is non-fatal — pricing still works from the in-memory seed.
  }
  return { ...DEFAULT_MODELS };
}

export function createPricingConfig(filePath: string): PricingConfig {
  const models = loadModels(filePath);
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
  return { priceFor, entries };
}
