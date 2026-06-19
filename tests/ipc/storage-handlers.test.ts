import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackupService } from '../../electron/backup';
import { STORAGE_CHANNELS } from '../../electron/ipc/channels';
import { registerStorageHandlers } from '../../electron/ipc/storage-handlers';
import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import { StorageStore } from '../../electron/storage/storage-store';

/*
 * The storage:summary IPC handler (M06.B, F28) — a plain request/response over a real
 * StorageStore against a temp SQLite db. No key, no SDK, no DB handle crosses to the renderer:
 * only the aggregated byte counts.
 */
function fakeIpc(): {
  registrar: {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  };
  invoke(channel: string, ...args: unknown[]): unknown;
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    registrar: { handle: (channel, handler) => void handlers.set(channel, handler) },
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({}, ...args);
    },
  };
}

let dir: string;
let db: ReturnType<typeof openDatabase>;
let ipc: ReturnType<typeof fakeIpc>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-storage-ipc-'));
  db = openDatabase(join(dir, 'store.db'));
  db.prepare(
    'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', DEFAULT_SPACE_ID, 'Alpha', 1, 1);
  db.prepare(
    'INSERT INTO notes (id, session_id, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('n1', 's1', 'hello', 0, 1, 1);
  ipc = fakeIpc();
  registerStorageHandlers(ipc.registrar, new StorageStore(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('storage IPC handler', () => {
  it('summary returns per-session + total byte accounting', () => {
    const summary = ipc.invoke(STORAGE_CHANNELS.summary) as {
      totalBytes: number;
      perSession: Array<{ sessionId: string; name: string; bytes: number }>;
    };
    expect(summary.totalBytes).toBe(5);
    expect(summary.perSession).toEqual([{ sessionId: 's1', name: 'Alpha', bytes: 5 }]);
  });

  it('does NOT register backup/restore without a backup service (M06.C)', () => {
    expect(() => ipc.invoke(STORAGE_CHANNELS.backup)).toThrow();
    expect(() => ipc.invoke(STORAGE_CHANNELS.restore)).toThrow();
  });

  it('delegates backup/restore to the injected service (M06.C)', async () => {
    const backup: BackupService = {
      backup: vi.fn().mockResolvedValue({ saved: true, path: 'C:/out/x.msbackup' }),
      restore: vi.fn().mockResolvedValue({ restored: true }),
    };
    const ipc2 = fakeIpc();
    registerStorageHandlers(ipc2.registrar, new StorageStore(db), backup);
    expect(await ipc2.invoke(STORAGE_CHANNELS.backup)).toEqual({
      saved: true,
      path: 'C:/out/x.msbackup',
    });
    expect(await ipc2.invoke(STORAGE_CHANNELS.restore)).toEqual({ restored: true });
    expect(backup.backup).toHaveBeenCalled();
    expect(backup.restore).toHaveBeenCalled();
  });
});
