import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../electron/gen/artifact-store';
import { openDatabase } from '../../electron/storage/db';
import { migrate, SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Migration v5 (M05.A) adds a nullable `model` column to `documents` so a generated
 * doc reloaded from storage can show which model produced it (the persisted-doc model
 * badge — M04 🟢). Invariants: the upgrade is ADDITIVE (an existing documents row keeps
 * its content; its model reads back NULL), IDEMPOTENT (re-running migrate is a no-op),
 * and does NOT regress close→reopen→intact. Storage §10 zone — surfaced before code.
 */
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migv5-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* A v4-shaped database with a documents row (v3 shape, no `model` column), stamped
 * user_version = 4 — so migrate() treats it as pre-v5 and runs only the v5 step. */
function seedV4DatabaseWithDoc(path: string): { docId: string } {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      template_id TEXT,
      created_at INTEGER NOT NULL
    );
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
  db.prepare(
    'INSERT INTO documents (id, session_id, kind, content, template_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('d-old', 's1', 'whitepaper', '<h1>Old paper</h1>', 'default', 10);
  db.pragma('user_version = 4');
  db.close();
  return { docId: 'd-old' };
}

function hasModelColumn(db: Database.Database): boolean {
  const cols = db.pragma('table_info(documents)') as Array<{ name: string }>;
  return cols.some((c) => c.name === 'model');
}

describe('migration v5 — documents.model column', () => {
  it('a fresh database opens at the current schema version with the model column', () => {
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
      expect(hasModelColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('upgrades a v4 database additively — existing row kept, model defaults NULL', () => {
    seedV4DatabaseWithDoc(dbPath);
    const db = new Database(dbPath);
    try {
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(hasModelColumn(db)).toBe(true);

      const row = db.prepare('SELECT content, model FROM documents WHERE id = ?').get('d-old') as {
        content: string;
        model: string | null;
      };
      expect(row.content).toBe('<h1>Old paper</h1>'); // existing content untouched
      expect(row.model).toBeNull(); // graceful for pre-v5 rows
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running migrate on a v5 database is a no-op', () => {
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

  it('persists and reads back the answering model via ArtifactStore', () => {
    const db = openDatabase(dbPath);
    db.prepare(
      'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
    try {
      const store = new ArtifactStore(
        db,
        () => 1000,
        () => 'doc-1',
      );
      const saved = store.saveArtifact({
        sessionId: 's1',
        kind: 'whitepaper',
        content: '<h1>WP</h1>',
        templateId: null,
        model: 'claude-sonnet-4-6',
      });
      expect(saved.model).toBe('claude-sonnet-4-6');
      expect(store.getLatestArtifact('s1', 'whitepaper')?.model).toBe('claude-sonnet-4-6');
    } finally {
      db.close();
    }
  });

  it('reads back NULL model for an artifact saved without one', () => {
    const db = openDatabase(dbPath);
    db.prepare(
      'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
    try {
      const store = new ArtifactStore(
        db,
        () => 1000,
        () => 'doc-1',
      );
      const saved = store.saveArtifact({
        sessionId: 's1',
        kind: 'focus',
        content: 'focus',
        templateId: null,
      });
      expect(saved.model ?? null).toBeNull();
    } finally {
      db.close();
    }
  });
});
