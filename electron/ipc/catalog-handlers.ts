import type { CatalogModel } from '@shared/types';

import { CATALOG_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The dynamic model catalog IPC surface (M06.D, ADR-0021). `catalog:list` returns the active
 * provider's models (the service caches + fails soft to the static list, so it is never empty);
 * `catalog:refresh` forces a re-fetch. Plain request/response; no key, no SDK crosses — the
 * service reads the credential main-side and returns only model metadata.
 */
export interface CatalogIpcService {
  list(): Promise<CatalogModel[]>;
  refresh(): Promise<CatalogModel[]>;
}

export function registerCatalogHandlers(
  registrar: IpcHandleRegistrar,
  service: CatalogIpcService,
): void {
  registrar.handle(CATALOG_CHANNELS.list, () => service.list());
  registrar.handle(CATALOG_CHANNELS.refresh, () => service.refresh());
}
