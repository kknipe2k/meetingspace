import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { migrate, SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * M06.D migration #2 (ADR-0020 + ADR-0021): v7 `chat_messages` + v8 `usage`, both additive,
 * user_version-gated, idempotent, with cascade-on-session-delete. §10 storage zone — surfaced
 * before code. Pinned invariants (gate "Storage migration safety"):
 *   - the two tables exist at the current schema version;
 *   - upgrading a v6 db is additive (existing rows untouched) and idempotent (re-open safe);
 *   - deleting a session CASCADES to its chat_messages AND usage rows — no orphans.
 *     (Mutation: drop either ON DELETE CASCADE → the orphan assertion below fails.)
 */
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migCU-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/* A v6-shaped database (spaces + sessions + one session row), stamped user_version = 6 so
 * migrate() treats it as pre-v7 and runs only the new chat_messages + usage steps. */
function seedV6Database(path: string): void {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    DEFAULT_SPACE_ID,
    'My Space',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
  db.pragma('user_version = 6');
  db.close();
}

describe('migration v7/v8 — chat_messages + usage tables', () => {
  it('a fresh database opens at the current schema version with both new tables', () => {
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
      expect(hasTable(db, 'chat_messages')).toBe(true);
      expect(hasTable(db, 'usage')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('upgrades a v6 database additively — the existing session row is preserved', () => {
    seedV6Database(dbPath);
    const db = new Database(dbPath);
    try {
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(hasTable(db, 'chat_messages')).toBe(true);
      expect(hasTable(db, 'usage')).toBe(true);
      const row = db.prepare('SELECT name FROM sessions WHERE id = ?').get('s1') as {
        name: string;
      };
      expect(row.name).toBe('S');
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running migrate on a v8 database is a no-op', () => {
    const db = openDatabase(dbPath);
    try {
      expect(() => {
        migrate(db);
        migrate(db);
      }).not.toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('cascades chat_messages AND usage on session delete — no orphan rows', () => {
    const db = openDatabase(dbPath);
    try {
      db.prepare(
        'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
      db.prepare(
        'INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('c1', 's1', 'user', 'hi', null, 10);
      db.prepare(
        'INSERT INTO usage (id, session_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('u1', 's1', 'chat', 'm', 5, 7, 0, 0, 11);

      db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');

      const chatLeft = db
        .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?')
        .get('s1') as { n: number };
      const usageLeft = db
        .prepare('SELECT COUNT(*) AS n FROM usage WHERE session_id = ?')
        .get('s1') as { n: number };
      expect(chatLeft.n).toBe(0); // cascade dropped the chat row
      expect(usageLeft.n).toBe(0); // cascade dropped the usage row
    } finally {
      db.close();
    }
  });
});
