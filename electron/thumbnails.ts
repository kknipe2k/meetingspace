import { existsSync } from 'node:fs';

import type Database from 'better-sqlite3';

import { thumbnailRelativePath } from '@shared/images/thumbnail-path';

import { confinedAssetPath } from './storage/blob-io';

/*
 * Thumbnail derivatives (M06.C / REVIEW-V11 F25). A downscaled JPEG thumbnail is generated for each
 * screenshot — at save time (new assets) and via an idempotent startup backfill (pre-M06.C assets)
 * — and stored as a SIBLING blob by convention (`<sessionId>/<id>.thumb.jpg`, shared/thumbnail-path).
 * NO schema migration (M06.C adds none): the thumb is a file, not a column. The grid serves the
 * thumb; the lightbox + export keep full-res; a missing thumb or a decode failure (the C-14 class)
 * falls back to the full image, so this is purely an optimization that can never break rendering.
 *
 * The downscale logic (don't-upscale, skip-undecodable) lives in the pure `makeThumbnail` seam,
 * tested under Node with a fake codec; the real codec wraps Electron `nativeImage` (the OS seam in
 * main.ts). The backfill orchestration is likewise pure (injected fs + generator).
 */

// The max edge (px) of a generated thumbnail. The grid cell is ~260px; 480 covers HiDPI without
// shipping full-res. JPEG quality is a reasonable thumbnail default.
export const THUMBNAIL_MAX_EDGE = 480;
export const THUMBNAIL_JPEG_QUALITY = 70;

// Abstracts Electron nativeImage so the resize logic is Node-testable. `decode` reports the source
// dimensions (+ whether the decode produced an empty image — the C-14 failure mode); `encodeJpeg`
// resizes to `targetWidth` and encodes JPEG.
export interface ThumbnailCodec {
  decode(bytes: Uint8Array): { width: number; height: number; empty: boolean };
  encodeJpeg(bytes: Uint8Array, targetWidth: number, quality: number): Buffer;
}

// Generate a thumbnail JPEG from source image bytes, or null when the image can't be decoded (the
// grid then falls back to full-res). NEVER upscales — the target width clamps to the natural width.
export function makeThumbnail(bytes: Uint8Array, codec: ThumbnailCodec): Buffer | null {
  const { width, empty } = codec.decode(bytes);
  if (empty || width <= 0) {
    return null;
  }
  const targetWidth = Math.min(THUMBNAIL_MAX_EDGE, width);
  return codec.encodeJpeg(bytes, targetWidth, THUMBNAIL_JPEG_QUALITY);
}

export interface ThumbnailBackfillDeps {
  // Read an asset's source bytes from disk; null when missing/unreadable (skip, never crash).
  readBytes(absolutePath: string): Uint8Array | null;
  writeThumb(absolutePath: string, bytes: Buffer): void;
  // Produce thumbnail bytes from source bytes, or null on an undecodable image.
  makeThumb(bytes: Uint8Array): Buffer | null;
}

interface AssetRow {
  id: string;
  session_id: string;
  relative_path: string;
}

/*
 * Idempotent thumbnail backfill (run non-blocking at startup). For every asset lacking a sibling
 * `.thumb.jpg`, read its source, generate a thumbnail, and write it. Already-thumbed assets and
 * unreadable/undecodable ones are skipped (the pass never crashes startup). Returns the number of
 * thumbnails generated; a second run finds them all present and returns 0. The full + thumb paths
 * are resolved through the SAME confinement primitive as the asset:// serve path (gotcha §8).
 */
export function backfillThumbnails(
  db: Database.Database,
  assetsRoot: string,
  deps: ThumbnailBackfillDeps & { thumbExists?: (absolutePath: string) => boolean },
): number {
  const rows = db.prepare('SELECT id, session_id, relative_path FROM assets').all() as AssetRow[];
  let generated = 0;
  for (const row of rows) {
    const thumbRel = thumbnailRelativePath(row.relative_path);
    const thumbAbs = confinedJoin(assetsRoot, row.session_id, thumbRel);
    const fullAbs = confinedJoin(assetsRoot, row.session_id, row.relative_path);
    if (!thumbAbs || !fullAbs) {
      continue;
    }
    const exists = deps.thumbExists ? deps.thumbExists(thumbAbs) : defaultExists(thumbAbs);
    if (exists) {
      continue; // idempotent: already has a thumbnail
    }
    const bytes = deps.readBytes(fullAbs);
    if (!bytes) {
      continue; // missing/unreadable source — leave full-res fallback in place
    }
    const thumb = deps.makeThumb(bytes);
    if (!thumb) {
      continue; // undecodable (C-14 class) — fall back to full-res
    }
    deps.writeThumb(thumbAbs, thumb);
    generated += 1;
  }
  return generated;
}

// `relative_path`/derived thumb path already carry the `<sessionId>/<file>` shape; confine the
// FILE part under <root>/<sessionId> exactly like the serve path so a malformed row can't escape.
function confinedJoin(assetsRoot: string, sessionId: string, relativePath: string): string | null {
  const slash = relativePath.indexOf('/');
  const filename = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  return confinedAssetPath(assetsRoot, sessionId, filename);
}

function defaultExists(absolutePath: string): boolean {
  return existsSync(absolutePath);
}

export { thumbnailRelativePath };

// The path (under the assets root) where a saved asset's thumbnail belongs — used by the on-save
// hook in main.ts. Returns null if the path would escape the root.
export function thumbnailAbsolutePath(
  assetsRoot: string,
  sessionId: string,
  fullRelativePath: string,
): string | null {
  return confinedJoin(assetsRoot, sessionId, thumbnailRelativePath(fullRelativePath));
}
