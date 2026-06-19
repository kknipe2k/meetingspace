import type { AppApi } from '@shared/api';
import type { AppCommand } from '@shared/types';

import { APP_CHANNELS } from './channels';
import type { IpcStreamTransport } from './llm-bridge';

/*
 * The renderer-facing app bridge (M06.A). The native menu's Find / New Session / Appearance
 * forward over app:command; the window's full-screen state arrives over app:fullScreenChange;
 * `exitFullScreen` invokes back to leave full screen (the toast's Exit control). Pure and
 * transport-agnostic (it takes the shared `{ on, invoke }` transport), so the mapping is
 * Node-unit-testable, leaving preload.ts thin. No key, no DB handle.
 */
export function createAppApi(transport: Pick<IpcStreamTransport, 'on' | 'invoke'>): AppApi {
  return {
    onCommand: (listener: (command: AppCommand) => void): (() => void) =>
      transport.on(APP_CHANNELS.command, (payload) => listener(payload as AppCommand)),

    onFullScreenChange: (listener: (isFullScreen: boolean) => void): (() => void) =>
      transport.on(APP_CHANNELS.fullScreenChange, (payload) => listener(payload as boolean)),

    exitFullScreen: (): void => {
      void transport.invoke(APP_CHANNELS.exitFullScreen);
    },
  };
}
