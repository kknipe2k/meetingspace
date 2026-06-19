import { describe, expect, it } from 'vitest';

import { SEARCH_CHANNELS } from '../../electron/ipc/channels';
import { registerSearchHandlers, type SearchIpcService } from '../../electron/ipc/search-handlers';
import type { SearchResult } from '@shared/types';

/*
 * The cross-session search IPC surface (M04.D). `search:notes` is a plain
 * request/response invoke carrying { query } — validated main-side — that returns
 * ranked results. No key, no SDK, no raw note rows beyond the snippet cross here.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

const RESULT: SearchResult = { sessionId: 's1', sessionName: 'Planning', snippet: '…migration…' };

function fakeService(captured: { query?: string }): SearchIpcService {
  return {
    searchNotes: (query: string) => {
      captured.query = query;
      return [RESULT];
    },
  };
}

describe('registerSearchHandlers', () => {
  it('routes search:notes to the service and returns ranked results', () => {
    const captured: { query?: string } = {};
    const reg = fakeRegistrar();
    registerSearchHandlers(reg, fakeService(captured));

    const handler = reg.handlers.get(SEARCH_CHANNELS.notes);
    expect(handler).toBeDefined();
    const out = handler?.({}, { query: 'migration' });
    expect(captured.query).toBe('migration');
    expect(out).toEqual([RESULT]);
  });

  it('rejects a non-string query at the trust boundary', () => {
    const reg = fakeRegistrar();
    registerSearchHandlers(reg, fakeService({}));
    const handler = reg.handlers.get(SEARCH_CHANNELS.notes);
    expect(() => handler?.({}, { query: 42 })).toThrow();
  });
});
