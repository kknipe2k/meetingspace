import type { StorageApi } from '@shared/api';
import type { BackupResult, RestoreResult, StorageSummary } from '@shared/types';

import { STORAGE_CHANNELS } from './channels';

/*
 * Builds the renderer-facing StorageApi over an injected `invoke` transport (ipcRenderer.invoke in
 * the preload). Pure + transport-agnostic so the channel mapping is unit-testable under Node
 * without an Electron runtime, leaving electron/preload.ts a thin shell. Only this typed method
 * crosses — no generic invoke (M06.B / F28).
 */
export type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createStorageApi(invoke: IpcInvoke): StorageApi {
  return {
    summary: () => invoke(STORAGE_CHANNELS.summary) as Promise<StorageSummary>,
    backup: () => invoke(STORAGE_CHANNELS.backup) as Promise<BackupResult>,
    restore: () => invoke(STORAGE_CHANNELS.restore) as Promise<RestoreResult>,
  };
}
