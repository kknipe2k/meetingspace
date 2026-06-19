import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../electron/gen/artifact-store';
import { openDatabase } from '../../electron/storage/db';
import { migrate, SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Migration v3 adds the `documents` table (generated artifacts, M04.A). The
 * invariant under test: the upgrade is additive and idempotent, and it does NOT
 * regress the M01 close→reopen→intact guarantee (existing notes survive). Stage D
 * will add FTS5 as migration v4 on top of this.
 */
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migv3-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* A v2-shaped database (notes.position present), stamped user_version = 2, with a
 * seeded space/session/note — so migrate() treats it as pre-v3. */
function seedV2Database(path: string): { sessionId: string; noteId: string; content: string } {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run(DEFAULT_SPACE_ID, 'My Space', 1, 1);
  const sessionId = 'session-1';
  const noteId = 'note-1';
  const content = 'a pre-M04 note';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    DEFAULT_SPACE_ID,
    'S',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(noteId, sessionId, content, 0, 1, 1);
  db.pragma('user_version = 2');
  db.close();
  return { sessionId, noteId, content };
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('migration v3 (documents table)', () => {
  it('upgrades a v2 database additively without regressing existing notes', () => {
    const { noteId, content } = seedV2Database(dbPath);

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    migrate(db);

    expect(tableNames(db)).toContain('documents');
    const row = db.prepare('SELECT content FROM notes WHERE id = ?').get(noteId) as {
      content: string;
    };
    expect(row.content).toBe(content); // close→reopen→intact not regressed
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('is a no-op when re-run on an already-migrated database', () => {
    seedV2Database(dbPath);
    const first = new Database(dbPath);
    first.pragma('foreign_keys = ON');
    migrate(first);
    first.close();

    const second = new Database(dbPath);
    second.pragma('foreign_keys = ON');
    migrate(second); // re-run
    expect(second.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(tableNames(second)).toContain('documents');
    second.close();
  });

  it('a fresh database opens at v3 with the documents table present', () => {
    const db = openDatabase(dbPath);
    try {
      expect(tableNames(db)).toContain('documents');
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  /*
   * Call-site regression guard (M04.B). An earlier check asserted the `documents`
   * table exists after v2→v3; this exercises the EXACT call the running app makes —
   * ArtifactStore.getArtifacts / saveArtifact — through the real openDatabase()
   * path (pragmas + migrate), on a pre-existing v2 database. The M04.B IRL hit
   * `no such table: documents` from a stale, divergent DEV database stamped at v3
   * without the table; the product migration is correct (proven here end-to-end),
   * so this locks the migrate → store round-trip so a future v3 edit can't ship the
   * DDL while leaving the store call broken.
   */
  it('exposes a working ArtifactStore after a v2→v3 upgrade (getArtifacts/saveArtifact)', () => {
    const { sessionId } = seedV2Database(dbPath);

    const db = openDatabase(dbPath); // the real app path: pragmas + migrate
    try {
      const store = new ArtifactStore(db);
      // The call that threw at runtime — must not raise "no such table: documents".
      expect(store.getArtifacts(sessionId)).toEqual([]);

      const saved = store.saveArtifact({
        sessionId,
        kind: 'whitepaper',
        content: '<html><body>paper</body></html>',
        templateId: 'default',
      });
      expect(store.getArtifacts(sessionId).map((d) => d.id)).toContain(saved.id);
      expect(store.getLatestArtifact(sessionId, 'whitepaper')?.content).toBe(
        '<html><body>paper</body></html>',
      );
    } finally {
      db.close();
    }
  });
});
