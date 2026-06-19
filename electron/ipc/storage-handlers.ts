import type { BackupService } from '../backup';
import type { StorageStore } from '../storage/storage-store';

import { STORAGE_CHANNELS } from './channels';

/*
 * Registers the storage IPC handlers against an injected registrar (Electron's ipcMain in
 * production; a fake in tests — tests/ipc/storage-handlers.test.ts), so this module is fully
 * exercisable under the Node test runtime. `storage:summary` returns aggregate byte counts only.
 * `storage:backup`/`storage:restore` (M06.C) delegate to the injected BackupService — the actual
 * dialog/relaunch/db-close are inside that service's main.ts deps. No key, no DB handle, no raw
 * filesystem path crosses to the renderer — only the typed summary / backup / restore results.
 */
type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcHandleRegistrar {
  handle(channel: string, handler: IpcInvokeHandler): void;
}

export function registerStorageHandlers(
  registrar: IpcHandleRegistrar,
  store: StorageStore,
  backup?: BackupService,
): void {
  registrar.handle(STORAGE_CHANNELS.summary, () => store.summary());
  if (backup) {
    registrar.handle(STORAGE_CHANNELS.backup, () => backup.backup());
    registrar.handle(STORAGE_CHANNELS.restore, () => backup.restore());
  }
}
