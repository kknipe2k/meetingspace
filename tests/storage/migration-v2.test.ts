import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { migrate, DEFAULT_SPACE_ID, SCHEMA_VERSION } from '../../electron/storage/schema';

// Migration v2 adds notes.position. The invariant under test: the upgrade is
// additive and idempotent — an M01-shaped (v1) database gains the column with
// existing rows preserved at position 0, and re-running migrate never mutates.
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migv2-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* Builds a database at exactly the M01 (v1) shape: the original schema with no
 * `position` column, one seeded space, one session, one note — then stamps
 * user_version = 1 so migrate() treats it as a pre-v2 database. */
function seedV1Database(path: string): { sessionId: string; noteId: string; content: string } {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run(DEFAULT_SPACE_ID, 'My Space', 1, 1);
  const sessionId = 'session-1';
  const noteId = 'note-1';
  const content = 'an M01 single note';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    DEFAULT_SPACE_ID,
    'Legacy session',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO notes (id, session_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(noteId, sessionId, content, 1, 1);
  db.pragma('user_version = 1');
  db.close();
  return { sessionId, noteId, content };
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('migration v2 (notes.position)', () => {
  it('upgrades a v1 database additively, preserving the existing note at position 0', () => {
    const { noteId, content } = seedV1Database(dbPath);

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    migrate(db);

    expect(columnNames(db, 'notes')).toContain('position');
    const row = db.prepare('SELECT content, position FROM notes WHERE id = ?').get(noteId) as {
      content: string;
      position: number;
    };
    expect(row.content).toBe(content); // existing row not rewritten
    expect(row.position).toBe(0);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('is a no-op when re-run on an already-migrated database', () => {
    seedV1Database(dbPath);
    const first = new Database(dbPath);
    first.pragma('foreign_keys = ON');
    migrate(first);
    const snapshot = first.prepare('SELECT id, content, position FROM notes ORDER BY id').all();
    first.close();

    const second = new Database(dbPath);
    second.pragma('foreign_keys = ON');
    migrate(second); // re-run
    const after = second.prepare('SELECT id, content, position FROM notes ORDER BY id').all();
    expect(after).toEqual(snapshot);
    expect(second.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    second.close();
  });

  it('a fresh database opens at v2 with the position column present', () => {
    const db = openDatabase(dbPath);
    try {
      expect(columnNames(db, 'notes')).toContain('position');
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
