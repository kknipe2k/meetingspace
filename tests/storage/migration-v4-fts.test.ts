import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchStore } from '../../electron/storage/search-store';
import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';
import { migrate, SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Migration v4 adds cross-session full-text search via SQLite FTS5 (M04.D, ADR-0011).
 * The invariants under test: the upgrade BACKFILLS the index from existing notes (so
 * pre-M04 content is searchable), keeps the index in SYNC on note add/update/delete
 * via triggers, is additive + idempotent, leaves the v3 `documents` table intact, and
 * does NOT regress the M01 close→reopen→intact guarantee. FTS5 is built into the
 * bundled better-sqlite3 SQLite — no new native dependency (a missing FTS5 would throw
 * at CREATE VIRTUAL TABLE, failing these tests).
 */
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migv4-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* A v3-shaped database (documents table present), stamped user_version = 3, with a
 * seeded space/session/note — so migrate() treats it as pre-v4. */
function seedV3Database(path: string): { sessionId: string; noteId: string; term: string } {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, content TEXT NOT NULL, template_id TEXT, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run(DEFAULT_SPACE_ID, 'My Space', 1, 1);
  const sessionId = 'session-1';
  const noteId = 'note-1';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    DEFAULT_SPACE_ID,
    'Budget meeting',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(noteId, sessionId, 'the quarterly forecast looks strong', 0, 1, 1);
  db.pragma('user_version = 3');
  db.close();
  return { sessionId, noteId, term: 'forecast' };
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('migration v4 (FTS5 full-text search)', () => {
  it('backfills the index from pre-existing notes (a pre-M04 note is findable)', () => {
    const { sessionId, term } = seedV3Database(dbPath);

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    migrate(db);
    try {
      // Mutation check 2: skipping the v4 backfill must fail this assertion.
      const results = new SearchStore(db).searchNotes(term);
      expect(results.map((r) => r.sessionId)).toContain(sessionId);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('is additive: the v3 documents table and existing notes survive the upgrade', () => {
    const { noteId } = seedV3Database(dbPath);

    const db = openDatabase(dbPath); // pragmas + migrate (the real app path)
    try {
      expect(tableNames(db)).toContain('documents');
      const row = db.prepare('SELECT content FROM notes WHERE id = ?').get(noteId) as {
        content: string;
      };
      expect(row.content).toBe('the quarterly forecast looks strong'); // close→reopen→intact
    } finally {
      db.close();
    }
  });

  it('is idempotent: re-running migrate leaves one index entry, not a duplicate', () => {
    const { term } = seedV3Database(dbPath);

    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath); // re-run
    try {
      expect(second.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const results = new SearchStore(second).searchNotes(term);
      expect(results).toHaveLength(1); // not doubled by a second backfill
    } finally {
      second.close();
    }
  });

  it('keeps the index in sync on note ADD (a new note is immediately findable)', () => {
    seedV3Database(dbPath);
    const db = openDatabase(dbPath);
    try {
      new NoteStore(db).addNoteWithContent('session-1', 'a brand new widget proposal');
      expect(new SearchStore(db).searchNotes('widget').map((r) => r.sessionId)).toContain(
        'session-1',
      );
    } finally {
      db.close();
    }
  });

  it('keeps the index in sync on note UPDATE (new term matches, old term does not)', () => {
    const { noteId } = seedV3Database(dbPath);
    const db = openDatabase(dbPath);
    try {
      new NoteStore(db).updateNote(noteId, 'replaced with a roadmap discussion');
      const search = new SearchStore(db);
      expect(search.searchNotes('roadmap')).toHaveLength(1);
      expect(search.searchNotes('forecast')).toHaveLength(0); // stale term gone
    } finally {
      db.close();
    }
  });

  it('keeps the index in sync on note DELETE (the deleted note no longer matches)', () => {
    const { noteId, term } = seedV3Database(dbPath);
    const db = openDatabase(dbPath);
    try {
      new NoteStore(db).deleteNote(noteId);
      // Mutation check 3: skipping index sync on delete must fail this.
      expect(new SearchStore(db).searchNotes(term)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('indexes session NAMES, not just note content', () => {
    const { sessionId } = seedV3Database(dbPath);
    const db = openDatabase(dbPath);
    try {
      // Renaming flows through the sessions trigger; the session is findable by name.
      new SessionStore(db).renameSession(sessionId, 'Roadmap planning');
      expect(new SearchStore(db).searchNotes('Roadmap').map((r) => r.sessionId)).toContain(
        sessionId,
      );
    } finally {
      db.close();
    }
  });
});
