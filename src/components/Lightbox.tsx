import { useMemo, type ReactElement } from 'react';

import { Modal } from './Modal';

export interface LightboxProps {
  /** Full-size image source — an `asset://` URL for stored screenshots. */
  src: string;
  alt?: string;
  onClose(): void;
}

/*
 * A reusable click-to-expand-and-close image overlay (M02.D). It now consumes the
 * shared Modal (M03.A): scrim, shadow-lg, role="dialog", and a REAL focus trap
 * (Tab contained, focus restored on close) — resolving the M02 over-claim. Closes
 * on Esc or a click outside the image; a click on the image does not close (the
 * Modal dialog stops propagation). UI-only: it renders bytes the scoped asset://
 * protocol already serves, with no new IPC or storage.
 *
 * Flicker fix (M02.D IRL), preserved: the Modal renders through a top-level portal
 * so the scrim is a sibling of the app root (not a descendant of the hover-
 * transformed thumbnail figure), and the <img> is memoized so a parent re-render
 * never remounts/refetches it. The full-viewport scrim captures pointer events, so
 * a mousemove over the app behind the open lightbox never reaches it.
 *
 * Built standalone (not coupled to the screenshot grid) so M04's white-paper
 * render can reuse it (memory: v1-image-lightbox / m04-whitepaper-generation).
 */
export function Lightbox({ src, alt = '', onClose }: LightboxProps): ReactElement {
  const image = useMemo(() => <img className="lightbox-img" src={src} alt={alt} />, [src, alt]);

  return (
    <Modal
      label={alt || 'Expanded screenshot'}
      className="lightbox"
      scrimClassName="lightbox-scrim"
      scrimTestId="lightbox-scrim"
      onClose={onClose}
    >
      {image}
    </Modal>
  );
}
