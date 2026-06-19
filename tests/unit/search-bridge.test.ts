import { describe, expect, it } from 'vitest';

import { SEARCH_CHANNELS } from '../../electron/ipc/channels';
import { createSearchApi } from '../../electron/ipc/search-bridge';
import type { SearchResult } from '@shared/types';

/*
 * The renderer-facing search bridge (M04.D). A single plain invoke maps
 * search.notes(query) onto search:notes; no key or DB handle crosses. Pure and
 * transport-agnostic, so the mapping is Node-unit-testable (leaving preload.ts thin).
 */
const HITS: SearchResult[] = [{ sessionId: 's1', sessionName: 'Planning', snippet: '…migration…' }];

function fakeInvoke(result: unknown): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  invokes: Array<{ channel: string; args: unknown[] }>;
} {
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  return {
    invokes,
    invoke: (channel, ...args) => {
      invokes.push({ channel, args });
      return Promise.resolve(result);
    },
  };
}

describe('createSearchApi', () => {
  it('exposes exactly the notes method', () => {
    expect(Object.keys(createSearchApi(() => Promise.resolve([])))).toEqual(['notes']);
  });

  it('invokes search:notes with { query } and returns the ranked results', async () => {
    const f = fakeInvoke(HITS);
    const out = await createSearchApi(f.invoke).notes('migration');

    expect(f.invokes).toEqual([{ channel: SEARCH_CHANNELS.notes, args: [{ query: 'migration' }] }]);
    expect(out).toEqual(HITS);
  });
});
