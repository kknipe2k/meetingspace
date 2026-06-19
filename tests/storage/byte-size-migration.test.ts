import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetStore } from '../../electron/storage/assets';
import { backfillAssetSizes } from '../../electron/storage/asset-backfill';
import { openDatabase } from '../../electron/storage/db';
import { migrate, SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * Migration v6 (M06.B, REVIEW-V11 F28) adds a nullable `byte_size` column to `assets` so the
 * storage meter is a single cheap query instead of an fs walk. §10 storage zone — surfaced
 * before code. Invariants pinned here:
 *   - ADDITIVE: an existing assets row keeps its data; byte_size reads back NULL pre-backfill.
 *   - IDEMPOTENT: re-running migrate() on a v6 db is a no-op (re-open safe).
 *   - GOING FORWARD: AssetStore.saveBlob records the real byte size at write time.
 *   - BACKFILL: a separate seam (assetsRoot-aware, not in the pure schema migration) fills NULL
 *     rows from disk in one pass, and is itself idempotent (a second run updates nothing).
 */
let dir: string;
let dbPath: string;
let assetsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-migv6-'));
  dbPath = join(dir, 'store.db');
  assetsRoot = join(dir, 'assets');
  mkdirSync(assetsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hasByteSizeColumn(db: Database.Database): boolean {
  const cols = db.pragma('table_info(assets)') as Array<{ name: string }>;
  return cols.some((c) => c.name === 'byte_size');
}

/* A v5-shaped database with an assets row (no `byte_size` column), stamped user_version = 5 —
 * so migrate() treats it as pre-v6 and runs only the v6 step. */
function seedV5DatabaseWithAsset(path: string): { assetId: string; relPath: string } {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
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
  const relPath = 's1/old.png';
  db.prepare(
    'INSERT INTO assets (id, session_id, kind, relative_path, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('a-old', 's1', 'image', relPath, 10);
  db.pragma('user_version = 5');
  db.close();
  return { assetId: 'a-old', relPath };
}

describe('migration v6 — assets.byte_size column', () => {
  it('a fresh database opens at the current schema version with the byte_size column', () => {
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
      expect(hasByteSizeColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('upgrades a v5 database additively — existing row kept, byte_size defaults NULL', () => {
    const { assetId } = seedV5DatabaseWithAsset(dbPath);
    const db = new Database(dbPath);
    try {
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(hasByteSizeColumn(db)).toBe(true);

      const row = db
        .prepare('SELECT relative_path, byte_size FROM assets WHERE id = ?')
        .get(assetId) as { relative_path: string; byte_size: number | null };
      expect(row.relative_path).toBe('s1/old.png'); // existing data untouched
      expect(row.byte_size).toBeNull(); // graceful for pre-v6 rows (needs backfill)
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running migrate on a v6 database is a no-op', () => {
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

  it('AssetStore.saveBlob records the real byte size going forward', () => {
    const db = openDatabase(dbPath);
    db.prepare(
      'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', DEFAULT_SPACE_ID, 'S', 1, 1);
    try {
      const store = new AssetStore(
        db,
        assetsRoot,
        () => 1000,
        () => 'a-new',
      );
      const bytes = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes
      store.saveBlob('s1', 'screenshot', bytes, 'png');

      const row = db.prepare('SELECT byte_size FROM assets WHERE id = ?').get('a-new') as {
        byte_size: number | null;
      };
      expect(row.byte_size).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('backfillAssetSizes — one-pass, idempotent fill of NULL rows', () => {
  it('fills NULL byte_size from disk and leaves already-sized rows untouched', () => {
    // Upgrade a v5 db so the column exists but the seeded row is NULL.
    const { relPath } = seedV5DatabaseWithAsset(dbPath);
    const db = openDatabase(dbPath); // runs the v6 migration on open
    try {
      // Write the actual blob on disk so the default fs sizeOf would also work.
      const abs = join(assetsRoot, relPath);
      mkdirSync(join(assetsRoot, 's1'), { recursive: true });
      writeFileSync(abs, Buffer.from([9, 9, 9, 9, 9, 9, 9])); // 7 bytes

      // Add a row that already has a size — backfill must not touch it.
      db.prepare(
        'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('a-sized', 's1', 'image', 's1/sized.png', 11, 42);

      const updated = backfillAssetSizes(db, assetsRoot);
      expect(updated).toBe(1); // only the NULL row

      const old = db.prepare('SELECT byte_size FROM assets WHERE id = ?').get('a-old') as {
        byte_size: number | null;
      };
      const sized = db.prepare('SELECT byte_size FROM assets WHERE id = ?').get('a-sized') as {
        byte_size: number | null;
      };
      expect(old.byte_size).toBe(7);
      expect(sized.byte_size).toBe(42); // untouched
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second backfill pass updates nothing', () => {
    seedV5DatabaseWithAsset(dbPath);
    const db = openDatabase(dbPath);
    try {
      mkdirSync(join(assetsRoot, 's1'), { recursive: true });
      writeFileSync(join(assetsRoot, 's1/old.png'), Buffer.from([1, 2, 3]));

      expect(backfillAssetSizes(db, assetsRoot)).toBe(1);
      expect(backfillAssetSizes(db, assetsRoot)).toBe(0); // re-run: no NULL rows remain
    } finally {
      db.close();
    }
  });

  it('records 0 for a NULL row whose blob is missing on disk (never crashes the pass)', () => {
    seedV5DatabaseWithAsset(dbPath); // row points at a file we never write
    const db = openDatabase(dbPath);
    try {
      const updated = backfillAssetSizes(db, assetsRoot);
      expect(updated).toBe(1);
      const old = db.prepare('SELECT byte_size FROM assets WHERE id = ?').get('a-old') as {
        byte_size: number | null;
      };
      expect(old.byte_size).toBe(0);
    } finally {
      db.close();
    }
  });
});
