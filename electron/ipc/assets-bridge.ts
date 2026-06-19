import type { AssetsApi } from '@shared/api';
import type { Asset } from '@shared/types';

import { ASSET_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * Builds the renderer-facing AssetsApi over an injected `invoke` transport
 * (ipcRenderer.invoke in the preload). Pure and transport-agnostic so the
 * channel mapping is unit-testable under Node without an Electron runtime
 * (tests/unit/assets-bridge.test.ts). Only these typed methods cross the
 * contextBridge — no generic invoke reaches the renderer. Image bytes ride as an
 * ArrayBuffer through structured clone.
 */
export function createAssetsApi(invoke: IpcInvoke): AssetsApi {
  return {
    save: (sessionId, bytes, mime, kind) =>
      invoke(ASSET_CHANNELS.save, sessionId, bytes, mime, kind) as Promise<Asset>,
    list: (sessionId) => invoke(ASSET_CHANNELS.list, sessionId) as Promise<Asset[]>,
    delete: (id) => invoke(ASSET_CHANNELS.delete, id) as Promise<void>,
  };
}
