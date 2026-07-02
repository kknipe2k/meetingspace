/*
 * The chat model catalog (M03.D, ADR-0008). The single source for the model-picker
 * options, the settings spend-guidance, and the chat default. IDs are bare aliases
 * (no date suffix) per the Anthropic SDK guidance — web-verified at build time.
 *
 * Pricing is an APPROXIMATE, DATED snapshot (advisory only — surfaced in settings):
 * re-verify against Anthropic's pricing page whenever this is touched. Prompt
 * caching reuses the session/grounding prefix at ~10% of the input price.
 */
import type { CatalogModel, GatewayModelProfile, GatewayModelVerification, Prefs } from './types';

export interface ChatModelOption {
  readonly id: string;
  readonly label: string;
  /** Approximate USD per million input tokens. */
  readonly inputPerMTok: number;
  /** Approximate USD per million output tokens. */
  readonly outputPerMTok: number;
  /**
   * The model's maximum output tokens (M07.D; web-verified ceilings). Feeds the
   * model-aware generation cap — min(GENERATION_MAX_TOKENS, this). NOTE (F22 deferred):
   * this is a STATIC seed, not a live `/v1/models` value; the dynamic catalog is owed
   * (docs/tech-debt.md TD-012).
   */
  readonly maxOutputTokens: number;
}

// The date the per-MTok prices below were web-verified (advisory snapshot).
export const PRICING_AS_OF = '2026-06-30';

export const CHAT_MODELS: readonly ChatModelOption[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    maxOutputTokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    inputPerMTok: 3,
    outputPerMTok: 15,
    maxOutputTokens: 64000,
  },
  // Claude Sonnet 5 (launched 2026-06-09; web-verified 2026-06-30 via anthropic.com/news +
  // platform.claude.com/pricing). Seeded at the INTRODUCTORY rate $2 in / $10 out per MTok, in
  // effect through 2026-08-31. MAINTAINER: on 2026-09-01 update these to the standard $3 / $15 (and
  // bump PRICING_AS_OF); a user can also override in-app (Settings → set price, M10.B) meanwhile.
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    inputPerMTok: 2,
    outputPerMTok: 10,
    maxOutputTokens: 128000,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    inputPerMTok: 5,
    outputPerMTok: 25,
    maxOutputTokens: 128000,
  },
];

// Chat defaults to the fast/inexpensive tier (cost + latency for an interactive
// back-and-forth). The generation tier (M04 white paper / minutes) defaults to the
// balanced Sonnet 4.6 tier — capable enough for a one-shot document without Opus's
// cost/latency — and is user-selectable. The generation default flipped Opus ->
// Sonnet at M04.C per ADR-0012, which supersedes the generation half of ADR-0008;
// the chat default (Haiku) is unchanged. Both settle Open Question #4.
export const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5';
export const DEFAULT_GENERATION_MODEL = 'claude-sonnet-4-6';

// The static model catalog (M06.D, ADR-0021) — the offline / dead-network fallback the dynamic
// catalog degrades to so the picker is NEVER empty, and the renderer hook's initial state (so
// options render before the live fetch lands). Derived from the seed table above so it stays in
// step with pricing. NOT named CHAT_MODELS, so it is importable by the renderer (the components/
// hooks guard bans the hardcoded CHAT_MODELS table + per-token price fields, not the catalog shape).
export const STATIC_CATALOG: readonly CatalogModel[] = CHAT_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  maxOutputTokens: m.maxOutputTokens,
}));

// Map a model id to its friendly catalog label. The API may answer with a dated
// snapshot (e.g. claude-haiku-4-5-20251001), so match by prefix too; fall back to
// the raw id so an unknown/newer model still shows something truthful. Single
// source for both the chat badge and the generation badge.
export function modelLabel(model: string): string {
  const match = CHAT_MODELS.find((option) => model === option.id || model.startsWith(option.id));
  return match ? match.label : model;
}

// The static per-model output ceiling (M07.D), matched by prefix like modelLabel so a
// dated snapshot id still resolves. Returns null for an unknown model so the generation
// cap falls SOFT to the static GENERATION_MAX_TOKENS (never blocks a run). F22 deferred:
// this is the static seed — a live catalog would supersede it (TD-012).
export function maxOutputTokensFor(model: string): number | null {
  const match = CHAT_MODELS.find((option) => model === option.id || model.startsWith(option.id));
  return match ? match.maxOutputTokens : null;
}

// Conservative output ceiling for a curated gateway id we can't resolve to served metadata
// (only hit if the gateway stops advertising a still-selected id) — the model-aware generation cap
// reads this; a real served entry always supplies the live value.
const GATEWAY_FALLBACK_MAX_OUTPUT_TOKENS = 64000;

export const EMPTY_GATEWAY_MODEL_PROFILE: GatewayModelProfile = {
  models: [],
  curatedModelIds: [],
  verifications: {},
};

// Canonical persistence/cache key for a corporate gateway. Query strings and fragments are not
// part of an API base URL and are intentionally excluded.
export function normalizeGatewayProfileKey(baseURL: string): string {
  try {
    const url = new URL(baseURL.trim());
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return baseURL.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export function gatewayModelProfile(prefs: Prefs, baseURL: string): GatewayModelProfile {
  const stored = prefs.gatewayModelProfiles?.[normalizeGatewayProfileKey(baseURL)];
  if (stored) {
    return stored;
  }
  // One-time compatibility with the diagnostics branch's global gatewayModels preference.
  return {
    ...EMPTY_GATEWAY_MODEL_PROFILE,
    curatedModelIds: [...(prefs.gatewayModels ?? [])],
  };
}

export function prefsWithGatewayModelProfile(
  prefs: Prefs,
  baseURL: string,
  profile: GatewayModelProfile,
): Prefs {
  const key = normalizeGatewayProfileKey(baseURL);
  return {
    gatewayModelProfiles: {
      ...(prefs.gatewayModelProfiles ?? {}),
      [key]: profile,
    },
  };
}

// The gateway picker's curated view (Gateway diagnostics). A corporate gateway's /v1/models can
// advertise the whole Bedrock catalog (and silently serve 3.5 Sonnet for ids it doesn't map), so the
// user curates which ids appear in the model dropdowns. Until they curate, the dropdowns use the
// conservative Haiku/Sonnet fallback instead of the full advertised set. When curated, each chosen
// id resolves to its saved metadata when present, else a best-effort synthesized entry so a
// still-selected id never vanishes from the picker.
export function curateGatewayModels(
  served: readonly CatalogModel[],
  curatedIds: readonly string[],
): CatalogModel[] {
  if (curatedIds.length === 0) {
    // Before setup, keep the gateway default conservative: no Opus and no flood of every advertised
    // Bedrock model. Explicitly verified/curated ids replace this fallback.
    return STATIC_CATALOG.filter((model) => model.id !== 'claude-opus-4-8');
  }
  return curatedIds.map((id) => {
    const match = served.find((model) => model.id === id);
    return (
      match ?? {
        id,
        label: modelLabel(id),
        maxOutputTokens: maxOutputTokensFor(id) ?? GATEWAY_FALLBACK_MAX_OUTPUT_TOKENS,
      }
    );
  });
}

// Drop any model the diagnostics proved the gateway SUBSTITUTES (you ask for it, the governance layer
// silently serves a different model). Such a model must never reach the chat/generation dropdowns —
// selecting it is a lie. Only 'substituted' is hidden: 'unavailable'/'timeout' stay visible (a probe
// failure is not proof the model is wrong), and an unverified id (no entry) stays visible too.
export function accessibleGatewayModels(
  models: readonly CatalogModel[],
  verifications: Readonly<Record<string, GatewayModelVerification>>,
): CatalogModel[] {
  return models.filter((model) => {
    const verification = verifications[model.id];
    return !verification || verification.status !== 'substituted';
  });
}
