/*
 * Shared size limits (single source of truth across the main boundary and the renderer). The
 * note byte cap is enforced authoritatively at the main IPC boundary (electron/ipc/note-handlers)
 * AND prechecked in the renderer (NoteBlocks upload) so an over-cap upload gets a precise,
 * size-helpful "too large" message instead of a generic failure (M06.B / F13). Measured as UTF-8
 * bytes — what actually lands on disk — not JS string length.
 */
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;

/*
 * Storage-meter nudge threshold (M06.B / F28). When total usage crosses 1 GiB the UI raises an
 * informational "you're using a lot of storage" toast. Shared so both the main-side StorageStore
 * and the renderer-side nudge use one source of truth. A pure check — easy to test.
 */
export const STORAGE_THRESHOLD_BYTES = 1024 ** 3;

export function crossesStorageThreshold(totalBytes: number): boolean {
  return totalBytes >= STORAGE_THRESHOLD_BYTES;
}

/*
 * Export image-inlining caps (M06.C / REVIEW-V11 F26). The self-contained HTML/PDF export inlines
 * screenshots as base64; an uncapped session produced a file too large to open and crossed the IPC
 * boundary twice in memory. Bound BOTH the COUNT and the cumulative DECODED bytes — whichever hits
 * first — and surface the overflow as a visible "N images omitted" notice (NEVER silent). Owner-set
 * at M06.C: 30 images / 50 MB. Shared so the main-side collector and any renderer/test agree on one
 * source. Adjustable — raising them is reversible.
 */
export const EXPORT_MAX_IMAGES = 30;
export const EXPORT_MAX_INLINE_BYTES = 50 * 1024 * 1024;

/*
 * Chat conversation-history window (M06.D, ADR-0020). A token-budgeted window of the most recent
 * prior turns is threaded into each chat request (AFTER the cached grounding prefix, so the cache
 * holds) to give the model multi-turn memory; OLDEST turns drop first so per-turn cost stays
 * bounded. Tokens are estimated at ~4 chars/token. 12,000 is a few full turns of memory — well
 * under the ~25k-token grounding budget and the model context — chosen at the M06.D plan (the
 * passive usage counter makes the per-turn cost visible). Shared so the main-side llm-service and
 * any test agree on one source.
 */
export const HISTORY_TOKEN_BUDGET = 12_000;

/*
 * White-paper generation output cap (M06.D, moved here from generation-service so the renderer can
 * surface it as a static FYI — ADR-0018 / M07.C). The per-call min(this, live model ceiling) bound:
 * 16K truncated real bodies at the HTML long pole, 32K clears it with headroom and stays under every
 * current generation model's ceiling. The model-aware cap (M06.D, ADR-0021) resolves
 * min(GENERATION_MAX_TOKENS, liveCatalogCeiling ?? staticSeed); the static seed is the offline
 * fallback. Single source across the main-side gen cap and the Settings display.
 */
export const GENERATION_MAX_TOKENS = 32000;
