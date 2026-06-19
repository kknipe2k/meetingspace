/*
 * Generation progress copy (M04.C → M07.C). The closed two-phase label map opened up
 * with the chunked pipeline: progress copy now arrives ON the GenProgress events
 * themselves (`progress.label` — "Section 3 of 7 — Architecture"), authored main-side
 * next to the steps that emit them, so the renderer no longer keeps a phase→label map.
 * The labels deliberately describe analysis/planning/writing/styling, NEVER a
 * scripting/JS step — the generated doc carries no scripts (the no-scripts security
 * mandate), so the progress UI must never imply one.
 */

// The user-facing label for a generated artifact kind — used by the app-level run toast
// (M07.B IRL reversal) so a live run is attributable by kind alongside its session + elapsed.
export function genKindLabel(kind: 'whitepaper' | 'minutes'): string {
  return kind === 'whitepaper' ? 'White paper' : 'Minutes';
}
