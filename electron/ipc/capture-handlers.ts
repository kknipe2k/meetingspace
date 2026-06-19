import type { CaptureService } from '../screen-capture';

import { CAPTURE_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * Registers the screen-capture IPC handlers against an injected registrar
 * (Electron's ipcMain in production; a fake in tests). The capture logic lives in
 * the injected CaptureService (electron/screen-capture.ts); this layer is the
 * main-process trust boundary — it validates the renderer's argument before the
 * service runs, so a malformed grab fails loudly rather than reaching the OS call.
 */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`capture ipc: ${field} must be a string`);
  }
  return value;
}

export function registerCaptureHandlers(
  registrar: IpcHandleRegistrar,
  service: CaptureService,
): void {
  registrar.handle(CAPTURE_CHANNELS.listSources, () => service.listSources());
  registrar.handle(CAPTURE_CHANNELS.grab, (_event, sourceId) =>
    service.grab(asString(sourceId, 'sourceId')),
  );
}
