import { useCallback, useEffect, useState } from 'react';

import type { CatalogModel } from '@shared/types';
import { STATIC_CATALOG } from '@shared/models';

import { catalogClient, type CatalogClient } from '../ipc/client';

/*
 * The dynamic model catalog hook (M06.D, ADR-0021; closes F22/TD-012). The SINGLE source of the
 * model-picker options for chat AND generation — replaces the old hardcoded model-table imports.
 * Seeds from the static catalog so options render immediately (and the picker is never empty), then
 * refines with the live per-provider list; `refresh` forces a re-fetch (manual refresh affordance).
 * A dead network keeps the static/last-known list — the picker never blocks.
 */
export interface UseModelCatalog {
  models: CatalogModel[];
  refresh(): void;
}

export function useModelCatalog(client: CatalogClient = catalogClient): UseModelCatalog {
  const [models, setModels] = useState<CatalogModel[]>(() => [...STATIC_CATALOG]);

  useEffect(() => {
    let active = true;
    void client.list().then((live) => {
      if (active && live.length > 0) {
        setModels(live);
      }
    });
    return () => {
      active = false;
    };
  }, [client]);

  const refresh = useCallback(() => {
    void client.refresh().then((live) => {
      if (live.length > 0) {
        setModels(live);
      }
    });
  }, [client]);

  return { models, refresh };
}
