import type { SearchResult } from '@shared/types';

import { SEARCH_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The cross-session search IPC surface (M04.D). `search:notes` is a plain
 * request/response invoke: validate the query main-side (the trust boundary, spec §5),
 * then run it through the FTS5-backed search service. No key, no SDK, and no raw note
 * rows beyond the ranked snippet cross this boundary.
 */
export interface SearchIpcService {
  searchNotes(query: string): SearchResult[];
}

export function registerSearchHandlers(
  registrar: IpcHandleRegistrar,
  service: SearchIpcService,
): void {
  registrar.handle(SEARCH_CHANNELS.notes, (_event, raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('search ipc: request must be an object');
    }
    const query = (raw as Record<string, unknown>).query;
    if (typeof query !== 'string') {
      throw new TypeError('search ipc: query must be a string');
    }
    return service.searchNotes(query);
  });
}
