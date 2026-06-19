import type { NotesApi } from '@shared/api';
import type { Note } from '@shared/types';

import { NOTE_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

// Synchronous transport (ipcRenderer.sendSync in the preload) for the D-03 teardown
// flush — returns the handler's value inline rather than a Promise.
export type IpcSendSync = (channel: string, ...args: unknown[]) => unknown;

/*
 * Builds the renderer-facing NotesApi over an injected `invoke` transport
 * (ipcRenderer.invoke in the preload) plus a `sendSync` transport for the single
 * synchronous method. Pure and transport-agnostic so the channel mapping is
 * unit-testable under Node without an Electron runtime (tests/unit/notes-bridge.test.ts).
 * Only these typed methods cross the contextBridge — no generic invoke/sendSync reaches
 * the renderer.
 */
export function createNotesApi(invoke: IpcInvoke, sendSync?: IpcSendSync): NotesApi {
  return {
    add: (sessionId) => invoke(NOTE_CHANNELS.add, sessionId) as Promise<Note>,
    addWithContent: (sessionId, content) =>
      invoke(NOTE_CHANNELS.addWithContent, sessionId, content) as Promise<Note>,
    list: (sessionId) => invoke(NOTE_CHANNELS.list, sessionId) as Promise<Note[]>,
    update: (id, content) => invoke(NOTE_CHANNELS.update, id, content) as Promise<Note>,
    updateSync: (id, content) => sendSync?.(NOTE_CHANNELS.updateSync, id, content) as Note,
    delete: (id) => invoke(NOTE_CHANNELS.delete, id) as Promise<void>,
    reorder: (sessionId, orderedIds) =>
      invoke(NOTE_CHANNELS.reorder, sessionId, orderedIds) as Promise<void>,
  };
}
