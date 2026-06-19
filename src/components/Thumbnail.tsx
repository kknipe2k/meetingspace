import { useState, type ReactElement } from 'react';

import type { Asset } from '@shared/types';
import { thumbnailRelativePath } from '@shared/images/thumbnail-path';

import { Lightbox } from './Lightbox';

export interface ThumbnailProps {
  asset: Asset;
  /** 1-based position, for stable, unique accessible labels (gotcha §7). */
  index: number;
  onDelete(id: string): void;
}

/*
 * One screenshot thumbnail (design.md §4 screenshot-thumb: radius-md, 1px border,
 * scale 1.01 + shadow-md on hover). The image is served by the scoped asset://
 * protocol from the per-session blob file — the renderer never sees a raw
 * filesystem path. Clicking the thumbnail expands it full-size in the reusable
 * Lightbox (the same asset:// bytes, no new IPC).
 *
 * The expand affordance and the delete control are separate buttons; delete also
 * stops propagation so a click on it never opens the lightbox (the delete-vs-
 * expand guard — Thumbnail.test asserts it, mutation-verified).
 *
 * M06.C (F25): the GRID renders the downscaled sibling thumbnail (`asset://<id>.thumb.jpg`) with
 * native lazy-loading, so a large session no longer decodes every full-res image at once. A
 * missing thumb (pre-M06.C asset, or a decode failure) `onError`-falls back to the full image, so
 * rendering never breaks. The Lightbox always opens the FULL-resolution image.
 */
export function Thumbnail({ asset, index, onDelete }: ThumbnailProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const fullSrc = `asset://${asset.relativePath}`;
  const thumbSrc = `asset://${thumbnailRelativePath(asset.relativePath)}`;
  // Start with the thumbnail; fall back to full-res once if the thumb file isn't there.
  const [gridSrc, setGridSrc] = useState(thumbSrc);

  return (
    <figure className="screenshot-thumb" data-testid="screenshot-thumb">
      <button
        type="button"
        className="screenshot-thumb-view"
        aria-label={`Expand screenshot ${index}`}
        onClick={() => setExpanded(true)}
      >
        <img
          className="screenshot-thumb-img"
          src={gridSrc}
          alt={`Screenshot ${index}`}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (gridSrc !== fullSrc) {
              setGridSrc(fullSrc);
            }
          }}
        />
      </button>
      <button
        type="button"
        className="btn-icon btn-danger screenshot-thumb-delete"
        aria-label={`Delete screenshot ${index}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete(asset.id);
        }}
      >
        Delete
      </button>
      {expanded && (
        <Lightbox src={fullSrc} alt={`Screenshot ${index}`} onClose={() => setExpanded(false)} />
      )}
    </figure>
  );
}
