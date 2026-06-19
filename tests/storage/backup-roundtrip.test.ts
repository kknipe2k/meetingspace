import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKUP_MAGIC,
  buildBackupBlob,
  parseBackupBlob,
  checkBackupCompatibility,
  collectBackup,
  applyBackup,
  createBackupService,
  type BackupManifest,
} from '../../electron/backup';
import { openDatabase } from '../../electron/storage/db';
import { SCHEMA_VERSION, DEFAULT_SPACE_ID } from '../../electron/storage/schema';

/*
 * One-file backup/restore (M06.C). Export the whole store — the SQLite DB + every asset blob —
 * to ONE portable, version-stamped file; import restores it losslessly. NO new dependency: a
 * magic-prefixed, gzip (node:zlib) container of a JSON envelope. The whole round-trip is
 * Node-testable (better-sqlite3 + node:fs); only the save/open dialog + app.relaunch are the
 * Electron OS wrappers in main.ts. Version-checked: importing a NEWER-schema backup into an
 * OLDER app must FAIL LOUDLY, never corrupt.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    format: 'msbackup',
    formatVersion: 1,
    appVersion: '1.1.0',
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
    counts: { sessions: 0, notes: 0, assets: 0, documents: 0 },
    ...overrides,
  };
}

// A populated store at `root`: a session with two notes, an asset (+ its blob file), a document.
function seedStore(root: string): { dbPath: string; assetsRoot: string; sessionId: string } {
  const dbPath = join(root, 'meetingspace.db');
  const assetsRoot = join(root, 'assets');
  mkdirSync(root, { recursive: true });
  const db = openDatabase(dbPath);
  const sessionId = 'sess-1';
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    DEFAULT_SPACE_ID,
    'Quarterly review',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('n1', sessionId, 'first note', 0, 1, 1);
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('n2', sessionId, 'second note', 1, 1, 1);
  db.prepare(
    'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('a1', sessionId, 'capture', `${sessionId}/a1.png`, 1, 4);
  db.prepare(
    'INSERT INTO documents (id, session_id, kind, content, template_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('d1', sessionId, 'whitepaper', '<html><body>paper</body></html>', 'default', 1);
  db.close();
  mkdirSync(join(assetsRoot, sessionId), { recursive: true });
  writeFileSync(join(assetsRoot, sessionId, 'a1.png'), Buffer.from([10, 20, 30, 40]));
  return { dbPath, assetsRoot, sessionId };
}

describe('backup container (build/parse)', () => {
  it('round-trips the manifest, DB bytes, and asset blobs losslessly', () => {
    const m = manifest({ counts: { sessions: 1, notes: 2, assets: 1, documents: 1 } });
    const dbBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const assets = [{ relativePath: 'sess-1/a1.png', bytes: new Uint8Array([9, 8, 7]) }];

    const blob = buildBackupBlob({ manifest: m, dbBytes, assets });
    expect(blob.subarray(0, BACKUP_MAGIC.length).toString()).toBe(BACKUP_MAGIC);

    const parsed = parseBackupBlob(blob);
    expect(parsed.manifest).toEqual(m);
    expect([...parsed.dbBytes]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0]?.relativePath).toBe('sess-1/a1.png');
    expect([...parsed.assets[0]!.bytes]).toEqual([9, 8, 7]);
  });

  it('FAILS LOUDLY on a file that is not a backup (bad magic), never silently returns junk', () => {
    expect(() => parseBackupBlob(Buffer.from('just some random file contents'))).toThrow();
  });
});

describe('checkBackupCompatibility', () => {
  it('accepts a backup at or below the current schema version', () => {
    expect(
      checkBackupCompatibility(manifest({ schemaVersion: SCHEMA_VERSION }), SCHEMA_VERSION),
    ).toBe('ok');
    expect(checkBackupCompatibility(manifest({ schemaVersion: 1 }), SCHEMA_VERSION)).toBe('ok');
  });

  it('REJECTS a newer-schema backup (would corrupt an older app)', () => {
    expect(
      checkBackupCompatibility(manifest({ schemaVersion: SCHEMA_VERSION + 1 }), SCHEMA_VERSION),
    ).toBe('incompatible');
  });
});

describe('collectBackup → applyBackup (end-to-end with a real DB)', () => {
  it('reproduces identical sessions/notes/assets/documents after export → wipe → import', () => {
    const src = seedStore(join(dir, 'src'));

    const srcDb = openDatabase(src.dbPath);
    const collected = collectBackup({
      db: srcDb,
      dbFilePath: src.dbPath,
      assetsRoot: src.assetsRoot,
      appVersion: '1.1.0',
      now: () => 1_700_000_000_000,
    });
    srcDb.close();

    expect(collected.manifest.counts).toEqual({ sessions: 1, notes: 2, assets: 1, documents: 1 });

    const blob = buildBackupBlob(collected);
    const parsed = parseBackupBlob(blob);

    // Restore into a FRESH location (simulates wipe → import on another machine).
    const destDbPath = join(dir, 'dest', 'meetingspace.db');
    const destAssetsRoot = join(dir, 'dest', 'assets');
    applyBackup({ targetDbFilePath: destDbPath, targetAssetsRoot: destAssetsRoot, parsed });

    const db = openDatabase(destDbPath);
    const sessions = db.prepare('SELECT id, name FROM sessions').all();
    const notes = db.prepare('SELECT content FROM notes ORDER BY position').all() as {
      content: string;
    }[];
    const docs = db.prepare('SELECT content FROM documents').all() as { content: string }[];
    expect(sessions).toEqual([{ id: src.sessionId, name: 'Quarterly review' }]);
    expect(notes.map((n) => n.content)).toEqual(['first note', 'second note']);
    expect(docs[0]?.content).toBe('<html><body>paper</body></html>');
    db.close();

    // The asset blob bytes survive byte-for-byte.
    const restoredBlob = readFileSync(join(destAssetsRoot, src.sessionId, 'a1.png'));
    expect([...restoredBlob]).toEqual([10, 20, 30, 40]);
  });

  it('excludes regenerable .thumb.jpg derivatives from the backup (they rebuild on restore)', () => {
    const src = seedStore(join(dir, 'src2'));
    writeFileSync(join(src.assetsRoot, src.sessionId, 'a1.thumb.jpg'), Buffer.from('THUMB'));
    const srcDb = openDatabase(src.dbPath);
    const collected = collectBackup({
      db: srcDb,
      dbFilePath: src.dbPath,
      assetsRoot: src.assetsRoot,
      appVersion: '1.1.0',
      now: () => 1,
    });
    srcDb.close();
    expect(collected.assets.some((a) => a.relativePath.endsWith('.thumb.jpg'))).toBe(false);
    expect(collected.assets.some((a) => a.relativePath.endsWith('a1.png'))).toBe(true);
  });
});

/*
 * Restore is DESTRUCTIVE (it replaces the live store) — so it MUST be failure-safe (M06.C 🔴 fix).
 * A valid backup whose unpack/swap fails partway (EBUSY/gotcha §10, disk-full, power-loss) must
 * NEVER leave the user with a half-deleted store: a restore that throws partway leaves the ORIGINAL
 * store FULLY INTACT. Implemented as stage-to-temp + atomic rename-swap with rollback; the `fault`
 * hook injects a throw at a named swap step so the recovery path is mutation-verifiable in Node.
 */
function readStore(dbPath: string, assetsRoot: string, sessionId: string) {
  const db = openDatabase(dbPath);
  const session = db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as
    | { name: string }
    | undefined;
  const notes = (
    db.prepare('SELECT content FROM notes ORDER BY position').all() as { content: string }[]
  ).map((n) => n.content);
  db.close();
  const assetPath = join(assetsRoot, sessionId, 'a1.png');
  const asset = existsSyncSafe(assetPath) ? [...readFileSync(assetPath)] : null;
  return { sessionName: session?.name, notes, asset };
}

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// A parsed backup carrying DIFFERENT (incoming) data; its junk db bytes must never land when the
// restore is faulted. (Valid container shape — the rollback test asserts the ORIGINAL survives.)
function incomingBackup(): ReturnType<typeof parseBackupBlob> {
  const src = seedStore(join(dir, `incoming-${Math.random().toString(36).slice(2)}`));
  const db = openDatabase(src.dbPath);
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run('INCOMING DIFFERENT', src.sessionId);
  db.close();
  writeFileSync(join(src.assetsRoot, src.sessionId, 'a1.png'), Buffer.from([99, 99, 99, 99]));
  const sdb = openDatabase(src.dbPath);
  const collected = collectBackup({
    db: sdb,
    dbFilePath: src.dbPath,
    assetsRoot: src.assetsRoot,
    appVersion: '1.1.0',
    now: () => 1,
  });
  sdb.close();
  return parseBackupBlob(buildBackupBlob(collected));
}

describe('applyBackup — failure-safe restore (rollback)', () => {
  it('replaces the live store in place on a successful restore', () => {
    const live = seedStore(join(dir, 'live-ok'));
    applyBackup({
      targetDbFilePath: live.dbPath,
      targetAssetsRoot: live.assetsRoot,
      parsed: incomingBackup(),
    });
    const after = readStore(live.dbPath, live.assetsRoot, 'sess-1');
    expect(after.sessionName).toBe('INCOMING DIFFERENT');
    expect(after.asset).toEqual([99, 99, 99, 99]);
  });

  it('leaves the ORIGINAL store fully intact when the swap throws mid-way (rollback)', () => {
    const live = seedStore(join(dir, 'live-fault'));
    const parsed = incomingBackup();

    expect(() =>
      applyBackup(
        { targetDbFilePath: live.dbPath, targetAssetsRoot: live.assetsRoot, parsed },
        {
          fault: (step) => {
            if (step === 'after-aside') {
              throw new Error('simulated EBUSY mid-swap');
            }
          },
        },
      ),
    ).toThrow('simulated EBUSY mid-swap');

    // The original store survives untouched — no half-deleted state, no incoming data.
    const after = readStore(live.dbPath, live.assetsRoot, 'sess-1');
    expect(after.sessionName).toBe('Quarterly review');
    expect(after.notes).toEqual(['first note', 'second note']);
    expect(after.asset).toEqual([10, 20, 30, 40]);
  });

  it('leaves the ORIGINAL intact when staging completes but a later step throws (before any swap)', () => {
    const live = seedStore(join(dir, 'live-stage'));
    const parsed = incomingBackup();

    expect(() =>
      applyBackup(
        { targetDbFilePath: live.dbPath, targetAssetsRoot: live.assetsRoot, parsed },
        {
          fault: (step) => {
            if (step === 'after-stage') {
              throw new Error('simulated failure after staging');
            }
          },
        },
      ),
    ).toThrow('simulated failure after staging');

    const after = readStore(live.dbPath, live.assetsRoot, 'sess-1');
    expect(after.sessionName).toBe('Quarterly review');
    expect(after.asset).toEqual([10, 20, 30, 40]);
  });
});

describe('createBackupService', () => {
  function service(overrides: Record<string, unknown> = {}) {
    const calls = {
      apply: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
      notifyRestart: vi.fn(),
      closeDb: vi.fn(),
    };
    const blob = buildBackupBlob({
      manifest: manifest(),
      dbBytes: new Uint8Array([1]),
      assets: [],
    });
    const deps = {
      collect: vi
        .fn()
        .mockReturnValue({ manifest: manifest(), dbBytes: new Uint8Array([1]), assets: [] }),
      save: vi.fn().mockResolvedValue({ saved: true, path: 'C:/out/backup.msbackup' }),
      pickFile: vi.fn().mockResolvedValue(blob),
      confirmReplace: vi.fn().mockResolvedValue(true),
      apply: calls.apply,
      // The restart leg is a branch (packaged → relaunch; dev → notify) with EXACTLY ONE quit on
      // both paths. The OS calls are injected so the branch is testable (the real relaunch/quit/
      // dialog are the excluded main.ts wrappers).
      isPackaged: true,
      relaunch: calls.relaunch,
      quit: calls.quit,
      notifyRestart: calls.notifyRestart,
      closeDb: calls.closeDb,
      currentSchemaVersion: SCHEMA_VERSION,
      ...overrides,
    };
    return { svc: createBackupService(deps as never), deps, calls };
  }

  it('backup() collects, builds the container, and saves it under the chosen path', async () => {
    const { svc, deps } = service();
    const result = await svc.backup();
    expect(deps.collect).toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalled();
    expect(result).toEqual({ saved: true, path: 'C:/out/backup.msbackup' });
  });

  it('PACKAGED restore: closes the DB, applies, relaunches, then quits ONCE (no restart prompt)', async () => {
    const { svc, deps, calls } = service({ isPackaged: true });
    const result = await svc.restore();
    expect(deps.confirmReplace).toHaveBeenCalled();
    expect(calls.closeDb).toHaveBeenCalledTimes(1);
    expect(calls.apply).toHaveBeenCalledTimes(1);
    expect(calls.relaunch).toHaveBeenCalledTimes(1);
    expect(calls.notifyRestart).not.toHaveBeenCalled();
    expect(calls.quit).toHaveBeenCalledTimes(1); // exactly one clean exit
    expect(result).toEqual({ restored: true });
  });

  it('DEV restore: applies, prompts "please restart" (no relaunch), then quits ONCE — no zombie', async () => {
    const { svc, calls } = service({ isPackaged: false });
    const result = await svc.restore();
    expect(calls.apply).toHaveBeenCalledTimes(1);
    expect(calls.relaunch).not.toHaveBeenCalled(); // dev never self-relaunches (the zombie source)
    expect(calls.notifyRestart).toHaveBeenCalledTimes(1);
    expect(calls.quit).toHaveBeenCalledTimes(1); // exactly one clean exit on the dev path too
    expect(result).toEqual({ restored: true });
  });

  it('restore() closes the DB BEFORE applying the swap (release the file lock first)', async () => {
    const order: string[] = [];
    const { svc } = service({
      closeDb: vi.fn(() => order.push('close')),
      apply: vi.fn(() => order.push('apply')),
    });
    await svc.restore();
    expect(order).toEqual(['close', 'apply']);
  });

  it('restore() REFUSES a newer-schema backup loudly — no apply, no relaunch, no quit', async () => {
    const newer = buildBackupBlob({
      manifest: manifest({ schemaVersion: SCHEMA_VERSION + 1 }),
      dbBytes: new Uint8Array([1]),
      assets: [],
    });
    const { svc, calls } = service({ pickFile: vi.fn().mockResolvedValue(newer) });
    const result = await svc.restore();
    expect(result).toEqual({ restored: false, reason: 'incompatible-version' });
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.relaunch).not.toHaveBeenCalled();
    expect(calls.quit).not.toHaveBeenCalled();
  });

  it('restore() is a no-op when the user cancels the file picker', async () => {
    const { svc, calls } = service({ pickFile: vi.fn().mockResolvedValue(null) });
    const result = await svc.restore();
    expect(result).toEqual({ restored: false, reason: 'cancelled' });
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.quit).not.toHaveBeenCalled();
  });

  it('restore() is a no-op when the user declines the destructive-replace confirm', async () => {
    const { svc, calls } = service({ confirmReplace: vi.fn().mockResolvedValue(false) });
    const result = await svc.restore();
    expect(result).toEqual({ restored: false, reason: 'cancelled' });
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.quit).not.toHaveBeenCalled();
  });

  it('restore() reports an invalid (non-backup) file without applying anything', async () => {
    const { svc, calls } = service({ pickFile: vi.fn().mockResolvedValue(Buffer.from('garbage')) });
    const result = await svc.restore();
    expect(result).toEqual({ restored: false, reason: 'invalid' });
    expect(calls.apply).not.toHaveBeenCalled();
    expect(calls.quit).not.toHaveBeenCalled();
  });
});
