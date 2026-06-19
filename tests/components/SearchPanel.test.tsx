// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchResult } from '@shared/types';

import { SearchPanel } from '../../src/components/SearchPanel';
import type { SearchClient } from '../../src/ipc/client';

/*
 * The cross-session search surface (M04.D). A debounced query input runs search:notes
 * over ALL sessions and lists ranked snippets; clicking a result navigates to its
 * session. UI-only over the typed search IPC — no key, no SDK.
 */
const RESULTS: SearchResult[] = [
  { sessionId: 's1', sessionName: 'Planning', snippet: '…the migration timeline…' },
  { sessionId: 's2', sessionName: 'Retro', snippet: '…migration risks…' },
];

function fakeClient(results: SearchResult[] = RESULTS): { client: SearchClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      notes: (query: string) => {
        calls.push(query);
        return Promise.resolve(query.trim() ? results : []);
      },
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SearchPanel', () => {
  it('debounces input before querying (one query, not one per keystroke)', async () => {
    const { client, calls } = fakeClient();
    render(<SearchPanel client={client} onNavigate={() => undefined} />);
    const input = screen.getByRole('searchbox', { name: /search/i });

    fireEvent.change(input, { target: { value: 'mig' } });
    fireEvent.change(input, { target: { value: 'migra' } });
    fireEvent.change(input, { target: { value: 'migration' } });
    expect(calls).toEqual([]); // nothing fired yet (debounced)

    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual(['migration']);
  });

  it('lists ranked results across sessions after a query resolves', async () => {
    const { client } = fakeClient();
    render(<SearchPanel client={client} onNavigate={() => undefined} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), {
      target: { value: 'migration' },
    });
    // Advance past the debounce + flush the resolved query inside act (fake timers
    // freeze waitFor's own polling, so assert directly after the advance instead).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('Retro')).toBeInTheDocument();
  });

  it('navigates to the session when a result is clicked', async () => {
    const onNavigate = vi.fn();
    const { client } = fakeClient();
    render(<SearchPanel client={client} onNavigate={onNavigate} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), {
      target: { value: 'migration' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    fireEvent.click(screen.getByText('Planning'));
    expect(onNavigate).toHaveBeenCalledWith('s1');
  });

  it('shows an error state with Retry (not "no matches") when the query rejects', async () => {
    const client = { notes: () => Promise.reject(new Error('boom')) };
    render(<SearchPanel client={client} onNavigate={() => undefined} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), {
      target: { value: 'migration' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // A failed search is an error (Retry), distinct from a successful empty result.
    expect(screen.getByText(/search failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/no matches/i)).toBeNull();
    expect(screen.queryByText('Planning')).toBeNull();
  });
});
