import type { ModelPrice } from '@shared/types';

import { PRICING_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The in-app price-override WRITE surface (M10.A, ADR-0027). `pricing:update` takes a model id and a
 * user-set price and persists it through the pricing config. This is a trust boundary: the renderer
 * is untrusted, so the handler VALIDATES the payload main-side (non-empty string id; finite,
 * non-negative input/output rates) before touching the config — a forged/garbage price is rejected
 * here, never written. No key, no DB handle crosses; only a price pair.
 */
export interface PricingIpcService {
  update(model: string, price: ModelPrice): void;
  // M10.B (§10): drop the user override for a model (validated id only — no price payload).
  delete(model: string): void;
}

function asModelId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('pricing ipc: model must be a non-empty string');
  }
  return value;
}

function asPrice(value: unknown): ModelPrice {
  const price = value as Partial<ModelPrice> | null;
  const fields = [price?.inputPerMTok, price?.outputPerMTok];
  for (const field of fields) {
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
      throw new RangeError('pricing ipc: input/output price must be a finite, non-negative number');
    }
  }
  return { inputPerMTok: price!.inputPerMTok!, outputPerMTok: price!.outputPerMTok! };
}

export function registerPricingHandlers(
  registrar: IpcHandleRegistrar,
  service: PricingIpcService,
): void {
  registrar.handle(PRICING_CHANNELS.update, (_event, model, price) =>
    service.update(asModelId(model), asPrice(price)),
  );
  // M10.B (§10): delete carries only a model id — validate it before touching the config.
  registrar.handle(PRICING_CHANNELS.delete, (_event, model) => service.delete(asModelId(model)));
}
