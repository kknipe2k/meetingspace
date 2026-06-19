/*
 * The thumbnail-derivative path convention (M06.C / REVIEW-V11 F25). A screenshot's downscaled
 * thumbnail is stored as a SIBLING blob next to the full image — `<sessionId>/<id>.thumb.jpg` —
 * derived purely from the full blob's relative path. By-convention (not a schema column) so M06.C
 * adds NO migration. This is the SINGLE source both processes derive from: the main-side generator
 * + backfill (electron/thumbnails.ts) writes here; the renderer (src/components/Thumbnail.tsx)
 * reads `asset://<thumb>` and falls back to the full image when the file is absent. Always `.jpg`
 * (JPEG thumbnails) regardless of the source extension.
 */
export function thumbnailRelativePath(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.');
  const base = dot > relativePath.lastIndexOf('/') ? relativePath.slice(0, dot) : relativePath;
  return `${base}.thumb.jpg`;
}
