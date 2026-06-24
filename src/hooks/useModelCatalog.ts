import { useCallback, useEffect, useRef, useState } from 'react';

import type { CatalogModel } from '@shared/types';
import { STATIC_CATALOG } from '@shared/models';

import { catalogClient, type CatalogClient } from '../ipc/client';
import { notifyCatalogChanged, subscribeCatalogChanged } from '../ipc/catalog-events';

/*
 * The dynamic model catalog hook (M06.D, ADR-0021; closes F22/TD-012). The SINGLE source of the
 * model-picker options for chat AND generation — replaces the old hardcoded model-table imports.
 * Seeds from the static catalog so options render immediately (and the picker is never empty), then
 * refines with the live per-provider list; `refresh` forces a re-fetch (manual refresh affordance).
 * A dead network keeps the static/last-known list — the picker never blocks.
 */
export interface UseModelCatalog {
  models: CatalogModel[];
  status: 'loading' | 'ready' | 'refreshing' | 'error';
  error: string | null;
  refresh(): Promise<boolean>;
}

export function useModelCatalog(client: CatalogClient = catalogClient): UseModelCatalog {
  const source = useRef(Symbol('model-catalog'));
  const [models, setModels] = useState<CatalogModel[]>(() => [...STATIC_CATALOG]);
  const [status, setStatus] = useState<UseModelCatalog['status']>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .list()
      .then((live) => {
        if (active) {
          if (live.length > 0) {
            setModels(live);
          }
          setError(null);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) {
          setError("Couldn't load the model list.");
          setStatus('error');
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  // Re-pull when the catalog changes elsewhere (e.g. the gateway curation was just saved in
  // Settings), so this picker reflects it without a manual refresh. main's cache was already
  // refreshed by the save site, so list() returns the new set.
  useEffect(() => {
    return subscribeCatalogChanged((changedBy) => {
      if (changedBy === source.current) {
        return;
      }
      setStatus('loading');
      void client
        .list()
        .then((live) => {
          if (live.length > 0) {
            setModels(live);
          }
          setError(null);
          setStatus('ready');
        })
        .catch(() => {
          setError("Couldn't load the model list.");
          setStatus('error');
        });
    });
  }, [client]);

  const refresh = useCallback(async (): Promise<boolean> => {
    setStatus('refreshing');
    try {
      const live = await client.refresh();
      if (live.length > 0) {
        setModels(live);
      }
      setError(null);
      setStatus('ready');
      notifyCatalogChanged(source.current);
      return true;
    } catch {
      setError("Couldn't refresh the model list.");
      setStatus('error');
      return false;
    }
  }, [client]);

  return { models, status, error, refresh };
}
