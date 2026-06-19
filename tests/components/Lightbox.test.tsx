// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Lightbox } from '../../src/components/Lightbox';

// The reusable click-to-expand-and-close image overlay (M02.D; M04 reuses it).
// It renders the full-size asset:// image and closes on Esc + click-outside, but
// not on a click on the image itself.
describe('Lightbox', () => {
  it('renders the full-size image at the given src', () => {
    render(<Lightbox src="asset://s1/shot.png" alt="Screenshot 1" onClose={() => {}} />);

    expect(screen.getByRole('img', { name: 'Screenshot 1' })).toHaveAttribute(
      'src',
      'asset://s1/shot.png',
    );
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Lightbox src="asset://s1/shot.png" onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside the image (on the scrim)', () => {
    const onClose = vi.fn();
    render(<Lightbox src="asset://s1/shot.png" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('lightbox-scrim'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a click on the image itself', () => {
    const onClose = vi.fn();
    render(<Lightbox src="asset://s1/shot.png" alt="Screenshot 1" onClose={onClose} />);

    fireEvent.click(screen.getByRole('img', { name: 'Screenshot 1' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  // Flicker fix, half 1: the overlay renders through a top-level portal so it is a
  // sibling of the app root (document.body child), not nested under the hover-
  // transformed thumbnail figure that caused the IRL repaint/refetch.
  it('renders through a portal at document.body', () => {
    render(<Lightbox src="asset://s1/shot.png" onClose={() => {}} />);

    expect(screen.getByTestId('lightbox-scrim').parentElement).toBe(document.body);
  });

  // Flicker fix, half 1 (cont.): a parent re-render must not remount the <img>
  // (a remount re-fetches the asset:// bytes — the visible flicker).
  it('keeps the same <img> DOM node across a parent re-render (no remount → no refetch)', () => {
    function Harness(): ReactElement {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            bump
          </button>
          <Lightbox src="asset://s1/shot.png" alt="Screenshot 1" onClose={() => {}} />
        </>
      );
    }
    render(<Harness />);
    const before = screen.getByRole('img', { name: 'Screenshot 1' });

    fireEvent.click(screen.getByRole('button', { name: 'bump' }));

    expect(screen.getByRole('img', { name: 'Screenshot 1' })).toBe(before);
  });

  // M02 Finding 1 closed on the real component: it inherits the shared focus-trap.
  // The lightbox has no focusable children, so initial focus lands on the dialog
  // and a Tab keydown is CONTAINED (preventDefault) — focus can never leave behind
  // the scrim. fireEvent returns false when the handler called preventDefault.
  it('contains Tab within the dialog (inherits the shared focus-trap)', () => {
    render(<Lightbox src="asset://s1/shot.png" alt="Screenshot 1" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    const notPrevented = fireEvent.keyDown(dialog, { key: 'Tab' });

    expect(notPrevented).toBe(false);
  });
});
