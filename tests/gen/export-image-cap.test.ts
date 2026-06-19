import { describe, expect, it } from 'vitest';

import type { Asset } from '@shared/types';
import { EXPORT_MAX_IMAGES, EXPORT_MAX_INLINE_BYTES } from '@shared/limits';

import { collectRawImages, type RawImageReader } from '../../electron/gen/raw-images';

/*
 * F26 (REVIEW-V11): the HTML/PDF export used to inline EVERY session image, uncapped, in
 * memory and across two IPC crossings — a huge session produced an unopenable file. The cap
 * bounds BOTH the image COUNT and the cumulative INLINED BYTES (whichever hits first); the
 * overflow is NEVER silently dropped — collectRawImages reports an `omittedCount` the export
 * surfaces as a visible "N images omitted" notice (M06.C / 30 imgs / 50 MB, owner-set).
 */

// One base64 string whose DECODED size is ~`bytes` (base64 is 4 chars per 3 bytes).
function base64OfSize(bytes: number): string {
  const chars = Math.ceil(bytes / 3) * 4;
  return 'A'.repeat(chars);
}

const asset = (id: string): Asset => ({
  id,
  sessionId: 's1',
  kind: 'capture',
  relativePath: `s1/${id}.png`,
  createdAt: 1,
});

// A reader whose images each decode to `perImageBytes` raw bytes.
function reader(ids: string[], perImageBytes: number): RawImageReader {
  return {
    listAssets: () => ids.map(asset),
    readRawImage: () => ({ mediaType: 'image/png', base64: base64OfSize(perImageBytes) }),
  };
}

describe('collectRawImages — F26 export cap', () => {
  it('returns every image and omittedCount 0 when under both caps', () => {
    const result = collectRawImages(reader(['a', 'b', 'c'], 1024), 's1');
    expect(result.images).toHaveLength(3);
    expect(result.omittedCount).toBe(0);
  });

  it('caps by image COUNT and reports the rest as omitted (never silent)', () => {
    const ids = Array.from({ length: EXPORT_MAX_IMAGES + 5 }, (_, i) => `img-${i}`);
    const result = collectRawImages(reader(ids, 1024), 's1');
    expect(result.images).toHaveLength(EXPORT_MAX_IMAGES);
    expect(result.omittedCount).toBe(5);
  });

  it('caps by cumulative BYTES before the count cap when images are large', () => {
    // Each image is ~40% of the byte budget, so 2 fit (~80%) and the 3rd (~120%) overflows.
    const big = Math.floor(EXPORT_MAX_INLINE_BYTES * 0.4);
    const result = collectRawImages(reader(['a', 'b', 'c', 'd'], big), 's1');
    expect(result.images).toHaveLength(2);
    expect(result.omittedCount).toBe(2);
  });

  it('skips an unreadable asset without counting it as omitted (it was never inlinable)', () => {
    const r: RawImageReader = {
      listAssets: () => [asset('a'), asset('b')],
      readRawImage: (a) => (a.id === 'b' ? null : { mediaType: 'image/png', base64: 'AAAA' }),
    };
    const result = collectRawImages(r, 's1');
    expect(result.images).toHaveLength(1);
    expect(result.omittedCount).toBe(0);
  });
});
