import type { PricingEntry, UsageSummary } from '@shared/types';

import { USAGE_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The passive usage-counter IPC surface (M06.D, ADR-0021/0022/0024). `usage:summary` takes the open
 * session id and returns the two TODAY-windowed rollups (this session today + all sessions today);
 * `usage:pricing` returns the config-driven price entries for the Settings display. No key, no DB
 * handle crosses, only aggregate counts + prices.
 */
export interface UsageIpcService {
  summary(sessionId: string): UsageSummary;
  pricing(): PricingEntry[];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`usage ipc: ${field} must be a string`);
  }
  return value;
}

export function registerUsageHandlers(
  registrar: IpcHandleRegistrar,
  service: UsageIpcService,
): void {
  registrar.handle(USAGE_CHANNELS.summary, (_event, sessionId) =>
    service.summary(asString(sessionId, 'sessionId')),
  );
  registrar.handle(USAGE_CHANNELS.pricing, () => service.pricing());
}
