import type { PricingApi } from '@shared/api';
import type { ModelPrice } from '@shared/types';

import { PRICING_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * The renderer-facing price-override bridge (M10.A, ADR-0027). Pure + transport-agnostic (like the
 * usage bridge) so the channel mapping is Node-unit-testable and preload.ts stays thin. `update`
 * maps to invoke(pricing:update, model, price); main re-validates. No key, no DB handle crosses.
 */
export function createPricingApi(invoke: IpcInvoke): PricingApi {
  return {
    update: (model: string, price: ModelPrice) =>
      invoke(PRICING_CHANNELS.update, model, price) as Promise<void>,
    // M10.B (§10): maps delete(model) → invoke(pricing:delete, model); main re-validates the id.
    delete: (model: string) => invoke(PRICING_CHANNELS.delete, model) as Promise<void>,
  };
}
