import { useEffect, useState } from 'react';

import type { SearchResult } from '@shared/types';

import { searchClient, type SearchClient } from '../ipc/client';

/*
 * Drives cross-session full-text search (M04.D). The query is DEBOUNCED so a burst of
 * keystrokes runs one search, not one per character; an empty/whitespace query clears
 * results without querying. The renderer holds no DB handle — it calls the typed
 * search IPC. Each effect run cancels the prior timer + ignores a stale in-flight
 * resolve (the `active` guard), so fast typing never races an older result onto screen.
 */
const DEBOUNCE_MS = 300;

export interface UseSearch {
  query: string;
  setQuery(query: string): void;
  results: SearchResult[];
  loading: boolean;
  /** True when the last search rejected (M05.A) — drives the error state, distinct from 0 results. */
  error: boolean;
  /** Re-run the current query after a failure (M05.A). */
  retry(): void;
}

export function useSearch(client: SearchClient = searchClient): UseSearch {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Bumped by retry() to re-run the effect for the same query.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults([]);
      setLoading(false);
      setError(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(false);
    const timer = setTimeout(() => {
      void client
        .notes(query)
        .then((hits) => {
          if (active) {
            setResults(hits);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active) {
            setResults([]);
            setError(true);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, client, retryToken]);

  return { query, setQuery, results, loading, error, retry: () => setRetryToken((t) => t + 1) };
}
