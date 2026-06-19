import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_CHANNELS } from '../../electron/ipc/channels';
import { registerSessionHandlers } from '../../electron/ipc/session-handlers';
import { openDatabase } from '../../electron/storage/db';
import { SessionStore } from '../../electron/storage/sessions';

// A fake ipcMain registrar that captures each channel's handler so the test can
// invoke it directly — the handlers are exercised against a real SessionStore
// over a temp SQLite db (no storage mocking; no Electron runtime needed).
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
let store: SessionStore;
let ipc: ReturnType<typeof fakeIpc>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-ipc-'));
  db = openDatabase(join(dir, 'store.db'));
  store = new SessionStore(
    db,
    ((): (() => number) => {
      let value = 1_000;
      return () => value++;
    })(),
  );
  ipc = fakeIpc();
  registerSessionHandlers(ipc.registrar, store);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('session IPC handlers', () => {
  it('registers exactly the five session channels', () => {
    expect(() => ipc.invoke(SESSION_CHANNELS.create, 'x')).not.toThrow();
    expect(() => ipc.invoke(SESSION_CHANNELS.list)).not.toThrow();
    expect(() => ipc.invoke(SESSION_CHANNELS.rename, 'id', 'n')).not.toThrow();
    expect(() => ipc.invoke(SESSION_CHANNELS.delete, 'id')).not.toThrow();
  });

  it('create persists a session and returns the typed shape', () => {
    const created = ipc.invoke(SESSION_CHANNELS.create, 'Design review') as {
      id: string;
      name: string;
    };

    expect(created.name).toBe('Design review');
    expect(store.getSession(created.id)?.name).toBe('Design review');
  });

  it('list returns persisted sessions, most-recently-updated first', () => {
    ipc.invoke(SESSION_CHANNELS.create, 'A');
    const b = ipc.invoke(SESSION_CHANNELS.create, 'B') as { id: string };

    const listed = ipc.invoke(SESSION_CHANNELS.list) as Array<{ id: string }>;

    expect(listed.map((s) => s.id)[0]).toBe(b.id);
    expect(listed).toHaveLength(2);
  });

  it('get returns the session, and null (not undefined) for an unknown id', () => {
    const created = ipc.invoke(SESSION_CHANNELS.create, 'Findable') as { id: string };

    expect((ipc.invoke(SESSION_CHANNELS.get, created.id) as { id: string }).id).toBe(created.id);
    expect(ipc.invoke(SESSION_CHANNELS.get, 'missing')).toBeNull();
  });

  it('rename persists the new name', () => {
    const created = ipc.invoke(SESSION_CHANNELS.create, 'Old') as { id: string };

    ipc.invoke(SESSION_CHANNELS.rename, created.id, 'New');

    expect(store.getSession(created.id)?.name).toBe('New');
  });

  it('delete removes the session', () => {
    const created = ipc.invoke(SESSION_CHANNELS.create, 'Doomed') as { id: string };

    ipc.invoke(SESSION_CHANNELS.delete, created.id);

    expect(store.getSession(created.id)).toBeUndefined();
  });

  it('rejects a non-string name on create (main-side validation)', () => {
    expect(() => ipc.invoke(SESSION_CHANNELS.create, 42)).toThrow(TypeError);
  });

  it('rejects a non-string id on get (main-side validation)', () => {
    expect(() => ipc.invoke(SESSION_CHANNELS.get, undefined)).toThrow(TypeError);
  });
});

/*
 * Bulk delete (M06.B) — the deleteMany channel loops the verified per-session cascade inside
 * ONE transaction (SessionStore.deleteSessions) and then runs per-session blob-dir cleanup via
 * the injected afterSessionDelete hook. RED pin (#3, owner): a per-session cleanup failure
 * (EBUSY, gotcha #10) must NOT half-abort the loop — every id is still attempted, the failure is
 * surfaced via onCleanupError, the operation does not reject (the rows are already committed).
 */
describe('session IPC handlers — bulk delete', () => {
  function setupWithHooks() {
    const ipcWithHooks = fakeIpc();
    const cleaned: string[] = [];
    const cleanupErrors: Array<{ id: string; message: string }> = [];
    const failOn = new Set<string>();
    registerSessionHandlers(ipcWithHooks.registrar, store, {
      afterSessionDelete: (id) => {
        if (failOn.has(id)) {
          throw new Error(`EBUSY cleaning ${id}`);
        }
        cleaned.push(id);
      },
      onCleanupError: (id, err) => {
        cleanupErrors.push({ id, message: (err as Error).message });
      },
    });
    return { ipc: ipcWithHooks, cleaned, cleanupErrors, failOn };
  }

  it('deletes every listed session and runs blob cleanup for each', () => {
    const { ipc: h, cleaned } = setupWithHooks();
    const a = store.createSession('A');
    const b = store.createSession('B');

    h.invoke(SESSION_CHANNELS.deleteMany, [a.id, b.id]);

    expect(store.getSession(a.id)).toBeUndefined();
    expect(store.getSession(b.id)).toBeUndefined();
    expect(cleaned.sort()).toEqual([a.id, b.id].sort());
  });

  it('continues the cleanup loop past a per-session failure and surfaces it (never half-aborts)', () => {
    const { ipc: h, cleaned, cleanupErrors, failOn } = setupWithHooks();
    const a = store.createSession('A');
    const b = store.createSession('B');
    const c = store.createSession('C');
    failOn.add(b.id); // the middle session's blob cleanup throws

    // The operation itself must NOT reject — the rows are committed; a leftover blob dir is soft.
    expect(() => h.invoke(SESSION_CHANNELS.deleteMany, [a.id, b.id, c.id])).not.toThrow();

    // Every row is gone (the transaction committed all three).
    expect(store.listSessions()).toHaveLength(0);
    // Cleanup was attempted for a AND c despite b throwing in the middle.
    expect(cleaned.sort()).toEqual([a.id, c.id].sort());
    // The failure was surfaced, not swallowed.
    expect(cleanupErrors).toHaveLength(1);
    expect(cleanupErrors[0]?.id).toBe(b.id);
  });

  it('rejects a non-array argument and a non-string element (main-side validation)', () => {
    const { ipc: h } = setupWithHooks();
    expect(() => h.invoke(SESSION_CHANNELS.deleteMany, 'not-an-array')).toThrow(TypeError);
    expect(() => h.invoke(SESSION_CHANNELS.deleteMany, ['ok', 42])).toThrow(TypeError);
  });
});
