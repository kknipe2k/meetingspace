// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from '../../src/components/Modal';

/*
 * The shared modal primitive. Regression guard for the scrim-close bug: selecting text
 * by dragging out of an input and releasing on the scrim fired a scrim `click` and
 * closed the modal mid-edit. The fix: close only when the press STARTED on the scrim.
 */
function renderModal(onClose: () => void) {
  return render(
    <Modal label="Editor" className="x-modal" scrimTestId="scrim" onClose={onClose}>
      <textarea aria-label="field" defaultValue="some text" />
    </Modal>,
  );
}

describe('Modal scrim close', () => {
  it('closes on a genuine scrim click (press and release on the scrim)', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    const scrim = screen.getByTestId('scrim');
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when a text-selection drag starts in the dialog and releases on the scrim', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    const scrim = screen.getByTestId('scrim');
    const field = screen.getByLabelText('field');
    // Press begins inside the textarea (bubbles to the scrim with target = textarea)…
    fireEvent.mouseDown(field);
    // …and the click lands on the scrim (mouse released outside the dialog).
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });
});
