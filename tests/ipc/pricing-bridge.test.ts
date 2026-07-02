import { describe, expect, it } from 'vitest';

import { PRICING_CHANNELS } from '../../electron/ipc/channels';
import { createPricingApi } from '../../electron/ipc/pricing-bridge';

/*
 * M10.A — the renderer-facing pricing bridge. Pure + transport-agnostic (like the usage bridge) so
 * the channel mapping is Node-unit-testable and preload.ts stays thin. `update` maps to
 * invoke(pricing:update, model, price). No key, no DB handle crosses.
 */
describe('createPricingApi', () => {
  it('maps update(model, price) to invoke(pricing:update, model, price)', async () => {
    const invoked: Array<{ channel: string; args: unknown[] }> = [];
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
      invoked.push({ channel, args });
      return Promise.resolve(undefined);
    };
    const api = createPricingApi(invoke);

    await api.update('claude-sonnet-5', { inputPerMTok: 2, outputPerMTok: 10 });

    expect(invoked).toEqual([
      {
        channel: PRICING_CHANNELS.update,
        args: ['claude-sonnet-5', { inputPerMTok: 2, outputPerMTok: 10 }],
      },
    ]);
  });

  it('maps delete(model) to invoke(pricing:delete, model) (M10.B, §10)', async () => {
    const invoked: Array<{ channel: string; args: unknown[] }> = [];
    const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
      invoked.push({ channel, args });
      return Promise.resolve(undefined);
    };
    const api = createPricingApi(invoke);

    await api.delete('claude-sonnet-5');

    expect(invoked).toEqual([{ channel: PRICING_CHANNELS.delete, args: ['claude-sonnet-5'] }]);
  });
});
