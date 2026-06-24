/*
 * The storage domain types shared by both processes: the main-process storage
 * layer (electron/storage/*) writes them; the renderer receives them over IPC
 * (wired in M01.C). Timestamps are epoch milliseconds.
 *
 * Model note (see ADR-0003): a Space groups Sessions; a Session holds Notes and
 * (M02) Assets. M01 seeds one default Space and exposes a session-centric API —
 * `spaces` is FK-wired now so M02 can add multi-space without a table migration.
 */
import type { InlinedImage } from './images/image-figures';

export interface Space {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Session {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Note {
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// Screenshot blobs (M02.B). The byte-source path is recorded as `kind`; the four
// values map to the four capture paths (drag-drop → screenshot, file → upload,
// clipboard → paste, desktopCapturer → capture in M02.C).
export type AssetKind = 'screenshot' | 'upload' | 'paste' | 'capture';

export interface Asset {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: AssetKind;
  // Stored relative to the assets root (forward-slash, portable) so the DB stays
  // movable between machines; the renderer serves it as `asset://<relativePath>`.
  readonly relativePath: string;
  readonly createdAt: number;
}

// In-app screen capture (M02.C). A capturable screen or window the picker offers;
// `preview` is a small data-URL thumbnail for the grid. The full-resolution grab
// returns PNG bytes (not part of this DTO) that flow through the asset pipeline.
export interface CaptureSource {
  readonly id: string;
  readonly name: string;
  readonly preview: string;
}

// The picker payload: the macOS Screen Recording `permission` status plus the
// enumerated sources (empty when permission is missing, so the renderer shows a
// guided error instead of capturing a black frame — gotcha §4).
export interface CaptureSourcesResult {
  readonly permission: string;
  readonly sources: CaptureSource[];
}

// Settings (M03.A). The renderer only ever learns the key STATUS — two booleans,
// never the key itself. The plaintext lives solely in the main process (encrypted
// at rest via safeStorage); the decrypted value is read in main via
// KeyStore.getKeyForMain(), which has no IPC channel (Stage B's SDK consumes it).
export interface KeyStatus {
  readonly hasKey: boolean;
  readonly encryptionAvailable: boolean;
}

// The outcome of a setKey attempt. When OS encryption is unavailable the store
// writes nothing and reports it, so the UI can surface a clear error rather than
// silently falling back to plaintext (gotcha §2 / Hard Rule §10).
export type SetKeyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'encryption-unavailable' };

// One-shot gateway connectivity check (Settings ▸ Test connection). Success means the bearer +
// baseURL (+ optional proxy) reached the gateway and it replied; failure carries a short message.
export type GatewayPingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

// One row of the gateway model diagnostic (Settings ▸ Gateway diagnostics). For a requested model
// id, `served` is the model the gateway ACTUALLY answered with (its response `model`) — which
// reveals a substitution (e.g. you ask for a Sonnet 4.x id and it serves 3.5 Sonnet). `ok` is false
// with an `error` when the ping failed (no token, HTTP error, unreachable). Never carries the token.
export interface GatewayModelDiagnosis {
  readonly id: string;
  readonly served: string | null;
  readonly ok: boolean;
  readonly status: 'available' | 'substituted' | 'unavailable' | 'timeout';
  readonly testedAt: number;
  readonly error?: string;
}

// Persisted, non-secret result of an explicit gateway model test. A credential replacement marks
// existing records stale rather than deleting them, so the user can see what worked previously and
// choose when to retest.
export interface GatewayModelVerification extends GatewayModelDiagnosis {
  readonly stale?: boolean;
}

// Gateway model setup is scoped to the normalized base URL. This prevents one company's curation
// and test results from leaking into another gateway configuration on the same machine.
export interface GatewayModelProfile {
  readonly models: readonly CatalogModel[];
  readonly curatedModelIds: readonly string[];
  readonly verifications: Readonly<Record<string, GatewayModelVerification>>;
}

// The LLM backend the app talks to (M07.D; REVIEW-V11 F19). `anthropic` is the direct
// API (`sk-ant-` x-api-key). `gateway` is a corporate proxy reached over a base URL with
// an `sk-` BEARER token (the corp credential routes to Bedrock BEHIND the gateway, but the
// client integration is pure baseURL + bearer — no @anthropic-ai/bedrock-sdk, no SigV4).
// Native Amazon Bedrock is deliberately NOT a provider here (ADR-0019).
export type ProviderId = 'anthropic' | 'gateway';

// The non-secret provider configuration persisted in Prefs. The SECRET (key / bearer) lives
// only in the multi-credential KeyStore (safeStorage), never here.
// `proxyUrl` is an OPTIONAL corporate forward proxy the gateway request routes through; it is
// applied to Electron's network session (net.fetch) so the OS proxy/auth/cert handling is used.
export type ProviderConfig =
  | { readonly provider: 'anthropic' }
  | { readonly provider: 'gateway'; readonly baseURL: string; readonly proxyUrl?: string };

// Persisted window geometry (M06.A; REVIEW-V11 F4) — size/position/maximized, restored on
// launch after validation against the CURRENT displays (an off-all-displays bound snaps to
// primary). Non-secret, so it rides Prefs (the JSON config), never SQLite, never the key.
export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized?: boolean;
}

// Storage meter (M06.B, REVIEW-V11 F28). Per-session + total byte usage (note content + document
// content + asset blob bytes). `totalBytes` is the sum of the per-session data bytes — no key, no
// raw filesystem path, only aggregate counts cross the IPC boundary.
export interface StorageUsage {
  readonly sessionId: string;
  readonly name: string;
  readonly bytes: number;
}

export interface StorageSummary {
  readonly totalBytes: number;
  readonly perSession: readonly StorageUsage[];
}

// The explicit appearance preference (M06.A IRL fix). `system` follows the OS
// (`prefers-color-scheme`, the A.3 default — preserved); `light`/`dark` override it. Applied
// renderer-side as `document.documentElement[data-theme]`; persisted in Prefs.
export type ThemePreference = 'system' | 'light' | 'dark';

// Non-secret, app-global preferences. Stored as a JSON file in userData — never SQLite,
// never holding the key (decision M03.A). `provider` is the M07.D backend selection;
// `windowState`/`zoomFactor`/`themePreference` are the M06.A desktop-convention state (window
// geometry, the persisted View-menu zoom, the appearance choice), all non-secret.
export interface Prefs {
  // Canonical model selection shared by chat and document generation. The two legacy fields below
  // remain readable for migration from older builds, but new writes use selectedModel.
  readonly selectedModel?: string;
  readonly chatModel?: string;
  readonly generationModel?: string;
  readonly provider?: ProviderConfig;
  readonly windowState?: WindowState;
  readonly zoomFactor?: number;
  readonly themePreference?: ThemePreference;
  // M06.B: persisted width (px) of the resizable left sidebar column (IRL request).
  readonly sidebarWidth?: number;
  // M06.D (F8): per-session chat scroll offset (px), so the conversation reopens where you left off
  // — meaningful now that chat_messages makes the thread survive a session switch / reload.
  readonly chatScroll?: Record<string, number>;
  // M06.E: set once the first-run onboarding has been completed OR skipped, so the welcome flow
  // appears exactly once (gated with hasKey by shouldShowOnboarding). Non-secret like the rest.
  readonly onboardingSeen?: boolean;
  // Gateway diagnostics (curated picker): the gateway's /v1/models can advertise the whole Bedrock
  // catalog, and it silently serves 3.5 Sonnet for ids it doesn't map. This is the user-curated
  // allowlist of gateway model ids to show in the chat + generation dropdowns. Empty/absent ⇒ not
  // curated yet ⇒ the dropdowns fall back to the app's known tiers (de-flooded). Gateway-only;
  // non-secret like the rest.
  readonly gatewayModels?: readonly string[];
  // Persisted model setup per normalized gateway base URL. Listing and testing are user-triggered;
  // opening Settings reads this cache and performs no model network requests.
  readonly gatewayModelProfiles?: Readonly<Record<string, GatewayModelProfile>>;
}

// A native-menu command the main process forwards to the renderer over app:command (M06.A).
// The menu does NOT register the Find/New accelerators — the renderer owns those keypresses
// (Ctrl/Cmd+F, Ctrl/Cmd+N); the command path services the menu's mouse-click of the same
// items, plus the View ▸ Appearance theme choice (`theme:*`).
export type AppCommand = 'find' | 'new-session' | 'theme:system' | 'theme:light' | 'theme:dark';

/*
 * LLM chat (M03.B). The message path is built multimodal-ready — content is an
 * array of text AND image blocks — so M03 text chat and M04's image-bearing
 * generation share one call path (no retrofit). v1 chat sends text only; the
 * image block is plumbing exercised now and surfaced in M04.
 */
export interface LlmTextBlock {
  readonly type: 'text';
  readonly text: string;
  // M07.C: opts this block into the API's prompt cache (the shared chunked prefix —
  // FOCUS+outline — is re-sent on every section call, so the N+1 calls read it at
  // ~0.1x instead of re-paying full input price). The main-only anthropic-client maps
  // this to the SDK's `cache_control` content-block property, so the SDK shape never
  // leaks into shared AND the request body's top-level key set is unchanged (the F29
  // read-only lock and caching coexist — cache_control is not a capability key).
  readonly cache?: boolean;
}

export interface LlmImageBlock {
  readonly type: 'image';
  // Camel-cased at the domain boundary; the main-only anthropic-client maps this
  // to the SDK's snake_case `media_type` so the SDK shape never leaks into shared.
  readonly source: { readonly type: 'base64'; readonly mediaType: string; readonly data: string };
}

export type LlmContentBlock = LlmTextBlock | LlmImageBlock;

export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: LlmContentBlock[];
}

// The renderer → main chat request. It NEVER carries the key. `sessionId` is the
// handle main uses to assemble grounding from storage in Stage C; M03.B streams
// the question text only.
export interface LlmChatRequest {
  readonly sessionId: string;
  readonly question: string;
  readonly model: string;
}

// A persisted chat turn (M06.D, ADR-0020). The in-session conversation is saved to the
// `chat_messages` table so it survives reload and gives the model multi-turn memory. `model`
// rides the ASSISTANT row (which model answered); user rows carry null. Session-scoped (cascade
// on delete). The key NEVER lands here — chat content is user data.
export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly model?: string | null;
  readonly createdAt: number;
}

// A model from the dynamic catalog (M06.D, ADR-0021; closes F22/TD-012). Listed per active
// provider via /v1/models (anthropic) or the per-provider fallback; `maxOutputTokens` is the
// LIVE per-model output ceiling the model-aware generation cap reads. No pricing — the Models
// API does not return it (config-driven pricing instead).
export interface CatalogModel {
  readonly id: string;
  readonly label: string;
  readonly maxOutputTokens: number;
}

// A model's per-MTok price for the settings display (M06.D, ADR-0021). Config-driven — read from
// the updatable pricing file, never hardcoded in a component.
export interface PricingEntry {
  readonly model: string;
  readonly label: string;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

// Real-usage token + cost rollup for one window (M06.D, ADR-0021, passive). Token totals are the
// ACTUAL usage (never estimated). `costUsd` is the CONSERVATIVE SPLIT: the summed cost of priced
// calls only (input + output + cache at the read/write multipliers); `unpricedCalls` counts calls
// whose model has no config price and are therefore excluded from cost — so the figure is never a
// wrong/understated total presented as exact.
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly unpricedCalls: number;
}

// The two passive rollups shown by the counter (M06.D; TODAY-WINDOWED per ADR-0024, local-midnight
// → now): the CURRENT session today and ALL sessions today — each across all kinds (chat +
// generation: focus / whitepaper / minutes). Read/aggregation only; the all-time total was dropped
// (ADR-0024 supersedes ADR-0022).
export interface UsageSummary {
  readonly sessionToday: UsageTotals;
  readonly allToday: UsageTotals;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

// Terminal success payload of a chat stream (stop reason + token usage). `model`
// is the model the API actually answered with (absent on the no-content marker,
// which never calls the SDK) — surfaced on the reply and saved with the note (M03.D).
export interface LlmDone {
  readonly stopReason: string | null;
  readonly usage: LlmUsage;
  readonly model?: string;
}

// The typed, KEY-FREE error taxonomy. Messages are static per code — they never
// interpolate the key or a raw SDK error string (Hard Rule §10).
//
// M07.A (REVIEW-V11 F21): the single `TIMEOUT` split into three watchdog-tier codes so
// the renderer can phrase per-tier copy — TIMEOUT_IDLE (byte-idle: dead connection),
// TIMEOUT_STALL (text-idle: wedged generation), TIMEOUT_CEILING (hard wall-clock cap).
// CANCELLED is the user-initiated abort (F11) — distinct from any timeout; its copy and
// retry semantics differ (a cancel is not a failure to retry away).
// M07.D (REVIEW-V11 F19): GATEWAY_UNREACHABLE is a connection failure on the gateway
// provider — distinct from OFFLINE (direct anthropic) so the renderer can phrase a
// gateway-specific message. A taxonomy EXTENSION (same key-free model), surfaced only
// when the active provider is gateway.
export type LlmErrorCode =
  | 'NO_KEY'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'OFFLINE'
  | 'OVERLOADED'
  | 'GATEWAY_UNREACHABLE'
  | 'TIMEOUT_IDLE'
  | 'TIMEOUT_STALL'
  | 'TIMEOUT_CEILING'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface LlmErrorPayload {
  readonly code: LlmErrorCode;
  readonly message: string;
}

// A throttled progress signal off the streaming byte tap (M07.A; F21). Emitted ~every
// heartbeatMs while raw bytes (incl. SSE pings) flow, so a long silent generation can
// be toasted "still working" (Stage B consumes it). Carries no content — just elapsed
// wall-clock and the running raw-byte count.
export interface LlmHeartbeat {
  readonly elapsedMs: number;
  readonly bytes: number;
}

/*
 * Document generation (M04). The captured session corpus (notes as text +
 * screenshots as image blocks) becomes an on-demand document. M04.A ships the
 * generation engine: the two-part prompt (FOCUS doc → white paper), an editable
 * template store, and Part 1 (FOCUS) orchestration reusing the M03 main-only SDK
 * path. Generation NEVER carries the key to the renderer; gen errors reuse the
 * M03 key-free LlmErrorPayload taxonomy.
 */
export type GenKind = 'focus' | 'whitepaper' | 'minutes' | 'raw';

// The open generation progress shape (M07.C; REVIEW-V11 F20) — the closed M04 GenPhase
// union opened up so chunked steps ("Section 3 of 7 — Architecture") flow to the UI.
// `step` names the pipeline stage (focus | outline | section | css | minutes), `index`/
// `total` are 1-based call positions in the run (total is provisional until the outline
// lands), and `label` is the renderer-ready copy. There is deliberately NO scripting/JS
// step: the generated doc carries no scripts (the no-scripts security mandate), so the
// progress UI must never imply one.
export interface GenProgress {
  readonly step: string;
  readonly index: number;
  readonly total: number;
  readonly label: string;
}

// A generation prompt template. The shipped default is a read-only seed; the user
// forks it into named, editable copies stored as a userData JSON file (mirrors
// Prefs) — never SQLite, never holding the key.
//
// M07.C round 4: the pipeline adds three OPTIONAL parts (plan / css / html). They are
// optional so v1 fork files keep loading unchanged; a missing part resolves to the
// factory default at run time. `whitepaperPrompt` is retained as the document MANDATE
// (voice/content/illustration rules) composed into every pipeline call — a v1 fork's
// customization keeps shaping the output, it is never silently orphaned.
export interface GenTemplate {
  readonly id: string;
  readonly name: string;
  readonly focusPrompt: string;
  readonly whitepaperPrompt: string;
  readonly planPrompt?: string;
  readonly cssPrompt?: string;
  readonly htmlPrompt?: string;
  // The minutes generation system prompt — editable like the white-paper parts; absent
  // (older forks) → the factory MINUTES_PROMPT at run time.
  readonly minutesPrompt?: string;
  readonly isDefault: boolean;
}

// The editable parts a user supplies when forking a template. The pipeline + minutes
// parts are optional (absent → factory default), mirroring GenTemplate.
export interface GenTemplateParts {
  readonly name: string;
  readonly focusPrompt: string;
  readonly whitepaperPrompt: string;
  readonly planPrompt?: string;
  readonly cssPrompt?: string;
  readonly htmlPrompt?: string;
  readonly minutesPrompt?: string;
}

// A persisted generated artifact (FOCUS doc in M04.A; whitepaper / minutes / raw
// later). Session-scoped SQLite row (documents table, migration v3) so Part 2 can
// re-run without redoing Part 1. The key NEVER lands here.
export interface GenDocument {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: GenKind;
  readonly content: string;
  readonly templateId: string | null;
  readonly createdAt: number;
  // The model that produced this doc (migration v5, M05.A) — null for pre-v5 rows and
  // for the no-SDK raw path. Drives the persisted-doc model badge.
  readonly model?: string | null;
}

// The renderer → main FOCUS generation request. It NEVER carries the key. The
// corpus (notes + screenshots) is assembled MAIN-SIDE from the session; the
// renderer supplies only the handle, the chosen template, and the model.
export interface GenFocusRequest {
  readonly sessionId: string;
  readonly templateId?: string;
  readonly model?: string;
}

// The renderer → main white-paper request (the corpus + the persisted FOCUS artifact
// are read MAIN-SIDE). It NEVER carries the key. When no FOCUS artifact exists yet, the
// main process runs Part 1 first (silently), so a single request just works.
// `reanalyze` is the one knob distinguishing Regenerate from Start over: when true the
// FOCUS analysis is recomputed before the write, instead of reusing the saved one — so
// both are ONE main-side run (no renderer-orchestrated focus leg).
export interface GenWhitepaperRequest {
  readonly sessionId: string;
  readonly templateId?: string;
  readonly model?: string;
  readonly reanalyze?: boolean;
}

// The renderer -> main structured-minutes request (M04.C). Like the white-paper
// request it NEVER carries the key; the corpus is assembled MAIN-SIDE. Minutes run a
// single SDK call; `templateId` selects the (editable) minutes prompt — absent → the
// factory default — so minutes is now a peer of the white paper in the template system.
export interface GenMinutesRequest {
  readonly sessionId: string;
  readonly model?: string;
  readonly templateId?: string;
}

// Terminal success payload of a generation stream — stop reason + usage + the
// kind generated and the persisted artifact id (absent on the no-content marker,
// which never calls the SDK and persists nothing).
export interface GenDone {
  readonly stopReason: string | null;
  readonly usage: LlmUsage;
  readonly model?: string;
  readonly kind: GenKind;
  readonly artifactId?: string;
}

// A main-side in-flight generation run for a session (M07.B; REVIEW-V11 F12). Generation
// DECOUPLES from the modal — closing the modal detaches the renderer but the run keeps
// streaming main-side — so the renderer queries `gen:status(sessionId)` on (re)open to
// reattach to a live run. `kind` is user-facing only (whitepaper | minutes); the internal
// `focus` leg is never advertised. `progress` is the latest streamed step (M07.C open
// shape — a reattaching renderer shows "Section 3 of 7" for free; null until the first
// marker); `startedAt` is epoch ms.
export interface GenStatus {
  readonly requestId: string;
  readonly sessionId: string;
  readonly kind: GenKind;
  readonly progress: GenProgress | null;
  readonly startedAt: number;
  // The name of the template driving this run (e.g. "Default" or a user template), so
  // the run toast can show which prompt is in effect. Absent for the internal focus leg.
  readonly templateName?: string;
}

// The typed resolution of a generate invoke (M07.C; product-owner scope amendment).
// Only ONE artifact build may run at a time, app-wide: a Generate invoke while any run
// is live resolves `{started:false}` carrying the LIVE run's GenStatus so the renderer
// can explain what is running — never a silent no-op. (A typed RESOLVE rather than a
// rejection: Electron serializes invoke rejections down to the message string, which
// would drop the GenStatus — recorded as an advisory deviation in the M07.C retro.)
export type GenStartResult =
  | { readonly started: true }
  | { readonly started: false; readonly reason: 'busy'; readonly live: GenStatus };

// The main->renderer broadcast fired when a user-facing artifact persists (M07.B; F12).
// Scoped by sessionId so an open modal refreshes only its OWN slot live — a background
// session's save never mutates the open modal's other state. `id` is the new artifact row.
export interface GenArtifactSaved {
  readonly sessionId: string;
  readonly kind: GenKind;
  readonly id: string;
}

// Settle signal for a user-facing run (M07.B; product-owner IRL reversal). Broadcast with
// `gen:run-ended` so the app-level run toast clears; on a failure it carries the tier error
// so the controller can land an explanatory toast (e.g. the 20-minute ceiling) even when the
// modal is closed — the elapsed `m:ss` alone never tells the user a hard limit exists.
export interface GenRunEnded {
  readonly requestId: string;
  readonly error?: LlmErrorPayload;
}

// The renderer -> main export request (M04.D). The renderer assembles the finished
// document string (sanitized self-contained HTML, or plain-text markdown) and hands
// it to main, which writes it to a user-chosen path via a save dialog. `defaultName`
// seeds the dialog's filename; the extension is added per format. No key crosses.
export interface ExportRequest {
  readonly content: string;
  readonly defaultName: string;
}

// The outcome of an export: the absolute path written, or `saved: false` when the
// user cancelled the save dialog.
export type ExportResult =
  | { readonly saved: true; readonly path: string }
  | { readonly saved: false };

// The result of acquiring a session's screenshots for export (M06.C / F26). The export inlines
// `images` (already capped by count + cumulative bytes); `omittedCount` is how many were dropped by
// the cap so the export can render an honest "N images omitted" notice — never silently lossy.
export interface ExportImagesResult {
  readonly images: readonly InlinedImage[];
  readonly omittedCount: number;
}

// Full backup/restore (M06.C). `backup` writes the whole store (DB + asset blobs) to one portable,
// version-stamped file; `restore` reads one back. Both report a typed outcome — no key, no DB
// handle, no raw filesystem path crosses to the renderer.
export type BackupResult =
  | { readonly saved: true; readonly path: string }
  | { readonly saved: false };

// Restore is destructive (it REPLACES the current store). A newer-schema backup is refused loudly
// (`incompatible-version`) rather than corrupting an older app; `invalid` is a non-backup/corrupt
// file; `cancelled` covers both a cancelled picker and a declined replace-confirm.
export type RestoreResult =
  | { readonly restored: true }
  | {
      readonly restored: false;
      readonly reason: 'cancelled' | 'incompatible-version' | 'invalid';
    };

// A cross-session full-text search hit (M04.D, ADR-0011). `sessionId` navigates to
// the source session; `snippet` is the FTS5 highlight; `sessionName` labels the result.
export interface SearchResult {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly snippet: string;
}
