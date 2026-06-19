import type { CatalogApi } from '@shared/api';
import type { CatalogModel } from '@shared/types';

import { CATALOG_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * The renderer-facing model-catalog bridge (M06.D, ADR-0021). `list` returns the active provider's
 * models (cached + offline-fallback main-side, so never empty); `refresh` forces a re-fetch. Pure
 * + transport-agnostic so the mapping is Node-unit-testable, leaving preload.ts thin. No key, no
 * SDK crosses — only model metadata.
 */
export function createCatalogApi(invoke: IpcInvoke): CatalogApi {
  return {
    list: () => invoke(CATALOG_CHANNELS.list) as Promise<CatalogModel[]>,
    refresh: () => invoke(CATALOG_CHANNELS.refresh) as Promise<CatalogModel[]>,
  };
}
