import type { Asset, ExportImagesResult } from '@shared/types';
import type { InlinedImage } from '@shared/images/image-figures';
import { EXPORT_MAX_IMAGES, EXPORT_MAX_INLINE_BYTES } from '@shared/limits';

/*
 * Raw screenshot acquisition for the self-contained HTML export (M04.D). This replaces
 * the M04.C in-app inline path, which decoded screenshots with Electron `nativeImage`
 * and downscaled them — but nativeImage decoded many VALID screenshots to an EMPTY
 * image here and silently DROPPED them (C-14). The export instead reads each asset's
 * RAW file bytes and base64-encodes them directly: no decode, no downscale, no drop.
 * Full resolution is fine for a file the user opens once.
 *
 * M06.C (F26): the inlining is now CAPPED — by image COUNT and cumulative DECODED bytes,
 * whichever hits first — so a huge session can't produce an unopenable file (and the
 * uncapped base64 no longer crosses IPC twice). The overflow is reported as `omittedCount`,
 * NEVER silently dropped (the export renders a visible "N images omitted" notice). Once a cap
 * is hit we STOP reading further blobs (they are dropped, not held) so memory stays bounded.
 *
 * The pure orchestration (list → read → cap → assemble) is unit-tested with an injected
 * reader; the confined file read + mime lookup is the thin main wrapper (main.ts,
 * coverage-excluded like the other OS seams), reusing the SAME confinement primitive
 * as the corpus image reader (gotcha §8).
 */
export interface RawImage {
  readonly mediaType: string;
  /** Base64 of the asset's raw, unmodified file bytes. */
  readonly base64: string;
}

export interface RawImageReader {
  listAssets(sessionId: string): Asset[];
  /** Read one asset's raw bytes + mime; null for an unreadable / unsupported asset. */
  readRawImage(asset: Asset): RawImage | null;
}

export interface ExportCaps {
  readonly maxImages: number;
  readonly maxInlineBytes: number;
}

// Decoded byte size of a base64 string (4 chars → 3 bytes, minus '=' padding).
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function collectRawImages(
  reader: RawImageReader,
  sessionId: string,
  caps: ExportCaps = { maxImages: EXPORT_MAX_IMAGES, maxInlineBytes: EXPORT_MAX_INLINE_BYTES },
): ExportImagesResult {
  const images: InlinedImage[] = [];
  let omittedCount = 0;
  let inlinedBytes = 0;
  for (const asset of reader.listAssets(sessionId)) {
    const raw = reader.readRawImage(asset);
    if (!raw) {
      // An unreadable/unsupported asset was never inlinable — skip it, do NOT count it as omitted.
      continue;
    }
    const bytes = decodedByteLength(raw.base64);
    if (images.length >= caps.maxImages || inlinedBytes + bytes > caps.maxInlineBytes) {
      omittedCount += 1;
      continue;
    }
    inlinedBytes += bytes;
    images.push({
      dataUri: `data:${raw.mediaType};base64,${raw.base64}`,
      alt: `Screenshot ${asset.kind}`,
    });
  }
  return { images, omittedCount };
}
