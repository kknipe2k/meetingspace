import type { UsageApi } from '@shared/api';
import type { PricingEntry, UsageSummary } from '@shared/types';

import { USAGE_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * The renderer-facing usage-counter bridge (M06.D, ADR-0021/0024). `summary` takes the open session
 * id and returns the two today-windowed rollups (this session today + all sessions today);
 * `pricing` returns the config-driven price entries for Settings. Pure + transport-agnostic so the
 * mapping is Node-unit-testable, leaving preload.ts thin. No key, no DB handle crosses — only
 * aggregate counts + prices.
 */
export function createUsageApi(invoke: IpcInvoke): UsageApi {
  return {
    summary: (sessionId) => invoke(USAGE_CHANNELS.summary, sessionId) as Promise<UsageSummary>,
    pricing: () => invoke(USAGE_CHANNELS.pricing) as Promise<PricingEntry[]>,
  };
}
