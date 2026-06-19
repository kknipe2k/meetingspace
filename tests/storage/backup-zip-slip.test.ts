import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyBackup,
  confinedStagingPath,
  buildBackupBlob,
  parseBackupBlob,
  collectBackup,
  type BackupData,
} from '../../electron/backup';
import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * S2-001 (independent audit 2026-06-17) — zip-slip / path traversal in backup restore.
 *
 * applyBackup wrote each parsed asset to `join(stagedAssets, ...relativePath.split('/'))` with NO
 * confinement, so a crafted `.msbackup` carrying `relativePath: '../../evil'` resolves OUTSIDE the
 * staging dir and `writeFileSync` lands attacker bytes at an arbitrary writable location — the exact
 * archive-extraction class the backup path was called out for. Every OTHER on-disk write in the app
 * routes through a confinement primitive (storage/blob-io.ts confinedAssetPath); the restore path
 * must too. These pins are mutation-verified: revert the confinement and the traversal lands again.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-zipslip-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A live store at `root` (mirrors backup-roundtrip's seed) so the rollback/intact assertions hold.
function seedStore(root: string): { dbPath: string; assetsRoot: string } {
  const dbPath = join(root, 'meetingspace.db');
  const assetsRoot = join(root, 'assets');
  mkdirSync(root, { recursive: true });
  const db = openDatabase(dbPath);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    'sess-1',
    DEFAULT_SPACE_ID,
    'Original',
    1,
    1,
  );
  db.close();
  mkdirSync(join(assetsRoot, 'sess-1'), { recursive: true });
  writeFileSync(join(assetsRoot, 'sess-1', 'a1.png'), Buffer.from([10, 20, 30, 40]));
  return { dbPath, assetsRoot };
}

// A valid container whose asset carries an attacker-chosen relativePath + bytes.
function maliciousBackup(relativePath: string): BackupData {
  const src = seedStore(join(dir, `mal-${relativePath.replace(/[^a-z0-9]/gi, '_')}`));
  const db = openDatabase(src.dbPath);
  const collected = collectBackup({
    db,
    dbFilePath: src.dbPath,
    assetsRoot: src.assetsRoot,
    appVersion: '1.1.0',
    now: () => 1,
  });
  db.close();
  // Replace the legitimate asset entry with the traversal payload.
  const parsed = parseBackupBlob(buildBackupBlob(collected));
  return {
    ...parsed,
    assets: [{ relativePath, bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }],
  };
}

describe('confinedStagingPath — staging-write confinement primitive', () => {
  it('resolves a normal posix relativePath inside the staging root', () => {
    const root = join(dir, 'staging');
    const result = confinedStagingPath(root, 'sess-1/a1.png');
    expect(result).toBe(join(root, 'sess-1', 'a1.png'));
  });

  it('REJECTS a parent-climbing path (../) — returns null', () => {
    const root = join(dir, 'staging');
    expect(confinedStagingPath(root, '../evil.txt')).toBeNull();
    expect(confinedStagingPath(root, '../../../../Startup/run.bat')).toBeNull();
    expect(confinedStagingPath(root, 'sess-1/../../escape')).toBeNull();
  });

  it('REJECTS an absolute path — returns null', () => {
    const root = join(dir, 'staging');
    expect(confinedStagingPath(root, 'C:/Windows/evil.txt')).toBeNull();
    expect(confinedStagingPath(root, '/etc/evil')).toBeNull();
  });

  it('REJECTS an empty path — returns null', () => {
    expect(confinedStagingPath(join(dir, 'staging'), '')).toBeNull();
  });
});

describe('applyBackup — zip-slip containment (S2-001)', () => {
  it('THROWS on a traversal relativePath and writes NO bytes outside the staging dir', () => {
    const live = seedStore(join(dir, 'live'));
    const parent = dirname(live.dbPath);
    // The traversal target a vulnerable writeFileSync would create, one level above the data root.
    const escapeTarget = join(parent, '..', 'pwned.txt');

    expect(() =>
      applyBackup({
        targetDbFilePath: live.dbPath,
        targetAssetsRoot: live.assetsRoot,
        parsed: maliciousBackup('../../pwned.txt'),
      }),
    ).toThrow();

    expect(existsSync(escapeTarget)).toBe(false);
  });

  it('rejects an absolute-path asset entry without writing it', () => {
    const live = seedStore(join(dir, 'live-abs'));
    const absTarget = join(dir, 'abs-escape.txt');

    expect(() =>
      applyBackup({
        targetDbFilePath: live.dbPath,
        targetAssetsRoot: live.assetsRoot,
        parsed: maliciousBackup(absTarget.split('\\').join('/')),
      }),
    ).toThrow();

    expect(existsSync(absTarget)).toBe(false);
  });

  it('leaves the ORIGINAL live store intact when a traversal entry is rejected (fails during staging)', () => {
    const live = seedStore(join(dir, 'live-intact'));

    expect(() =>
      applyBackup({
        targetDbFilePath: live.dbPath,
        targetAssetsRoot: live.assetsRoot,
        parsed: maliciousBackup('../../pwned.txt'),
      }),
    ).toThrow();

    // The live DB + asset blob are untouched (the rejection fires before any swap).
    const db = openDatabase(live.dbPath);
    const name = (
      db.prepare('SELECT name FROM sessions WHERE id = ?').get('sess-1') as {
        name: string;
      }
    ).name;
    db.close();
    expect(name).toBe('Original');
    expect([...readFileSync(join(live.assetsRoot, 'sess-1', 'a1.png'))]).toEqual([10, 20, 30, 40]);
  });
});
