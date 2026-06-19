import type { SearchApi } from '@shared/api';
import type { SearchResult } from '@shared/types';

import { SEARCH_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * The renderer-facing search bridge (M04.D). A single plain invoke maps the typed
 * `search.notes(query)` onto search:notes; results are ranked SearchResult hits. Pure
 * and transport-agnostic so the mapping is Node-unit-testable, leaving preload.ts thin.
 * No key and no DB handle cross — only the query string and the snippet results.
 */
export function createSearchApi(invoke: IpcInvoke): SearchApi {
  return {
    notes: (query: string) => invoke(SEARCH_CHANNELS.notes, { query }) as Promise<SearchResult[]>,
  };
}
