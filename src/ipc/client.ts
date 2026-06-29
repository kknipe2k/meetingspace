import type {
  AppApi,
  AssetsApi,
  CaptureApi,
  CatalogApi,
  GenApi,
  LlmApi,
  NotesApi,
  SearchApi,
  SessionApi,
  SettingsApi,
  StorageApi,
  UsageApi,
  WindowApi,
} from '@shared/api';
import type { GenRunEnded } from '@shared/types';
import { STATIC_CATALOG } from '@shared/models';

/*
 * The renderer's single entry point to the main process. Components and hooks
 * call `sessionClient` / `noteClient`; they never touch `window.api` directly —
 * this is the only module in src/ that reads it (scope lock M01.C; verified by
 * the fan_out_grep on `window.api`). The methods are thin pass-throughs to the
 * typed contextBridge surface so the call site stays free of IPC mechanics.
 */
export type SessionClient = SessionApi;
export type NoteClient = NotesApi;
export type AssetClient = AssetsApi;
export type CaptureClient = CaptureApi;
export type SettingsClient = SettingsApi;
export type LlmClient = LlmApi;
export type GenClient = GenApi;
export type SearchClient = SearchApi;
export type StorageClient = StorageApi;
export type AppClient = AppApi;
export type CatalogClient = CatalogApi;
export type UsageClient = UsageApi;

export const sessionClient: SessionClient = {
  create: (name) => window.api.sessions.create(name),
  list: () => window.api.sessions.list(),
  get: (id) => window.api.sessions.get(id),
  rename: (id, name) => window.api.sessions.rename(id, name),
  delete: (id) => window.api.sessions.delete(id),
  deleteMany: (ids) => window.api.sessions.deleteMany(ids),
};

// Storage meter (M06.B / F28): per-session + total byte usage. Guarded like appClient so the
// jsdom component suites (no `window.api`) degrade to an empty summary rather than throwing.
export const storageClient: StorageClient = {
  summary: () =>
    (window as { api?: WindowApi }).api?.storage.summary() ??
    Promise.resolve({ totalBytes: 0, perSession: [] }),
  // M06.C backup/restore. Guarded like summary so the jsdom suites (no `window.api`) degrade to a
  // cancelled outcome rather than throwing.
  backup: () =>
    (window as { api?: WindowApi }).api?.storage.backup() ?? Promise.resolve({ saved: false }),
  restore: () =>
    (window as { api?: WindowApi }).api?.storage.restore() ??
    Promise.resolve({ restored: false, reason: 'cancelled' }),
};

export const noteClient: NoteClient = {
  add: (sessionId) => window.api.notes.add(sessionId),
  addWithContent: (sessionId, content) => window.api.notes.addWithContent(sessionId, content),
  list: (sessionId) => window.api.notes.list(sessionId),
  update: (id, content) => window.api.notes.update(id, content),
  updateSync: (id, content) => window.api.notes.updateSync(id, content),
  delete: (id) => window.api.notes.delete(id),
  reorder: (sessionId, orderedIds) => window.api.notes.reorder(sessionId, orderedIds),
};

export const assetClient: AssetClient = {
  save: (sessionId, bytes, mime, kind) => window.api.assets.save(sessionId, bytes, mime, kind),
  list: (sessionId) => window.api.assets.list(sessionId),
  delete: (id) => window.api.assets.delete(id),
};

export const captureClient: CaptureClient = {
  listSources: () => window.api.capture.listSources(),
  grab: (sourceId) => window.api.capture.grab(sourceId),
};

export const settingsClient: SettingsClient = {
  setKey: (plaintext, providerId) => window.api.settings.setKey(plaintext, providerId),
  keyStatus: (providerId) => window.api.settings.keyStatus(providerId),
  clearKey: (providerId) => window.api.settings.clearKey(providerId),
  getPrefs: () => window.api.settings.getPrefs(),
  setPrefs: (prefs) => window.api.settings.setPrefs(prefs),
  getProvider: () => window.api.settings.getProvider(),
  setProvider: (provider) => window.api.settings.setProvider(provider),
  pingGateway: () => window.api.settings.pingGateway(),
  listGatewayModels: () => window.api.settings.listGatewayModels?.() ?? Promise.resolve([]),
  diagnoseGatewayModels: (ids) =>
    window.api.settings.diagnoseGatewayModels?.(ids) ?? Promise.resolve([]),
};

// Chat is event-driven (streamed chunks); `chat` returns an unsubscribe. The
// renderer holds no key and no SDK — only this typed llm surface crosses. The UI
// that consumes it lands in Stage C.
export const llmClient: LlmClient = {
  chat: (request, callbacks) => window.api.llm.chat(request, callbacks),
  // M06.D (ADR-0020): hydrate the persisted thread on open. Guarded down to the method (the jsdom
  // component suites stub a PARTIAL window.api without these newer surfaces) so it degrades to an
  // empty thread rather than throwing.
  history: (sessionId) =>
    (window as { api?: WindowApi }).api?.llm?.history?.(sessionId) ?? Promise.resolve([]),
};

// Dynamic model catalog (M06.D, ADR-0021). Guarded to the method so partial-stub suites degrade to
// the static fallback (the picker is never empty) rather than throwing.
export const catalogClient: CatalogClient = {
  list: () =>
    (window as { api?: WindowApi }).api?.catalog?.list?.() ?? Promise.resolve([...STATIC_CATALOG]),
  refresh: () =>
    (window as { api?: WindowApi }).api?.catalog?.refresh?.() ??
    Promise.resolve([...STATIC_CATALOG]),
};

// Passive usage counter (M06.D, ADR-0021). Guarded to the method so partial-stub suites degrade to
// an empty rollup / no prices rather than throwing.
const EMPTY_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
} as const;
export const usageClient: UsageClient = {
  summary: (sessionId) =>
    (window as { api?: WindowApi }).api?.usage?.summary?.(sessionId) ??
    Promise.resolve({ sessionToday: EMPTY_TOTALS, allToday: EMPTY_TOTALS }),
  pricing: () => (window as { api?: WindowApi }).api?.usage?.pricing?.() ?? Promise.resolve([]),
};

// M08.C: a guarded subscription to the app-wide gen:run-ended lifecycle event — the SOLE
// generation-refresh trigger for the passive usage counter (subscribed in useUsageCounter, where the
// counter is owned, so a modal-closed background finish still refreshes). Guarded to the method like
// usageClient/appClient, so the jsdom hook/component suites (no window.api) degrade to a no-op
// subscription rather than throwing.
export interface GenEventsClient {
  onRunEnded(listener: (event: GenRunEnded) => void): () => void;
}
export const genEventsClient: GenEventsClient = {
  onRunEnded: (listener) =>
    (window as { api?: WindowApi }).api?.gen?.onRunEnded?.(listener) ?? (() => undefined),
};

// Document generation (M04). Like chat, the streaming generators return an
// unsubscribe; templates/artifacts are plain request/response. The renderer holds
// no key and no SDK — only this typed gen surface crosses.
export const genClient: GenClient = {
  generateFocus: (request, callbacks) => window.api.gen.generateFocus(request, callbacks),
  generateWhitepaper: (request, callbacks) => window.api.gen.generateWhitepaper(request, callbacks),
  generateMinutes: (request, callbacks) => window.api.gen.generateMinutes(request, callbacks),
  // M07.B (F12): reattach to a live run, query in-flight state, subscribe to the persist
  // broadcast, and fetch latest-per-kind on open.
  attach: (requestId, callbacks) => window.api.gen.attach(requestId, callbacks),
  status: (sessionId) => window.api.gen.status(sessionId),
  cancel: (requestId) => window.api.gen.cancel(requestId),
  onArtifactSaved: (listener) => window.api.gen.onArtifactSaved(listener),
  onRunStarted: (listener) => window.api.gen.onRunStarted(listener),
  onRunEnded: (listener) => window.api.gen.onRunEnded(listener),
  // M07.C: the unkeyed progress feed for the app-level run toast.
  onProgress: (listener) => window.api.gen.onProgress(listener),
  getLatestArtifacts: (sessionId) => window.api.gen.getLatestArtifacts(sessionId),
  buildRawDoc: (sessionId) => window.api.gen.buildRawDoc(sessionId),
  exportImages: (sessionId) => window.api.gen.exportImages(sessionId),
  exportHtml: (request) => window.api.gen.exportHtml(request),
  exportMarkdown: (request) => window.api.gen.exportMarkdown(request),
  exportPdf: (request) => window.api.gen.exportPdf(request),
  listTemplates: () => window.api.gen.listTemplates(),
  saveTemplate: (parts) => window.api.gen.saveTemplate(parts),
  updateTemplate: (id, parts) => window.api.gen.updateTemplate(id, parts),
  getTemplate: (id) => window.api.gen.getTemplate(id),
  deleteTemplate: (id) => window.api.gen.deleteTemplate(id),
  getArtifacts: (sessionId) => window.api.gen.getArtifacts(sessionId),
};

// Cross-session full-text search (M04.D). A plain request/response surface over the
// search IPC; the renderer holds no DB handle — only this typed method crosses.
export const searchClient: SearchClient = {
  notes: (query) => window.api.search.notes(query),
};

// App-level menu commands + full-screen control (M06.A). The native menu's Find / New Session /
// Appearance forward over app:command; full-screen state arrives over onFullScreenChange;
// exitFullScreen leaves full screen (the toast's Exit control). Guarded for the jsdom component
// suites, where `window.api` is not injected — it degrades to no-ops rather than throwing.
export const appClient: AppClient = {
  onCommand: (listener) =>
    (window as { api?: WindowApi }).api?.app.onCommand(listener) ?? (() => undefined),
  onFullScreenChange: (listener) =>
    (window as { api?: WindowApi }).api?.app.onFullScreenChange(listener) ?? (() => undefined),
  exitFullScreen: () => (window as { api?: WindowApi }).api?.app.exitFullScreen(),
};
