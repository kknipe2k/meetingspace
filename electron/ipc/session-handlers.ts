import type { SessionStore } from '../storage/sessions';

import { SESSION_CHANNELS } from './channels';

/*
 * Registers the session IPC handlers against an injected registrar (Electron's
 * ipcMain in production; a fake in tests). Taking the registrar by injection —
 * rather than importing ipcMain here — keeps this module loadable and fully
 * exercisable under the Node test runtime (tests/ipc/session-handlers.test.ts).
 *
 * The renderer is sandboxed, but the main process still validates argument types
 * at the boundary (spec §5 — "which side validates"): the main process is the
 * trust boundary for storage, so a malformed call fails loudly here.
 */
type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcHandleRegistrar {
  handle(channel: string, handler: IpcInvokeHandler): void;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`session ipc: ${field} must be a string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`session ipc: ${field} must be an array of strings`);
  }
  return value as string[];
}

/*
 * Side effects to run after a session row is deleted. `afterSessionDelete` lets
 * main.ts hang per-session blob-directory cleanup off the delete path: the FK
 * cascade drops the asset ROWS, but the FILES need an explicit unlink or they
 * leak (M02.B orphan safety). Injected (not imported) so the wiring stays
 * testable without an AssetStore.
 */
export interface SessionHandlerHooks {
  afterSessionDelete?(id: string): void;
  // M06.B: a per-session blob-cleanup failure during bulk delete (EBUSY, gotcha #10) must not
  // half-abort the loop — the row deletes are already committed. The handler reports each failure
  // here (surfaced/logged main-side) and continues; a leftover blob dir is a soft orphan, never a
  // data-integrity failure.
  onCleanupError?(id: string, error: unknown): void;
}

export function registerSessionHandlers(
  registrar: IpcHandleRegistrar,
  store: SessionStore,
  hooks: SessionHandlerHooks = {},
): void {
  registrar.handle(SESSION_CHANNELS.create, (_event, name) =>
    store.createSession(asString(name, 'name')),
  );
  registrar.handle(SESSION_CHANNELS.list, () => store.listSessions());
  registrar.handle(
    SESSION_CHANNELS.get,
    (_event, id) => store.getSession(asString(id, 'id')) ?? null,
  );
  registrar.handle(SESSION_CHANNELS.rename, (_event, id, name) =>
    store.renameSession(asString(id, 'id'), asString(name, 'name')),
  );
  registrar.handle(SESSION_CHANNELS.delete, (_event, id) => {
    const sessionId = asString(id, 'id');
    store.deleteSession(sessionId);
    hooks.afterSessionDelete?.(sessionId);
  });
  registrar.handle(SESSION_CHANNELS.deleteMany, (_event, ids) => {
    const sessionIds = asStringArray(ids, 'ids');
    // One transaction deletes every row (FK cascade drops notes/assets/documents). Then per-id
    // blob-dir cleanup, each guarded so one failure (EBUSY) never half-aborts the rest — the rows
    // are already committed, so a leftover dir is a soft orphan reported via onCleanupError.
    store.deleteSessions(sessionIds);
    for (const sessionId of sessionIds) {
      try {
        hooks.afterSessionDelete?.(sessionId);
      } catch (error) {
        hooks.onCleanupError?.(sessionId, error);
      }
    }
  });
}
