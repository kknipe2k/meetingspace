import { describe, expect, it } from 'vitest';

import {
  createWindowApi,
  type AppApi,
  type AssetsApi,
  type CaptureApi,
  type CatalogApi,
  type GenApi,
  type LlmApi,
  type NotesApi,
  type SearchApi,
  type SessionApi,
  type SettingsApi,
  type StorageApi,
  type UsageApi,
} from '@shared/api';

// Stand-in APIs; createWindowApi only composes the bridge object — the real
// ipcRenderer mapping is covered by the *-bridge unit tests.
const noopSessions: SessionApi = {
  create: () => Promise.resolve({} as never),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(null),
  rename: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deleteMany: () => Promise.resolve(),
};

const noopNotes: NotesApi = {
  add: () => Promise.resolve({} as never),
  addWithContent: () => Promise.resolve({} as never),
  list: () => Promise.resolve([]),
  update: () => Promise.resolve({} as never),
  updateSync: () => ({}) as never,
  delete: () => Promise.resolve(),
  reorder: () => Promise.resolve(),
};

const noopAssets: AssetsApi = {
  save: () => Promise.resolve({} as never),
  list: () => Promise.resolve([]),
  delete: () => Promise.resolve(),
};

const noopCapture: CaptureApi = {
  listSources: () => Promise.resolve({ permission: 'granted', sources: [] }),
  grab: () => Promise.resolve(new ArrayBuffer(0)),
};

const noopSettings: SettingsApi = {
  setKey: () => Promise.resolve({ ok: true }),
  keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
  clearKey: () => Promise.resolve(),
  getPrefs: () => Promise.resolve({}),
  setPrefs: () => Promise.resolve({}),
  getProvider: () => Promise.resolve({ provider: 'anthropic' }),
  setProvider: (provider) => Promise.resolve(provider),
};

const noopLlm: LlmApi = {
  chat: () => () => undefined,
  history: () => Promise.resolve([]),
};

const noopHandle = { detach: () => undefined, cancel: () => undefined };
const noopGen: GenApi = {
  generateFocus: () => noopHandle,
  generateWhitepaper: () => noopHandle,
  generateMinutes: () => noopHandle,
  attach: () => noopHandle,
  status: () => Promise.resolve(null),
  cancel: () => Promise.resolve(),
  onArtifactSaved: () => () => undefined,
  onRunStarted: () => () => undefined,
  onRunEnded: () => () => undefined,
  onProgress: () => () => undefined,
  getLatestArtifacts: () => Promise.resolve([]),
  buildRawDoc: () => Promise.resolve(''),
  exportImages: () => Promise.resolve({ images: [], omittedCount: 0 }),
  exportHtml: () => Promise.resolve({ saved: false }),
  exportMarkdown: () => Promise.resolve({ saved: false }),
  exportPdf: () => Promise.resolve({ saved: false }),
  listTemplates: () => Promise.resolve([]),
  saveTemplate: () => Promise.resolve({} as never),
  getTemplate: () => Promise.resolve(null),
  deleteTemplate: () => Promise.resolve(),
  getArtifacts: () => Promise.resolve([]),
};

const noopSearch: SearchApi = {
  notes: () => Promise.resolve([]),
};

const noopStorage: StorageApi = {
  summary: () => Promise.resolve({ totalBytes: 0, perSession: [] }),
  backup: () => Promise.resolve({ saved: false }),
  restore: () => Promise.resolve({ restored: false, reason: 'cancelled' }),
};

const noopApp: AppApi = {
  onCommand: () => () => undefined,
  onFullScreenChange: () => () => undefined,
  exitFullScreen: () => undefined,
};

const noopCatalog: CatalogApi = {
  list: () => Promise.resolve([]),
  refresh: () => Promise.resolve([]),
};

const noopUsage: UsageApi = {
  summary: () =>
    Promise.resolve({
      sessionToday: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
      allToday: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
    }),
  pricing: () => Promise.resolve([]),
};

function buildApi() {
  return createWindowApi(
    noopSessions,
    noopNotes,
    noopAssets,
    noopCapture,
    noopSettings,
    noopLlm,
    noopGen,
    noopSearch,
    noopStorage,
    noopApp,
    noopCatalog,
    noopUsage,
  );
}

describe('preload contextBridge contract', () => {
  it('exposes the meta surface plus the session, notes, assets, capture, settings, llm, gen, search, app, catalog, and usage APIs', () => {
    const api = buildApi();

    expect(Object.keys(api).sort()).toEqual([
      'app',
      'assets',
      'capture',
      'catalog',
      'gen',
      'llm',
      'meta',
      'notes',
      'search',
      'sessions',
      'settings',
      'storage',
      'usage',
    ]);
  });

  it('exposes exactly the app command + full-screen methods on the bridge', () => {
    expect(Object.keys(buildApi().app).sort()).toEqual([
      'exitFullScreen',
      'onCommand',
      'onFullScreenChange',
    ]);
  });

  it('identifies the app on the bridge', () => {
    expect(buildApi().meta.appName).toBe('MeetingSpace');
  });

  it('exposes exactly the session methods on the bridge', () => {
    expect(Object.keys(buildApi().sessions).sort()).toEqual([
      'create',
      'delete',
      'deleteMany',
      'get',
      'list',
      'rename',
    ]);
  });

  it('exposes exactly the note methods on the bridge', () => {
    expect(Object.keys(buildApi().notes).sort()).toEqual([
      'add',
      'addWithContent',
      'delete',
      'list',
      'reorder',
      'update',
      'updateSync',
    ]);
  });

  it('exposes exactly the asset methods on the bridge', () => {
    expect(Object.keys(buildApi().assets).sort()).toEqual(['delete', 'list', 'save']);
  });

  it('exposes exactly the capture methods on the bridge', () => {
    expect(Object.keys(buildApi().capture).sort()).toEqual(['grab', 'listSources']);
  });

  it('exposes exactly the settings methods on the bridge — and no key-read method', () => {
    const keys = Object.keys(buildApi().settings).sort();

    expect(keys).toEqual([
      'clearKey',
      'getPrefs',
      'getProvider',
      'keyStatus',
      'setKey',
      'setPrefs',
      'setProvider',
    ]);
    // The renderer can set or clear the key and read its status, but there is no
    // method that returns the key itself.
    expect(keys).not.toContain('getKey');
  });

  it('exposes exactly the llm chat + history methods on the bridge', () => {
    expect(Object.keys(buildApi().llm).sort()).toEqual(['chat', 'history']);
  });

  it('exposes exactly the generation methods on the bridge', () => {
    expect(Object.keys(buildApi().gen).sort()).toEqual([
      // M07.B (F12): reattach to a live run, query in-flight state, persist broadcast.
      // (IRL reversal adds cancel-by-id + the app-level run-lifecycle subscriptions.)
      'attach',
      'buildRawDoc',
      'cancel',
      'deleteTemplate',
      'exportHtml',
      'exportImages',
      'exportMarkdown',
      'exportPdf',
      'generateFocus',
      'generateMinutes',
      'generateWhitepaper',
      'getArtifacts',
      'getLatestArtifacts',
      'getTemplate',
      'listTemplates',
      'onArtifactSaved',
      // M07.C: the unkeyed progress feed for the app-level run toast.
      'onProgress',
      'onRunEnded',
      'onRunStarted',
      'saveTemplate',
      'status',
    ]);
  });

  it('exposes exactly the search method on the bridge', () => {
    expect(Object.keys(buildApi().search).sort()).toEqual(['notes']);
  });
});
