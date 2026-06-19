import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOTE_CHANNELS } from '../../electron/ipc/channels';
import { MAX_NOTE_BYTES, registerNoteHandlers } from '../../electron/ipc/note-handlers';
import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';

// A fake registrar capturing handlers by channel, so the note IPC surface is
// exercised under Node without an Electron ipcMain (mirrors session-handlers.test).
type Handler = (event: unknown, ...args: unknown[]) => unknown;

type SyncHandler = (event: { returnValue: unknown }, ...args: unknown[]) => void;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  on: (c: string, h: SyncHandler) => void;
  handlers: Map<string, Handler>;
  syncHandlers: Map<string, SyncHandler>;
} {
  const handlers = new Map<string, Handler>();
  const syncHandlers = new Map<string, SyncHandler>();
  return {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => syncHandlers.set(channel, handler),
    handlers,
    syncHandlers,
  };
}

let dir: string;
let db: ReturnType<typeof openDatabase>;
let handlers: Map<string, Handler>;
let syncHandlers: Map<string, SyncHandler>;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-notehandlers-'));
  db = openDatabase(join(dir, 'store.db'));
  sessionId = new SessionStore(db).createSession('S').id;
  const registrar = fakeRegistrar();
  registerNoteHandlers(registrar, new NoteStore(db));
  handlers = registrar.handlers;
  syncHandlers = registrar.syncHandlers;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({}, ...args);
}

describe('note IPC handlers', () => {
  it('registers exactly the six note channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        NOTE_CHANNELS.add,
        NOTE_CHANNELS.addWithContent,
        NOTE_CHANNELS.list,
        NOTE_CHANNELS.update,
        NOTE_CHANNELS.delete,
        NOTE_CHANNELS.reorder,
      ].sort(),
    );
  });

  it('addWithContent seeds a block with content in one call', () => {
    const seeded = call(NOTE_CHANNELS.addWithContent, sessionId, 'x.md\n\nbody') as {
      id: string;
      content: string;
    };
    expect(seeded.content).toBe('x.md\n\nbody');
    expect((call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string }>).map((n) => n.id)).toEqual(
      [seeded.id],
    );
  });

  it('rejects an oversized upload at the boundary, and accepts content right at the cap', () => {
    expect(() =>
      call(NOTE_CHANNELS.addWithContent, sessionId, 'x'.repeat(MAX_NOTE_BYTES + 1)),
    ).toThrow(RangeError);
    expect(() =>
      call(NOTE_CHANNELS.addWithContent, sessionId, 'x'.repeat(MAX_NOTE_BYTES)),
    ).not.toThrow();
  });

  it('enforces the same byte cap on note:update and note:updateSync (audit S6-003)', () => {
    const a = call(NOTE_CHANNELS.add, sessionId) as { id: string };
    const tooBig = 'x'.repeat(MAX_NOTE_BYTES + 1);

    // async update path
    expect(() => call(NOTE_CHANNELS.update, a.id, tooBig)).toThrow(RangeError);

    // sync update path (D-03 edit-then-quit flush) — same cap, not just asString
    const handler = syncHandlers.get(NOTE_CHANNELS.updateSync);
    const event = { returnValue: undefined as unknown };
    expect(() => handler?.(event, a.id, tooBig)).toThrow(RangeError);

    // content right at the cap still goes through
    expect(() => call(NOTE_CHANNELS.update, a.id, 'x'.repeat(MAX_NOTE_BYTES))).not.toThrow();
  });

  it('add → list → update → delete round-trips through the handlers', () => {
    const a = call(NOTE_CHANNELS.add, sessionId) as { id: string };
    const b = call(NOTE_CHANNELS.add, sessionId) as { id: string };
    expect((call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string }>).map((n) => n.id)).toEqual(
      [a.id, b.id],
    );

    call(NOTE_CHANNELS.update, a.id, 'edited');
    expect(
      (call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string; content: string }>).find(
        (n) => n.id === a.id,
      )?.content,
    ).toBe('edited');

    call(NOTE_CHANNELS.delete, b.id);
    expect((call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string }>).map((n) => n.id)).toEqual(
      [a.id],
    );
  });

  it('reorder applies the new id order', () => {
    const a = call(NOTE_CHANNELS.add, sessionId) as { id: string };
    const b = call(NOTE_CHANNELS.add, sessionId) as { id: string };
    call(NOTE_CHANNELS.reorder, sessionId, [b.id, a.id]);
    expect((call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string }>).map((n) => n.id)).toEqual(
      [b.id, a.id],
    );
  });

  it('note:updateSync writes synchronously via event.returnValue (D-03 edit-then-quit path)', () => {
    const a = call(NOTE_CHANNELS.add, sessionId) as { id: string };

    const handler = syncHandlers.get(NOTE_CHANNELS.updateSync);
    expect(handler).toBeDefined();

    const event = { returnValue: undefined as unknown };
    handler?.(event, a.id, 'flushed on quit');

    // The handler set the updated row as the synchronous return value...
    expect((event.returnValue as { id: string; content: string }).content).toBe('flushed on quit');
    // ...and the write actually landed in SQLite (so reopen + FTS see it).
    expect(
      (call(NOTE_CHANNELS.list, sessionId) as Array<{ id: string; content: string }>).find(
        (n) => n.id === a.id,
      )?.content,
    ).toBe('flushed on quit');
  });

  it('note:updateSync validates argument types at the main-process boundary', () => {
    const handler = syncHandlers.get(NOTE_CHANNELS.updateSync);
    const event = { returnValue: undefined as unknown };
    expect(() => handler?.(event, 123, 'body')).toThrow(TypeError);
    expect(() => handler?.(event, 'id', 42)).toThrow(TypeError);
  });

  it('validates argument types at the main-process boundary', () => {
    expect(() => call(NOTE_CHANNELS.add, 123)).toThrow(TypeError);
    expect(() => call(NOTE_CHANNELS.addWithContent, 123, 'body')).toThrow(TypeError);
    expect(() => call(NOTE_CHANNELS.addWithContent, sessionId, 42)).toThrow(TypeError);
    expect(() => call(NOTE_CHANNELS.update, 'id', 42)).toThrow(TypeError);
    expect(() => call(NOTE_CHANNELS.reorder, sessionId, 'not-an-array')).toThrow(TypeError);
    expect(() => call(NOTE_CHANNELS.reorder, sessionId, [1, 2])).toThrow(TypeError);
  });
});
