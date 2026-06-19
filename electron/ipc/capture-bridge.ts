import type { CaptureApi } from '@shared/api';
import type { CaptureSourcesResult } from '@shared/types';

import { CAPTURE_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * Builds the renderer-facing CaptureApi over an injected `invoke` transport
 * (ipcRenderer.invoke in the preload). Pure and transport-agnostic so the channel
 * mapping is unit-testable under Node without an Electron runtime
 * (tests/unit/capture-bridge.test.ts). Only these typed methods cross the
 * contextBridge — no generic invoke reaches the renderer. `grab` returns the
 * captured PNG as an ArrayBuffer the renderer hands straight to assets.save.
 */
export function createCaptureApi(invoke: IpcInvoke): CaptureApi {
  return {
    listSources: () => invoke(CAPTURE_CHANNELS.listSources) as Promise<CaptureSourcesResult>,
    grab: (sourceId) => invoke(CAPTURE_CHANNELS.grab, sourceId) as Promise<ArrayBuffer>,
  };
}
