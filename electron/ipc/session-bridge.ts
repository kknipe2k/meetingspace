import type { SessionApi } from '@shared/api';
import type { Session } from '@shared/types';

import { SESSION_CHANNELS } from './channels';

/*
 * Builds the renderer-facing SessionApi over an injected `invoke` transport
 * (ipcRenderer.invoke in the preload). Kept pure and transport-agnostic so the
 * channel mapping is unit-testable under Node without an Electron runtime
 * (tests/unit/session-bridge.test.ts), leaving electron/preload.ts a thin shell.
 *
 * Only these typed methods are exposed across the contextBridge — there is no
 * generic invoke, so the renderer cannot reach an arbitrary channel. Note-block
 * methods live on the parallel notes bridge (notes-bridge.ts).
 */
export type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createSessionApi(invoke: IpcInvoke): SessionApi {
  return {
    create: (name) => invoke(SESSION_CHANNELS.create, name) as Promise<Session>,
    list: () => invoke(SESSION_CHANNELS.list) as Promise<Session[]>,
    get: (id) => invoke(SESSION_CHANNELS.get, id) as Promise<Session | null>,
    rename: (id, name) => invoke(SESSION_CHANNELS.rename, id, name) as Promise<void>,
    delete: (id) => invoke(SESSION_CHANNELS.delete, id) as Promise<void>,
    deleteMany: (ids) => invoke(SESSION_CHANNELS.deleteMany, ids) as Promise<void>,
  };
}
