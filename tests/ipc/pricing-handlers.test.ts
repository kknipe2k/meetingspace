import { describe, expect, it } from 'vitest';

import { PRICING_CHANNELS } from '../../electron/ipc/channels';
import {
  registerPricingHandlers,
  type PricingIpcService,
} from '../../electron/ipc/pricing-handlers';
import type { ModelPrice } from '@shared/types';

/*
 * M10.A — the pricing:update WRITE channel (§10 IPC boundary). The renderer sends a user-set price
 * for a model; main VALIDATES it (string model id; finite, non-negative input/output rates) before
 * routing to pricingConfig.updatePrice. A forged/garbage price must be rejected at this boundary —
 * never trust the renderer. No key, no DB handle crosses.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;
function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (c, h) => handlers.set(c, h), handlers };
}

describe('registerPricingHandlers — pricing:update', () => {
  it('validates then routes pricing:update to the service with (model, price)', () => {
    const calls: Array<[string, ModelPrice]> = [];
    const service: PricingIpcService = {
      update: (model, price) => calls.push([model, price]),
      delete: () => undefined,
    };
    const reg = fakeRegistrar();
    registerPricingHandlers(reg, service);

    reg.handlers.get(PRICING_CHANNELS.update)?.({}, 'claude-sonnet-5', {
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(calls).toEqual([['claude-sonnet-5', { inputPerMTok: 2, outputPerMTok: 10 }]]);
  });

  it('rejects a non-string model id and never calls the service', () => {
    const reg = fakeRegistrar();
    const calls: unknown[] = [];
    registerPricingHandlers(reg, { update: (...a) => calls.push(a), delete: () => undefined });
    expect(() =>
      reg.handlers.get(PRICING_CHANNELS.update)?.({}, 123, { inputPerMTok: 2, outputPerMTok: 10 }),
    ).toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects a negative, NaN, or missing price field and never calls the service', () => {
    const reg = fakeRegistrar();
    const calls: unknown[] = [];
    registerPricingHandlers(reg, { update: (...a) => calls.push(a), delete: () => undefined });
    const update = reg.handlers.get(PRICING_CHANNELS.update);
    expect(() => update?.({}, 'm', { inputPerMTok: -1, outputPerMTok: 1 })).toThrow();
    expect(() => update?.({}, 'm', { inputPerMTok: 1, outputPerMTok: Number.NaN })).toThrow();
    expect(() => update?.({}, 'm', { inputPerMTok: 1 })).toThrow();
    expect(calls).toEqual([]);
  });
});

describe('registerPricingHandlers — pricing:delete (M10.B, §10)', () => {
  it('validates then routes pricing:delete to the service with the model id', () => {
    const removed: string[] = [];
    const service: PricingIpcService = {
      update: () => undefined,
      delete: (model) => removed.push(model),
    };
    const reg = fakeRegistrar();
    registerPricingHandlers(reg, service);

    reg.handlers.get(PRICING_CHANNELS.delete)?.({}, 'claude-sonnet-5');
    expect(removed).toEqual(['claude-sonnet-5']);
  });

  it('rejects a non-string or empty model id and never calls delete', () => {
    const reg = fakeRegistrar();
    const removed: unknown[] = [];
    registerPricingHandlers(reg, { update: () => undefined, delete: (...a) => removed.push(a) });
    const del = reg.handlers.get(PRICING_CHANNELS.delete);
    expect(() => del?.({}, 123)).toThrow();
    expect(() => del?.({}, '')).toThrow();
    expect(removed).toEqual([]);
  });
});
