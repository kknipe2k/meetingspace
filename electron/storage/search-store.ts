import type Database from 'better-sqlite3';

import type { SearchResult } from '@shared/types';

/*
 * Cross-session full-text search (M04.D, ADR-0011). Runs a SANITIZED FTS5 MATCH over
 * the v4 `notes_fts` (note content) and `sessions_fts` (session names) indexes, ranked
 * by bm25 with a snippet, scoped back to the owning session for navigation. The handle
 * is injected (no module-global connection — docs/style.md), so it is fully testable.
 *
 * Query sanitization is load-bearing: a raw user string containing FTS5 metacharacters
 * (a bare quote, parenthesis, `*`, or a bare AND/OR/NOT) is a MATCH syntax error. Each
 * whitespace-delimited token is wrapped in double quotes (with internal quotes doubled),
 * so every term is a literal — metacharacters can never crash the query.
 */
interface FtsRow {
  sessionId: string;
  sessionName: string;
  snippet: string;
  rank: number;
}

export class SearchStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  searchNotes(query: string): SearchResult[] {
    const match = sanitizeQuery(query);
    if (match === null) {
      return [];
    }

    // notes_fts is standalone and stores session_id, so we trust the index directly
    // (no JOIN to `notes` — that JOIN would hide a stale index entry and make the sync
    // triggers un-observable). JOIN `sessions` only for the human-readable name.
    const noteHits = this.db
      .prepare(
        `SELECT notes_fts.session_id AS sessionId, s.name AS sessionName,
                snippet(notes_fts, 0, '[', ']', '…', 12) AS snippet,
                bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN sessions s ON s.id = notes_fts.session_id
          WHERE notes_fts MATCH ?
          ORDER BY rank`,
      )
      .all(match) as FtsRow[];

    const nameHits = this.db
      .prepare(
        `SELECT s.id AS sessionId, s.name AS sessionName,
                snippet(sessions_fts, 0, '[', ']', '…', 12) AS snippet,
                bm25(sessions_fts) AS rank
           FROM sessions_fts
           JOIN sessions s ON s.rowid = sessions_fts.rowid
          WHERE sessions_fts MATCH ?
          ORDER BY rank`,
      )
      .all(match) as FtsRow[];

    // Merge both sources, deduped by session (note matches take priority over a
    // name-only match for the same session — the snippet is more informative).
    const bySession = new Map<string, SearchResult>();
    for (const row of [...noteHits, ...nameHits]) {
      if (!bySession.has(row.sessionId)) {
        bySession.set(row.sessionId, {
          sessionId: row.sessionId,
          sessionName: row.sessionName,
          snippet: row.snippet,
        });
      }
    }
    return [...bySession.values()];
  }
}

function sanitizeQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}
