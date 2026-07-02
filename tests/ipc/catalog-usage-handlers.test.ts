import { describe, expect, it } from 'vitest';

import { CATALOG_CHANNELS, USAGE_CHANNELS } from '../../electron/ipc/channels';
import {
  registerCatalogHandlers,
  type CatalogIpcService,
} from '../../electron/ipc/catalog-handlers';
import { registerUsageHandlers, type UsageIpcService } from '../../electron/ipc/usage-handlers';
import type { CatalogModel, PricingStatus, UsageSummary } from '@shared/types';

/*
 * The M06.D catalog + usage IPC surfaces (§10 IPC boundary). `catalog:list`/`catalog:refresh`
 * return the active provider's models (offline fallback handled in the service). `usage:summary`
 * returns the session+today rollup; `usage:pricing` returns the config-driven price entries.
 * Trust boundary here — sessionId is validated; no key, no DB handle crosses.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;
function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (c, h) => handlers.set(c, h), handlers };
}

const MODELS: CatalogModel[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', maxOutputTokens: 128000 },
];
const SUMMARY: UsageSummary = {
  sessionToday: {
    inputTokens: 5,
    outputTokens: 8,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.05,
    unpricedCalls: 0,
  },
  allToday: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.1,
    unpricedCalls: 0,
  },
};
// M10.A: usage:pricing now returns priced + unpriced (the Settings override UI needs both), so a
// new price channel doesn't orphan the one existing pricing consumer.
const PRICING_STATUS: PricingStatus = {
  priced: [
    { model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', inputPerMTok: 3, outputPerMTok: 15 },
  ],
  unpriced: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }],
};

describe('registerCatalogHandlers', () => {
  it('routes catalog:list and catalog:refresh to the service', async () => {
    const calls: string[] = [];
    const service: CatalogIpcService = {
      list: async () => {
        calls.push('list');
        return MODELS;
      },
      refresh: async () => {
        calls.push('refresh');
        return MODELS;
      },
    };
    const reg = fakeRegistrar();
    registerCatalogHandlers(reg, service);

    expect(await reg.handlers.get(CATALOG_CHANNELS.list)?.({})).toEqual(MODELS);
    expect(await reg.handlers.get(CATALOG_CHANNELS.refresh)?.({})).toEqual(MODELS);
    expect(calls).toEqual(['list', 'refresh']);
  });
});

describe('registerUsageHandlers', () => {
  it('routes usage:summary to the service, threading the open sessionId (ADR-0024)', () => {
    let seen: string | null = null;
    const service: UsageIpcService = {
      summary: (sessionId) => {
        seen = sessionId;
        return SUMMARY;
      },
      pricing: async () => PRICING_STATUS,
    };
    const reg = fakeRegistrar();
    registerUsageHandlers(reg, service);

    const out = reg.handlers.get(USAGE_CHANNELS.summary)?.({}, 's1');
    expect(seen).toBe('s1');
    expect(out).toEqual(SUMMARY);
  });

  it('rejects a non-string sessionId on usage:summary', () => {
    const reg = fakeRegistrar();
    registerUsageHandlers(reg, { summary: () => SUMMARY, pricing: async () => PRICING_STATUS });
    expect(() => reg.handlers.get(USAGE_CHANNELS.summary)?.({})).toThrow(
      /sessionId must be a string/,
    );
  });

  it('routes usage:pricing to the service (now returning priced + unpriced)', async () => {
    const reg = fakeRegistrar();
    registerUsageHandlers(reg, { summary: () => SUMMARY, pricing: async () => PRICING_STATUS });
    expect(await reg.handlers.get(USAGE_CHANNELS.pricing)?.({})).toEqual(PRICING_STATUS);
  });
});
