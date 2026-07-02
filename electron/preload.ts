import { contextBridge, ipcRenderer } from 'electron';

import { createWindowApi } from '@shared/api';

import { createAppApi } from './ipc/app-bridge';
import { createAssetsApi } from './ipc/assets-bridge';
import { createCaptureApi } from './ipc/capture-bridge';
import { createCatalogApi } from './ipc/catalog-bridge';
import { createGenApi } from './ipc/gen-bridge';
import { createLlmApi } from './ipc/llm-bridge';
import { createPricingApi } from './ipc/pricing-bridge';
import { createUsageApi } from './ipc/usage-bridge';
import { createNotesApi } from './ipc/notes-bridge';
import { createSearchApi } from './ipc/search-bridge';
import { createSessionApi } from './ipc/session-bridge';
import { createSettingsApi } from './ipc/settings-bridge';
import { createStorageApi } from './ipc/storage-bridge';

// Thin contextBridge shell: wires ipcRenderer.invoke into the (Node-tested)
// session, notes, assets, capture, and settings bridges and exposes only the typed
// window.api surface. No channel strings or Node modules reach the renderer, and no
// bridge carries the API key (settings exposes booleans + a one-way setKey only;
// the llm bridge carries chat requests + streamed result chunks, never the key/SDK).
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args);
// Synchronous transport for the single note:updateSync channel (D-03 teardown flush);
// blocks the renderer until main commits the write, so an edit-then-quit isn't lost.
const sendSync = (channel: string, ...args: unknown[]): unknown =>
  ipcRenderer.sendSync(channel, ...args);
const sessions = createSessionApi(invoke);
const notes = createNotesApi(invoke, sendSync);
const assets = createAssetsApi(invoke);
const capture = createCaptureApi(invoke);
const settings = createSettingsApi(invoke);
const search = createSearchApi(invoke);
const storage = createStorageApi(invoke);
const catalog = createCatalogApi(invoke);
const usage = createUsageApi(invoke);
const pricing = createPricingApi(invoke);

// The llm + gen bridges need event subscription (requestId-keyed chunk/done/error)
// alongside invoke; `on` returns an unsubscribe that removes the wrapped listener.
const streamTransport = {
  invoke,
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};
const newRequestId = (): string => crypto.randomUUID();
const llm = createLlmApi(streamTransport, newRequestId);
const gen = createGenApi(streamTransport, newRequestId);
// App-level menu commands + full-screen control (M06.A): main↔renderer events + an invoke.
const app = createAppApi(streamTransport);

contextBridge.exposeInMainWorld(
  'api',
  createWindowApi(
    sessions,
    notes,
    assets,
    capture,
    settings,
    llm,
    gen,
    search,
    storage,
    app,
    catalog,
    usage,
    pricing,
  ),
);
