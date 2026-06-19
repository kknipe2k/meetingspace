import { useEffect, useRef, type ReactElement } from 'react';

import { useSearch } from '../hooks/useSearch';
import type { SearchClient } from '../ipc/client';

import { ErrorState } from './ErrorState';

/*
 * The cross-session search surface (M04.D). A debounced query input runs search:notes
 * over EVERY session and lists ranked snippets; clicking a result navigates to its
 * session. UI-only over the typed search IPC — no key, no SDK, no DB handle. Styled
 * with design tokens; the one lavender accent is reserved for the focused input + the
 * hovered result (docs/design.md).
 */
export interface SearchPanelProps {
  /** Injectable for tests; defaults to the real search IPC client. */
  client?: SearchClient;
  onNavigate(sessionId: string): void;
  /** Bumped to focus the input (Ctrl/Cmd+F or the menu's Find — M06.A). */
  focusSignal?: number;
}

export function SearchPanel({ client, onNavigate, focusSignal }: SearchPanelProps): ReactElement {
  const { query, setQuery, results, loading, error, retry } = useSearch(client);
  const hasQuery = query.trim().length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input whenever the signal advances (the initial 0 is inert).
  useEffect(() => {
    if (focusSignal !== undefined && focusSignal > 0) {
      inputRef.current?.focus();
    }
  }, [focusSignal]);

  return (
    <div className="search-panel">
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        aria-label="Search all sessions"
        placeholder="Search all sessions…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {hasQuery && loading && <p className="zone-loading search-loading">Searching…</p>}
      {error && (
        <ErrorState
          className="search-error"
          message="Search failed — please try again."
          onRetry={retry}
        />
      )}
      {results.length > 0 && (
        <ul className="search-results" role="list">
          {results.map((result) => (
            <li key={result.sessionId}>
              <button
                type="button"
                className="search-result"
                onClick={() => onNavigate(result.sessionId)}
              >
                <span className="search-result-name">{result.sessionName}</span>
                <span className="search-result-snippet">{result.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasQuery && !loading && !error && results.length === 0 && (
        <p className="search-empty">No matches across your sessions.</p>
      )}
    </div>
  );
}
