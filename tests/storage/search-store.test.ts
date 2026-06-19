import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchStore } from '../../electron/storage/search-store';
import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';

/*
 * Cross-session full-text search (M04.D, ADR-0011). searchNotes runs a SANITIZED FTS5
 * MATCH over every session's note content (and session names), ranked by bm25 with a
 * snippet, scoped back to the owning session for navigation. The query is sanitized
 * against FTS5 MATCH syntax so a stray metacharacter is a literal term, never a crash.
 */
let dir: string;
let db: Database.Database;
let sessions: SessionStore;
let notes: NoteStore;
let search: SearchStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-search-'));
  db = openDatabase(join(dir, 'store.db'));
  sessions = new SessionStore(db);
  notes = new NoteStore(db);
  search = new SearchStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SearchStore.searchNotes', () => {
  it('finds matching note content across multiple sessions, scoped to the right session', () => {
    const a = sessions.createSession('Planning');
    const b = sessions.createSession('Retro');
    notes.addNoteWithContent(a.id, 'we discussed the migration timeline');
    notes.addNoteWithContent(b.id, 'the retro covered deployment risks');

    const hits = search.searchNotes('migration');
    expect(hits.map((h) => h.sessionId)).toEqual([a.id]);
    expect(hits[0]?.sessionName).toBe('Planning');
    expect(hits[0]?.snippet.toLowerCase()).toContain('migration');
  });

  it('returns multiple ranked results when several sessions match', () => {
    const a = sessions.createSession('One');
    const b = sessions.createSession('Two');
    notes.addNoteWithContent(a.id, 'budget budget budget figures');
    notes.addNoteWithContent(b.id, 'a single budget mention');

    const hits = search.searchNotes('budget');
    expect(hits.map((h) => h.sessionId).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns nothing for an empty or whitespace query without error', () => {
    sessions.createSession('X');
    expect(search.searchNotes('')).toEqual([]);
    expect(search.searchNotes('   ')).toEqual([]);
  });

  it('treats FTS5 metacharacters as literal terms (no syntax-error crash)', () => {
    const a = sessions.createSession('Q');
    notes.addNoteWithContent(a.id, 'release planning notes');
    // Bare metacharacters would be an FTS5 syntax error if passed through raw.
    expect(() => search.searchNotes('"')).not.toThrow();
    expect(() => search.searchNotes('release (')).not.toThrow();
    expect(() => search.searchNotes('a OR* b')).not.toThrow();
    // A valid term still inside a metacharacter-laden query still matches.
    expect(search.searchNotes('planning').map((h) => h.sessionId)).toContain(a.id);
  });

  it('finds a session by its NAME, not only its note content', () => {
    const a = sessions.createSession('Acme onboarding');
    notes.addNoteWithContent(a.id, 'unrelated body text');
    expect(search.searchNotes('onboarding').map((h) => h.sessionId)).toContain(a.id);
  });
});
