/*
 * The typed channel contract — the single source of truth for the IPC channel
 * names, imported by the main-process handlers (electron/ipc/*-handlers.ts) and
 * the preload mappings (electron/ipc/*-bridge.ts). The renderer never imports
 * this; it calls the ergonomic window.api.{sessions,notes}.* surface
 * (shared/api.ts) instead.
 *
 * Channels are namespaced per domain. Each channel is enumerated here and tested
 * in tests/ipc/*-handlers.test.ts (spec §5 — each channel documented + tested).
 */
export const SESSION_CHANNELS = {
  create: 'session:create',
  list: 'session:list',
  get: 'session:get',
  rename: 'session:rename',
  delete: 'session:delete',
  // M06.B: bulk delete — loops the verified per-session cascade in one transaction, then
  // best-effort blob-dir cleanup per id (never half-aborts on a per-session cleanup failure).
  deleteMany: 'session:deleteMany',
} as const;

export type SessionChannel = (typeof SESSION_CHANNELS)[keyof typeof SESSION_CHANNELS];

/*
 * Note-block channels (M02.A; M02.D adds `addWithContent`). An ordered multi-block
 * surface: add an empty block, add a block already seeded with content (the M02.D
 * upload path — byte-capped at the boundary), list a session's blocks in order,
 * update one block's content, delete one block, and reorder all blocks atomically.
 */
export const NOTE_CHANNELS = {
  add: 'note:add',
  addWithContent: 'note:addWithContent',
  list: 'note:list',
  update: 'note:update',
  // M04 D-03: a SYNCHRONOUS variant of `update` (ipcMain.on + sendSync). Used only by
  // the autosave teardown flush on `pagehide`, so a note edited within the debounce
  // window commits to SQLite before the renderer is torn down on app quit — the async
  // `update` would still be in the IPC pipe and could be lost. Same write, sync delivery.
  updateSync: 'note:updateSync',
  delete: 'note:delete',
  reorder: 'note:reorder',
} as const;

export type NoteChannel = (typeof NOTE_CHANNELS)[keyof typeof NOTE_CHANNELS];

/*
 * Asset (screenshot blob) channels (M02.B). `save` takes the session id, the
 * image bytes, the mime type (allowlisted at the main boundary), and the capture
 * `kind`; `list` returns a session's assets; `delete` removes one (file + row).
 */
export const ASSET_CHANNELS = {
  save: 'asset:save',
  list: 'asset:list',
  delete: 'asset:delete',
} as const;

export type AssetChannel = (typeof ASSET_CHANNELS)[keyof typeof ASSET_CHANNELS];

/*
 * Screen-capture channels (M02.C). `listSources` enumerates the capturable
 * screens/windows (with the macOS permission status); `grab` captures the chosen
 * source to full-resolution PNG bytes. The bytes ride the asset:save pipeline in
 * the renderer, so no sessionId crosses here.
 */
export const CAPTURE_CHANNELS = {
  listSources: 'capture:listSources',
  grab: 'capture:grab',
} as const;

export type CaptureChannel = (typeof CAPTURE_CHANNELS)[keyof typeof CAPTURE_CHANNELS];

/*
 * Settings channels (M03.A). `setKey` stores the user's Anthropic API key encrypted
 * via safeStorage (main-process only); `keyStatus` returns ONLY booleans
 * (`{ hasKey, encryptionAvailable }`) — never the key; `clearKey` removes it.
 * `getPrefs`/`setPrefs` carry non-secret app preferences (model selection, Stage D).
 * There is deliberately NO channel for the decrypted key: the main-only key-read
 * path is consumed by the Stage B SDK call and never crosses this boundary.
 */
export const SETTINGS_CHANNELS = {
  setKey: 'settings:setKey',
  keyStatus: 'settings:keyStatus',
  clearKey: 'settings:clearKey',
  getPrefs: 'settings:getPrefs',
  setPrefs: 'settings:setPrefs',
  // M07.D (REVIEW-V11 F19): the non-secret provider selection (anthropic | gateway{baseURL}).
  // `setProvider` validates the gateway baseURL (https except loopback) main-side. The
  // per-provider SECRET still rides setKey/keyStatus/clearKey with an optional providerId —
  // no key/token ever crosses back (keyStatus is booleans only).
  getProvider: 'settings:getProvider',
  setProvider: 'settings:setProvider',
  // M07.D follow-up: one-shot gateway connectivity check (Test connection). Returns { ok, error }.
  pingGateway: 'settings:pingGateway',
} as const;

export type SettingsChannel = (typeof SETTINGS_CHANNELS)[keyof typeof SETTINGS_CHANNELS];

/*
 * LLM streaming chat channels (M03.B; lives here per the single-source pattern,
 * not a separate llm-channels.ts — M03.A decision #3). `chat` is the invoke
 * trigger carrying { sessionId, question, model, requestId } — never the key; the
 * main process streams back `chunk` (text deltas) then `done` (stop reason +
 * usage) or `error` (a typed, key-free LlmErrorPayload), each keyed by requestId.
 * There is deliberately NO key/SDK channel: the decrypted key is read only by the
 * main-process key-read path, and the Anthropic call runs main-side.
 */
export const LLM_CHANNELS = {
  chat: 'llm:chat',
  chunk: 'llm:chunk',
  done: 'llm:done',
  error: 'llm:error',
  // M07.A (F11): `cancel` invokes with { requestId } to abort an in-flight chat stream
  // main-side (idempotent, unknown-id-safe). `heartbeat` is a requestId-keyed main→renderer
  // progress event { requestId, elapsedMs, bytes } off the streaming byte tap (F21).
  cancel: 'llm:cancel',
  heartbeat: 'llm:heartbeat',
  // M06.D (ADR-0020): plain request/response — hydrate a session's persisted chat thread on
  // open ({ sessionId } → ChatMessage[]). No key, no SDK (chat content is user data).
  history: 'llm:history',
} as const;

export type LlmChannel = (typeof LLM_CHANNELS)[keyof typeof LLM_CHANNELS];

/*
 * Dynamic model catalog (M06.D, ADR-0021; closes F22/TD-012). `catalog:list` returns the active
 * provider's models (cached, offline → static fallback so it is never empty); `catalog:refresh`
 * forces a re-fetch. No key crosses — only model metadata (id/label/maxOutputTokens).
 */
export const CATALOG_CHANNELS = {
  list: 'catalog:list',
  refresh: 'catalog:refresh',
} as const;

export type CatalogChannel = (typeof CATALOG_CHANNELS)[keyof typeof CATALOG_CHANNELS];

/*
 * Real-usage token + cost counter (M06.D, ADR-0021, passive). `usage:summary` returns a session's
 * this-session + today rollups ({ sessionId } → UsageSummary); `usage:pricing` returns the
 * config-driven price entries for the Settings display. No key, no DB handle crosses — only counts.
 */
export const USAGE_CHANNELS = {
  summary: 'usage:summary',
  pricing: 'usage:pricing',
} as const;

export type UsageChannel = (typeof USAGE_CHANNELS)[keyof typeof USAGE_CHANNELS];

/*
 * Document generation channels (M04.A; lives here per the single-source pattern,
 * mirroring LLM_CHANNELS). `generateFocus` is the streaming invoke trigger
 * carrying { sessionId, templateId?, model?, requestId } — never the key; main
 * streams back `chunk`/`done`/`error` keyed by requestId (the same key-free
 * LlmErrorPayload as chat). `listTemplates`/`saveTemplate` manage the editable
 * prompt templates; `getArtifacts` reads a session's persisted documents. There
 * is deliberately NO key/SDK channel — the decrypted key is read only by the
 * main-process key path, and the Anthropic call runs main-side.
 */
export const GEN_CHANNELS = {
  generateFocus: 'gen:generateFocus',
  generateWhitepaper: 'gen:generateWhitepaper',
  // M04.C: structured minutes (single SDK call) + raw notes (NO SDK call, built
  // main-side), the template get/delete the prompt editor needs, and a requestId-
  // keyed `phase` event carrying the two-phase progress marker.
  generateMinutes: 'gen:generateMinutes',
  buildRawDoc: 'gen:buildRawDoc',
  // M04.D: export a generated doc as a portable file. `exportImages` returns the
  // session screenshots as RAW base64 data: URIs (no nativeImage decode/downscale —
  // resolves C-14) for the renderer to inline; `exportHtml`/`exportMarkdown` take the
  // renderer-assembled string and write it via a main-side save dialog.
  exportImages: 'gen:exportImages',
  exportHtml: 'gen:exportHtml',
  exportMarkdown: 'gen:exportMarkdown',
  // M06.C: PDF export of a generated doc. Takes the SAME renderer-assembled self-contained HTML
  // string `exportHtml` does and renders it to PDF via Electron printToPDF (no new dep), written
  // via the save dialog. No key crosses.
  exportPdf: 'gen:exportPdf',
  getTemplate: 'gen:getTemplate',
  deleteTemplate: 'gen:deleteTemplate',
  listTemplates: 'gen:listTemplates',
  saveTemplate: 'gen:saveTemplate',
  updateTemplate: 'gen:updateTemplate',
  getArtifacts: 'gen:getArtifacts',
  // M07.B (F16): latest-per-kind payload (one row per kind) for the modal's mount fetch —
  // replaces shipping every revision's full content (`getArtifacts`, kept for callers that
  // still want the full list). `status` returns the session's in-flight run (F12 reattach)
  // or null. `artifact-saved` is a main->renderer BROADCAST scoped by sessionId, fired when
  // a user-facing artifact persists so an open modal refreshes that slot live.
  getLatestArtifacts: 'gen:getLatestArtifacts',
  status: 'gen:status',
  artifactSaved: 'gen:artifact-saved',
  // M07.B (product-owner IRL reversal): main->renderer broadcasts that feed the app-level
  // persistent run toast — `run-started` carries the GenStatus (kind/session/startedAt) when a
  // user-facing run begins; `run-ended` carries { requestId, error? } on settle.
  runStarted: 'gen:run-started',
  runEnded: 'gen:run-ended',
  // M07.C (F20): `progress` replaces the closed two-phase `gen:phase` marker — a
  // requestId-keyed { requestId, progress: GenProgress } event carrying the open
  // {step, index, total, label} shape ("Section 3 of 7 — Architecture").
  progress: 'gen:progress',
  chunk: 'gen:chunk',
  done: 'gen:done',
  error: 'gen:error',
  // M07.A (F11): `cancel` invokes with { requestId } to abort an in-flight generation
  // main-side (a cancelled run also persists no artifact). `heartbeat` is the requestId-
  // keyed progress event { requestId, elapsedMs, bytes } off the byte tap (F21).
  cancel: 'gen:cancel',
  heartbeat: 'gen:heartbeat',
} as const;

export type GenChannel = (typeof GEN_CHANNELS)[keyof typeof GEN_CHANNELS];

/*
 * Cross-session full-text search (M04.D, ADR-0011). `search:notes` is a plain
 * request/response invoke carrying { query } — validated main-side — returning ranked
 * SearchResult hits (sessionId + sessionName + snippet) over the FTS5 index. No key,
 * no SDK, and no raw note rows beyond the snippet cross this boundary.
 */
export const SEARCH_CHANNELS = {
  notes: 'search:notes',
} as const;

export type SearchChannel = (typeof SEARCH_CHANNELS)[keyof typeof SEARCH_CHANNELS];

/*
 * Storage meter (M06.B, REVIEW-V11 F28). `storage:summary` is a plain request/response invoke
 * returning per-session + total byte usage. No key, no DB handle, no raw filesystem path crosses —
 * only aggregate counts.
 */
export const STORAGE_CHANNELS = {
  summary: 'storage:summary',
  // M06.C: full backup/restore. `backup` writes the whole store (DB + asset blobs) to one
  // portable, version-stamped file via a save dialog; `restore` reads one back (version-checked,
  // destructive — confirm + relaunch happen main-side). No key, no DB handle, no raw path crosses.
  backup: 'storage:backup',
  restore: 'storage:restore',
} as const;

export type StorageChannel = (typeof STORAGE_CHANNELS)[keyof typeof STORAGE_CHANNELS];

/*
 * App-level desktop commands (M06.A). `app:command` is a one-way main→renderer broadcast
 * carrying an AppCommand ('find' | 'new-session' | 'theme:*') fired from the native menu — the
 * renderer services the same behavior its keyboard shortcuts do. `app:fullScreenChange` is a
 * one-way main→renderer event carrying the window's full-screen boolean (so the renderer can
 * raise/clear the full-screen exit toast). `app:exitFullScreen` is a renderer→main invoke that
 * leaves full screen (the toast's Exit control). No key, no DB handle.
 */
export const APP_CHANNELS = {
  command: 'app:command',
  fullScreenChange: 'app:fullScreenChange',
  exitFullScreen: 'app:exitFullScreen',
} as const;

export type AppChannel = (typeof APP_CHANNELS)[keyof typeof APP_CHANNELS];
