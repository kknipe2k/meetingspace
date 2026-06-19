import { MAX_NOTE_BYTES } from '@shared/limits';

import type { NoteStore } from '../storage/notes';

import { NOTE_CHANNELS } from './channels';

/*
 * Registers the note-block IPC handlers against an injected registrar (Electron's
 * ipcMain in production; a fake in tests — tests/ipc/note-handlers.test.ts), so
 * this module is fully exercisable under the Node test runtime.
 *
 * The renderer is sandboxed, but the main process still validates argument types
 * at the trust boundary (spec §5 — "which side validates"): a malformed call
 * fails loudly here rather than reaching SQLite.
 */
type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcHandleRegistrar {
  handle(channel: string, handler: IpcInvokeHandler): void;
}

// Synchronous IPC (ipcMain.on): the handler sets `event.returnValue` and sendSync
// returns it to the renderer. Only `note:updateSync` uses this (D-03 teardown flush);
// the registrar is extended structurally so it stays fake-testable under Node.
type IpcSyncHandler = (event: { returnValue: unknown }, ...args: unknown[]) => void;

export interface IpcSyncRegistrar {
  on(channel: string, handler: IpcSyncHandler): void;
}

// 5 MiB — generous for a pasted/uploaded transcript or note, small enough to reject a runaway
// upload. Measured as UTF-8 bytes (not JS string length) so multi-byte text is bounded by what
// actually lands on disk (M02.D upload path). Re-exported from the shared single source (M06.B)
// so the renderer can precheck and give a size-helpful message before the boundary rejects.
export { MAX_NOTE_BYTES };

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`note ipc: ${field} must be a string`);
  }
  return value;
}

function asBoundedContent(value: unknown): string {
  const content = asString(value, 'content');
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
    throw new RangeError(`note ipc: content exceeds ${MAX_NOTE_BYTES} bytes`);
  }
  return content;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`note ipc: ${field} must be an array of strings`);
  }
  return value as string[];
}

export function registerNoteHandlers(
  registrar: IpcHandleRegistrar & IpcSyncRegistrar,
  store: NoteStore,
): void {
  // Synchronous twin of `update` (D-03): mirrors the async handler's validation, but
  // returns the written row via `event.returnValue` so the renderer's pagehide flush
  // blocks until the write has landed in SQLite. No key, no SDK — one note write.
  registrar.on(NOTE_CHANNELS.updateSync, (event, id, content) => {
    event.returnValue = store.updateNote(asString(id, 'id'), asBoundedContent(content));
  });
  registrar.handle(NOTE_CHANNELS.add, (_event, sessionId) =>
    store.addNote(asString(sessionId, 'sessionId')),
  );
  registrar.handle(NOTE_CHANNELS.addWithContent, (_event, sessionId, content) =>
    store.addNoteWithContent(asString(sessionId, 'sessionId'), asBoundedContent(content)),
  );
  registrar.handle(NOTE_CHANNELS.list, (_event, sessionId) =>
    store.listNotes(asString(sessionId, 'sessionId')),
  );
  registrar.handle(NOTE_CHANNELS.update, (_event, id, content) =>
    store.updateNote(asString(id, 'id'), asBoundedContent(content)),
  );
  registrar.handle(NOTE_CHANNELS.delete, (_event, id) => store.deleteNote(asString(id, 'id')));
  registrar.handle(NOTE_CHANNELS.reorder, (_event, sessionId, orderedIds) =>
    store.reorderNotes(asString(sessionId, 'sessionId'), asStringArray(orderedIds, 'orderedIds')),
  );
}
