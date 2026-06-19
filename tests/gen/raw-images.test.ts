import { describe, expect, it } from 'vitest';

import type { Asset } from '@shared/types';

import { collectRawImages, type RawImageReader } from '../../electron/gen/raw-images';

/*
 * Raw screenshot acquisition for the HTML export (M04.D). Unlike the M04.C in-app
 * inline path (Electron nativeImage downscale — which decoded many real screenshots
 * to EMPTY and silently dropped them, C-14), the export reads the asset's RAW file
 * bytes and base64-encodes them directly: no decode, no downscale, no drop. Full
 * resolution is fine for a file the user opens once. The pure orchestration (list →
 * read → assemble) is unit-tested with an injected reader; the confined file read is
 * the thin main wrapper.
 */
const asset = (id: string, kind: Asset['kind']): Asset => ({
  id,
  sessionId: 's1',
  kind,
  relativePath: `s1/${id}.png`,
  createdAt: 1,
});

function reader(map: Record<string, { mediaType: string; base64: string } | null>): RawImageReader {
  return {
    listAssets: () => Object.keys(map).map((id) => asset(id, 'capture')),
    readRawImage: (a) => map[a.id] ?? null,
  };
}

describe('collectRawImages', () => {
  it('encodes each readable screenshot as a data: URI from its RAW bytes (no decode/downscale)', () => {
    const { images } = collectRawImages(
      reader({ a: { mediaType: 'image/png', base64: 'RAWPNG==' } }),
      's1',
    );
    expect(images).toEqual([
      { dataUri: 'data:image/png;base64,RAWPNG==', alt: 'Screenshot capture' },
    ]);
  });

  it('skips an unreadable / unsupported asset rather than emitting a broken URI', () => {
    const { images } = collectRawImages(
      reader({ a: { mediaType: 'image/jpeg', base64: 'JJ==' }, b: null }),
      's1',
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.dataUri).toBe('data:image/jpeg;base64,JJ==');
  });

  it('returns an empty result when the session has no screenshots', () => {
    expect(collectRawImages(reader({}), 's1')).toEqual({ images: [], omittedCount: 0 });
  });
});
