import {
  buildFontFaceStyle,
  GENERATED_DOC_FONT_FACES,
  type InlinedFontFace,
} from '@shared/fonts/font-faces';
import { FONT_DATA_URIS } from '@shared/fonts/font-data';

/*
 * The renderer-side font assembly (M04.C; ADR-0013). The vendored, latin-subset OFL
 * fonts (assets/fonts/) are materialized as base64 data: URIs in the generated
 * shared/fonts/font-data.ts (built by scripts/generate-font-data.cjs). Self-hosting
 * them this way is what lets the designed typography render inside the sandbox=""
 * generated-document iframe with ZERO network — the opaque-origin frame can't reach
 * asset://, and the strict app CSP forbids external font origins (only
 * `font-src 'self' data:` is permitted). Stage-D export reuses buildFontFaceStyle
 * (and the same FONT_DATA_URIS) main-side.
 */
const INLINED: InlinedFontFace[] = GENERATED_DOC_FONT_FACES.map((face) => ({
  ...face,
  dataUri: FONT_DATA_URIS[`${face.family}-${face.weight}` as keyof typeof FONT_DATA_URIS],
}));

// Built once at module load — the same <style> is injected into every generated doc
// (white paper / minutes / raw) after sanitization, via injectFontFaces.
export const GENERATED_DOC_FONT_STYLE = buildFontFaceStyle(INLINED);
