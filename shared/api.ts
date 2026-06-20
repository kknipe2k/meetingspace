import type {
  AppCommand,
  Asset,
  AssetKind,
  BackupResult,
  CaptureSourcesResult,
  CatalogModel,
  ChatMessage,
  ExportImagesResult,
  ExportRequest,
  ExportResult,
  GenArtifactSaved,
  GenDocument,
  GenDone,
  GenFocusRequest,
  GenMinutesRequest,
  GenProgress,
  GenRunEnded,
  GenStatus,
  GenTemplate,
  GenTemplateParts,
  GenWhitepaperRequest,
  KeyStatus,
  LlmChatRequest,
  LlmDone,
  LlmErrorPayload,
  LlmHeartbeat,
  Note,
  Prefs,
  PricingEntry,
  ProviderConfig,
  ProviderId,
  RestoreResult,
  SearchResult,
  Session,
  SetKeyResult,
  StorageSummary,
  UsageSummary,
} from './types';

/*
 * The typed contextBridge contract shared by both processes: electron/preload.ts
 * builds it and exposes it on `window.api`; src/global.d.ts types it for the
 * renderer; src/ipc/client.ts is the renderer's only reader of it.
 *
 * These are the renderer-facing surfaces — ergonomic async methods, not raw
 * channel names. The preload maps each method onto an ipcRenderer.invoke of the
 * corresponding electron/ipc/channels.ts channel (see the per-group *-bridge.ts
 * files), so the renderer can never reach an arbitrary channel — only the typed
 * method groups on `window.api` (sessions, notes, assets, capture, settings, llm,
 * gen, search) cross. There is no generic invoke. (Keep this list description, not a
 * hard count — the surface grows milestone to milestone; TD-001.)
 */
export interface SessionApi {
  create(name: string): Promise<Session>;
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | null>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
  // M06.B: bulk delete (checkbox multi-select). Loops the verified per-session cascade inside one
  // transaction main-side; per-session blob cleanup is best-effort and never half-aborts.
  deleteMany(ids: string[]): Promise<void>;
}

/*
 * Note blocks (M02.A; M02.D adds `addWithContent`): a session holds an ordered
 * list of note blocks. `add` appends an empty block; `addWithContent` appends a
 * block seeded with content (the upload path — an uploaded text file becomes an
 * ordinary note block); `list` returns a session's blocks in order; `update` sets
 * one block's content; `delete` removes one; `reorder` rewrites the order of all
 * of a session's blocks atomically (orderedIds is a permutation).
 */
export interface NotesApi {
  add(sessionId: string): Promise<Note>;
  addWithContent(sessionId: string, content: string): Promise<Note>;
  list(sessionId: string): Promise<Note[]>;
  update(id: string, content: string): Promise<Note>;
  // M04 D-03: synchronous twin of `update` (sendSync). Used only by the autosave
  // teardown flush on `pagehide` so an edit made within the debounce window commits
  // before the renderer is torn down on app quit; returns the written row inline.
  updateSync(id: string, content: string): Note;
  delete(id: string): Promise<void>;
  reorder(sessionId: string, orderedIds: string[]): Promise<void>;
}

/*
 * Screenshot blobs (M02.B): `save` sends the image bytes (ArrayBuffer) plus the
 * mime type and the capture kind; the main process validates and writes them,
 * returning the stored Asset. `list` returns a session's assets; `delete`
 * removes one. Thumbnails render from `asset://<asset.relativePath>` (the scoped
 * protocol), never a raw file path.
 */
export interface AssetsApi {
  save(sessionId: string, bytes: ArrayBuffer, mime: string, kind: AssetKind): Promise<Asset>;
  list(sessionId: string): Promise<Asset[]>;
  delete(id: string): Promise<void>;
}

/*
 * In-app screen capture (M02.C): `listSources` enumerates the capturable
 * screens/windows plus the macOS permission status; `grab` captures the chosen
 * source to full-resolution PNG bytes. The renderer pairs those bytes with the
 * current session via assets.save (kind 'capture') — so capture rides the Stage B
 * blob pipeline and no raw filesystem path is involved.
 */
export interface CaptureApi {
  listSources(): Promise<CaptureSourcesResult>;
  grab(sourceId: string): Promise<ArrayBuffer>;
}

/*
 * Settings (M03.A): `setKey` sends the plaintext secret one-way into the main process
 * (encrypted at rest via safeStorage); `keyStatus` returns ONLY booleans — never
 * the secret; `clearKey` removes it. `getPrefs`/`setPrefs` carry non-secret app
 * preferences. There is deliberately no "read the secret" method — the renderer never
 * receives the plaintext.
 *
 * M07.D: setKey/keyStatus/clearKey take an OPTIONAL providerId (default anthropic) so the
 * gateway bearer is stored/queried/cleared independently; getProvider/setProvider carry the
 * non-secret provider config (setProvider validates the gateway baseURL main-side).
 */
export interface SettingsApi {
  setKey(plaintext: string, providerId?: ProviderId): Promise<SetKeyResult>;
  keyStatus(providerId?: ProviderId): Promise<KeyStatus>;
  clearKey(providerId?: ProviderId): Promise<void>;
  getPrefs(): Promise<Prefs>;
  setPrefs(prefs: Prefs): Promise<Prefs>;
  getProvider(): Promise<ProviderConfig>;
  setProvider(provider: ProviderConfig): Promise<ProviderConfig>;
}

/*
 * LLM chat (M03.B). Streaming is event-driven rather than request/response:
 * `chat` sends {sessionId, question, model} (never the key) and registers
 * callbacks fed by requestId-keyed chunk/done/error events. It returns an
 * unsubscribe that tears down the renderer's own listeners (the IPC-level cancel
 * channel is deferred to Stage C/D, where the UI drives it). No SDK, no key, and
 * no grounding here — grounding is assembled main-side in Stage C.
 */
export interface LlmStreamCallbacks {
  onChunk(delta: string): void;
  onDone(result: LlmDone): void;
  onError(error: LlmErrorPayload): void;
  // M07.A: throttled progress off the streaming byte tap (F21). Optional — the M03
  // callers stay valid; Stage B consumes it for heartbeat toasts.
  onHeartbeat?(heartbeat: LlmHeartbeat): void;
}

export interface LlmApi {
  chat(request: LlmChatRequest, callbacks: LlmStreamCallbacks): () => void;
  // M06.D (ADR-0020): hydrate the session's persisted thread on open. Plain request/response —
  // the renderer holds no key; only saved chat content (user data) crosses.
  history(sessionId: string): Promise<ChatMessage[]>;
}

/*
 * Dynamic model catalog (M06.D, ADR-0021; closes F22/TD-012). `list` returns the active provider's
 * models (cached, offline → static fallback so the picker is never empty); `refresh` forces a
 * re-fetch. No key, no SDK — only model metadata crosses.
 */
export interface CatalogApi {
  list(): Promise<CatalogModel[]>;
  refresh(): Promise<CatalogModel[]>;
}

/*
 * Real-usage token + cost counter (M06.D, ADR-0021/0022/0024, passive). `summary` takes the open
 * session id and returns the two today-windowed rollups (this session today + all sessions today);
 * `pricing` returns the config-driven price entries for Settings. No key, no DB handle — only
 * aggregate counts + prices.
 */
export interface UsageApi {
  summary(sessionId: string): Promise<UsageSummary>;
  pricing(): Promise<PricingEntry[]>;
}

/*
 * Document generation (M04.A). `generateFocus` is event-driven like chat: it sends
 * {sessionId, templateId?, model?} (NEVER the key) and registers callbacks fed by
 * requestId-keyed chunk/done/error events; it returns an unsubscribe that tears
 * down the renderer's own listeners. `listTemplates`/`saveTemplate` manage the
 * editable prompt templates; `getArtifacts` reads a session's persisted documents.
 * No SDK, no key, and no corpus assembly here — the corpus is built main-side.
 */
export interface GenStreamCallbacks {
  onChunk(delta: string): void;
  // Per-step progress (M07.C open shape — was the closed two-phase marker). Optional
  // so non-progress callers stay valid.
  onProgress?(progress: GenProgress): void;
  onDone(result: GenDone): void;
  onError(error: LlmErrorPayload): void;
  // M07.A: throttled progress off the byte tap (F21). Optional; Stage B consumes it.
  onHeartbeat?(heartbeat: LlmHeartbeat): void;
  // M07.C (single build slot): main refused the start because another build is live —
  // the bridge resolves the typed GenStartResult into this callback, carrying the live
  // run's GenStatus. The refusal must never be silent (the modal raises the busy toast
  // with the explicitly-labeled cancel-&-start handoff).
  onBusy?(live: GenStatus): void;
}

// M07.B (REVIEW-V11 F12/F14): a generation stream now returns a two-intent handle, not a
// bare teardown — because generation DECOUPLES from the modal. `detach` stops the renderer
// listening but leaves the main-side run ALIVE (closing the modal must not kill a long
// generation — it is reattachable on reopen). `cancel` detaches AND fires gen:cancel (the
// explicit-stop spend guard — A's F11 path). Chat keeps its bare `() => void` teardown
// (chat is modal-less and cancel-on-unmount is correct there).
export interface GenStreamHandle {
  detach(): void;
  cancel(): void;
}

export interface GenApi {
  generateFocus(request: GenFocusRequest, callbacks: GenStreamCallbacks): GenStreamHandle;
  generateWhitepaper(request: GenWhitepaperRequest, callbacks: GenStreamCallbacks): GenStreamHandle;
  // M04.C: structured minutes (streamed) + raw notes (NO SDK — built main-side) +
  // the template get/delete the prompt editor needs.
  generateMinutes(request: GenMinutesRequest, callbacks: GenStreamCallbacks): GenStreamHandle;
  // M07.B (F12): reattach to an ALREADY-RUNNING generation (after gen:status reports it
  // in-flight on modal reopen). Subscribes to the existing requestId's phase/heartbeat/
  // done/error — it sends NO fresh generate invoke. Returns the same two-intent handle.
  attach(requestId: string, callbacks: GenStreamCallbacks): GenStreamHandle;
  // M07.B (F12): the session's in-flight run (reattach source), or null.
  status(sessionId: string): Promise<GenStatus | null>;
  // M07.B (product-owner IRL reversal): cancel a run by id (the app-level toast's Cancel,
  // which has no stream handle of its own).
  cancel(requestId: string): Promise<void>;
  // M07.B (F12): subscribe to the gen:artifact-saved broadcast (a user-facing artifact
  // persisted). The renderer filters by sessionId. Returns an unsubscribe.
  onArtifactSaved(listener: (event: GenArtifactSaved) => void): () => void;
  // M07.B (IRL reversal): the app-level run-lifecycle feed for the persistent run toast —
  // `onRunStarted` carries the GenStatus, `onRunEnded` the settle (with a tier error on
  // failure). Each returns an unsubscribe.
  onRunStarted(listener: (run: GenStatus) => void): () => void;
  onRunEnded(listener: (event: GenRunEnded) => void): () => void;
  // M07.C: an UNKEYED subscription to every gen:progress event reaching this window —
  // the app-level run toast appends the current step label ("Section 3 of 7") to its
  // live-run line without a new main-side channel (single-window: the invoking
  // webContents IS this window). Returns an unsubscribe.
  onProgress(listener: (event: { requestId: string; progress: GenProgress }) => void): () => void;
  // M07.B (F16): latest-per-kind for the modal's mount fetch (one row per kind), replacing
  // the ship-every-revision `getArtifacts` on the open path.
  getLatestArtifacts(sessionId: string): Promise<GenDocument[]>;
  buildRawDoc(sessionId: string): Promise<string>;
  // M04.D export. `exportImages` returns the session screenshots as RAW base64 data: URIs (no
  // nativeImage decode/downscale — resolves C-14) for the renderer to inline, CAPPED by count +
  // bytes with an `omittedCount` so a huge session can't produce an unopenable file (M06.C / F26);
  // `exportHtml`/`exportMarkdown`/`exportPdf` hand the finished string to main, which writes it via
  // a save dialog (`exportPdf` renders the HTML to PDF via printToPDF — no new dep).
  exportImages(sessionId: string): Promise<ExportImagesResult>;
  exportHtml(request: ExportRequest): Promise<ExportResult>;
  exportMarkdown(request: ExportRequest): Promise<ExportResult>;
  exportPdf(request: ExportRequest): Promise<ExportResult>;
  listTemplates(): Promise<GenTemplate[]>;
  saveTemplate(parts: GenTemplateParts): Promise<GenTemplate>;
  updateTemplate(id: string, parts: GenTemplateParts): Promise<GenTemplate>;
  getTemplate(id: string): Promise<GenTemplate | null>;
  deleteTemplate(id: string): Promise<void>;
  getArtifacts(sessionId: string): Promise<GenDocument[]>;
}

/*
 * Cross-session full-text search (M04.D). `notes` runs a query over EVERY session's
 * note content (and session names) and returns ranked hits scoped to their session.
 * UI-only over the typed search IPC — no key, no SDK.
 */
export interface SearchApi {
  notes(query: string): Promise<SearchResult[]>;
}

/*
 * Storage meter (M06.B, REVIEW-V11 F28). A plain request/response surface returning per-session +
 * total byte usage. No key, no DB handle, no raw filesystem path crosses — only aggregate counts.
 */
export interface StorageApi {
  summary(): Promise<StorageSummary>;
  // M06.C: full backup/restore. `backup` writes the whole store to one portable file; `restore`
  // reads one back (version-checked + destructive — the confirm + relaunch run main-side).
  backup(): Promise<BackupResult>;
  restore(): Promise<RestoreResult>;
}

/*
 * App-level desktop commands (M06.A). The native application menu forwards Find / New Session /
 * the Appearance theme choice to the renderer over app:command; the renderer subscribes via
 * `onCommand` and services the same behavior the keyboard shortcuts do. `onFullScreenChange`
 * carries the main-process full-screen state so the renderer can raise/clear the full-screen
 * exit toast (the menu bar hides in full screen — M06.A IRL fix); `exitFullScreen` leaves full
 * screen (the toast's Exit control). Event/command-only — no key, no DB handle.
 */
export interface AppApi {
  onCommand(listener: (command: AppCommand) => void): () => void;
  onFullScreenChange(listener: (isFullScreen: boolean) => void): () => void;
  exitFullScreen(): void;
}

export interface WindowApi {
  readonly meta: {
    readonly appName: string;
  };
  readonly sessions: SessionApi;
  readonly notes: NotesApi;
  readonly assets: AssetsApi;
  readonly capture: CaptureApi;
  readonly settings: SettingsApi;
  readonly llm: LlmApi;
  readonly gen: GenApi;
  readonly search: SearchApi;
  readonly storage: StorageApi;
  readonly app: AppApi;
  readonly catalog: CatalogApi;
  readonly usage: UsageApi;
}

export function createWindowApi(
  sessions: SessionApi,
  notes: NotesApi,
  assets: AssetsApi,
  capture: CaptureApi,
  settings: SettingsApi,
  llm: LlmApi,
  gen: GenApi,
  search: SearchApi,
  storage: StorageApi,
  app: AppApi,
  catalog: CatalogApi,
  usage: UsageApi,
): WindowApi {
  return {
    meta: { appName: 'MeetingSpace' },
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
  };
}
